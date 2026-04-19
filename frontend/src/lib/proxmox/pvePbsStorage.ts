import { pveFetch } from './client'
import type { PveConn } from '@/lib/connections/getConnection'

export function sanitizeStorageName(tenantSlug: string, vdcSlug: string, prefix = 'pbs-'): string {
  const clean = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
  const core = `${clean(tenantSlug)}-${clean(vdcSlug)}`.slice(0, 40 - prefix.length)
  return `${prefix}${core}`
}

export async function pbsStorageExists(conn: PveConn, storage: string): Promise<boolean> {
  try {
    const r = await pveFetch<any>(conn, `/storage/${encodeURIComponent(storage)}`)
    return !!r
  } catch (e: any) {
    const msg = String(e?.message ?? '')
    // PVE returns 500 "storage 'X' does not exist" for missing storages (non-standard).
    if (/\b404\b/.test(msg) || /does not exist/i.test(msg)) return false
    throw e
  }
}

export interface CreatePbsStorageArgs {
  storage: string
  server: string
  datastore: string
  namespace: string
  username: string
  password: string
  fingerprint: string
  nodes: string[]
  port?: number
}

export async function createPbsStorage(conn: PveConn, args: CreatePbsStorageArgs): Promise<void> {
  if (await pbsStorageExists(conn, args.storage)) return
  const body: Record<string, any> = {
    storage: args.storage,
    type: 'pbs',
    server: args.server,
    datastore: args.datastore,
    namespace: args.namespace,
    username: args.username,
    password: args.password,
    fingerprint: args.fingerprint,
    content: 'backup',
  }
  if (args.nodes.length) body.nodes = args.nodes.join(',')
  if (args.port) body.port = args.port
  await pveFetch(conn, '/storage', { method: 'POST', body: body as any })
}

export async function deletePbsStorage(conn: PveConn, storage: string): Promise<void> {
  try {
    await pveFetch(conn, `/storage/${encodeURIComponent(storage)}`, { method: 'DELETE' })
  } catch (e: any) {
    const msg = String(e?.message ?? '')
    if (!/\b404\b/.test(msg) && !/does not exist/i.test(msg)) throw e
  }
}
