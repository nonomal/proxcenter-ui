// src/lib/vdc/ipam.ts
//
// ProxCenter-owned IPAM. Replaces our previous reliance on PVE's built-in
// IPAM, which is unusable on VXLAN zones in PVE 9.x — the
// /cluster/sdn/vnets/<vnet>/ips POST returns 200 but nothing ever surfaces
// in /cluster/sdn/ipams/pve/status, and the GET/DELETE counterparts are
// not implemented. We need a deterministic, queryable, multi-tenant
// allocator anyway, so we keep it inside our SQLite next to the rest of
// the vDC data.
//
// Backing table: `vdc_ipam_allocations` (see lib/db/sqlite.ts). Allocations
// are keyed on (subnet_id, mac), so re-running allocateIp with the same MAC
// returns the same IP — handy for VM-config replays / migrations.
//
// The allocator skips:
//   - the network address and the broadcast address (handled by ParsedCidr)
//   - the gateway (always)
//
// Tenants who want to reserve a slice of the subnet for IPs they manage by
// hand (appliances created in CLI, etc.) just declare a smaller CIDR on
// their VNet — there is no per-subnet sub-range override.
//
// /31 and /32 subnets are supported: ParsedCidr returns the two/single
// usable hosts, and we still skip the gateway.

import { randomUUID } from 'crypto'
import type Database from 'better-sqlite3'

import { getDb as realGetDb } from '@/lib/db/sqlite'
import { parseCidr, ipToInt, intToIp, isValidIpv4 } from '@/lib/vdc/network'
import { invalidateScanCache } from '@/lib/vdc/ipamScan'

// ---------------------------------------------------------------------------
// Test seam — mirrors the pattern used by lib/db/vdcPbsBindings.ts
// ---------------------------------------------------------------------------

let overrideDb: Database.Database | null = null
export function __setDbForTests(db: Database.Database | null) { overrideDb = db }
function db(): Database.Database { return overrideDb ?? realGetDb() }

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface IpamAllocation {
  id: string
  vdcId: string
  subnetId: string
  vnetId: string
  connectionId: string
  ip: string
  ipInt: number
  mac: string
  vmid: number | null
  hostname: string | null
  createdAt: string
}

export interface AllocateIpInput {
  vdcId: string
  subnetId: string
  vnetId: string
  connectionId: string
  mac: string
  vmid?: number | null
  hostname?: string | null
  /** Optional preferred IP. If free + in usable range, we take it; else throw. */
  hint?: string
  /** Optional set of uint32 IPs to treat as already taken on top of what
   *  the IPAM DB knows. Caller fills this from scanUsedIpsForSubnet so the
   *  allocator avoids IPs that exist in PVE config but were never tracked
   *  by us (CLI-created VMs, restored backups, etc.). Empty / omitted →
   *  pure DB-driven allocation, same as before. */
  externalIps?: Set<number>
}

export class IpamExhaustedError extends Error {
  constructor(public readonly subnetId: string) {
    super(`No free IP available in subnet ${subnetId}`)
    this.name = 'IpamExhaustedError'
  }
}

