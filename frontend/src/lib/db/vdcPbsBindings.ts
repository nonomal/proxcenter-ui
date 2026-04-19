import { randomUUID } from 'crypto'
import type Database from 'better-sqlite3'

import { getDb as realGetDb } from './sqlite'

let overrideDb: Database.Database | null = null
export function __setDbForTests(db: Database.Database | null) { overrideDb = db }
function db(): Database.Database { return overrideDb ?? realGetDb() }

export type PbsBindingMode = 'auto' | 'manual'

export interface PbsBindingRow {
  id: string
  vdcId: string
  pbsConnectionId: string
  datastore: string
  namespace: string
  mode: PbsBindingMode
  pbsTokenId: string | null
  pbsTokenSecret: string | null
  createdAt: string
}

export interface PvePbsStorageRow {
  id: string
  bindingId: string
  pveConnectionId: string
  pveStorageName: string
  managed: boolean
  createdAt: string
}

function rowToBinding(r: any): PbsBindingRow {
  return {
    id: r.id,
    vdcId: r.vdc_id,
    pbsConnectionId: r.pbs_connection_id,
    datastore: r.datastore,
    namespace: r.namespace,
    mode: (r.mode ?? 'auto') as PbsBindingMode,
    pbsTokenId: r.pbs_token_id ?? null,
    pbsTokenSecret: r.pbs_token_secret ?? null,
    createdAt: r.created_at,
  }
}

function rowToStorage(r: any): PvePbsStorageRow {
  return {
    id: r.id,
    bindingId: r.vdc_pbs_namespace_id,
    pveConnectionId: r.pve_connection_id,
    pveStorageName: r.pve_storage_name,
    managed: !!r.managed,
    createdAt: r.created_at,
  }
}

export function insertBinding(args: {
  vdcId: string; pbsConnectionId: string; datastore: string; namespace: string;
  mode: PbsBindingMode;
  pbsTokenId?: string | null; pbsTokenSecret?: string | null;
}): PbsBindingRow {
  const id = randomUUID()
  db().prepare(
    `INSERT INTO vdc_pbs_namespaces (id, vdc_id, pbs_connection_id, datastore, namespace, mode, pbs_token_id, pbs_token_secret)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    args.vdcId, args.pbsConnectionId, args.datastore, args.namespace,
    args.mode,
    args.pbsTokenId ?? null, args.pbsTokenSecret ?? null,
  )
  return rowToBinding(db().prepare(`SELECT * FROM vdc_pbs_namespaces WHERE id = ?`).get(id))
}

export function findBindingByTuple(pbsConnectionId: string, datastore: string, namespace: string): PbsBindingRow | null {
  const r = db().prepare(
    `SELECT * FROM vdc_pbs_namespaces WHERE pbs_connection_id = ? AND datastore = ? AND namespace = ?`
  ).get(pbsConnectionId, datastore, namespace) as any
  return r ? rowToBinding(r) : null
}

export function listBindingsForVdc(vdcId: string): PbsBindingRow[] {
  return (db().prepare(
    `SELECT * FROM vdc_pbs_namespaces WHERE vdc_id = ? ORDER BY created_at`
  ).all(vdcId) as any[]).map(rowToBinding)
}

export function listBindingsForTenant(tenantId: string): PbsBindingRow[] {
  return (db().prepare(
    `SELECT b.* FROM vdc_pbs_namespaces b
     JOIN vdcs v ON v.id = b.vdc_id
     WHERE v.tenant_id = ? AND v.enabled = 1`
  ).all(tenantId) as any[]).map(rowToBinding)
}

export function deleteBinding(id: string): void {
  db().prepare(`DELETE FROM vdc_pbs_namespaces WHERE id = ?`).run(id)
}

export function insertPveStorage(args: {
  bindingId: string; pveConnectionId: string; pveStorageName: string;
  managed?: boolean;
}): PvePbsStorageRow {
  const id = randomUUID()
  db().prepare(
    `INSERT INTO vdc_pbs_pve_storages (id, vdc_pbs_namespace_id, pve_connection_id, pve_storage_name, managed)
     VALUES (?, ?, ?, ?, ?)`
  ).run(
    id, args.bindingId, args.pveConnectionId, args.pveStorageName,
    (args.managed ?? true) ? 1 : 0,
  )
  return rowToStorage(db().prepare(`SELECT * FROM vdc_pbs_pve_storages WHERE id = ?`).get(id))
}

export function listPveStoragesForBinding(bindingId: string): PvePbsStorageRow[] {
  return (db().prepare(
    `SELECT * FROM vdc_pbs_pve_storages WHERE vdc_pbs_namespace_id = ? ORDER BY created_at`
  ).all(bindingId) as any[]).map(rowToStorage)
}

export function deletePveStorage(id: string): void {
  db().prepare(`DELETE FROM vdc_pbs_pve_storages WHERE id = ?`).run(id)
}
