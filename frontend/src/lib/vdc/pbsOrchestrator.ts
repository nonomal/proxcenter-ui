import { randomUUID } from 'crypto'

import { getDb } from '@/lib/db/sqlite'
import { prisma } from '@/lib/db/prisma'
import { decryptSecret } from '@/lib/crypto/secret'
import {
  ensureNamespacePath, ensureSubToken, setNamespaceAcl, setDatastoreAuditAcl, deleteSubToken,
} from '@/lib/proxmox/pbsNamespace'
import {
  createPbsStorage, deletePbsStorage, sanitizeStorageName,
} from '@/lib/proxmox/pvePbsStorage'
import { getConnectionById } from '@/lib/connections/getConnection'
import {
  insertBinding, insertPveStorage, deleteBinding, deletePveStorage,
  listPveStoragesForBinding, findBindingByTuple, type PbsBindingRow,
} from '@/lib/db/vdcPbsBindings'
import { clearVdcScopeCache } from './scope'

interface BindAutoArgs {
  vdcId: string
  pbsConnectionId: string
  datastore: string
  namespace?: string
}

interface BindManualArgs {
  vdcId: string
  pbsConnectionId: string
  datastore: string
  namespace: string
  pveStorageName?: string
  pveConnectionId?: string
}

interface StepStatus {
  namespace: 'ok' | 'skipped' | 'failed'
  token: 'ok' | 'skipped' | 'failed'
  acl: 'ok' | 'skipped' | 'failed'
  pveStorages: Array<{ pveConnectionId: string; name: string; status: 'ok' | 'skipped' | 'failed'; error?: string }>
}

interface ManualStepStatus {
  mode: 'manual'
  pveStorage: 'ok' | 'skipped'
}

const locks = new Map<string, Promise<any>>()
async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve()
  let resolve: () => void = () => {}
  const next = new Promise<void>(r => { resolve = r })
  locks.set(key, prev.then(() => next))
  try { return await prev.then(fn) }
  finally { resolve(); if (locks.get(key) === next) locks.delete(key) }
}

function parsePbsUser(apiToken: string): string {
  const m = apiToken.match(/^([^!]+)!/)
  if (!m) throw new Error('Unexpected PBS root token format; expected user@realm!tokenid:secret')
  return m[1]
}

async function resolvePbsMeta(pbsConnectionId: string): Promise<{
  conn: { baseUrl: string; apiToken: string; insecureDev: boolean }
  host: string
  fingerprint: string
  rootUser: string
}> {
  const row = await prisma.connection.findUnique({
    where: { id: pbsConnectionId },
    select: { baseUrl: true, fingerprint: true, apiTokenEnc: true, insecureTLS: true, type: true },
  })
  if (!row || row.type !== 'pbs') throw new Error(`PBS connection not found: ${pbsConnectionId}`)
  if (!row.fingerprint) throw new Error('PBS fingerprint missing — capture it on the connection first')

  const apiToken = decryptSecret(row.apiTokenEnc)
  const host = row.baseUrl.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/:\d+$/, '')

  return {
    conn: { baseUrl: row.baseUrl, apiToken, insecureDev: !!row.insecureTLS },
    host,
    fingerprint: row.fingerprint,
    rootUser: parsePbsUser(apiToken),
  }
}

function readVdcAndTenant(vdcId: string) {
  const db = getDb()
  const vdc = db.prepare('SELECT * FROM vdcs WHERE id = ?').get(vdcId) as any
  if (!vdc) throw new Error(`vDC not found: ${vdcId}`)
  const tenant = db.prepare('SELECT * FROM tenants WHERE id = ?').get(vdc.tenant_id) as any
  if (!tenant) throw new Error(`tenant not found: ${vdc.tenant_id}`)
  return { vdc, tenant }
}

function readVdcNodeNames(vdcId: string): string[] {
  return (getDb().prepare('SELECT node_name FROM vdc_nodes WHERE vdc_id = ?').all(vdcId) as any[])
    .map(r => r.node_name)
}

