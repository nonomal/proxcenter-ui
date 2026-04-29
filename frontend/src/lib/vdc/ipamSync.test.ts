import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'

import {
  __setDbForTests,
  allocateIp,
  findAllocationByMac,
  findAllocationsForVm,
} from './ipam'
import { __clearScanCacheForTests } from './ipamScan'
import { syncIpamForVmConfig } from './ipamSync'

// Stub the IPAM scanner — these tests only care about reconciliation
// logic, not PVE I/O. The real scan path is covered in ipamScan.test.ts.
vi.mock('./ipamScan', async () => {
  const real: any = await vi.importActual('./ipamScan')
  return {
    ...real,
    scanUsedIpsForSubnet: vi.fn(async () => []),
  }
})

// Mock resolveSubnetForBridge so we don't need a full vdcs schema with
// sdn_zone_name, pve_pool_name, etc. in the in-memory test DB.
vi.mock('./vnets', () => ({
  resolveSubnetForBridge: vi.fn((connectionId: string, bridge: string) => {
    if (bridge === 'tenantA') {
      return {
        vdcId: 'vdc-1',
        vnetId: 'vnet-1',
        subnetId: 'subnet-1',
        pveName: 'tenantA',
        cidr: '10.42.0.0/24',
        gateway: '10.42.0.254',
        dnsServers: [],
        sdnZoneName: 'zoneA',
        pvePoolName: 'poolA',
      }
    }
    if (bridge === 'tenantB') {
      return {
        vdcId: 'vdc-1',
        vnetId: 'vnet-2',
        subnetId: 'subnet-2',
        pveName: 'tenantB',
        cidr: '10.43.0.0/24',
        gateway: '10.43.0.254',
        dnsServers: [],
        sdnZoneName: 'zoneA',
        pvePoolName: 'poolA',
      }
    }
    return null
  }),
}))

