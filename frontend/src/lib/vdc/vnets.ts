// src/lib/vdc/vnets.ts
// Tenant-scoped VNet orchestration (DB mirror + PVE SDN operations).

import { randomUUID } from 'crypto'

import { getDb } from '@/lib/db/sqlite'
import { getConnectionById } from '@/lib/connections/getConnection'
import { prisma } from '@/lib/db/prisma'

import type { VdcVnet, VdcSubnet } from './types'
import { clearVdcScopeCache } from './scope'
import {
  parseCidr,
  gatewayValidForCidr,
} from './network'

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

function rowToSubnet(r: any): VdcSubnet | null {
  if (!r || !r.id) return null
  const dnsRaw: string | null = r.dns_servers ?? null
  const dnsServers = dnsRaw
    ? dnsRaw.split(',').map((s: string) => s.trim()).filter(Boolean)
    : []
  return {
    id: r.id,
    vnetId: r.vnet_id,
    cidr: r.cidr,
    gateway: r.gateway,
    dnsServers,
    ipamEnabled: !!r.ipam_enabled,
    createdAt: r.created_at,
  }
}

function rowToVnet(r: any, subnetRow: any): VdcVnet {
  const subnet = rowToSubnet(subnetRow)
  if (!subnet) {
    // The schema enforces a 1-1 between VNet and subnet now (subnet is
    // created in the same transaction as the VNet). A missing row means
    // legacy data we couldn't migrate or hand-corrupted state — surface
    // it loudly rather than silently returning a half-broken VNet.
    throw new Error(`VNet ${r.id} has no subnet — DB migration required`)
  }
  return {
    id: r.id,
    vdcId: r.vdc_id,
    pveName: r.pve_name,
    displayName: r.display_name ?? r.pve_name,
    description: r.description ?? null,
    vxlanTag: r.vxlan_tag,
    firewall: !!r.firewall,
    subnet,
    createdBy: r.created_by ?? null,
    createdAt: r.created_at,
  }
}

const VNET_SELECT_COLS = 'id, vdc_id, pve_name, display_name, description, vxlan_tag, firewall, created_by, created_at'
const SUBNET_SELECT_COLS = 'id, vnet_id, cidr, gateway, dns_servers, ipam_enabled, created_at'

function findSubnetByVnetId(db: any, vnetId: string): any {
  return db.prepare(`SELECT ${SUBNET_SELECT_COLS} FROM vdc_subnets WHERE vnet_id = ? LIMIT 1`).get(vnetId)
}

export function listVnetsForTenant(vdcId: string): VdcVnet[] {
  const db = getDb()
  const rows = db
    .prepare(`SELECT ${VNET_SELECT_COLS} FROM vdc_vnets WHERE vdc_id = ? ORDER BY display_name`)
    .all(vdcId) as any[]
  return rows.map(r => rowToVnet(r, findSubnetByVnetId(db, r.id)))
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
  /** L3 + IPAM config attached at create time. Mandatory: ProxCenter's IPAM
   *  is the only working IP allocator on VXLAN (PVE-native IPAM/DHCP are
   *  broken on PVE 9.x VXLAN zones), so a VNet without a subnet would have
   *  no way to assign IPs to its VMs. */
  subnet: {
    cidr: string
    gateway: string
    dnsServers?: string[]
  }
  createdBy: string | null
}

/** Validate the subnet config block. Throws on first violation with a
 *  user-readable message that survives across the API boundary unchanged. */