function appendVdcStorage(vdcId: string, storageId: string) {
  getDb().prepare('INSERT OR IGNORE INTO vdc_storages (id, vdc_id, storage_id) VALUES (?, ?, ?)')
    .run(randomUUID(), vdcId, storageId)
}

function removeVdcStorage(vdcId: string, storageId: string) {
  getDb().prepare('DELETE FROM vdc_storages WHERE vdc_id = ? AND storage_id = ?').run(vdcId, storageId)
}

export async function bindPbsToVdc(args: BindAutoArgs): Promise<{ binding: PbsBindingRow; steps: StepStatus }> {
  const lockKey = `${args.vdcId}|${args.pbsConnectionId}|${args.datastore}|${args.namespace ?? ''}`
  return withLock(lockKey, async () => {
    const { vdc, tenant } = readVdcAndTenant(args.vdcId)
    const namespace = args.namespace ?? `tenant-${tenant.slug}/vdc-${vdc.slug}`
    const pbs = await resolvePbsMeta(args.pbsConnectionId)

    const steps: StepStatus = { namespace: 'skipped', token: 'skipped', acl: 'skipped', pveStorages: [] }

    console.log(`[pbs-orchestrator] bind vdc=${args.vdcId} pbs=${args.pbsConnectionId} store=${args.datastore} ns=${namespace} base=${pbs.conn.baseUrl} rootUser=${pbs.rootUser}`)

    // Pre-check: if a binding on this tuple already exists, fail BEFORE touching
    // PBS. Otherwise ensureSubToken would rotate the PBS secret and leave the DB
    // with the stale one, breaking future auth.
    const existing = findBindingByTuple(args.pbsConnectionId, args.datastore, namespace)
    if (existing) {
      throw new Error(`Binding already exists (${existing.datastore}/${existing.namespace}). Delete it first if you want to recreate.`)
    }

    await ensureNamespacePath(pbs.conn, args.datastore, namespace)
    console.log(`[pbs-orchestrator] namespace ensured: ${namespace}`)
    steps.namespace = 'ok'

    const tokenShortId = `vdc-${args.vdcId.slice(0, 8)}`
    let tokenResult = await ensureSubToken(pbs.conn, pbs.rootUser, tokenShortId)
    console.log(`[pbs-orchestrator] ensureSubToken first call → tokenId=${tokenResult.tokenId} secret=${tokenResult.secret ? 'yes' : 'no'}`)
    if (!tokenResult.secret) {
      await deleteSubToken(pbs.conn, pbs.rootUser, tokenShortId)
      tokenResult = await ensureSubToken(pbs.conn, pbs.rootUser, tokenShortId)
      console.log(`[pbs-orchestrator] ensureSubToken after rotate → tokenId=${tokenResult.tokenId} secret=${tokenResult.secret ? 'yes' : 'no'}`)
      if (!tokenResult.secret) throw new Error('Failed to mint sub-token (no secret)')
    }
    steps.token = 'ok'
    const effectiveTokenId = tokenResult.tokenId
    const effectiveSecret = tokenResult.secret

    await setNamespaceAcl(pbs.conn, args.datastore, namespace, effectiveTokenId)
    await setDatastoreAuditAcl(pbs.conn, args.datastore, effectiveTokenId)
    console.log(`[pbs-orchestrator] ACLs set on ${args.datastore} for ${effectiveTokenId}`)
    steps.acl = 'ok'

    const binding = insertBinding({
      vdcId: args.vdcId,
      pbsConnectionId: args.pbsConnectionId,
      datastore: args.datastore,
      namespace,
      mode: 'auto',
      pbsTokenId: effectiveTokenId,
      pbsTokenSecret: effectiveSecret,
    })

    const pveConnId = vdc.connection_id
    const pveConn = await getConnectionById(pveConnId, tenant.id)
    const storageName = sanitizeStorageName(tenant.slug, vdc.slug)
    const nodes = readVdcNodeNames(args.vdcId)
    try {
      await createPbsStorage(pveConn, {
        storage: storageName,
        server: pbs.host,
        datastore: args.datastore,
        namespace,
        username: effectiveTokenId,
        password: effectiveSecret,
        fingerprint: pbs.fingerprint,
        nodes,
      })
      insertPveStorage({ bindingId: binding.id, pveConnectionId: pveConnId, pveStorageName: storageName, managed: true })
      appendVdcStorage(args.vdcId, storageName)
      steps.pveStorages.push({ pveConnectionId: pveConnId, name: storageName, status: 'ok' })
    } catch (e: any) {
      steps.pveStorages.push({ pveConnectionId: pveConnId, name: storageName, status: 'failed', error: String(e?.message ?? e) })
    }

    clearVdcScopeCache(tenant.id)
    return { binding, steps }
  })
}

