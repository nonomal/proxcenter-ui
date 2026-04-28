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
  validateDhcpRange,
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
  createSubnetPve,
  updateSubnetPve,
  deleteSubnetPve,
  ensureZoneDhcpBackend,
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
    dhcpRangeStart: r.dhcp_range_start ?? null,
    dhcpRangeEnd: r.dhcp_range_end ?? null,
    ipamEnabled: !!r.ipam_enabled,
    createdAt: r.created_at,
  }
}

function rowToVnet(r: any, subnetRow: any | null): VdcVnet {
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
    subnet: rowToSubnet(subnetRow),
    createdBy: r.created_by ?? null,
    createdAt: r.created_at,
  }
}

const VNET_SELECT_COLS = 'id, vdc_id, pve_name, display_name, description, vxlan_tag, firewall, isolate_ports, vlan_aware, created_by, created_at'
const SUBNET_SELECT_COLS = 'id, vnet_id, cidr, gateway, dns_servers, dhcp_range_start, dhcp_range_end, ipam_enabled, created_at'

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
  isolatePorts?: boolean
  vlanAware?: boolean
  /** Optional L3 + IPAM config attached at create time. Omit for bridge-only.
   *  When present, ipam=pve is enforced and CloudInit can later auto-allocate
   *  IPs from this subnet for VMs attached to the VNet. */
  subnet?: {
    cidr: string
    gateway: string
    dnsServers?: string[]
    dhcpRangeStart?: string
    dhcpRangeEnd?: string
  }
  createdBy: string | null
}

/** Validate the subnet config block. Throws on first violation with a
 *  user-readable message that survives across the API boundary unchanged. */
