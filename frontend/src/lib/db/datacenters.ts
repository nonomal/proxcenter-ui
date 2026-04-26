// Datacenter catalogue — provider-managed list of physical sites with
// their own PUE / electricity / CO₂ characteristics.
//
// All access is currently provider-only. The `tenant_id` column is kept on
// the row for forward-compat (per-tenant catalogues someday) and queries
// default to 'default'.

import { randomUUID } from 'crypto'
import type Database from 'better-sqlite3'

import { getDb as realGetDb } from './sqlite'
import { DEFAULT_TENANT_ID } from '@/lib/tenant'

let overrideDb: Database.Database | null = null
export function __setDbForTests(db: Database.Database | null) { overrideDb = db }
function db(): Database.Database { return overrideDb ?? realGetDb() }

export interface DatacenterRow {
  id: string
  tenantId: string
  name: string
  locationLabel: string | null
  country: string | null
  latitude: number | null
  longitude: number | null
  pue: number
  electricityPrice: number
  currency: string
  co2Factor: number
  co2CountryPreset: string | null
  tdpPerCoreW: number
  wattsPerGbRam: number
  overheadPerNodeW: number
  comment: string | null
  isDefault: boolean
  createdAt: string
  updatedAt: string
  /** Populated by listDatacenters() — counts of clusters/nodes anchored here. */
  clusterCount?: number
  nodeCount?: number
}

export interface DatacenterInput {
  name: string
  locationLabel?: string | null
  country?: string | null
  latitude?: number | null
  longitude?: number | null
  pue: number
  electricityPrice: number
  currency: string
  co2Factor: number
  co2CountryPreset?: string | null
  tdpPerCoreW?: number
  wattsPerGbRam?: number
  overheadPerNodeW?: number
  comment?: string | null
  isDefault?: boolean
}

function rowToDatacenter(r: any): DatacenterRow {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    name: r.name,
    locationLabel: r.location_label ?? null,
    country: r.country ?? null,
    latitude: r.latitude ?? null,
    longitude: r.longitude ?? null,
    pue: Number(r.pue),
    electricityPrice: Number(r.electricity_price),
    currency: r.currency,
    co2Factor: Number(r.co2_factor),
    co2CountryPreset: r.co2_country_preset ?? null,
    tdpPerCoreW: Number(r.tdp_per_core_w ?? 10),
    wattsPerGbRam: Number(r.watts_per_gb_ram ?? 0.375),
    overheadPerNodeW: Number(r.overhead_per_node_w ?? 50),
    comment: r.comment ?? null,
    isDefault: !!r.is_default,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    clusterCount: r.cluster_count != null ? Number(r.cluster_count) : undefined,
    nodeCount: r.node_count != null ? Number(r.node_count) : undefined,
  }
}

export function listDatacenters(tenantId: string = DEFAULT_TENANT_ID): DatacenterRow[] {
  // Counts are pulled with correlated subqueries so each row carries its
  // own clusterCount/nodeCount. The UI shows them as a small "Resources"
  // badge so orphan DCs are visible at a glance.
  const rows = db().prepare(
    `SELECT d.*,
            (SELECT COUNT(*) FROM connection_green_config c WHERE c.datacenter_id = d.id) AS cluster_count,
            (SELECT COUNT(*) FROM node_green_config n WHERE n.datacenter_id = d.id) AS node_count
     FROM datacenters d
     WHERE d.tenant_id = ?
     ORDER BY d.is_default DESC, d.name`
  ).all(tenantId) as any[]
  return rows.map(rowToDatacenter)
}

export function getDatacenterById(id: string): DatacenterRow | null {
  const r = db().prepare(`SELECT * FROM datacenters WHERE id = ?`).get(id) as any
  return r ? rowToDatacenter(r) : null
}

export function getDefaultDatacenter(tenantId: string = DEFAULT_TENANT_ID): DatacenterRow | null {
  const r = db()
    .prepare(`SELECT * FROM datacenters WHERE tenant_id = ? AND is_default = 1 LIMIT 1`)
    .get(tenantId) as any
  return r ? rowToDatacenter(r) : null
}

