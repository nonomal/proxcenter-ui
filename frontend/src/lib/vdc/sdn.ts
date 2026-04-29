// src/lib/vdc/sdn.ts
// Proxmox SDN zone + VNet CRUD for vDCs.

import crypto from 'crypto'

import { getDb } from '@/lib/db/sqlite'
import { pveFetch } from '@/lib/proxmox/client'

import type { SdnVnet } from './types'

// ---------------------------------------------------------------------------
// Zone name generation
// ---------------------------------------------------------------------------

// PVE caps SDN zone IDs at 8 characters total (cluster check, not just our
// preference). The previous 14-char strip was a leftover from an earlier
// schema and broke the moment slugs got longer than ~7 chars after the
// switch to <tenantSlug>-<connectionSlug> auto-derivation. Keep the
// sanitiser pure here; the call sites cap to whatever fits below.
function stripSlug(slug: string): string {
  return slug.replace(/[^a-z0-9]/g, '')
}

const ZONE_MAX_LEN = 8         // PVE hard limit on /cluster/sdn/zones
const ZONE_HASH_LEN = 2        // collision suffix length (hex)

interface ZoneNameInput { id: string; slug: string }

function generateZoneNameImpl(db: any, connectionId: string, vdc: ZoneNameInput): string {
  // 'z' prefix + up to 7 slug chars = 8 total. We always reserve room for
  // the prefix even when the slug is tiny.
  const base = 'z' + stripSlug(vdc.slug).slice(0, ZONE_MAX_LEN - 1)

  const existing = db
    .prepare('SELECT sdn_zone_name FROM vdcs WHERE connection_id = ? AND sdn_zone_name = ?')
    .get(connectionId, base)

  if (!existing) return base

  // Collision: drop two slug chars and append a 2-hex-char hash of the
  // vdc id so two vDCs with similar slugs on the same cluster don't
  // overlap. Total: 'z' (1) + 5 slug + 2 hash = 8.
  const hash = crypto.createHash('sha1').update(vdc.id).digest('hex').slice(0, ZONE_HASH_LEN)
  const slugRoom = ZONE_MAX_LEN - 1 - ZONE_HASH_LEN
  const withSuffix = 'z' + stripSlug(vdc.slug).slice(0, slugRoom) + hash

  const collision2 = db
    .prepare('SELECT sdn_zone_name FROM vdcs WHERE connection_id = ? AND sdn_zone_name = ?')
    .get(connectionId, withSuffix)

  if (collision2) {
    throw new Error(`Cannot generate unique SDN zone name for vDC ${vdc.id} (slug=${vdc.slug})`)
  }
  return withSuffix
}

/** @internal exported only for testing */
export function generateZoneNameForTesting(db: any, connectionId: string, vdc: ZoneNameInput): string {
  return generateZoneNameImpl(db, connectionId, vdc)
}

export function generateZoneName(connectionId: string, vdc: ZoneNameInput): string {
  return generateZoneNameImpl(getDb(), connectionId, vdc)
}


// ---------------------------------------------------------------------------
// PVE VNet ID generation
// ---------------------------------------------------------------------------
//
// PVE caps SDN VNet IDs at 8 characters AND requires them to be unique
// cluster-wide (across every zone, not per-zone). Forcing tenants to share
// that flat 8-char namespace is unusable in MSP — two tenants both naturally
// want a "lan" VNet. We decouple by storing a free-form display_name in the
// vDC namespace and computing a deterministic 8-char pve_name to send to PVE.
// PVE's own `alias` field carries the display_name so an admin debugging in
// the Proxmox GUI sees both ID and friendly label.

const PVE_VNET_ID_LEN = 8                // PVE hard limit
const PVE_VNET_ID_PREFIX = 'v'           // first char must be a letter
const PVE_VNET_ID_HEX_LEN = PVE_VNET_ID_LEN - PVE_VNET_ID_PREFIX.length

function hashVnetSeed(seed: string): string {
  return crypto.createHash('sha256').update(seed).digest('hex').slice(0, PVE_VNET_ID_HEX_LEN)
}