export async function bindPbsToVdcManual(args: BindManualArgs): Promise<{ binding: PbsBindingRow; steps: ManualStepStatus }> {
  if (!args.namespace) throw new Error('namespace is required in manual mode')
  const lockKey = `${args.vdcId}|${args.pbsConnectionId}|${args.datastore}|${args.namespace}`
  return withLock(lockKey, async () => {
    const { vdc, tenant } = readVdcAndTenant(args.vdcId)

    const row = await prisma.connection.findUnique({
      where: { id: args.pbsConnectionId },
      select: { type: true },
    })
    if (!row || row.type !== 'pbs') throw new Error(`PBS connection not found: ${args.pbsConnectionId}`)

    const binding = insertBinding({
      vdcId: args.vdcId,
      pbsConnectionId: args.pbsConnectionId,
      datastore: args.datastore,
      namespace: args.namespace,
      mode: 'manual',
      pbsTokenId: null,
      pbsTokenSecret: null,
    })

    const steps: ManualStepStatus = { mode: 'manual', pveStorage: 'skipped' }
    if (args.pveStorageName) {
      const pveConnId = args.pveConnectionId ?? vdc.connection_id
      insertPveStorage({
        bindingId: binding.id,
        pveConnectionId: pveConnId,
        pveStorageName: args.pveStorageName,
        managed: false,
      })
      appendVdcStorage(args.vdcId, args.pveStorageName)
      steps.pveStorage = 'ok'
    }

    clearVdcScopeCache(tenant.id)
    return { binding, steps }
  })
}

export async function unbindFromVdc(bindingId: string): Promise<void> {
  const row = getDb().prepare('SELECT * FROM vdc_pbs_namespaces WHERE id = ?').get(bindingId) as any
  if (!row) return

  const { tenant } = readVdcAndTenant(row.vdc_id)
  const mode: 'auto' | 'manual' = row.mode ?? 'auto'

  for (const s of listPveStoragesForBinding(bindingId)) {
    if (s.managed) {
      try {
        const pveConn = await getConnectionById(s.pveConnectionId, tenant.id)
        await deletePbsStorage(pveConn, s.pveStorageName)
      } catch { /* already gone */ }
    }
    removeVdcStorage(row.vdc_id, s.pveStorageName)
    deletePveStorage(s.id)
  }

  if (mode === 'auto' && row.pbs_token_id) {
    try {
      const pbs = await resolvePbsMeta(row.pbs_connection_id)
      const tokenShortId = String(row.pbs_token_id).split('!')[1] ?? `vdc-${row.vdc_id.slice(0, 8)}`
      await deleteSubToken(pbs.conn, pbs.rootUser, tokenShortId)
    } catch (e) {
      console.error(`[pbs-unbind] token revoke failed for ${bindingId}:`, e)
    }
  }

  deleteBinding(bindingId)
  clearVdcScopeCache(tenant.id)
}
