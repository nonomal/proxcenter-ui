import { describe, it, expect } from 'vitest'
import crypto from 'crypto'

import Database from 'better-sqlite3'

import { generateZoneNameForTesting } from './sdn'

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
