import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/db/vdcPbsBindings', () => ({
  insertBinding: vi.fn(),
  insertPveStorage: vi.fn(),
  listPveStoragesForBinding: vi.fn(() => []),
  deleteBinding: vi.fn(),
  deletePveStorage: vi.fn(),
  findBindingByTuple: vi.fn(() => null),
}))
vi.mock('@/lib/proxmox/pbsNamespace', () => ({
  ensureNamespacePath: vi.fn(),
  ensureSubToken: vi.fn(async () => ({ tokenId: 'root@pam!vdc-abc', secret: 'S3CR3T' })),
  setNamespaceAcl: vi.fn(),
  deleteSubToken: vi.fn(),
}))
vi.mock('@/lib/proxmox/pvePbsStorage', () => ({
  createPbsStorage: vi.fn(),
  deletePbsStorage: vi.fn(),
  sanitizeStorageName: vi.fn((a, b) => `pbs-${a}-${b}`),
}))
vi.mock('@/lib/connections/getConnection', () => ({
  getPbsConnectionById: vi.fn(async () => ({ id: 'pbs1', name: 'pbs', baseUrl: 'https://pbs', apiToken: 'root@pam!x:y', insecureDev: true })),
  getConnectionById: vi.fn(async (id) => ({ id, name: id, baseUrl: 'https://pve', apiToken: 't', insecureDev: true, behindProxy: false })),
}))

vi.mock('@/lib/db/prisma', () => ({
  prisma: {
    connection: {
      findUnique: vi.fn(async () => ({
        id: 'pbs1',
        type: 'pbs',
        baseUrl: 'https://pbs.example:8007',
        fingerprint: 'AA:BB:CC',
        apiTokenEnc: 'enc',
        insecureTLS: true,
      })),
      update: vi.fn(),
    },
  },
}))
vi.mock('@/lib/crypto/secret', () => ({
  decryptSecret: () => `root@pam!admin:secret`,
  encryptSecret: (s: string) => `enc:${s}`,
}))

vi.mock('@/lib/db/sqlite', () => {
  const vdcs = new Map([['v1', { id: 'v1', tenant_id: 't1', slug: 'prod', connection_id: 'pve1' }]])
  const nodes = new Map([['v1', [{ node_name: 'pve01' }, { node_name: 'pve02' }]]])
  const storages = new Map<string, Set<string>>([['v1', new Set()]])
  const tenants = new Map([['t1', { slug: 'acme', id: 't1' }]])
  return {
    getDb: () => ({
      prepare: (sql: string) => ({
        get: (...args: any[]) => {
          if (sql.includes('FROM vdcs')) return vdcs.get(args[0])
          if (sql.includes('FROM tenants')) return tenants.get(args[0])
          if (sql.includes('FROM vdc_pbs_namespaces')) return null
          return null
        },
        all: (...args: any[]) => {
          if (sql.includes('FROM vdc_nodes')) return nodes.get(args[0]) || []
          return []
        },
        run: (...args: any[]) => {
          if (sql.includes('INSERT INTO vdc_storages')) storages.get(args[1])!.add(args[2])
          if (sql.includes('DELETE FROM vdc_storages')) storages.get(args[0])?.delete(args[1])
          return { changes: 1 }
        },
      }),
    }),
  }
})

vi.mock('./scope', () => ({ clearVdcScopeCache: vi.fn() }))

import { bindPbsToVdc, bindPbsToVdcManual, unbindFromVdc } from './pbsOrchestrator'
import * as bindings from '@/lib/db/vdcPbsBindings'
import * as pbsNs from '@/lib/proxmox/pbsNamespace'
import * as pveStorage from '@/lib/proxmox/pvePbsStorage'

describe('bindPbsToVdc', () => {
  beforeEach(() => vi.clearAllMocks())

  it('orchestrates namespace + token + acl + pve storages and writes DB', async () => {
    (bindings.insertBinding as any).mockReturnValue({
      id: 'b1', vdcId: 'v1', pbsConnectionId: 'pbs1',
      datastore: 'store1', namespace: 'tenant-acme/vdc-prod',
      pbsTokenId: 'root@pam!vdc-abc', pbsTokenSecret: 'S3CR3T',
      createdAt: 't',
    })

    const result = await bindPbsToVdc({
      vdcId: 'v1',
      pbsConnectionId: 'pbs1',
      datastore: 'store1',
    })

    expect(pbsNs.ensureNamespacePath).toHaveBeenCalledWith(expect.anything(), 'store1', 'tenant-acme/vdc-prod')
    expect(pbsNs.ensureSubToken).toHaveBeenCalled()
    expect(pbsNs.setNamespaceAcl).toHaveBeenCalled()
    expect(pveStorage.createPbsStorage).toHaveBeenCalledTimes(1)
    expect(bindings.insertBinding).toHaveBeenCalled()
    expect(bindings.insertPveStorage).toHaveBeenCalled()
    expect(result.binding.id).toBe('b1')
    expect(result.steps.namespace).toBe('ok')
    expect(result.steps.token).toBe('ok')
    expect(result.steps.acl).toBe('ok')
    expect(result.steps.pveStorages).toHaveLength(1)
  })

  it('rejects when fingerprint is missing on the PBS connection', async () => {
    const prismaMod = await import('@/lib/db/prisma')
    ;(prismaMod.prisma.connection.findUnique as any).mockResolvedValueOnce({
      id: 'pbs1', type: 'pbs', baseUrl: 'https://pbs', fingerprint: null, apiTokenEnc: 'e', insecureTLS: true,
    })
    await expect(bindPbsToVdc({ vdcId: 'v1', pbsConnectionId: 'pbs1', datastore: 'store1' }))
      .rejects.toThrow(/fingerprint/i)
  })
})

