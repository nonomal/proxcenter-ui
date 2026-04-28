// src/lib/vdc/vnets.ts
// Tenant-scoped VNet orchestration (DB mirror + PVE SDN operations).

import { randomUUID } from 'crypto'

import { getDb } from '@/lib/db/sqlite'
import { getConnectionById } from '@/lib/connections/getConnection'
import { prisma } from '@/lib/db/prisma'

import type { VdcVnet } from './types'
import { clearVdcScopeCache } from './scope'

import {
  createVnetPve,
  updateVnetPve,
  setVnetFirewallEnabled,
  deleteVnetPve,
  allocateVni,
  applySdn,
  countVnetAttachments,
  generatePveVnetId,
} from './sdn'

// ---------------------------------------------------------------------------
// resolveVdcForVnet
// ---------------------------------------------------------------------------

interface ResolvedVdc {
  id: string
  tenantId: string
  connectionId: string
  sdnZoneName: string
}

function resolveVdcForVnetImpl(db: any, vdcId: string, tenantId: string): ResolvedVdc | null {
  const row = db
    .prepare(
      `SELECT id, tenant_id, connection_id, sdn_zone_name, enabled
       FROM vdcs WHERE id = ? AND tenant_id = ?`
    )
    .get(vdcId, tenantId) as any
  if (!row) return null
  if (!row.enabled) return null
  if (!row.sdn_zone_name) return null
  return {
    id: row.id,
    tenantId: row.tenant_id,
    connectionId: row.connection_id,
    sdnZoneName: row.sdn_zone_name,
  }
}

/** @internal exported only for testing */
export function resolveVdcForVnetForTesting(db: any, vdcId: string, tenantId: string): ResolvedVdc | null {
  return resolveVdcForVnetImpl(db, vdcId, tenantId)
}

export function resolveVdcForVnet(vdcId: string, tenantId: string): ResolvedVdc | null {
  return resolveVdcForVnetImpl(getDb(), vdcId, tenantId)
}

// ---------------------------------------------------------------------------
// checkVnetQuota
// ---------------------------------------------------------------------------

export interface VnetQuotaResult {
  allowed: boolean
  current: number
  max: number | null
}

function checkVnetQuotaImpl(db: any, vdcId: string): VnetQuotaResult {
  const quotaRow = db.prepare('SELECT max_vnets FROM vdc_quotas WHERE vdc_id = ?').get(vdcId) as any
  const max: number | null = quotaRow?.max_vnets ?? null
  const countRow = db.prepare('SELECT COUNT(*) AS n FROM vdc_vnets WHERE vdc_id = ?').get(vdcId) as any
  const current: number = countRow?.n ?? 0
  if (max === null) return { allowed: true, current, max: null }
  return { allowed: current < max, current, max }
}

/** @internal exported only for testing */
export function checkVnetQuotaForTesting(db: any, vdcId: string): VnetQuotaResult {
  return checkVnetQuotaImpl(db, vdcId)
}

export function checkVnetQuota(vdcId: string): VnetQuotaResult {
  return checkVnetQuotaImpl(getDb(), vdcId)
}

// ---------------------------------------------------------------------------
// listVnetsForTenant
// ---------------------------------------------------------------------------

function rowToVnet(r: any): VdcVnet {
  return {
    id: r.id,
    vdcId: r.vdc_id,
    pveName: r.pve_name,
    displayName: r.display_name ?? r.pve_name,
    description: r.description ?? null,
    vxlanTag: r.vxlan_tag,
    firewall: !!r.firewall,
    isolatePorts: !!r.isolate_ports,
    vlanAware: !!r.vlan_aware,
    createdBy: r.created_by ?? null,
    createdAt: r.created_at,
  }
}

const VNET_SELECT_COLS = 'id, vdc_id, pve_name, display_name, description, vxlan_tag, firewall, isolate_ports, vlan_aware, created_by, created_at'

export function listVnetsForTenant(vdcId: string): VdcVnet[] {
  const db = getDb()
  const rows = db
    .prepare(`SELECT ${VNET_SELECT_COLS} FROM vdc_vnets WHERE vdc_id = ? ORDER BY display_name`)
    .all(vdcId) as any[]
  return rows.map(rowToVnet)
}

/** Resolve a user-facing display name (scoped to a vDC) to its row. */
function findVnetByDisplayName(db: any, vdcId: string, displayName: string): any {
  return db
    .prepare(`SELECT ${VNET_SELECT_COLS} FROM vdc_vnets WHERE vdc_id = ? AND display_name = ? LIMIT 1`)
    .get(vdcId, displayName)
}

// ---------------------------------------------------------------------------
// createVnetForTenant
// ---------------------------------------------------------------------------

export interface CreateVnetInput {
  vdcId: string
  tenantId: string
  /** Free-form, tenant-facing name; unique per vDC. We hash this into the
   *  8-char pve_name actually sent to PVE so two tenants can both use "lan". */
  displayName: string
  description?: string
  firewall?: boolean
  isolatePorts?: boolean
  vlanAware?: boolean
  createdBy: string | null
}