function generatePveVnetIdImpl(db: any, vdcId: string, displayName: string): string {
  // Deterministic for the same (vdcId, displayName) pair so re-runs of a
  // failed create don't drift. Collision-check across the whole connection
  // (PVE's actual uniqueness scope), with up to 16 retries appending a nonce.
  const seedBase = `${vdcId}:${displayName}`

  const stmt = db.prepare(
    `SELECT 1 FROM vdc_vnets v
     JOIN vdcs d ON d.id = v.vdc_id
     WHERE d.connection_id = (SELECT connection_id FROM vdcs WHERE id = ?)
       AND v.pve_name = ?
     LIMIT 1`
  )

  for (let i = 0; i < 16; i++) {
    const seed = i === 0 ? seedBase : `${seedBase}#${i}`
    const candidate = PVE_VNET_ID_PREFIX + hashVnetSeed(seed)
    if (!stmt.get(vdcId, candidate)) return candidate
  }

  throw new Error(
    `Cannot generate a unique PVE VNet ID for vdc=${vdcId} displayName=${displayName} after 16 retries — extreme collision rate suggests a bug.`
  )
}

/** @internal exported only for testing */
export function generatePveVnetIdForTesting(db: any, vdcId: string, displayName: string): string {
  return generatePveVnetIdImpl(db, vdcId, displayName)
}

export function generatePveVnetId(vdcId: string, displayName: string): string {
  return generatePveVnetIdImpl(getDb(), vdcId, displayName)
}

// ---------------------------------------------------------------------------
// VNI allocation (cluster-wide per PVE connection)
// ---------------------------------------------------------------------------

const VNI_BASE = 10000

function allocateVniImpl(db: any, vdcId: string): number {
  // VXLAN VNIs must be unique across the entire PVE cluster (transport is one
  // shared overlay), not just within a single vDC. Scoping by vdc_id caused
  // tenant A's first VNet (VNI 10000) to collide with tenant B's first VNet
  // (also 10000) on the same cluster → PVE returns a 400 on the second.
  const row = db
    .prepare(
      `SELECT MAX(v.vxlan_tag) AS max_tag
       FROM vdc_vnets v
       JOIN vdcs d ON d.id = v.vdc_id
       WHERE d.connection_id = (SELECT connection_id FROM vdcs WHERE id = ?)`
    )
    .get(vdcId) as { max_tag: number | null } | undefined

  const maxTag = row?.max_tag ?? null
  return maxTag === null ? VNI_BASE : maxTag + 1
}

/** @internal exported only for testing */
export function allocateVniForTesting(db: any, vdcId: string): number {
  return allocateVniImpl(db, vdcId)
}

export function allocateVni(vdcId: string): number {
  return allocateVniImpl(getDb(), vdcId)
}

// ---------------------------------------------------------------------------
// PVE SDN: apply pending changes
// ---------------------------------------------------------------------------

/**
 * Applies pending SDN changes: triggers ifreload on every node.
 * Should be called once at the end of a batch of SDN mutations.
 */
export async function applySdn(conn: any): Promise<void> {
  await pveFetch(conn, '/cluster/sdn', { method: 'PUT' })
}

// ---------------------------------------------------------------------------
// Zone CRUD
// ---------------------------------------------------------------------------

async function listClusterNodeIps(conn: any): Promise<string[]> {
  const entries = await pveFetch<any[]>(conn, '/cluster/status')
  return (entries || [])
    .filter((e: any) => e.type === 'node' && e.ip)
    .map((e: any) => e.ip as string)
}

/**
 * Creates a VXLAN zone on PVE. Caller must invoke applySdn(conn) afterwards.
 */
export async function createZone(conn: any, zoneName: string): Promise<void> {
  const peers = await listClusterNodeIps(conn)
  const params = new URLSearchParams()
  params.append('type', 'vxlan')
  params.append('zone', zoneName)
  params.append('peers', peers.join(','))

  try {
    await pveFetch(conn, '/cluster/sdn/zones', { method: 'POST', body: params })
  } catch (err: any) {
    const msg = String(err?.message || '')
    if (!msg.includes('already exists')) {
      throw new Error(`Failed to create SDN zone "${zoneName}": ${msg}`)
    }
    console.warn(`[vdc-sdn] SDN zone "${zoneName}" already exists, proceeding`)
  }
}

/**
 * Deletes a VXLAN zone (idempotent - tolerates "not found").
 * Caller must invoke applySdn(conn) afterwards.
 */
export async function deleteZone(conn: any, zoneName: string): Promise<void> {
  try {
    await pveFetch(conn, `/cluster/sdn/zones/${encodeURIComponent(zoneName)}`, { method: 'DELETE' })
  } catch (err: any) {
    const msg = String(err?.message || '')
    if (!msg.toLowerCase().includes('not found') && !msg.includes('404')) {
      throw new Error(`Failed to delete SDN zone "${zoneName}": ${msg}`)
    }
    console.warn(`[vdc-sdn] SDN zone "${zoneName}" not found, skipping`)
  }
}

// ---------------------------------------------------------------------------
// VNet CRUD
// ---------------------------------------------------------------------------

