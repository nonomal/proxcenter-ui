// src/lib/vdc/vnets.ts
// Tenant-scoped VNet orchestration (DB mirror + PVE SDN operations).

import { randomUUID } from 'crypto'

import { getDb } from '@/lib/db/sqlite'
import { getConnectionById } from '@/lib/connections/getConnection'
import { prisma } from '@/lib/db/prisma'

import type { VdcVnet } from './types'
import {
  createVnetPve,
  updateVnetPve,
  deleteVnetPve,
  allocateVni,
  applySdn,
  countVnetAttachments,
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

export function listVnetsForTenant(vdcId: string): VdcVnet[] {
  const db = getDb()
  const rows = db
    .prepare('SELECT id, vdc_id, pve_name, description, vxlan_tag, firewall, created_by, created_at FROM vdc_vnets WHERE vdc_id = ? ORDER BY pve_name')
    .all(vdcId) as any[]
  return rows.map((r) => ({
    id: r.id,
    vdcId: r.vdc_id,
    pveName: r.pve_name,
    description: r.description ?? null,
    vxlanTag: r.vxlan_tag,
    firewall: !!r.firewall,
    createdBy: r.created_by ?? null,
    createdAt: r.created_at,
  }))
}

// ---------------------------------------------------------------------------
// createVnetForTenant
// ---------------------------------------------------------------------------

export interface CreateVnetInput {
  vdcId: string
  tenantId: string
  pveName: string
  description?: string
  firewall?: boolean
  createdBy: string | null
}

const VNET_NAME_REGEX = /^[a-z][a-z0-9]{0,14}$/

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

  if (!VNET_NAME_REGEX.test(input.pveName)) {
    throw new Error('Invalid VNet name (must match ^[a-z][a-z0-9]{0,14}$)')
  }

  const db = getDb()

  const existing = db.prepare('SELECT id FROM vdc_vnets WHERE vdc_id = ? AND pve_name = ?').get(vdc.id, input.pveName)
  if (existing) throw new Error(`VNet "${input.pveName}" already exists in this vDC`)

  const quota = checkVnetQuota(vdc.id)
  if (!quota.allowed) {
    throw new Error(`Quota exceeded: max_vnets=${quota.max}, current=${quota.current}`)
  }

  const tag = allocateVni(vdc.id)
  const conn = await getConn(vdc)
  const firewall = input.firewall !== false

  await createVnetPve(conn, {
    pveName: input.pveName,
    zoneName: vdc.sdnZoneName,
    tag,
    firewall,
  })

  const id = randomUUID()
  const now = new Date().toISOString()

  try {
    db.prepare(
      'INSERT INTO vdc_vnets (id, vdc_id, pve_name, description, vxlan_tag, firewall, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(id, vdc.id, input.pveName, input.description ?? null, tag, firewall ? 1 : 0, input.createdBy, now)
  } catch (err: any) {
    try { await deleteVnetPve(conn, input.pveName) } catch {}
    throw new Error(`Failed to persist VNet: ${err?.message}`)
  }

  try { await applySdn(conn) } catch (err: any) {
    console.warn(`[vdc-vnets] applySdn failed after create: ${err?.message}`)
  }

  return {
    id,
    vdcId: vdc.id,
    pveName: input.pveName,
    description: input.description ?? null,
    vxlanTag: tag,
    firewall,
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
  pveName: string,
  patch: { description?: string; firewall?: boolean }
): Promise<VdcVnet> {
  const vdc = resolveVdcForVnet(vdcId, tenantId)
  if (!vdc) throw new Error('vDC not found')

  const db = getDb()
  const row = db
    .prepare('SELECT id FROM vdc_vnets WHERE vdc_id = ? AND pve_name = ?')
    .get(vdc.id, pveName) as any
  if (!row) throw new Error(`VNet "${pveName}" not found`)

  if (patch.firewall !== undefined) {
    const conn = await getConn(vdc)
    await updateVnetPve(conn, pveName, { firewall: patch.firewall })
    try { await applySdn(conn) } catch (err: any) {
      console.warn(`[vdc-vnets] applySdn failed after update: ${err?.message}`)
    }
  }

  db.prepare(
    `UPDATE vdc_vnets SET
       description = CASE WHEN ? IS NULL THEN description ELSE ? END,
       firewall = CASE WHEN ? IS NULL THEN firewall ELSE ? END
     WHERE id = ?`
  ).run(
    patch.description === undefined ? null : patch.description,
    patch.description === undefined ? null : patch.description,
    patch.firewall === undefined ? null : (patch.firewall ? 1 : 0),
    patch.firewall === undefined ? null : (patch.firewall ? 1 : 0),
    row.id
  )

  const updated = db.prepare(
    'SELECT id, vdc_id, pve_name, description, vxlan_tag, firewall, created_by, created_at FROM vdc_vnets WHERE id = ?'
  ).get(row.id) as any
  return {
    id: updated.id,
    vdcId: updated.vdc_id,
    pveName: updated.pve_name,
    description: updated.description ?? null,
    vxlanTag: updated.vxlan_tag,
    firewall: !!updated.firewall,
    createdBy: updated.created_by ?? null,
    createdAt: updated.created_at,
  }
}

// ---------------------------------------------------------------------------
// deleteVnetForTenant
// ---------------------------------------------------------------------------

export async function deleteVnetForTenant(
  vdcId: string,
  tenantId: string,
  pveName: string
): Promise<{ deleted: true } | { deleted: false; attachmentCount: number }> {
  const vdc = resolveVdcForVnet(vdcId, tenantId)
  if (!vdc) throw new Error('vDC not found')

  const db = getDb()
  const row = db.prepare('SELECT id FROM vdc_vnets WHERE vdc_id = ? AND pve_name = ?').get(vdc.id, pveName) as any
  if (!row) throw new Error(`VNet "${pveName}" not found`)

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

  return { deleted: true }
}

// ---------------------------------------------------------------------------
// listSharedBridgesForTenant
// ---------------------------------------------------------------------------

export function listSharedBridgesForTenant(vdcId: string, tenantId: string): Array<{ bridge: string; label: string | null }> {
  const db = getDb()
  const vdc = db
    .prepare('SELECT id FROM vdcs WHERE id = ? AND tenant_id = ?')
    .get(vdcId, tenantId) as any
  if (!vdc) return []
  const rows = db
    .prepare('SELECT bridge, label FROM vdc_shared_bridges WHERE vdc_id = ? ORDER BY bridge')
    .all(vdcId) as any[]
  return rows.map((r) => ({ bridge: r.bridge, label: r.label ?? null }))
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