// Display name is what tenants type — kept scoped to their vDC, free of PVE's
// 8-char + cluster-wide constraints. Up to 20 lowercase alphanumeric chars,
// optionally separated by single dashes; must start with a letter.
const VNET_DISPLAY_NAME_REGEX = /^[a-z][a-z0-9-]{0,19}$/

async function getConn(vdc: ResolvedVdc): Promise<any> {
  const connMeta = await prisma.connection.findUnique({
    where: { id: vdc.connectionId },
    select: { tenantId: true },
  })
  if (!connMeta) throw new Error(`Connection not found: ${vdc.connectionId}`)
  return getConnectionById(vdc.connectionId, connMeta.tenantId)
}

export async function createVnetForTenant(input: CreateVnetInput): Promise<VdcVnet> {
  const vdc = resolveVdcForVnet(input.vdcId, input.tenantId)
  if (!vdc) throw new Error('vDC not found')

  const displayName = input.displayName
  if (!VNET_DISPLAY_NAME_REGEX.test(displayName)) {
    throw new Error('Invalid VNet name (1-20 chars, lowercase letters / digits / dashes, must start with a letter)')
  }

  const db = getDb()

  // Display name uniqueness is scoped to the vDC — two tenants can both
  // legitimately have a "lan". The unique index on (vdc_id, display_name)
  // also enforces this at the DB level.
  if (findVnetByDisplayName(db, vdc.id, displayName)) {
    throw new Error(`VNet "${displayName}" already exists in this vDC`)
  }

  const quota = checkVnetQuota(vdc.id)
  if (!quota.allowed) {
    throw new Error(`Quota exceeded: max_vnets=${quota.max}, current=${quota.current}`)
  }

  const pveName = generatePveVnetId(vdc.id, displayName)
  const tag = allocateVni(vdc.id)
  const conn = await getConn(vdc)
  const firewall = input.firewall !== false
  const isolatePorts = input.isolatePorts === true
  const vlanAware = input.vlanAware === true

  await createVnetPve(conn, {
    pveName,
    zoneName: vdc.sdnZoneName,
    tag,
    alias: displayName,
    isolatePorts,
    vlanAware,
  })

  const id = randomUUID()
  const now = new Date().toISOString()

  try {
    db.prepare(
      'INSERT INTO vdc_vnets (id, vdc_id, pve_name, display_name, description, vxlan_tag, firewall, isolate_ports, vlan_aware, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(id, vdc.id, pveName, displayName, input.description ?? null, tag, firewall ? 1 : 0, isolatePorts ? 1 : 0, vlanAware ? 1 : 0, input.createdBy, now)
  } catch (err: any) {
    try { await deleteVnetPve(conn, pveName) } catch {}
    throw new Error(`Failed to persist VNet: ${err?.message}`)
  }

  // applySdn MUST run before the firewall options endpoint: fresh VNets are
  // in a "pending" state until applied, and PVE's firewall subsystem refuses
  // to attach options to a VNet it doesn't see yet (500 "invalid vnet").
  try { await applySdn(conn) } catch (err: any) {
    console.warn(`[vdc-vnets] applySdn failed after create: ${err?.message}`)
  }

  // Firewall default on a fresh VNet is "disabled" — only POST when the user
  // asked for it enabled. If this fails we roll back both DB and PVE so the
  // system state stays consistent.
  if (firewall) {
    try {
      await setVnetFirewallEnabled(conn, pveName, true)
    } catch (err: any) {
      db.prepare('DELETE FROM vdc_vnets WHERE id = ?').run(id)
      try { await deleteVnetPve(conn, pveName) } catch {}
      try { await applySdn(conn) } catch {}
      throw err
    }
  }

  // Invalidate the tenant scope cache so the next network-choices /
  // VM-create flow sees the new VNet instead of stale 60s-cached data.
  clearVdcScopeCache(vdc.tenantId)

  return {
    id,
    vdcId: vdc.id,
    pveName,
    displayName,
    description: input.description ?? null,
    vxlanTag: tag,
    firewall,
    isolatePorts,
    vlanAware,
    createdBy: input.createdBy,
    createdAt: now,
  }
}

// ---------------------------------------------------------------------------
// updateVnetForTenant
// ---------------------------------------------------------------------------

export async function updateVnetForTenant(
  vdcId: string,
  tenantId: string,
  displayName: string,
  patch: { description?: string; firewall?: boolean; isolatePorts?: boolean; vlanAware?: boolean }
): Promise<VdcVnet> {
  const vdc = resolveVdcForVnet(vdcId, tenantId)
  if (!vdc) throw new Error('vDC not found')

  const db = getDb()
  const row = findVnetByDisplayName(db, vdc.id, displayName)
  if (!row) throw new Error(`VNet "${displayName}" not found`)

  const pveName: string = row.pve_name
  const conn = await getConn(vdc)

  // Push isolate-ports / vlanaware to PVE first — these are part of the VNet
  // schema (PUT /cluster/sdn/vnets/{id}). Firewall is its own subresource.
  if (patch.isolatePorts !== undefined || patch.vlanAware !== undefined) {
    await updateVnetPve(conn, pveName, {
      isolatePorts: patch.isolatePorts,
      vlanAware: patch.vlanAware,
    })
  }

  if (patch.firewall !== undefined) {
    await setVnetFirewallEnabled(conn, pveName, patch.firewall)
  }

  if (patch.isolatePorts !== undefined || patch.vlanAware !== undefined || patch.firewall !== undefined) {
    try { await applySdn(conn) } catch (err: any) {
      console.warn(`[vdc-vnets] applySdn failed after update: ${err?.message}`)
    }
  }

  db.prepare(
    `UPDATE vdc_vnets SET
       description    = CASE WHEN ? IS NULL THEN description ELSE ? END,
       firewall       = CASE WHEN ? IS NULL THEN firewall ELSE ? END,
       isolate_ports  = CASE WHEN ? IS NULL THEN isolate_ports ELSE ? END,
       vlan_aware     = CASE WHEN ? IS NULL THEN vlan_aware ELSE ? END
     WHERE id = ?`
  ).run(
    patch.description === undefined ? null : patch.description,
    patch.description === undefined ? null : patch.description,
    patch.firewall === undefined ? null : (patch.firewall ? 1 : 0),
    patch.firewall === undefined ? null : (patch.firewall ? 1 : 0),
    patch.isolatePorts === undefined ? null : (patch.isolatePorts ? 1 : 0),
    patch.isolatePorts === undefined ? null : (patch.isolatePorts ? 1 : 0),
    patch.vlanAware === undefined ? null : (patch.vlanAware ? 1 : 0),
    patch.vlanAware === undefined ? null : (patch.vlanAware ? 1 : 0),
    row.id
  )

  const updated = db.prepare(`SELECT ${VNET_SELECT_COLS} FROM vdc_vnets WHERE id = ?`).get(row.id)
  return rowToVnet(updated)
}

// ---------------------------------------------------------------------------
// deleteVnetForTenant
// ---------------------------------------------------------------------------

export async function deleteVnetForTenant(
  vdcId: string,
  tenantId: string,
  displayName: string
): Promise<{ deleted: true } | { deleted: false; attachmentCount: number }> {
  const vdc = resolveVdcForVnet(vdcId, tenantId)
  if (!vdc) throw new Error('vDC not found')

  const db = getDb()
  const row = findVnetByDisplayName(db, vdc.id, displayName)
  if (!row) throw new Error(`VNet "${displayName}" not found`)

  const pveName: string = row.pve_name

  const conn = await getConn(vdc)
  const attachments = await countVnetAttachments(conn, pveName)
  if (attachments > 0) {
    return { deleted: false, attachmentCount: attachments }
  }

  await deleteVnetPve(conn, pveName)

  db.prepare('DELETE FROM vdc_vnets WHERE id = ?').run(row.id)

  try { await applySdn(conn) } catch (err: any) {
    console.warn(`[vdc-vnets] applySdn failed after delete: ${err?.message}`)
  }

  clearVdcScopeCache(vdc.tenantId)

  return { deleted: true }
}

// ---------------------------------------------------------------------------
// Bridge whitelist helpers (used by guest route enforcement in Task 4)
// ---------------------------------------------------------------------------

/**
 * Returns the set of bridge names a tenant is allowed to attach to on a given connection.
 * Returns null if no restrictions apply (tenant without vDCs on this connection).
 */
export function getAllowedBridgesForTenant(tenantId: string, connectionId: string): Set<string> | null {
  const db = getDb()
  const vdcRows = db
    .prepare('SELECT id FROM vdcs WHERE tenant_id = ? AND connection_id = ? AND enabled = 1')
    .all(tenantId, connectionId) as Array<{ id: string }>
  if (vdcRows.length === 0) return null

  const allowed = new Set<string>()
  const stmtVnets = db.prepare('SELECT pve_name FROM vdc_vnets WHERE vdc_id = ?')
  const stmtShared = db.prepare('SELECT bridge FROM vdc_shared_bridges WHERE vdc_id = ?')
  for (const vdc of vdcRows) {
    for (const v of stmtVnets.all(vdc.id) as Array<{ pve_name: string }>) allowed.add(v.pve_name)
    for (const b of stmtShared.all(vdc.id) as Array<{ bridge: string }>) allowed.add(b.bridge)
  }
  return allowed
}

/** Parse bridge= from a PVE net config string */
export function parseBridgeFromNet(netStr: string): string | null {
  const m = String(netStr || '').match(/bridge=([^,]+)/)
  return m ? m[1] : null
}