function validateSubnetInput(input: NonNullable<CreateVnetInput['subnet']>): void {
  if (!parseCidr(input.cidr)) {
    throw new Error(`Invalid CIDR "${input.cidr}" — expected IPv4 form like 10.42.0.0/24`)
  }
  if (!gatewayValidForCidr(input.gateway, input.cidr)) {
    throw new Error(`Gateway "${input.gateway}" is not a usable host inside ${input.cidr}`)
  }
  const hasStart = !!input.dhcpRangeStart
  const hasEnd = !!input.dhcpRangeEnd
  if (hasStart !== hasEnd) {
    throw new Error('DHCP range requires both start and end addresses (or neither)')
  }
  if (hasStart && hasEnd) {
    const v = validateDhcpRange(input.cidr, input.gateway, input.dhcpRangeStart!, input.dhcpRangeEnd!)
    if (!v.ok) {
      const reasonMap: Record<NonNullable<typeof v.reason>, string> = {
        invalid_start: `DHCP range start "${input.dhcpRangeStart}" is not a usable host in ${input.cidr}`,
        invalid_end: `DHCP range end "${input.dhcpRangeEnd}" is not a usable host in ${input.cidr}`,
        reversed: `DHCP range is reversed (start > end)`,
        gateway_in_range: `Gateway ${input.gateway} falls inside the DHCP range — pick a range that excludes it`,
      }
      throw new Error(reasonMap[v.reason!])
    }
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

  // Validate subnet input up front — fail before touching PVE so a typo on
  // CIDR doesn't leave a half-created VNet behind.
  if (input.subnet) validateSubnetInput(input.subnet)

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

  // Optional subnet: created AFTER the VNet exists in PVE (subnet endpoint
  // lives under /cluster/sdn/vnets/{vnet}/subnets, so the VNet must be
  // applied first). Failure here rolls back both the VNet and the DB row.
  let subnetRow: any | null = null
  if (input.subnet) {
    const dnsList = (input.subnet.dnsServers ?? []).map(s => s.trim()).filter(Boolean)
    const dhcpRange = input.subnet.dhcpRangeStart && input.subnet.dhcpRangeEnd
      ? { start: input.subnet.dhcpRangeStart, end: input.subnet.dhcpRangeEnd }
      : undefined
    try {
      // Lazy upgrade of the parent zone: PVE silently drops a subnet's
      // `dhcp-range` unless the zone declares a DHCP backend, so we PUT
      // `dhcp=dnsmasq, ipam=pve` on the zone the first time the user
      // creates a DHCP-enabled subnet under it. The helper also fails
      // upfront with a clear message if dnsmasq is missing on any node.
      if (dhcpRange) {
        await ensureZoneDhcpBackend(conn, vdc.sdnZoneName)
      }
      await createSubnetPve(conn, pveName, {
        cidr: input.subnet.cidr,
        gateway: input.subnet.gateway,
        dnsServers: dnsList.length > 0 ? dnsList : undefined,
        dhcpRange,
      })
    } catch (err: any) {
      db.prepare('DELETE FROM vdc_vnets WHERE id = ?').run(id)
      try { await deleteVnetPve(conn, pveName) } catch {}
      try { await applySdn(conn) } catch {}
      throw err
    }

    const subnetId = randomUUID()
    try {
      db.prepare(
        'INSERT INTO vdc_subnets (id, vnet_id, cidr, gateway, dns_servers, dhcp_range_start, dhcp_range_end, ipam_enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)'
      ).run(
        subnetId,
        id,
        input.subnet.cidr,
        input.subnet.gateway,
        dnsList.length > 0 ? dnsList.join(',') : null,
        input.subnet.dhcpRangeStart ?? null,
        input.subnet.dhcpRangeEnd ?? null,
        now,
      )
    } catch (err: any) {
      // Best-effort rollback: drop the PVE subnet so it doesn't dangle.
      try { await deleteSubnetPve(conn, pveName, input.subnet.cidr) } catch {}
      db.prepare('DELETE FROM vdc_vnets WHERE id = ?').run(id)
      try { await deleteVnetPve(conn, pveName) } catch {}
      try { await applySdn(conn) } catch {}
      throw new Error(`Failed to persist subnet: ${err?.message}`)
    }

    try { await applySdn(conn) } catch (err: any) {
      console.warn(`[vdc-vnets] applySdn failed after subnet create: ${err?.message}`)
    }

    subnetRow = findSubnetByVnetId(db, id)
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
    subnet: rowToSubnet(subnetRow),
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
    isolatePorts?: boolean
    vlanAware?: boolean
    /** Subnet patch — only DNS + DHCP range are editable. CIDR/gateway changes
     *  would invalidate IPAM allocations and require recreate. */
    subnet?: {
      dnsServers?: string[]
      dhcpRangeStart?: string | null
      dhcpRangeEnd?: string | null
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

  // Subnet patch (DNS server list lives in our DB only — CloudInit pushes it
  // to VMs at create time. DHCP range is the only PVE-side mutation here).
  if (patch.subnet) {
    const subnetRow = findSubnetByVnetId(db, row.id) as any | null
    if (!subnetRow) {
      throw new Error(`Cannot edit subnet for VNet "${displayName}" — VNet has no subnet (bridge-only)`)
    }
    const wantsDhcp =
      patch.subnet.dhcpRangeStart !== undefined ||
      patch.subnet.dhcpRangeEnd !== undefined
    if (wantsDhcp) {
      // Both endpoints required to enable, both empty = clear.
      const startCleared = patch.subnet.dhcpRangeStart === null || patch.subnet.dhcpRangeStart === ''
      const endCleared = patch.subnet.dhcpRangeEnd === null || patch.subnet.dhcpRangeEnd === ''
      if (startCleared && endCleared) {
        await updateSubnetPve(conn, vdc.sdnZoneName, pveName, subnetRow.cidr, { dhcpRange: null })
      } else if (!startCleared && !endCleared) {
        const v = validateDhcpRange(subnetRow.cidr, subnetRow.gateway, patch.subnet.dhcpRangeStart!, patch.subnet.dhcpRangeEnd!)
        if (!v.ok) {
          const reasonMap: Record<NonNullable<typeof v.reason>, string> = {
            invalid_start: `DHCP range start "${patch.subnet.dhcpRangeStart}" is not a usable host in ${subnetRow.cidr}`,
            invalid_end: `DHCP range end "${patch.subnet.dhcpRangeEnd}" is not a usable host in ${subnetRow.cidr}`,
            reversed: `DHCP range is reversed (start > end)`,
            gateway_in_range: `Gateway ${subnetRow.gateway} falls inside the DHCP range — pick a range that excludes it`,
          }
          throw new Error(reasonMap[v.reason!])
        }
        // Lazy zone upgrade: enabling DHCP on an existing zone needs
        // `dhcp=dnsmasq` on the zone, not just `dhcp-range` on the subnet.
        // See ensureZoneDhcpBackend for the why.
        await ensureZoneDhcpBackend(conn, vdc.sdnZoneName)
        await updateSubnetPve(conn, vdc.sdnZoneName, pveName, subnetRow.cidr, {
          dhcpRange: { start: patch.subnet.dhcpRangeStart!, end: patch.subnet.dhcpRangeEnd! },
        })
      } else {
        throw new Error('DHCP range requires both start and end addresses (or neither to clear)')
      }
    }
    // Persist DNS + DHCP range in our DB regardless (DNS is only DB-stored).
    db.prepare(
      `UPDATE vdc_subnets SET
         dns_servers      = CASE WHEN ? IS NULL THEN dns_servers ELSE ? END,
         dhcp_range_start = CASE WHEN ? IS NULL THEN dhcp_range_start ELSE ? END,
         dhcp_range_end   = CASE WHEN ? IS NULL THEN dhcp_range_end ELSE ? END
       WHERE id = ?`
    ).run(
      patch.subnet.dnsServers === undefined ? null : (patch.subnet.dnsServers.length > 0 ? patch.subnet.dnsServers.join(',') : ''),
      patch.subnet.dnsServers === undefined ? null : (patch.subnet.dnsServers.length > 0 ? patch.subnet.dnsServers.join(',') : ''),
      patch.subnet.dhcpRangeStart === undefined ? null : (patch.subnet.dhcpRangeStart || null),
      patch.subnet.dhcpRangeStart === undefined ? null : (patch.subnet.dhcpRangeStart || null),
      patch.subnet.dhcpRangeEnd === undefined ? null : (patch.subnet.dhcpRangeEnd || null),
      patch.subnet.dhcpRangeEnd === undefined ? null : (patch.subnet.dhcpRangeEnd || null),
      subnetRow.id,
    )
  }

  if (
    patch.isolatePorts !== undefined ||
    patch.vlanAware !== undefined ||
    patch.firewall !== undefined ||
    patch.subnet !== undefined
  ) {
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

  // Drop the subnet first — PVE refuses to delete a VNet that still has
  // subnets attached (it would orphan IPAM entries). Both helpers are
  // idempotent so a manually-cleaned-up cluster doesn't block the cascade.
  const subnetRow = findSubnetByVnetId(db, row.id) as { cidr?: string } | undefined
  if (subnetRow?.cidr) {
    await deleteSubnetPve(conn, pveName, subnetRow.cidr)
    try { await applySdn(conn) } catch { /* tolerate */ }
  }

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
      | { vdc_id: string; sdn_zone_name: string; vnet_id: string; pve_name: string; subnet_id: string; cidr: string; gateway: string; dns_servers: string | null }
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
  }
}
