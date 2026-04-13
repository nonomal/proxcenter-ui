import { describe, it, expect } from 'vitest'
import crypto from 'crypto'

import Database from 'better-sqlite3'

import { generateZoneNameForTesting, allocateVniForTesting } from './sdn'

function newDb(): any {
  const db = new Database(':memory:')
  db.prepare(`
    CREATE TABLE vdcs (
      id TEXT PRIMARY KEY,
      connection_id TEXT NOT NULL,
      slug TEXT NOT NULL,
      sdn_zone_name TEXT
    )
  `).run()
  db.prepare(
    'CREATE UNIQUE INDEX idx_vdcs_sdn_zone_name ON vdcs(connection_id, sdn_zone_name)'
  ).run()
  return db
}

describe('generateZoneName', () => {
  it('strips hyphens, prefixes with z', () => {
    const db = newDb()
    const name = generateZoneNameForTesting(db, 'conn1', { id: 'vdc-1', slug: 'acme-prod' })
    expect(name).toBe('zacmeprod')
  })

  it('truncates long slugs to 14 chars after z', () => {
    const db = newDb()
    const name = generateZoneNameForTesting(db, 'conn1', { id: 'vdc-2', slug: 'very-long-slug-name' })
    expect(name).toBe('zverylongslugna')
    expect(name.length).toBe(15)
  })

  it('collision suffix uses sha1(vdc.id)[:2]', () => {
    const db = newDb()
    db.prepare(
      'INSERT INTO vdcs (id, connection_id, slug, sdn_zone_name) VALUES (?, ?, ?, ?)'
    ).run('other-vdc', 'conn1', 'acme-prod', 'zacmeprod')

    const name = generateZoneNameForTesting(db, 'conn1', { id: 'vdc-3', slug: 'acme-prod' })
    const hash = crypto.createHash('sha1').update('vdc-3').digest('hex').slice(0, 2)
    expect(name).toBe('zacmeprod' + hash)
  })

  it('throws on double collision', () => {
    const db = newDb()
    const hash = crypto.createHash('sha1').update('vdc-4').digest('hex').slice(0, 2)
    db.prepare('INSERT INTO vdcs (id, connection_id, slug, sdn_zone_name) VALUES (?, ?, ?, ?)')
      .run('other-1', 'conn1', 'acme-prod', 'zacmeprod')
    db.prepare('INSERT INTO vdcs (id, connection_id, slug, sdn_zone_name) VALUES (?, ?, ?, ?)')
      .run('other-2', 'conn1', 'acme-prod', 'zacmeprod' + hash)
    expect(() =>
      generateZoneNameForTesting(db, 'conn1', { id: 'vdc-4', slug: 'acme-prod' })
    ).toThrow('Cannot generate unique SDN zone name')
  })
})

// ---------------------------------------------------------------------------
// VNI allocation tests
// ---------------------------------------------------------------------------

function newVnetDb(): any {
  const db = new Database(':memory:')
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

it('allocateVni: first VNet in vDC returns 10000', () => {
  const db = newVnetDb()
  const tag = allocateVniForTesting(db, 'vdc-1')
  expect(tag).toBe(10000)
})

it('allocateVni: subsequent VNets increment from max', () => {
  const db = newVnetDb()
  db.prepare('INSERT INTO vdc_vnets (id, vdc_id, pve_name, vxlan_tag) VALUES (?, ?, ?, ?)')
    .run('x', 'vdc-1', 'prodlan', 10000)
  db.prepare('INSERT INTO vdc_vnets (id, vdc_id, pve_name, vxlan_tag) VALUES (?, ?, ?, ?)')
    .run('y', 'vdc-1', 'dmz', 10001)

  const tag = allocateVniForTesting(db, 'vdc-1')
  expect(tag).toBe(10002)
})

it('allocateVni: skips holes, uses max+1', () => {
  const db = newVnetDb()
  db.prepare('INSERT INTO vdc_vnets (id, vdc_id, pve_name, vxlan_tag) VALUES (?, ?, ?, ?)')
    .run('x', 'vdc-1', 'prodlan', 10000)
  db.prepare('INSERT INTO vdc_vnets (id, vdc_id, pve_name, vxlan_tag) VALUES (?, ?, ?, ?)')
    .run('y', 'vdc-1', 'dmz', 10005)

  const tag = allocateVniForTesting(db, 'vdc-1')
  expect(tag).toBe(10006)
})

it('allocateVni: isolated per vdc', () => {
  const db = newVnetDb()
  db.prepare('INSERT INTO vdc_vnets (id, vdc_id, pve_name, vxlan_tag) VALUES (?, ?, ?, ?)')
    .run('x', 'vdc-A', 'prodlan', 10042)

  const tag = allocateVniForTesting(db, 'vdc-B')
  expect(tag).toBe(10000)
})
