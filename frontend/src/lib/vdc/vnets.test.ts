import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'

import { resolveVdcForVnetForTesting, checkVnetQuotaForTesting } from './vnets'

function newDb(): any {
  const db = new Database(':memory:')
  db.prepare(`
    CREATE TABLE vdcs (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      connection_id TEXT NOT NULL,
      slug TEXT NOT NULL,
      pve_pool_name TEXT NOT NULL,
      sdn_zone_name TEXT,
      enabled INTEGER DEFAULT 1
    )
  `).run()
  db.prepare(`
    CREATE TABLE vdc_quotas (
      vdc_id TEXT PRIMARY KEY,
      max_vnets INTEGER
    )
  `).run()
  db.prepare(`
    CREATE TABLE vdc_vnets (
      id TEXT PRIMARY KEY,
      vdc_id TEXT NOT NULL,
      pve_name TEXT NOT NULL,
      vxlan_tag INTEGER NOT NULL
    )
  `).run()
  return db
}

describe('resolveVdcForVnet', () => {
  it('returns vdc when owned by tenant and enabled', () => {
    const db = newDb()
    db.prepare('INSERT INTO vdcs (id, tenant_id, connection_id, slug, pve_pool_name, sdn_zone_name) VALUES (?, ?, ?, ?, ?, ?)')
      .run('vdc-1', 'tenant-a', 'conn-1', 'acme-prod', 'vdc-pool', 'zacmeprod')

    const vdc = resolveVdcForVnetForTesting(db, 'vdc-1', 'tenant-a')
    expect(vdc).not.toBeNull()
    expect(vdc?.sdnZoneName).toBe('zacmeprod')
  })

  it('returns null when vdc belongs to different tenant', () => {
    const db = newDb()
    db.prepare('INSERT INTO vdcs (id, tenant_id, connection_id, slug, pve_pool_name, sdn_zone_name) VALUES (?, ?, ?, ?, ?, ?)')
      .run('vdc-1', 'tenant-a', 'conn-1', 'acme', 'pool', 'zacme')
    expect(resolveVdcForVnetForTesting(db, 'vdc-1', 'tenant-b')).toBeNull()
  })

  it('returns null when vdc has no SDN zone (pre-Phase-4a vDC)', () => {
    const db = newDb()
    db.prepare('INSERT INTO vdcs (id, tenant_id, connection_id, slug, pve_pool_name, sdn_zone_name) VALUES (?, ?, ?, ?, ?, ?)')
      .run('vdc-1', 'tenant-a', 'conn-1', 'acme', 'pool', null)
    expect(resolveVdcForVnetForTesting(db, 'vdc-1', 'tenant-a')).toBeNull()
  })

  it('returns null when vdc is disabled', () => {
    const db = newDb()
    db.prepare('INSERT INTO vdcs (id, tenant_id, connection_id, slug, pve_pool_name, sdn_zone_name, enabled) VALUES (?, ?, ?, ?, ?, ?, 0)')
      .run('vdc-1', 'tenant-a', 'conn-1', 'acme', 'pool', 'zacme')
    expect(resolveVdcForVnetForTesting(db, 'vdc-1', 'tenant-a')).toBeNull()
  })
})

describe('checkVnetQuota', () => {
  it('allows when quota null (unlimited)', () => {
    const db = newDb()
    db.prepare('INSERT INTO vdc_quotas (vdc_id, max_vnets) VALUES (?, NULL)').run('vdc-1')
    expect(checkVnetQuotaForTesting(db, 'vdc-1')).toEqual({ allowed: true, current: 0, max: null })
  })

  it('allows under limit', () => {
    const db = newDb()
    db.prepare('INSERT INTO vdc_quotas (vdc_id, max_vnets) VALUES (?, 5)').run('vdc-1')
    db.prepare('INSERT INTO vdc_vnets (id, vdc_id, pve_name, vxlan_tag) VALUES (?, ?, ?, ?)').run('x', 'vdc-1', 'a', 10000)
    db.prepare('INSERT INTO vdc_vnets (id, vdc_id, pve_name, vxlan_tag) VALUES (?, ?, ?, ?)').run('y', 'vdc-1', 'b', 10001)
    expect(checkVnetQuotaForTesting(db, 'vdc-1')).toEqual({ allowed: true, current: 2, max: 5 })
  })

  it('blocks at limit', () => {
    const db = newDb()
    db.prepare('INSERT INTO vdc_quotas (vdc_id, max_vnets) VALUES (?, 2)').run('vdc-1')
    db.prepare('INSERT INTO vdc_vnets (id, vdc_id, pve_name, vxlan_tag) VALUES (?, ?, ?, ?)').run('x', 'vdc-1', 'a', 10000)
    db.prepare('INSERT INTO vdc_vnets (id, vdc_id, pve_name, vxlan_tag) VALUES (?, ?, ?, ?)').run('y', 'vdc-1', 'b', 10001)
    expect(checkVnetQuotaForTesting(db, 'vdc-1')).toEqual({ allowed: false, current: 2, max: 2 })
  })
})
