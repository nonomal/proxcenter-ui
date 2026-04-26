// Per-cluster and per-node Green-IT overrides. Every spec field is nullable
// so callers can express "inherit from the level above". Resolution at calc
// time walks node → cluster → global default.

import type Database from 'better-sqlite3'

import { getDb as realGetDb } from './sqlite'

let overrideDb: Database.Database | null = null
export function __setDbForTests(db: Database.Database | null) { overrideDb = db }
function db(): Database.Database { return overrideDb ?? realGetDb() }

export interface ConnectionGreenConfigRow {
  connectionId: string
  datacenterId: string | null
  tdpPerCoreW: number | null
  wattsPerGbRam: number | null
  overheadPerNodeW: number | null
  updatedAt: string
}

export interface NodeGreenConfigRow {
  connectionId: string
  nodeName: string
  datacenterId: string | null
  tdpPerCoreW: number | null
  wattsPerGbRam: number | null
  overheadPerNodeW: number | null
  updatedAt: string
}

export interface GreenConfigInput {
  datacenterId?: string | null
  tdpPerCoreW?: number | null
  wattsPerGbRam?: number | null
  overheadPerNodeW?: number | null
}

function rowToConnection(r: any): ConnectionGreenConfigRow {
  return {
    connectionId: r.connection_id,
    datacenterId: r.datacenter_id ?? null,
    tdpPerCoreW: r.tdp_per_core_w == null ? null : Number(r.tdp_per_core_w),
    wattsPerGbRam: r.watts_per_gb_ram == null ? null : Number(r.watts_per_gb_ram),
    overheadPerNodeW: r.overhead_per_node_w == null ? null : Number(r.overhead_per_node_w),
    updatedAt: r.updated_at,
  }
}

function rowToNode(r: any): NodeGreenConfigRow {
  return {
    connectionId: r.connection_id,
    nodeName: r.node_name,
    datacenterId: r.datacenter_id ?? null,
    tdpPerCoreW: r.tdp_per_core_w == null ? null : Number(r.tdp_per_core_w),
    wattsPerGbRam: r.watts_per_gb_ram == null ? null : Number(r.watts_per_gb_ram),
    overheadPerNodeW: r.overhead_per_node_w == null ? null : Number(r.overhead_per_node_w),
    updatedAt: r.updated_at,
  }
}

// ── connection_green_config ────────────────────────────────────────────────

export function getConnectionGreenConfig(connectionId: string): ConnectionGreenConfigRow | null {
  const r = db()
    .prepare(`SELECT * FROM connection_green_config WHERE connection_id = ?`)
    .get(connectionId) as any
  return r ? rowToConnection(r) : null
}

export function upsertConnectionGreenConfig(connectionId: string, input: GreenConfigInput): ConnectionGreenConfigRow {
  db().prepare(
    `INSERT INTO connection_green_config (
       connection_id, datacenter_id, tdp_per_core_w, watts_per_gb_ram, overhead_per_node_w, updated_at
     ) VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(connection_id) DO UPDATE SET
       datacenter_id        = excluded.datacenter_id,
       tdp_per_core_w       = excluded.tdp_per_core_w,
       watts_per_gb_ram     = excluded.watts_per_gb_ram,
       overhead_per_node_w  = excluded.overhead_per_node_w,
       updated_at           = excluded.updated_at`
  ).run(
    connectionId,
    input.datacenterId ?? null,
    input.tdpPerCoreW ?? null,
    input.wattsPerGbRam ?? null,
    input.overheadPerNodeW ?? null,
  )
  return getConnectionGreenConfig(connectionId)!
}

export function deleteConnectionGreenConfig(connectionId: string): void {
  db().prepare(`DELETE FROM connection_green_config WHERE connection_id = ?`).run(connectionId)
}

// ── node_green_config ──────────────────────────────────────────────────────

export function getNodeGreenConfig(connectionId: string, nodeName: string): NodeGreenConfigRow | null {
  const r = db()
    .prepare(`SELECT * FROM node_green_config WHERE connection_id = ? AND node_name = ?`)
    .get(connectionId, nodeName) as any
  return r ? rowToNode(r) : null
}

export function listNodeGreenConfigs(connectionId: string): NodeGreenConfigRow[] {
  const rows = db()
    .prepare(`SELECT * FROM node_green_config WHERE connection_id = ? ORDER BY node_name`)
    .all(connectionId) as any[]
  return rows.map(rowToNode)
}

export function upsertNodeGreenConfig(
  connectionId: string,
  nodeName: string,
  input: GreenConfigInput,
): NodeGreenConfigRow {
  db().prepare(
    `INSERT INTO node_green_config (
       connection_id, node_name, datacenter_id, tdp_per_core_w, watts_per_gb_ram, overhead_per_node_w, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(connection_id, node_name) DO UPDATE SET
       datacenter_id        = excluded.datacenter_id,
       tdp_per_core_w       = excluded.tdp_per_core_w,
       watts_per_gb_ram     = excluded.watts_per_gb_ram,
       overhead_per_node_w  = excluded.overhead_per_node_w,
       updated_at           = excluded.updated_at`
  ).run(
    connectionId,
    nodeName,
    input.datacenterId ?? null,
    input.tdpPerCoreW ?? null,
    input.wattsPerGbRam ?? null,
    input.overheadPerNodeW ?? null,
  )
  return getNodeGreenConfig(connectionId, nodeName)!
}

export function deleteNodeGreenConfig(connectionId: string, nodeName: string): void {
  db().prepare(`DELETE FROM node_green_config WHERE connection_id = ? AND node_name = ?`).run(connectionId, nodeName)
}

/**
 * Bulk-applies the cluster's `datacenterId` to every node, wiping per-node
 * DC overrides for that connection. Used by the "Apply DC to all nodes"
 * UX action.
 */
export function clearAllNodeDatacenterOverrides(connectionId: string): void {
  db().prepare(
    `UPDATE node_green_config SET datacenter_id = NULL, updated_at = datetime('now')
     WHERE connection_id = ?`
  ).run(connectionId)
}
