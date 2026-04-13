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