export interface CreateVnetParams {
  pveName: string
  zoneName: string
  tag: number
  /** Friendly label shown in the PVE GUI under the hashed pveName — lets a
   *  provider admin debugging Proxmox identify which tenant VNet this is. */
  alias?: string
}

/**
 * Creates a VNet on PVE. Caller must invoke applySdn(conn) afterwards.
 * The VNet firewall toggle is NOT part of the VNet schema in PVE 8.x — use
 * setVnetFirewallEnabled() after creation to enable/disable it.
 */
export async function createVnetPve(conn: any, params: CreateVnetParams): Promise<void> {
  const body = new URLSearchParams()
  body.append('vnet', params.pveName)
  body.append('zone', params.zoneName)
  body.append('tag', String(params.tag))
  body.append('type', 'vnet')
  if (params.alias) body.append('alias', params.alias)

  try {
    await pveFetch(conn, '/cluster/sdn/vnets', { method: 'POST', body })
  } catch (err: any) {
    throw new Error(`Failed to create SDN VNet "${params.alias ?? params.pveName}": ${err?.message}`)
  }
}

export async function updateVnetPve(
  conn: any,
  pveName: string,
  patch: { alias?: string }
): Promise<void> {
  const body = new URLSearchParams()
  if (patch.alias !== undefined) body.append('alias', patch.alias)
  if ([...body.keys()].length === 0) return

  await pveFetch(conn, `/cluster/sdn/vnets/${encodeURIComponent(pveName)}`, { method: 'PUT', body })
}

/**
 * Enable or disable the VNet-level firewall via the SDN firewall options
 * endpoint: `/cluster/sdn/vnets/{vnet}/firewall/options` (PVE 8.3+).
 * Older PVE builds may not implement this route — we swallow 501 responses
 * and surface a clearer error so the caller can decide (e.g. skip when
 * disabling, warn when enabling).
 */
export async function setVnetFirewallEnabled(conn: any, pveName: string, enabled: boolean): Promise<void> {
  const body = new URLSearchParams()
  body.append('enable', enabled ? '1' : '0')
  try {
    await pveFetch(conn, `/cluster/sdn/vnets/${encodeURIComponent(pveName)}/firewall/options`, { method: 'PUT', body })
  } catch (err: any) {
    const msg = String(err?.message || '')
    // Not implemented: cluster runs a PVE that doesn't ship SDN VNet firewall.
    if (msg.includes('501') || msg.toLowerCase().includes('not implemented')) {
      throw new Error(
        `VNet firewall is not supported on this Proxmox cluster — upgrade to PVE 8.3+ or leave the toggle off (${pveName}).`
      )
    }
    // Missing options row is OK when we're turning it off.
    if (!enabled && msg.includes('404')) return
    throw new Error(`Failed to set VNet "${pveName}" firewall to ${enabled}: ${msg}`)
  }
}

export async function deleteVnetPve(conn: any, pveName: string): Promise<void> {
  try {
    await pveFetch(conn, `/cluster/sdn/vnets/${encodeURIComponent(pveName)}`, { method: 'DELETE' })
  } catch (err: any) {
    const msg = String(err?.message || '')
    const lower = msg.toLowerCase()
    // PVE returns 500 with "sdn vnet 'X' does not exist" for SDN objects that
    // were already removed (manual cluster cleanup, drift, etc.). Treat any of
    // these missing-object signals as success so DB-side delete stays
    // idempotent and the user can clean up the orphan row.
    const isMissing =
      lower.includes('not found') ||
      msg.includes('404') ||
      lower.includes('does not exist') ||
      lower.includes("doesn't exist")
    if (!isMissing) {
      throw new Error(`Failed to delete SDN VNet "${pveName}": ${msg}`)
    }
    console.warn(`[vdc-sdn] SDN VNet "${pveName}" already gone on PVE, proceeding with DB cleanup`)
  }
}

// ---------------------------------------------------------------------------
// PVE SDN: subnets used to be mirrored to PVE here. They no longer are —
// the subnet definition lives only in our DB (`vdc_subnets`), because:
//   - DHCP via dnsmasq does not work on VXLAN zones in PVE 9.x (the
//     `dhcp=dnsmasq, ipam=pve` zone backend depends on the broken IPAM)
//   - SNAT was always disabled (`snat=0`)
//   - DNS resolvers are pushed via CloudInit, not via PVE
//   - the gateway is purely declarative on PVE — the VM gets it via
//     CloudInit `ipconfigN`, never reads it from PVE
// → the PVE-side subnet had no functional effect on tenant traffic, so
// keeping it in sync was pure overhead and a source of drift.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// MAC address helper — used when allocating an IP from IPAM before the VM
// exists on PVE (we need a MAC to key the IPAM entry, can't rely on PVE
// auto-generation since that happens after the create).
// ---------------------------------------------------------------------------