export class IpamHintUnavailableError extends Error {
  constructor(public readonly hint: string) {
    super(`IP ${hint} is not available (out of range, gateway, or already allocated)`)
    this.name = 'IpamHintUnavailableError'
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface SubnetRow {
  id: string
  vnet_id: string
  cidr: string
  gateway: string
}

function loadSubnet(subnetId: string): SubnetRow | null {
  return db()
    .prepare(
      `SELECT id, vnet_id, cidr, gateway
       FROM vdc_subnets WHERE id = ?`,
    )
    .get(subnetId) as SubnetRow | null
}

function rowToAllocation(r: any): IpamAllocation {
  return {
    id: r.id,
    vdcId: r.vdc_id,
    subnetId: r.subnet_id,
    vnetId: r.vnet_id,
    connectionId: r.connection_id,
    ip: r.ip,
    ipInt: r.ip_int,
    mac: r.mac,
    vmid: r.vmid ?? null,
    hostname: r.hostname ?? null,
    createdAt: r.created_at,
  }
}

function normalizeMac(mac: string): string {
  return mac.trim().toUpperCase()
}

/**
 * Compute the [low, high] uint32 bounds of the allocation range for a given
 * subnet — `[firstUsable, lastUsable]` derived from the CIDR. The gateway
 * is excluded separately by the caller.
 */
function buildRangeBounds(subnet: SubnetRow): {
  low: number
  high: number
  gatewayInt: number
} {
  const parsed = parseCidr(subnet.cidr)
  if (!parsed) throw new Error(`Subnet ${subnet.id} has invalid CIDR: ${subnet.cidr}`)
  const gatewayInt = ipToInt(subnet.gateway)
  if (gatewayInt === null) throw new Error(`Subnet ${subnet.id} has invalid gateway: ${subnet.gateway}`)

  return { low: parsed.firstUsableInt, high: parsed.lastUsableInt, gatewayInt }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Allocate an IP for a (subnet, mac) tuple. Idempotent: if a row already
 * exists for this MAC in this subnet, return it unchanged (the caller's
 * hostname / vmid hints are ignored on the second call — this matches PVE
 * IPAM semantics). Throws IpamExhaustedError when the range is full.
 *
 * When `hint` is provided:
 *   - if it equals the existing allocation's IP → returned (idempotent)
 *   - else if free and in range → reserved
 *   - else → IpamHintUnavailableError
 */
export function allocateIp(input: AllocateIpInput): IpamAllocation {
  const mac = normalizeMac(input.mac)
  const subnet = loadSubnet(input.subnetId)
  if (!subnet) throw new Error(`Subnet not found: ${input.subnetId}`)

  // Fast path: same MAC already has an IP — return it.
  const existing = db()
    .prepare(`SELECT * FROM vdc_ipam_allocations WHERE subnet_id = ? AND mac = ?`)
    .get(input.subnetId, mac) as any
  if (existing) {
    if (input.hint && input.hint !== existing.ip) {
      // Caller wants a specific IP that differs from what's already bound
      // to this MAC. Treat that as a programming error rather than silently
      // returning the wrong one.
      throw new IpamHintUnavailableError(input.hint)
    }
    return rowToAllocation(existing)
  }

  const { low, high, gatewayInt } = buildRangeBounds(subnet)

  // Build the union of "already taken" IPs: rows from the IPAM DB plus any
  // IPs the caller learned about by scanning PVE configs (externalIps).
  // The DB's UNIQUE (subnet_id, ip) is the authoritative guard, but
  // mixing in externalIps prevents us from picking an IP that's deployed
  // out-of-band — the next allocation would have collided otherwise.
  const taken = new Set<number>()
  if (input.externalIps) for (const n of input.externalIps) taken.add(n)
  taken.add(gatewayInt)

  // Hint path: try to reserve the requested IP if it's in range and free.
  if (input.hint) {
    if (!isValidIpv4(input.hint)) throw new IpamHintUnavailableError(input.hint)
    const hintInt = ipToInt(input.hint)!
    if (hintInt < low || hintInt > high || taken.has(hintInt)) {
      throw new IpamHintUnavailableError(input.hint)
    }
    return insertAllocation({ ...input, mac }, subnet, input.hint, hintInt)
  }

  // Auto: load the set of IPAM-tracked IPs and pick the first free.
  // For typical /24s this is < 254 entries — a single SELECT is fine.
  const takenRows = db()
    .prepare(`SELECT ip_int FROM vdc_ipam_allocations WHERE subnet_id = ?`)
    .all(input.subnetId) as Array<{ ip_int: number }>
  for (const r of takenRows) taken.add(r.ip_int)

  for (let candidate = low; candidate <= high; candidate++) {
    if (!taken.has(candidate)) {
      const ip = intToIp(candidate)
      return insertAllocation({ ...input, mac }, subnet, ip, candidate)
    }
  }
  throw new IpamExhaustedError(input.subnetId)
}

function insertAllocation(
  input: AllocateIpInput,
  subnet: SubnetRow,
  ip: string,
  ipInt: number,
): IpamAllocation {
  const id = randomUUID()
  const now = new Date().toISOString()
  db()
    .prepare(
      `INSERT INTO vdc_ipam_allocations
        (id, vdc_id, subnet_id, vnet_id, connection_id, ip, ip_int, mac, vmid, hostname, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.vdcId,
      input.subnetId,
      input.vnetId,
      input.connectionId,
      ip,
      ipInt,
      input.mac,
      input.vmid ?? null,
      input.hostname ?? null,
      now,
    )
  // Drop the (connection, subnet) scan cache so the next allocation sees
  // this row and never picks the same IP — the cache could otherwise hand
  // out the IP we just allocated for another MAC's hint check.
  invalidateScanCache(input.connectionId, input.subnetId)
  return {
    id,
    vdcId: input.vdcId,
    subnetId: input.subnetId,
    vnetId: input.vnetId,
    connectionId: input.connectionId,
    ip,
    ipInt,
    mac: input.mac,
    vmid: input.vmid ?? null,
    hostname: input.hostname ?? null,
    createdAt: now,
  }
}

/** Hard-delete an allocation by IP. Idempotent: missing rows are fine. */
export function releaseIp(args: { subnetId: string; ip: string }): void {
  // Read the connection_id before deleting so we can invalidate the right
  // cache entry. Idempotent — if no row exists we just no-op.
  const row = db()
    .prepare(`SELECT connection_id FROM vdc_ipam_allocations WHERE subnet_id = ? AND ip = ?`)
    .get(args.subnetId, args.ip) as { connection_id: string } | undefined
  db()
    .prepare(`DELETE FROM vdc_ipam_allocations WHERE subnet_id = ? AND ip = ?`)
    .run(args.subnetId, args.ip)
  if (row) invalidateScanCache(row.connection_id, args.subnetId)
}

/** Hard-delete an allocation by MAC. Idempotent. */
export function releaseByMac(args: { subnetId: string; mac: string }): void {
  const mac = normalizeMac(args.mac)
  const row = db()
    .prepare(`SELECT connection_id FROM vdc_ipam_allocations WHERE subnet_id = ? AND mac = ?`)
    .get(args.subnetId, mac) as { connection_id: string } | undefined
  db()
    .prepare(`DELETE FROM vdc_ipam_allocations WHERE subnet_id = ? AND mac = ?`)
    .run(args.subnetId, mac)
  if (row) invalidateScanCache(row.connection_id, args.subnetId)
}

/**
 * Release every allocation a given (connection, vmid) currently holds.
 * Used by the VM-delete hook so we don't have to re-parse netN out of qm
 * config: the vmid is the most reliable cross-key.
 */
export function releaseAllocationsForVm(connectionId: string, vmid: number): IpamAllocation[] {
  const rows = db()
    .prepare(`SELECT * FROM vdc_ipam_allocations WHERE connection_id = ? AND vmid = ?`)
    .all(connectionId, vmid) as any[]
  if (rows.length === 0) return []
  db()
    .prepare(`DELETE FROM vdc_ipam_allocations WHERE connection_id = ? AND vmid = ?`)
    .run(connectionId, vmid)
  // Each released row may live in a different subnet (multi-NIC VM) — drop
  // the scan cache for every distinct (connection, subnet) we touched.
  const subnets = new Set<string>()
  for (const r of rows) subnets.add(r.subnet_id)
  for (const subnetId of subnets) invalidateScanCache(connectionId, subnetId)
  return rows.map(rowToAllocation)
}

export function findAllocationByMac(subnetId: string, mac: string): IpamAllocation | null {
  const r = db()
    .prepare(`SELECT * FROM vdc_ipam_allocations WHERE subnet_id = ? AND mac = ?`)
    .get(subnetId, normalizeMac(mac)) as any
  return r ? rowToAllocation(r) : null
}

export function findAllocationByIp(subnetId: string, ip: string): IpamAllocation | null {
  const r = db()
    .prepare(`SELECT * FROM vdc_ipam_allocations WHERE subnet_id = ? AND ip = ?`)
    .get(subnetId, ip) as any
  return r ? rowToAllocation(r) : null
}

/**
 * Return every allocation a given (connection, vmid) holds, without
 * mutating anything. Used by the IPAM sync helpers (PUT config / clone
 * / restore) to detect whether a VM is already IPAM-tracked before
 * deciding whether to release-and-reallocate.
 */
export function findAllocationsForVm(connectionId: string, vmid: number): IpamAllocation[] {
  return (db()
    .prepare(`SELECT * FROM vdc_ipam_allocations WHERE connection_id = ? AND vmid = ?`)
    .all(connectionId, vmid) as any[]).map(rowToAllocation)
}

export function listAllocationsForSubnet(subnetId: string): IpamAllocation[] {
  return (db()
    .prepare(`SELECT * FROM vdc_ipam_allocations WHERE subnet_id = ? ORDER BY ip_int`)
    .all(subnetId) as any[]).map(rowToAllocation)
}

export function countAllocationsForSubnet(subnetId: string): number {
  const row = db()
    .prepare(`SELECT COUNT(*) AS n FROM vdc_ipam_allocations WHERE subnet_id = ?`)
    .get(subnetId) as { n: number } | undefined
  return row?.n ?? 0
}

/**
 * Compute (used, usable) for a subnet without fetching every allocation row.
 * `usable` mirrors the allocator's own definition: CIDR usable hosts minus
 * the gateway when it falls inside the usable range. Tenants who want a
 * smaller pool just declare a smaller CIDR — there is no separate reserve.
 *
 * Used by the VNets list endpoint to surface "used / usable" counts in the
 * dashboard without an extra round-trip per row.
 */
export function getSubnetUsage(subnetId: string, cidr: string, gateway: string): { used: number; usable: number } {
  const used = countAllocationsForSubnet(subnetId)
  const parsed = parseCidr(cidr)
  let usable = 0
  if (parsed) {
    const low = parsed.firstUsableInt
    const high = parsed.lastUsableInt
    const gatewayInt = parseCidr(`${gateway}/32`)?.networkInt
    const gatewayInRange = typeof gatewayInt === 'number' && gatewayInt >= low && gatewayInt <= high
    usable = Math.max(0, high - low + 1 - (gatewayInRange ? 1 : 0))
  }
  return { used, usable }
}

export function listAllocationsForVdc(vdcId: string): IpamAllocation[] {
  return (db()
    .prepare(`SELECT * FROM vdc_ipam_allocations WHERE vdc_id = ? ORDER BY ip_int`)
    .all(vdcId) as any[]).map(rowToAllocation)
}

/**
 * Bind a vmid to an existing allocation (e.g. when the VM is created with
 * a pre-allocated IP and we want to record it after PVE returns the vmid).
 * No-op if the allocation doesn't exist.
 */
export function bindVmidToAllocation(args: {
  subnetId: string
  ip: string
  vmid: number
  hostname?: string | null
}): void {
  db()
    .prepare(
      `UPDATE vdc_ipam_allocations SET vmid = ?, hostname = COALESCE(?, hostname)
       WHERE subnet_id = ? AND ip = ?`,
    )
    .run(args.vmid, args.hostname ?? null, args.subnetId, args.ip)
}