const fakeConn = { baseUrl: 'http://x', apiToken: 't' } as any

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
    INSERT INTO vdcs (id) VALUES ('vdc-1');
    INSERT INTO vdc_vnets (id, vdc_id) VALUES ('vnet-1', 'vdc-1'), ('vnet-2', 'vdc-1');
    INSERT INTO vdc_subnets (id, vnet_id, cidr, gateway) VALUES
      ('subnet-1', 'vnet-1', '10.42.0.0/24', '10.42.0.254'),
      ('subnet-2', 'vnet-2', '10.43.0.0/24', '10.43.0.254');
  `)
  return sqlite
}

beforeEach(() => {
  __setDbForTests(freshDb())
  __clearScanCacheForTests()
})

describe('syncIpamForVmConfig — no-op paths', () => {
  it('returns immediately when neither side has an IPAM-managed bridge', async () => {
    const result = await syncIpamForVmConfig({
      before: { net0: 'virtio=AA:00:00:00:00:01,bridge=vmbr0' },
      after: { net0: 'virtio=AA:00:00:00:00:01,bridge=vmbr1' },
      conn: fakeConn,
      connectionId: 'conn-1',
      vmid: 100,
      hostname: 'test',
    })
    expect(result.bodyOverrides).toEqual({})
  })

  it('returns immediately on a VM without netN slots and no allocations', async () => {
    const result = await syncIpamForVmConfig({
      before: { name: 'foo' },
      after: { name: 'bar' },
      conn: fakeConn,
      connectionId: 'conn-1',
      vmid: 100,
      hostname: null,
    })
    expect(result.bodyOverrides).toEqual({})
  })
})

describe('syncIpamForVmConfig — fresh allocation', () => {
  it('allocates an IP when a NIC moves onto an IPAM-managed VNet', async () => {
    const result = await syncIpamForVmConfig({
      before: null,
      after: { net0: 'virtio=AA:00:00:00:00:01,bridge=tenantA' },
      conn: fakeConn,
      connectionId: 'conn-1',
      vmid: 100,
      hostname: 'web',
    })
    const alloc = findAllocationByMac('subnet-1', 'AA:00:00:00:00:01')
    expect(alloc?.ip).toBe('10.42.0.1')
    // ipconfig0 not in `after` → caller needs the ipconfig0 patch.
    expect(result.bodyOverrides.ipconfig0).toBe('ip=10.42.0.1/24,gw=10.42.0.254')
  })

  it('honours an ipconfigN.ip hint that the caller already set', async () => {
    const result = await syncIpamForVmConfig({
      before: null,
      after: {
        net0: 'virtio=AA:00:00:00:00:01,bridge=tenantA',
        ipconfig0: 'ip=10.42.0.42/24,gw=10.42.0.254',
      },
      conn: fakeConn,
      connectionId: 'conn-1',
      vmid: 100,
      hostname: null,
    })
    const alloc = findAllocationByMac('subnet-1', 'AA:00:00:00:00:01')
    expect(alloc?.ip).toBe('10.42.0.42')
    // No override needed — caller after-snapshot already had the right IP.
    expect(result.bodyOverrides).toEqual({})
  })
})

describe('syncIpamForVmConfig — MAC change on the same VNet', () => {
  it('releases the old allocation and creates a new one for the new MAC', async () => {
    // Seed: VM 100 already has an IPAM row with the old MAC.
    allocateIp({
      vdcId: 'vdc-1',
      subnetId: 'subnet-1',
      vnetId: 'vnet-1',
      connectionId: 'conn-1',
      mac: 'AA:00:00:00:00:01',
      vmid: 100,
      hostname: 'web',
    })
    expect(findAllocationByMac('subnet-1', 'AA:00:00:00:00:01')?.ip).toBe('10.42.0.1')

    await syncIpamForVmConfig({
      before: { net0: 'virtio=AA:00:00:00:00:01,bridge=tenantA' },
      after: { net0: 'virtio=BB:00:00:00:00:99,bridge=tenantA' },
      conn: fakeConn,
      connectionId: 'conn-1',
      vmid: 100,
      hostname: 'web',
    })

    expect(findAllocationByMac('subnet-1', 'AA:00:00:00:00:01')).toBeNull()
    expect(findAllocationByMac('subnet-1', 'BB:00:00:00:00:99')).not.toBeNull()
  })
})

describe('syncIpamForVmConfig — bridge change between IPAM-managed VNets', () => {
  it('releases in the old subnet and allocates in the new one', async () => {
    allocateIp({
      vdcId: 'vdc-1',
      subnetId: 'subnet-1',
      vnetId: 'vnet-1',
      connectionId: 'conn-1',
      mac: 'AA:00:00:00:00:01',
      vmid: 100,
    })

    const result = await syncIpamForVmConfig({
      before: { net0: 'virtio=AA:00:00:00:00:01,bridge=tenantA' },
      after: { net0: 'virtio=AA:00:00:00:00:01,bridge=tenantB' },
      conn: fakeConn,
      connectionId: 'conn-1',
      vmid: 100,
      hostname: null,
    })

    expect(findAllocationByMac('subnet-1', 'AA:00:00:00:00:01')).toBeNull()
    expect(findAllocationByMac('subnet-2', 'AA:00:00:00:00:01')?.ip).toBe('10.43.0.1')
    // New subnet → ipconfig0 must reflect the new gateway.
    expect(result.bodyOverrides.ipconfig0).toBe('ip=10.43.0.1/24,gw=10.43.0.254')
  })
})

describe('syncIpamForVmConfig — IP change on the same MAC', () => {
  it('honours a new ipconfigN.ip by releasing and re-hinting', async () => {
    allocateIp({
      vdcId: 'vdc-1',
      subnetId: 'subnet-1',
      vnetId: 'vnet-1',
      connectionId: 'conn-1',
      mac: 'AA:00:00:00:00:01',
      vmid: 100,
    })
    expect(findAllocationByMac('subnet-1', 'AA:00:00:00:00:01')?.ip).toBe('10.42.0.1')

    await syncIpamForVmConfig({
      before: {
        net0: 'virtio=AA:00:00:00:00:01,bridge=tenantA',
        ipconfig0: 'ip=10.42.0.1/24,gw=10.42.0.254',
      },
      after: {
        net0: 'virtio=AA:00:00:00:00:01,bridge=tenantA',
        ipconfig0: 'ip=10.42.0.50/24,gw=10.42.0.254',
      },
      conn: fakeConn,
      connectionId: 'conn-1',
      vmid: 100,
      hostname: null,
    })

    expect(findAllocationByMac('subnet-1', 'AA:00:00:00:00:01')?.ip).toBe('10.42.0.50')
  })
})

describe('syncIpamForVmConfig — NIC removed from IPAM-managed VNet', () => {
  it('releases the allocation when the bridge moves off an IPAM VNet', async () => {
    allocateIp({
      vdcId: 'vdc-1',
      subnetId: 'subnet-1',
      vnetId: 'vnet-1',
      connectionId: 'conn-1',
      mac: 'AA:00:00:00:00:01',
      vmid: 100,
    })

    await syncIpamForVmConfig({
      before: { net0: 'virtio=AA:00:00:00:00:01,bridge=tenantA' },
      after: { net0: 'virtio=AA:00:00:00:00:01,bridge=vmbr0' /* unmanaged */ },
      conn: fakeConn,
      connectionId: 'conn-1',
      vmid: 100,
      hostname: null,
    })

    expect(findAllocationByMac('subnet-1', 'AA:00:00:00:00:01')).toBeNull()
  })
})

describe('syncIpamForVmConfig — rollback on PVE failure simulation', () => {
  it('undo handle restores the released allocation when invoked', async () => {
    allocateIp({
      vdcId: 'vdc-1',
      subnetId: 'subnet-1',
      vnetId: 'vnet-1',
      connectionId: 'conn-1',
      mac: 'AA:00:00:00:00:01',
      vmid: 100,
      hostname: 'before',
    })

    const result = await syncIpamForVmConfig({
      before: { net0: 'virtio=AA:00:00:00:00:01,bridge=tenantA' },
      after: { net0: 'virtio=BB:00:00:00:00:99,bridge=tenantA' },
      conn: fakeConn,
      connectionId: 'conn-1',
      vmid: 100,
      hostname: 'after',
    })

    // Mid-sync state: old MAC released, new MAC allocated.
    expect(findAllocationByMac('subnet-1', 'AA:00:00:00:00:01')).toBeNull()
    expect(findAllocationByMac('subnet-1', 'BB:00:00:00:00:99')).not.toBeNull()

    // Caller PVE PUT failed — replay rollback.
    result.rollback()

    expect(findAllocationByMac('subnet-1', 'BB:00:00:00:00:99')).toBeNull()
    expect(findAllocationByMac('subnet-1', 'AA:00:00:00:00:01')?.ip).toBe('10.42.0.1')
  })
})

describe('syncIpamForVmConfig — unrelated VM, no allocations', () => {
  it('does not leak any allocation when reconfiguring a non-IPAM VM', async () => {
    await syncIpamForVmConfig({
      before: { net0: 'virtio=AA:00:00:00:00:01,bridge=vmbr0' },
      after: { net0: 'virtio=AA:00:00:00:00:01,bridge=vmbr0', cores: 4 },
      conn: fakeConn,
      connectionId: 'conn-1',
      vmid: 100,
      hostname: null,
    })
    expect(findAllocationsForVm('conn-1', 100)).toEqual([])
  })
})