/** Generates a random MAC with the Proxmox OUI prefix `BC:24:11` so the VM's
 *  NIC matches what an admin would expect to see in PVE. The remaining 24
 *  bits are uniformly random — collision probability inside a single tenant
 *  is negligible (~1 in 16M for typical fleet sizes). */
export function generatePveMacAddress(): string {
  const buf = crypto.randomBytes(3)
  const bytes = ['BC', '24', '11', buf[0].toString(16).padStart(2, '0').toUpperCase(), buf[1].toString(16).padStart(2, '0').toUpperCase(), buf[2].toString(16).padStart(2, '0').toUpperCase()]
  return bytes.join(':')
}

// PVE IPAM helpers used to live here (allocateIp / releaseIp calling
// /cluster/sdn/vnets/<vnet>/ips). They were removed because PVE 9.x's
// IPAM is unusable on VXLAN zones (the POST returns 200 but writes
// nothing visible in /cluster/sdn/ipams/pve/status, and GET / DELETE
// counterparts are not implemented). ProxCenter now owns the IPAM in
// SQLite — see lib/vdc/ipam.ts.

export async function listVnetsPve(conn: any): Promise<SdnVnet[]> {
  const items = await pveFetch<any[]>(conn, '/cluster/sdn/vnets')
  return (items || []).map((v: any) => ({
    vnet: v.vnet,
    zone: v.zone,
    tag: Number(v.tag),
    firewall: v.firewall ? 1 : 0,
  }))
}

// ---------------------------------------------------------------------------
// Count NIC attachments for a VNet (used before delete)
// ---------------------------------------------------------------------------

/**
 * Returns the number of NICs across all VMs/CTs that reference `pveName` as bridge.
 * Best-effort: skips VMs whose config fails to fetch.
 */
export async function countVnetAttachments(conn: any, pveName: string): Promise<number> {
  const resources = await pveFetch<any[]>(conn, '/cluster/resources?type=vm')
  let count = 0

  for (const res of resources || []) {
    const vmid = res.vmid
    const node = res.node
    const type = res.type
    if (!vmid || !node || !type) continue

    try {
      const config = await pveFetch<any>(conn, `/nodes/${encodeURIComponent(node)}/${type}/${vmid}/config`)
      for (const key of Object.keys(config)) {
        if (!/^net\d+$/.test(key)) continue
        const val = String(config[key] || '')
        const m = val.match(/bridge=([^,]+)/)
        if (m && m[1] === pveName) count++
      }
    } catch {
      // Skip VMs whose config fails
    }
  }

  return count
}

// ---------------------------------------------------------------------------
// Reconcile DB mirror with PVE state
// ---------------------------------------------------------------------------

/**
 * Compare DB `vdc_vnets` rows with PVE SDN state for the given zone.
 * If a DB row exists for a VNet not in PVE: delete the DB row.
 * If PVE has a VNet in this zone not in DB: log warning (don't auto-create).
 */
export async function reconcileVnets(vdcId: string, zoneName: string, conn: any): Promise<void> {
  const db = getDb()
  const dbRows = db
    .prepare('SELECT id, pve_name FROM vdc_vnets WHERE vdc_id = ?')
    .all(vdcId) as Array<{ id: string; pve_name: string }>

  let pveVnets: SdnVnet[] = []
  try {
    const all = await listVnetsPve(conn)
    pveVnets = all.filter((v) => v.zone === zoneName)
  } catch (err: any) {
    console.warn(`[vdc-sdn] reconcileVnets: listVnetsPve failed for zone ${zoneName}: ${err?.message}`)
    return
  }

  const pveSet = new Set(pveVnets.map((v) => v.vnet))
  const dbSet = new Set(dbRows.map((r) => r.pve_name))

  for (const row of dbRows) {
    if (!pveSet.has(row.pve_name)) {
      db.prepare('DELETE FROM vdc_vnets WHERE id = ?').run(row.id)
      console.warn(`[vdc-sdn] reconcileVnets: removed stale DB row for VNet ${row.pve_name}`)
    }
  }

  for (const v of pveVnets) {
    if (!dbSet.has(v.vnet)) {
      console.warn(`[vdc-sdn] reconcileVnets: orphan VNet ${v.vnet} in zone ${zoneName} (not in DB)`)
    }
  }
}
