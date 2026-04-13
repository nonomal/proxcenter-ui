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
