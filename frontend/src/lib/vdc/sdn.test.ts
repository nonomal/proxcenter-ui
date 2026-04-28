import { describe, it, expect } from 'vitest'
import crypto from 'crypto'

import Database from 'better-sqlite3'

import { generateZoneNameForTesting, allocateVniForTesting, generatePveVnetIdForTesting } from './sdn'

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
  // PVE caps zone IDs at 8 characters; the helper enforces that hard
  // limit (1-char "z" prefix + 7 slug chars max).
  it('strips hyphens, prefixes with z, caps at 8 chars total', () => {
    const db = newDb()
    const name = generateZoneNameForTesting(db, 'conn1', { id: 'vdc-1', slug: 'acme-prod' })
    expect(name).toBe('zacmepro')
    expect(name.length).toBe(8)
  })

  it('truncates long slugs to fit within the 8-char ceiling', () => {
    const db = newDb()
    const name = generateZoneNameForTesting(db, 'conn1', { id: 'vdc-2', slug: 'very-long-slug-name' })
    expect(name).toBe('zverylon')
    expect(name.length).toBe(8)
  })

  it('collision suffix: sha1(vdc.id)[:2] + 5-char slug stub', () => {
    const db = newDb()
    db.prepare(
      'INSERT INTO vdcs (id, connection_id, slug, sdn_zone_name) VALUES (?, ?, ?, ?)'
    ).run('other-vdc', 'conn1', 'acme-prod', 'zacmepro')

    const name = generateZoneNameForTesting(db, 'conn1', { id: 'vdc-3', slug: 'acme-prod' })
    const hash = crypto.createHash('sha1').update('vdc-3').digest('hex').slice(0, 2)
    expect(name).toBe('zacmep' + hash) // 'z' + 5 slug + 2 hash = 8
    expect(name.length).toBe(8)
  })

  it('throws on double collision', () => {
    const db = newDb()
    const hash = crypto.createHash('sha1').update('vdc-4').digest('hex').slice(0, 2)
    db.prepare('INSERT INTO vdcs (id, connection_id, slug, sdn_zone_name) VALUES (?, ?, ?, ?)')
      .run('other-1', 'conn1', 'acme-prod', 'zacmepro')
    db.prepare('INSERT INTO vdcs (id, connection_id, slug, sdn_zone_name) VALUES (?, ?, ?, ?)')
      .run('other-2', 'conn1', 'acme-prod', 'zacmep' + hash)
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
    CREATE TABLE vdcs (
      id TEXT PRIMARY KEY,
      connection_id TEXT NOT NULL
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

function addVdc(db: any, vdcId: string, connectionId: string) {
  db.prepare('INSERT INTO vdcs (id, connection_id) VALUES (?, ?)').run(vdcId, connectionId)
}

it('allocateVni: first VNet in vDC returns 10000', () => {
  const db = newVnetDb()
  addVdc(db, 'vdc-1', 'conn-A')
  const tag = allocateVniForTesting(db, 'vdc-1')
  expect(tag).toBe(10000)
})

it('allocateVni: subsequent VNets increment from max', () => {
  const db = newVnetDb()
  addVdc(db, 'vdc-1', 'conn-A')
  db.prepare('INSERT INTO vdc_vnets (id, vdc_id, pve_name, vxlan_tag) VALUES (?, ?, ?, ?)')
    .run('x', 'vdc-1', 'prodlan', 10000)
  db.prepare('INSERT INTO vdc_vnets (id, vdc_id, pve_name, vxlan_tag) VALUES (?, ?, ?, ?)')
    .run('y', 'vdc-1', 'dmz', 10001)

  const tag = allocateVniForTesting(db, 'vdc-1')
  expect(tag).toBe(10002)
})

it('allocateVni: skips holes, uses max+1', () => {
  const db = newVnetDb()
  addVdc(db, 'vdc-1', 'conn-A')
  db.prepare('INSERT INTO vdc_vnets (id, vdc_id, pve_name, vxlan_tag) VALUES (?, ?, ?, ?)')
    .run('x', 'vdc-1', 'prodlan', 10000)
  db.prepare('INSERT INTO vdc_vnets (id, vdc_id, pve_name, vxlan_tag) VALUES (?, ?, ?, ?)')
    .run('y', 'vdc-1', 'dmz', 10005)

  const tag = allocateVniForTesting(db, 'vdc-1')
  expect(tag).toBe(10006)
})

it('allocateVni: VNI is unique across vDCs on the same PVE connection', () => {
  // Two separate vDCs (different tenants) share one PVE cluster. The second
  // vDC must NOT be allowed to reuse a VNI already taken by the first —
  // VXLAN VNIs are cluster-wide, not vDC-local.
  const db = newVnetDb()
  addVdc(db, 'vdc-A', 'conn-shared')
  addVdc(db, 'vdc-B', 'conn-shared')
  db.prepare('INSERT INTO vdc_vnets (id, vdc_id, pve_name, vxlan_tag) VALUES (?, ?, ?, ?)')
    .run('a1', 'vdc-A', 'lan', 10000)
  db.prepare('INSERT INTO vdc_vnets (id, vdc_id, pve_name, vxlan_tag) VALUES (?, ?, ?, ?)')
    .run('a2', 'vdc-A', 'dmz', 10001)

  const tag = allocateVniForTesting(db, 'vdc-B')
  expect(tag).toBe(10002)
})

it('allocateVni: VNIs reset per connection (separate PVE clusters get their own pool)', () => {
  const db = newVnetDb()
  addVdc(db, 'vdc-A', 'conn-A')
  addVdc(db, 'vdc-B', 'conn-B')
  db.prepare('INSERT INTO vdc_vnets (id, vdc_id, pve_name, vxlan_tag) VALUES (?, ?, ?, ?)')
    .run('a1', 'vdc-A', 'lan', 10000)

  // Different cluster = independent VXLAN overlay → fresh counter.
  const tag = allocateVniForTesting(db, 'vdc-B')
  expect(tag).toBe(10000)
})

// ---------------------------------------------------------------------------
// generatePveVnetId tests
// ---------------------------------------------------------------------------

it('generatePveVnetId: produces an 8-char id starting with a letter', () => {
  const db = newVnetDb()
  addVdc(db, 'vdc-1', 'conn-A')
  const id = generatePveVnetIdForTesting(db, 'vdc-1', 'lan')
  expect(id).toMatch(/^[a-z][a-z0-9]{7}$/)
  expect(id).toHaveLength(8)
})

it('generatePveVnetId: deterministic for same (vdcId, displayName)', () => {
  const db = newVnetDb()
  addVdc(db, 'vdc-1', 'conn-A')
  const id1 = generatePveVnetIdForTesting(db, 'vdc-1', 'lan')
  const id2 = generatePveVnetIdForTesting(db, 'vdc-1', 'lan')
  expect(id1).toBe(id2)
})

it('generatePveVnetId: different displayName -> different id', () => {
  const db = newVnetDb()
  addVdc(db, 'vdc-1', 'conn-A')
  const id1 = generatePveVnetIdForTesting(db, 'vdc-1', 'lan')
  const id2 = generatePveVnetIdForTesting(db, 'vdc-1', 'dmz')
  expect(id1).not.toBe(id2)
})

it('generatePveVnetId: same displayName in 2 vDCs -> 2 different ids (MSP requirement)', () => {
  const db = newVnetDb()
  addVdc(db, 'vdc-A', 'conn-shared')
  addVdc(db, 'vdc-B', 'conn-shared')
  const idA = generatePveVnetIdForTesting(db, 'vdc-A', 'lan')
  const idB = generatePveVnetIdForTesting(db, 'vdc-B', 'lan')
  expect(idA).not.toBe(idB)
})

it('generatePveVnetId: collision-resistant via nonce when hash collides', () => {
  const db = newVnetDb()
  addVdc(db, 'vdc-1', 'conn-A')
  // Pre-fill the candidate id (deterministic from seed) so the first try
  // collides — the helper must retry with a nonce and return a different id.
  const firstTry = generatePveVnetIdForTesting(db, 'vdc-1', 'lan')
  db.prepare('INSERT INTO vdc_vnets (id, vdc_id, pve_name, vxlan_tag) VALUES (?, ?, ?, ?)')
    .run('x', 'vdc-1', firstTry, 10000)

  const next = generatePveVnetIdForTesting(db, 'vdc-1', 'lan')
  expect(next).not.toBe(firstTry)
  expect(next).toMatch(/^[a-z][a-z0-9]{7}$/)
})