function validateSubnetInput(input: CreateVnetInput['subnet']): void {
  if (!parseCidr(input.cidr)) {
    throw new Error(`Invalid CIDR "${input.cidr}" — expected IPv4 form like 10.42.0.0/24`)
  }
  if (!gatewayValidForCidr(input.gateway, input.cidr)) {
    throw new Error(`Gateway "${input.gateway}" is not a usable host inside ${input.cidr}`)
  }
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

  // Subnet is mandatory — IPAM only works with a CIDR + gateway.
  validateSubnetInput(input.subnet)

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

  await createVnetPve(conn, {
    pveName,
    zoneName: vdc.sdnZoneName,
    tag,
    alias: displayName,
  })

  const id = randomUUID()
  const now = new Date().toISOString()

  try {
    db.prepare(
      'INSERT INTO vdc_vnets (id, vdc_id, pve_name, display_name, description, vxlan_tag, firewall, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(id, vdc.id, pveName, displayName, input.description ?? null, tag, firewall ? 1 : 0, input.createdBy, now)
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

  // Subnet lives only in our DB now — no PVE-side subnet (see sdn.ts comment
  // about why mirroring it had no functional value on VXLAN zones).
  const dnsList = (input.subnet.dnsServers ?? []).map(s => s.trim()).filter(Boolean)
  const subnetId = randomUUID()
  try {
    db.prepare(
      'INSERT INTO vdc_subnets (id, vnet_id, cidr, gateway, dns_servers, ipam_enabled, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)'
    ).run(
      subnetId,
      id,
      input.subnet.cidr,
      input.subnet.gateway,
      dnsList.length > 0 ? dnsList.join(',') : null,
      now,
    )
  } catch (err: any) {
    db.prepare('DELETE FROM vdc_vnets WHERE id = ?').run(id)
    try { await deleteVnetPve(conn, pveName) } catch {}
    try { await applySdn(conn) } catch {}
    throw new Error(`Failed to persist subnet: ${err?.message}`)
  }

  const subnetRow = findSubnetByVnetId(db, id)

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
    subnet: rowToSubnet(subnetRow)!,
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
  patch: {
    description?: string
    firewall?: boolean
    /** Subnet patch — only DNS is editable. CIDR/gateway changes would
     *  invalidate IPAM allocations and require a recreate. */
    subnet?: {
      dnsServers?: string[]
    }
  }
): Promise<VdcVnet> {
  const vdc = resolveVdcForVnet(vdcId, tenantId)
  if (!vdc) throw new Error('vDC not found')

  const db = getDb()
  const row = findVnetByDisplayName(db, vdc.id, displayName)
  if (!row) throw new Error(`VNet "${displayName}" not found`)

  const pveName: string = row.pve_name
  const conn = await getConn(vdc)

  if (patch.firewall !== undefined) {
    await setVnetFirewallEnabled(conn, pveName, patch.firewall)
  }

  // DNS edits are DB-only — CloudInit pushes them to VMs at create time.
  if (patch.subnet?.dnsServers !== undefined) {
    const subnetRow = findSubnetByVnetId(db, row.id) as any | null
    if (!subnetRow) {
      throw new Error(`VNet "${displayName}" has no subnet — DB migration required`)
    }
    const dnsCsv = patch.subnet.dnsServers.length > 0
      ? patch.subnet.dnsServers.map(s => s.trim()).filter(Boolean).join(',')
      : ''
    db.prepare(`UPDATE vdc_subnets SET dns_servers = ? WHERE id = ?`)
      .run(dnsCsv || null, subnetRow.id)
  }

  if (patch.firewall !== undefined) {
    try { await applySdn(conn) } catch (err: any) {
      console.warn(`[vdc-vnets] applySdn failed after update: ${err?.message}`)
    }
  }

  db.prepare(
    `UPDATE vdc_vnets SET
       description = CASE WHEN ? IS NULL THEN description ELSE ? END,
       firewall    = CASE WHEN ? IS NULL THEN firewall ELSE ? END
     WHERE id = ?`
  ).run(
    patch.description === undefined ? null : patch.description,
    patch.description === undefined ? null : patch.description,
    patch.firewall === undefined ? null : (patch.firewall ? 1 : 0),
    patch.firewall === undefined ? null : (patch.firewall ? 1 : 0),
    row.id
  )

  const updated = db.prepare(`SELECT ${VNET_SELECT_COLS} FROM vdc_vnets WHERE id = ?`).get(row.id)
  return rowToVnet(updated, findSubnetByVnetId(db, row.id))
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

  // No PVE-side subnet to drop anymore — subnet only lives in our DB and
  // is removed by the ON DELETE CASCADE below.
  await deleteVnetPve(conn, pveName)

  // ON DELETE CASCADE on vdc_subnets.vnet_id removes the subnet row.
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

// getTenantIpamBridgesForConnection used to live here. It filtered by
// session tenant, which broke the IPAM hook when a super-admin (default
// tenant) deployed into a tenant-owned vDC. Replaced by
// resolveSubnetForBridge below — same inputs minus the tenant filter,
// since tenant authorisation is enforced separately upstream.

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

// ---------------------------------------------------------------------------
// resolveSubnetForBridge — IPAM target lookup without tenant scoping
// ---------------------------------------------------------------------------

export interface SubnetForBridge {
  vdcId: string
  vnetId: string
  subnetId: string
  pveName: string
  cidr: string
  gateway: string
  dnsServers: string[]
  sdnZoneName: string
  /** PVE pool name backing the vDC. Used by the IPAM scanner to limit
   *  the search to the vDC's VMs instead of the whole cluster. */
  pvePoolName: string
}

/**
 * Find the (vDC, VNet, subnet) tuple that owns a given bridge on a given
 * PVE connection — *without* filtering by tenant. The deploy / VM-create
 * routes already enforce tenant access upstream (`resolveVdcForTenant`,
 * RBAC, vDC scope guards), so a second tenant filter here was the bug
 * that left the IPAM hook silent when a super-admin (default tenant)
 * deployed into a tenant-owned vDC.
 *
 * Returns null when:
 *   - no VNet on this connection matches the bridge name, OR
 *   - the matching VNet has no subnet (bridge-only mode)
 */
export function resolveSubnetForBridge(
  connectionId: string,
  bridgePveName: string,
): SubnetForBridge | null {
  const db = getDb()
  const row = db
    .prepare(
      `SELECT
         d.id   AS vdc_id,
         d.sdn_zone_name AS sdn_zone_name,
         d.pve_pool_name AS pve_pool_name,
         v.id   AS vnet_id,
         v.pve_name,
         s.id   AS subnet_id,
         s.cidr,
         s.gateway,
         s.dns_servers
       FROM vdc_vnets v
       JOIN vdcs d        ON d.id = v.vdc_id
       JOIN vdc_subnets s ON s.vnet_id = v.id
       WHERE d.connection_id = ?
         AND d.enabled = 1
         AND v.pve_name = ?
         AND s.ipam_enabled = 1
       LIMIT 1`,
    )
    .get(connectionId, bridgePveName) as
      | { vdc_id: string; sdn_zone_name: string; pve_pool_name: string; vnet_id: string; pve_name: string; subnet_id: string; cidr: string; gateway: string; dns_servers: string | null }
      | undefined
  if (!row) return null
  return {
    vdcId: row.vdc_id,
    vnetId: row.vnet_id,
    subnetId: row.subnet_id,
    pveName: row.pve_name,
    cidr: row.cidr,
    gateway: row.gateway,
    dnsServers: row.dns_servers ? row.dns_servers.split(',').map(s => s.trim()).filter(Boolean) : [],
    sdnZoneName: row.sdn_zone_name,
    pvePoolName: row.pve_pool_name,
  }
}