describe('bindPbsToVdcManual', () => {
  beforeEach(() => vi.clearAllMocks())

  it('writes a manual-mode row without touching PBS or PVE', async () => {
    (bindings.insertBinding as any).mockReturnValue({
      id: 'b1', vdcId: 'v1', pbsConnectionId: 'pbs1',
      datastore: 'store1', namespace: 'tenant-acme/vdc-prod',
      mode: 'manual', pbsTokenId: null, pbsTokenSecret: null, createdAt: 't',
    })

    const result = await bindPbsToVdcManual({
      vdcId: 'v1',
      pbsConnectionId: 'pbs1',
      datastore: 'store1',
      namespace: 'tenant-acme/vdc-prod',
    })

    expect(pbsNs.ensureNamespacePath).not.toHaveBeenCalled()
    expect(pbsNs.ensureSubToken).not.toHaveBeenCalled()
    expect(pveStorage.createPbsStorage).not.toHaveBeenCalled()
    expect(bindings.insertBinding).toHaveBeenCalledWith(expect.objectContaining({ mode: 'manual', pbsTokenId: null }))
    expect(result.steps).toEqual({ mode: 'manual', pveStorage: 'skipped' })
  })

  it('records a pre-existing PVE storage with managed=false when provided', async () => {
    (bindings.insertBinding as any).mockReturnValue({ id: 'b2', vdcId: 'v1', pbsConnectionId: 'pbs1', datastore: 'd', namespace: 'n', mode: 'manual', pbsTokenId: null, pbsTokenSecret: null, createdAt: 't' })
    await bindPbsToVdcManual({
      vdcId: 'v1',
      pbsConnectionId: 'pbs1',
      datastore: 'store1',
      namespace: 'tenant-acme/vdc-prod',
      pveStorageName: 'pbs-preexisting',
    })
    expect(bindings.insertPveStorage).toHaveBeenCalledWith(expect.objectContaining({ pveStorageName: 'pbs-preexisting', managed: false }))
  })

  it('requires a namespace', async () => {
    await expect(bindPbsToVdcManual({ vdcId: 'v1', pbsConnectionId: 'pbs1', datastore: 'store1', namespace: '' }))
      .rejects.toThrow(/namespace/i)
  })
})

describe('unbindFromVdc', () => {
  beforeEach(() => vi.clearAllMocks())

  it('deletes PVE storages, revokes sub-token, removes DB row', async () => {
    const sqliteMod = await import('@/lib/db/sqlite')
    const origGetDb = sqliteMod.getDb
    ;(sqliteMod as any).getDb = () => ({
      prepare: (sql: string) => ({
        get: (...args: any[]) => {
          if (sql.includes('FROM vdc_pbs_namespaces')) return {
            id: 'b1', vdc_id: 'v1', pbs_connection_id: 'pbs1', datastore: 'store1',
            namespace: 'tenant-acme/vdc-prod', pbs_token_id: 'root@pam!vdc-abc',
            pbs_token_secret: 'S3CR3T', mode: 'auto',
          }
          if (sql.includes('FROM vdcs')) return { id: 'v1', tenant_id: 't1', slug: 'prod', connection_id: 'pve1' }
          if (sql.includes('FROM tenants')) return { id: 't1', slug: 'acme' }
          return null
        },
        all: () => [],
        run: () => ({ changes: 1 }),
      }),
    })
    ;(bindings.listPveStoragesForBinding as any).mockReturnValue([
      { id: 's1', bindingId: 'b1', pveConnectionId: 'pve1', pveStorageName: 'pbs-acme-prod', managed: true, createdAt: 't' },
    ])

    await unbindFromVdc('b1')
    expect(pveStorage.deletePbsStorage).toHaveBeenCalledWith(expect.anything(), 'pbs-acme-prod')
    expect(pbsNs.deleteSubToken).toHaveBeenCalled()
    expect(bindings.deleteBinding).toHaveBeenCalledWith('b1')
    ;(sqliteMod as any).getDb = origGetDb
  })
})
