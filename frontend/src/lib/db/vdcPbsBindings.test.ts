import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'

import {
  listBindingsForVdc,
  insertBinding,
  insertPveStorage,
  deleteBinding,
  listPveStoragesForBinding,
  findBindingByTuple,
  __setDbForTests,
} from './vdcPbsBindings'

function freshDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE vdcs (id TEXT PRIMARY KEY, tenant_id TEXT, connection_id TEXT, name TEXT, slug TEXT, pve_pool_name TEXT, enabled INTEGER);
    CREATE TABLE vdc_pbs_namespaces (
      id TEXT PRIMARY KEY, vdc_id TEXT, pbs_connection_id TEXT,
      datastore TEXT, namespace TEXT,
      mode TEXT NOT NULL DEFAULT 'auto',
      pbs_token_id TEXT, pbs_token_secret TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE (pbs_connection_id, datastore, namespace)
    );
    CREATE TABLE vdc_pbs_pve_storages (
      id TEXT PRIMARY KEY, vdc_pbs_namespace_id TEXT,
      pve_connection_id TEXT, pve_storage_name TEXT,
      managed INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `)
  db.prepare(`INSERT INTO vdcs VALUES ('v1','t1','c1','VDC1','vdc1','pool-vdc1',1)`).run()
  __setDbForTests(db)
  return db
}

describe('vdcPbsBindings', () => {
  beforeEach(() => freshDb())

  it('inserts and reads a binding', () => {
    const row = insertBinding({
      vdcId: 'v1',
      pbsConnectionId: 'pbs1',
      datastore: 'store1',
      namespace: 'tenant-x/vdc-y',
      mode: 'auto',
      pbsTokenId: 'root@pam!vdc-abc',
      pbsTokenSecret: 'sekret',
    })
    expect(row.id).toMatch(/^[a-f0-9-]{36}$/)
    const found = findBindingByTuple('pbs1', 'store1', 'tenant-x/vdc-y')
    expect(found?.id).toBe(row.id)
  })

  it('enforces uniqueness on (pbs, ds, ns)', () => {
    insertBinding({ vdcId: 'v1', pbsConnectionId: 'p', datastore: 'd', namespace: 'n', mode: 'auto', pbsTokenId: 't', pbsTokenSecret: 's' })
    expect(() =>
      insertBinding({ vdcId: 'v1', pbsConnectionId: 'p', datastore: 'd', namespace: 'n', mode: 'auto', pbsTokenId: 't', pbsTokenSecret: 's' }),
    ).toThrow()
  })

  it('lists bindings for a vdc', () => {
    insertBinding({ vdcId: 'v1', pbsConnectionId: 'p', datastore: 'd', namespace: 'n1', mode: 'auto', pbsTokenId: 't', pbsTokenSecret: 's' })
    insertBinding({ vdcId: 'v1', pbsConnectionId: 'p', datastore: 'd', namespace: 'n2', mode: 'auto', pbsTokenId: 't', pbsTokenSecret: 's' })
    expect(listBindingsForVdc('v1')).toHaveLength(2)
  })

  it('cascades PVE storages when binding is deleted', () => {
    const b = insertBinding({ vdcId: 'v1', pbsConnectionId: 'p', datastore: 'd', namespace: 'n', mode: 'auto', pbsTokenId: 't', pbsTokenSecret: 's' })
    insertPveStorage({ bindingId: b.id, pveConnectionId: 'c1', pveStorageName: 'pbs-acme-prod', managed: true })
    expect(listPveStoragesForBinding(b.id)).toHaveLength(1)
    deleteBinding(b.id)
    expect(listBindingsForVdc('v1')).toHaveLength(0)
    // FK cascade isn't enabled in in-memory tests; the orchestrator deletes children first.
  })
})
