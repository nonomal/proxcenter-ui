import { describe, expect, it, beforeEach } from 'vitest'
import Database from 'better-sqlite3'

import {
  __setDbForTests,
  allocateIp,
  releaseIp,
  releaseByMac,
  releaseAllocationsForVm,
  findAllocationByMac,
  findAllocationByIp,
  listAllocationsForSubnet,
  listAllocationsForVdc,
  bindVmidToAllocation,
  IpamExhaustedError,
  IpamHintUnavailableError,
} from './ipam'

// In-memory DB with the slice of schema the IPAM module touches.
function freshDb(): Database.Database {
  const sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE vdcs (id TEXT PRIMARY KEY);
    CREATE TABLE vdc_vnets (id TEXT PRIMARY KEY, vdc_id TEXT NOT NULL);
    CREATE TABLE vdc_subnets (
      id TEXT PRIMARY KEY,
      vnet_id TEXT NOT NULL,
      cidr TEXT NOT NULL,
      gateway TEXT NOT NULL,
      dns_servers TEXT,
      ipam_enabled INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE vdc_ipam_allocations (
      id TEXT PRIMARY KEY,
      vdc_id TEXT NOT NULL,
      subnet_id TEXT NOT NULL,
      vnet_id TEXT NOT NULL,
      connection_id TEXT NOT NULL,
      ip TEXT NOT NULL,
      ip_int INTEGER NOT NULL,
      mac TEXT NOT NULL,
      vmid INTEGER,
      hostname TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (subnet_id, ip),
      UNIQUE (subnet_id, mac)
    );
  `)
  return sqlite
}

function seed(
  sqlite: Database.Database,
  args: { cidr: string; gateway: string },
): { vdcId: string; vnetId: string; subnetId: string; connectionId: string } {
  sqlite.prepare(`INSERT INTO vdcs (id) VALUES ('vdc-1')`).run()
  sqlite.prepare(`INSERT INTO vdc_vnets (id, vdc_id) VALUES ('vnet-1', 'vdc-1')`).run()
  sqlite
    .prepare(
      `INSERT INTO vdc_subnets (id, vnet_id, cidr, gateway)
       VALUES ('subnet-1', 'vnet-1', ?, ?)`,
    )
    .run(args.cidr, args.gateway)
  return { vdcId: 'vdc-1', vnetId: 'vnet-1', subnetId: 'subnet-1', connectionId: 'conn-1' }
}

beforeEach(() => {
  __setDbForTests(freshDb())
})

describe('allocateIp', () => {
  it('returns the first usable IP in a /24, skipping the gateway', () => {
    const ids = seed(freshDb(), { cidr: '10.42.0.0/24', gateway: '10.42.0.254' })
    // beforeEach already gave us a fresh DB; re-seed there
    __setDbForTests(seedFresh({ cidr: '10.42.0.0/24', gateway: '10.42.0.254' }).sqlite)
    const a = allocateIp({ ...ids, mac: 'BC:24:11:00:00:01' })
    expect(a.ip).toBe('10.42.0.1')
  })
})

// Convenience: rebuild a DB and seed it in one call.
function seedFresh(opts: {
  cidr: string
  gateway: string
}): { sqlite: Database.Database; ids: ReturnType<typeof seed> } {
  const sqlite = freshDb()
  __setDbForTests(sqlite)
  const ids = seed(sqlite, opts)
  return { sqlite, ids }
}

describe('allocateIp behaviour', () => {
  it('walks forward when earlier IPs are taken', () => {
    const { ids } = seedFresh({ cidr: '10.42.0.0/24', gateway: '10.42.0.254' })
    allocateIp({ ...ids, mac: 'AA:00:00:00:00:01' })
    allocateIp({ ...ids, mac: 'AA:00:00:00:00:02' })
    const third = allocateIp({ ...ids, mac: 'AA:00:00:00:00:03' })
    expect(third.ip).toBe('10.42.0.3')
  })

  it('skips the gateway when it lands inside the usable range', () => {
    const { ids } = seedFresh({ cidr: '10.42.0.0/24', gateway: '10.42.0.1' })
    const a = allocateIp({ ...ids, mac: 'AA:00:00:00:00:01' })
    expect(a.ip).toBe('10.42.0.2')
  })

  it('is idempotent on repeated calls with the same MAC', () => {
    const { ids } = seedFresh({ cidr: '10.42.0.0/24', gateway: '10.42.0.254' })
    const first = allocateIp({ ...ids, mac: 'BC:24:11:00:00:01', hostname: 'web' })
    const second = allocateIp({ ...ids, mac: 'BC:24:11:00:00:01', hostname: 'ignored' })
    expect(second.ip).toBe(first.ip)
    expect(second.id).toBe(first.id)
    // First reservation wins (matches PVE IPAM semantics).
    expect(second.hostname).toBe('web')
  })

  it('normalises MAC casing for idempotency', () => {
    const { ids } = seedFresh({ cidr: '10.42.0.0/24', gateway: '10.42.0.254' })
    const first = allocateIp({ ...ids, mac: 'bc:24:11:aa:bb:cc' })
    const second = allocateIp({ ...ids, mac: 'BC:24:11:AA:BB:CC' })
    expect(second.id).toBe(first.id)
  })

  it('honours an in-range hint', () => {
    const { ids } = seedFresh({ cidr: '10.42.0.0/24', gateway: '10.42.0.254' })
    const a = allocateIp({ ...ids, mac: 'AA:00:00:00:00:01', hint: '10.42.0.42' })
    expect(a.ip).toBe('10.42.0.42')
  })

  it('rejects a hint equal to the gateway', () => {
    const { ids } = seedFresh({ cidr: '10.42.0.0/24', gateway: '10.42.0.254' })
    expect(() => allocateIp({ ...ids, mac: 'AA:00:00:00:00:01', hint: '10.42.0.254' }))
      .toThrow(IpamHintUnavailableError)
  })

  it('rejects a hint outside the CIDR', () => {
    const { ids } = seedFresh({ cidr: '10.42.0.0/24', gateway: '10.42.0.254' })
    expect(() => allocateIp({ ...ids, mac: 'AA:00:00:00:00:01', hint: '10.43.0.5' }))
      .toThrow(IpamHintUnavailableError)
  })

  it('throws IpamExhaustedError when the CIDR is full', () => {
    // /30 has 2 usable hosts; one is the gateway → only 1 IP allocatable.
    const { ids } = seedFresh({ cidr: '10.42.0.0/30', gateway: '10.42.0.1' })
    allocateIp({ ...ids, mac: 'AA:00:00:00:00:01' })
    expect(() => allocateIp({ ...ids, mac: 'AA:00:00:00:00:02' })).toThrow(IpamExhaustedError)
  })

  it('handles /31 RFC 3021 — both IPs usable', () => {
    const { ids } = seedFresh({ cidr: '10.42.0.0/31', gateway: '10.42.0.0' })
    const a = allocateIp({ ...ids, mac: 'AA:00:00:00:00:01' })
    expect(a.ip).toBe('10.42.0.1')
    expect(() => allocateIp({ ...ids, mac: 'AA:00:00:00:00:02' })).toThrow(IpamExhaustedError)
  })

  it('handles /32 — single host equals gateway → exhausted', () => {
    const { ids } = seedFresh({ cidr: '10.42.0.0/32', gateway: '10.42.0.0' })
    expect(() => allocateIp({ ...ids, mac: 'AA:00:00:00:00:01' })).toThrow(IpamExhaustedError)
  })
})

describe('release / find / list / bind', () => {
  it('releaseIp removes by IP and is idempotent', () => {
    const { ids } = seedFresh({ cidr: '10.42.0.0/24', gateway: '10.42.0.254' })
    allocateIp({ ...ids, mac: 'AA:00:00:00:00:01' })
    releaseIp({ subnetId: ids.subnetId, ip: '10.42.0.1' })
    releaseIp({ subnetId: ids.subnetId, ip: '10.42.0.1' })
    expect(findAllocationByIp(ids.subnetId, '10.42.0.1')).toBeNull()
  })

  it('releaseByMac removes by MAC', () => {
    const { ids } = seedFresh({ cidr: '10.42.0.0/24', gateway: '10.42.0.254' })
    allocateIp({ ...ids, mac: 'AA:00:00:00:00:01' })
    releaseByMac({ subnetId: ids.subnetId, mac: 'aa:00:00:00:00:01' })
    expect(findAllocationByMac(ids.subnetId, 'AA:00:00:00:00:01')).toBeNull()
  })

  it('releaseAllocationsForVm wipes every NIC of a deleted VM', () => {
    const { ids } = seedFresh({ cidr: '10.42.0.0/24', gateway: '10.42.0.254' })
    const a = allocateIp({ ...ids, mac: 'AA:00:00:00:00:01', vmid: 100 })
    const b = allocateIp({ ...ids, mac: 'AA:00:00:00:00:02', vmid: 100 })
    allocateIp({ ...ids, mac: 'AA:00:00:00:00:03', vmid: 200 })
    const released = releaseAllocationsForVm(ids.connectionId, 100)
    expect(released.map((r) => r.ip).sort()).toEqual([a.ip, b.ip].sort())
    expect(listAllocationsForSubnet(ids.subnetId)).toHaveLength(1)
  })

  it('bindVmidToAllocation patches the row', () => {
    const { ids } = seedFresh({ cidr: '10.42.0.0/24', gateway: '10.42.0.254' })
    const a = allocateIp({ ...ids, mac: 'AA:00:00:00:00:01' })
    expect(a.vmid).toBeNull()
    bindVmidToAllocation({ subnetId: ids.subnetId, ip: a.ip, vmid: 101, hostname: 'web' })
    const after = findAllocationByIp(ids.subnetId, a.ip)
    expect(after?.vmid).toBe(101)
    expect(after?.hostname).toBe('web')
  })

  it('listAllocationsForVdc returns rows sorted by IP', () => {
    const { ids } = seedFresh({ cidr: '10.42.0.0/24', gateway: '10.42.0.254' })
    allocateIp({ ...ids, mac: 'AA:00:00:00:00:03', hint: '10.42.0.30' })
    allocateIp({ ...ids, mac: 'AA:00:00:00:00:01', hint: '10.42.0.10' })
    allocateIp({ ...ids, mac: 'AA:00:00:00:00:02', hint: '10.42.0.20' })
    expect(listAllocationsForVdc(ids.vdcId).map((r) => r.ip))
      .toEqual(['10.42.0.10', '10.42.0.20', '10.42.0.30'])
  })
})
