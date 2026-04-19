// src/lib/vdc/sdn.ts
// Proxmox SDN zone + VNet CRUD for vDCs.

import crypto from 'crypto'

import { getDb } from '@/lib/db/sqlite'
import { pveFetch } from '@/lib/proxmox/client'

import type { SdnVnet } from './types'

// ---------------------------------------------------------------------------
// Zone name generation
// ---------------------------------------------------------------------------

function stripSlug(slug: string): string {
  return slug.replace(/[^a-z0-9]/g, '').slice(0, 14)
}

interface ZoneNameInput { id: string; slug: string }

function generateZoneNameImpl(db: any, connectionId: string, vdc: ZoneNameInput): string {
  const base = 'z' + stripSlug(vdc.slug)

  const existing = db
    .prepare('SELECT sdn_zone_name FROM vdcs WHERE connection_id = ? AND sdn_zone_name = ?')
    .get(connectionId, base)

  if (!existing) return base

  const hash = crypto.createHash('sha1').update(vdc.id).digest('hex').slice(0, 2)
  const withSuffix = 'z' + stripSlug(vdc.slug).slice(0, 12) + hash

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
// VNI allocation (local per vDC)
// ---------------------------------------------------------------------------

const VNI_BASE = 10000

function allocateVniImpl(db: any, vdcId: string): number {
  const row = db
    .prepare('SELECT MAX(vxlan_tag) AS max_tag FROM vdc_vnets WHERE vdc_id = ?')
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

  try {
    await pveFetch(conn, '/cluster/sdn/vnets', { method: 'POST', body })
  } catch (err: any) {
    throw new Error(`Failed to create SDN VNet "${params.pveName}": ${err?.message}`)
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
    if (!msg.toLowerCase().includes('not found') && !msg.includes('404')) {
      throw new Error(`Failed to delete SDN VNet "${pveName}": ${msg}`)
    }
    console.warn(`[vdc-sdn] SDN VNet "${pveName}" not found, skipping`)
  }
}

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