export function insertDatacenter(input: DatacenterInput, tenantId: string = DEFAULT_TENANT_ID): DatacenterRow {
  const id = randomUUID()
  const tx = db().transaction(() => {
    if (input.isDefault) {
      // Demote any existing default for this tenant.
      db().prepare(`UPDATE datacenters SET is_default = 0 WHERE tenant_id = ? AND is_default = 1`).run(tenantId)
    }
    db().prepare(
      `INSERT INTO datacenters (
         id, tenant_id, name, location_label, country, latitude, longitude,
         pue, electricity_price, currency, co2_factor, co2_country_preset,
         tdp_per_core_w, watts_per_gb_ram, overhead_per_node_w, comment,
         is_default
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      tenantId,
      input.name,
      input.locationLabel ?? null,
      input.country ?? null,
      input.latitude ?? null,
      input.longitude ?? null,
      input.pue,
      input.electricityPrice,
      input.currency,
      input.co2Factor,
      input.co2CountryPreset ?? null,
      input.tdpPerCoreW ?? 10,
      input.wattsPerGbRam ?? 0.375,
      input.overheadPerNodeW ?? 50,
      input.comment ?? null,
      input.isDefault ? 1 : 0,
    )
  })
  tx()
  return getDatacenterById(id)!
}

export function updateDatacenter(id: string, input: Partial<DatacenterInput>): DatacenterRow {
  const existing = getDatacenterById(id)
  if (!existing) throw new Error(`Datacenter not found: ${id}`)

  const tx = db().transaction(() => {
    if (input.isDefault === true && !existing.isDefault) {
      db().prepare(`UPDATE datacenters SET is_default = 0 WHERE tenant_id = ? AND is_default = 1`).run(existing.tenantId)
    }
    if (input.isDefault === false && existing.isDefault) {
      // Refuse to demote the only default — keep at least one.
      const others = db()
        .prepare(`SELECT COUNT(*) as c FROM datacenters WHERE tenant_id = ? AND is_default = 1 AND id != ?`)
        .get(existing.tenantId, id) as { c: number }
      if (others.c === 0) {
        throw new Error('Cannot demote the only default datacenter; promote another first.')
      }
    }

    const fields: string[] = []
    const values: any[] = []
    const set = (col: string, val: any) => { fields.push(`${col} = ?`); values.push(val) }

    if (input.name !== undefined) set('name', input.name)
    if (input.locationLabel !== undefined) set('location_label', input.locationLabel ?? null)
    if (input.country !== undefined) set('country', input.country ?? null)
    if (input.latitude !== undefined) set('latitude', input.latitude ?? null)
    if (input.longitude !== undefined) set('longitude', input.longitude ?? null)
    if (input.pue !== undefined) set('pue', input.pue)
    if (input.electricityPrice !== undefined) set('electricity_price', input.electricityPrice)
    if (input.currency !== undefined) set('currency', input.currency)
    if (input.co2Factor !== undefined) set('co2_factor', input.co2Factor)
    if (input.co2CountryPreset !== undefined) set('co2_country_preset', input.co2CountryPreset ?? null)
    if (input.tdpPerCoreW !== undefined) set('tdp_per_core_w', input.tdpPerCoreW)
    if (input.wattsPerGbRam !== undefined) set('watts_per_gb_ram', input.wattsPerGbRam)
    if (input.overheadPerNodeW !== undefined) set('overhead_per_node_w', input.overheadPerNodeW)
    if (input.comment !== undefined) set('comment', input.comment ?? null)
    if (input.isDefault !== undefined) set('is_default', input.isDefault ? 1 : 0)
    set('updated_at', new Date().toISOString())

    if (fields.length === 1) return // only updated_at, nothing else
    values.push(id)
    db().prepare(`UPDATE datacenters SET ${fields.join(', ')} WHERE id = ?`).run(...values)
  })
  tx()
  return getDatacenterById(id)!
}

export function deleteDatacenter(id: string): void {
  const existing = getDatacenterById(id)
  if (!existing) return

  // Don't delete a row still referenced by cluster/node configs — caller should
  // reassign first. We block at the DB layer with a clear error rather than
  // letting ON DELETE SET NULL silently break the resolution chain.
  const refs = db().prepare(
    `SELECT
       (SELECT COUNT(*) FROM connection_green_config WHERE datacenter_id = ?) +
       (SELECT COUNT(*) FROM node_green_config WHERE datacenter_id = ?) AS c`
  ).get(id, id) as { c: number }
  if (refs.c > 0) {
    throw new Error(`Datacenter is referenced by ${refs.c} cluster/node config(s); reassign them first.`)
  }

  if (existing.isDefault) {
    const others = db()
      .prepare(`SELECT COUNT(*) as c FROM datacenters WHERE tenant_id = ? AND id != ?`)
      .get(existing.tenantId, id) as { c: number }
    if (others.c > 0) {
      throw new Error('Cannot delete the default datacenter while others exist; promote another first.')
    }
  }

  db().prepare(`DELETE FROM datacenters WHERE id = ?`).run(id)
}

/**
 * Ensures at least one datacenter exists for the provider. Called lazily
 * from green-IT endpoints. If none exists and a legacy `settings.green` row
 * is present, seed the new "Default" DC from those values; otherwise create
 * one with safe defaults.
 */
export function ensureDefaultDatacenter(tenantId: string = DEFAULT_TENANT_ID): DatacenterRow {
  const existing = getDefaultDatacenter(tenantId)
  if (existing) return existing

  let pue = 1.4
  let electricityPrice = 0.18
  let currency = 'EUR'
  let co2Factor = 0.052
  let co2CountryPreset: string | null = null
  let tdpPerCoreW = 10
  let wattsPerGbRam = 0.375
  let overheadPerNodeW = 50

  try {
    const row = db()
      .prepare(`SELECT value FROM settings WHERE key = 'green' AND tenant_id = ?`)
      .get(tenantId) as any
    if (row?.value) {
      const parsed = JSON.parse(row.value)
      if (typeof parsed.pue === 'number') pue = parsed.pue
      if (typeof parsed.electricityPrice === 'number') electricityPrice = parsed.electricityPrice
      if (typeof parsed.currency === 'string') currency = parsed.currency
      if (typeof parsed.co2Factor === 'number') co2Factor = parsed.co2Factor
      if (typeof parsed.co2Country === 'string') co2CountryPreset = parsed.co2Country
      const specs = parsed.serverSpecs ?? {}
      if (typeof specs.tdpPerCore === 'number') tdpPerCoreW = specs.tdpPerCore
      if (typeof specs.wattsPerGbRam === 'number') wattsPerGbRam = specs.wattsPerGbRam
      if (typeof specs.overheadPerServer === 'number') overheadPerNodeW = specs.overheadPerServer
    }
  } catch {
    // No legacy row — fall through to defaults.
  }

  return insertDatacenter({
    name: 'Default',
    pue,
    electricityPrice,
    currency,
    co2Factor,
    co2CountryPreset,
    tdpPerCoreW,
    wattsPerGbRam,
    overheadPerNodeW,
    isDefault: true,
  }, tenantId)
}
