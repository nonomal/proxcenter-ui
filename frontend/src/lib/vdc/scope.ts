// src/lib/vdc/scope.ts
// vDC Scope Resolver & Cluster Filter
//
// Resolves which nodes/storages/pools a tenant is allowed to see based on
// their vDC assignments, and provides a filter function for cluster data.

import { getDb } from '@/lib/db/sqlite'
import { DEFAULT_TENANT_ID } from '@/lib/tenant'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VdcScope {
  /** Connection IDs that have vDCs for this tenant */
  connectionIds: Set<string>
  /** Per-connection: allowed node names */
  nodesByConnection: Map<string, Set<string>>
  /** Per-connection: allowed storage IDs */
  storagesByConnection: Map<string, Set<string>>
  /** Per-connection: PVE pool names (VMs must be in one of these pools) */
  poolsByConnection: Map<string, Set<string>>
}

// ---------------------------------------------------------------------------
// In-memory cache (60s TTL)
// ---------------------------------------------------------------------------

interface CacheEntry {
  data: VdcScope | null
  expiry: number
}

const scopeCache = new Map<string, CacheEntry>()

const CACHE_TTL_MS = 60_000

// ---------------------------------------------------------------------------
// getVdcScope
// ---------------------------------------------------------------------------

/**
 * Resolves the vDC scope for a tenant.
 *
 * Returns `null` if no filtering should be applied:
 * - The default tenant always sees everything (provider view).
 * - Tenants with no enabled vDCs see everything (backwards compatible).
 *
 * When a non-null VdcScope is returned, the caller should use it to restrict
 * which nodes, storages, and VMs the tenant can see.
 */
export function getVdcScope(tenantId: string): VdcScope | null {
  // Default tenant = provider, no filtering
  if (tenantId === DEFAULT_TENANT_ID) return null

  // Check cache
  const now = Date.now()
  const cached = scopeCache.get(tenantId)

  if (cached && cached.expiry > now) {
    return cached.data
  }

  // Build scope from DB
  const scope = buildVdcScope(tenantId)

  // Cache the result
  scopeCache.set(tenantId, { data: scope, expiry: now + CACHE_TTL_MS })

  return scope
}

// ---------------------------------------------------------------------------
// buildVdcScope (internal)
// ---------------------------------------------------------------------------

function buildVdcScope(tenantId: string): VdcScope | null {
  const db = getDb()

  // 1. Find all enabled vDCs for this tenant
  const vdcRows = db
    .prepare(
      `SELECT v.id, v.connection_id, v.pve_pool_name
       FROM vdcs v
       WHERE v.tenant_id = ? AND v.enabled = 1`
    )
    .all(tenantId) as Array<{ id: string; connection_id: string; pve_pool_name: string }>

  // No vDCs for this tenant - backwards compatible, no restrictions
  if (vdcRows.length === 0) return null

  // 2. Prepare statements for child tables
  const stmtNodes = db.prepare('SELECT node_name FROM vdc_nodes WHERE vdc_id = ?')
  const stmtStorages = db.prepare('SELECT storage_id FROM vdc_storages WHERE vdc_id = ?')

  // 3. Build the scope
  const connectionIds = new Set<string>()
  const nodesByConnection = new Map<string, Set<string>>()
  const storagesByConnection = new Map<string, Set<string>>()
  const poolsByConnection = new Map<string, Set<string>>()

  for (const row of vdcRows) {
    const connId = row.connection_id
    connectionIds.add(connId)

    // Nodes: merge across multiple vDCs on the same connection
    if (!nodesByConnection.has(connId)) {
      nodesByConnection.set(connId, new Set())
    }

    const nodeRows = stmtNodes.all(row.id) as Array<{ node_name: string }>

    for (const nr of nodeRows) {
      nodesByConnection.get(connId)!.add(nr.node_name)
    }

    // Storages: merge across multiple vDCs on the same connection
    if (!storagesByConnection.has(connId)) {
      storagesByConnection.set(connId, new Set())
    }

    const storageRows = stmtStorages.all(row.id) as Array<{ storage_id: string }>

    for (const sr of storageRows) {
      storagesByConnection.get(connId)!.add(sr.storage_id)
    }

    // Pools: each vDC has exactly one PVE pool
    if (!poolsByConnection.has(connId)) {
      poolsByConnection.set(connId, new Set())
    }

    poolsByConnection.get(connId)!.add(row.pve_pool_name)
  }

  return {
    connectionIds,
    nodesByConnection,
    storagesByConnection,
    poolsByConnection,
  }
}

// ---------------------------------------------------------------------------
// applyVdcFilter
// ---------------------------------------------------------------------------

/**
 * Filters a ClusterData object by vDC scope. Called after RBAC filtering.
 *
 * Expected cluster shape:
 *   { id: string (connectionId), name: string, nodes: [{ node: string, guests: [{ pool?: string, ... }] }] }
 *
 * Behaviour:
 * - scope === null  ->  return cluster unchanged (no vDC restrictions)
 * - no scope for this connection  ->  tenant has no vDC on this cluster, hide everything
 * - otherwise  ->  filter nodes + filter guests by pool membership
 *
 * VMs without a `pool` (undefined / empty string) are hidden for vDC-scoped
 * tenants because they don't belong to any vDC pool.
 */
export function applyVdcFilter(cluster: any, scope: VdcScope | null): any {
  // No scope means no vDC restrictions - return as-is
  if (scope === null) return cluster

  const connId: string = cluster.id
  const allowedNodes = scope.nodesByConnection.get(connId)

  // Tenant has no vDC on this connection - hide everything
  if (!allowedNodes) {
    return { ...cluster, nodes: [] }
  }

  const allowedPools = scope.poolsByConnection.get(connId) ?? new Set<string>()

  // Filter nodes, then filter guests within each remaining node
  const filteredNodes = cluster.nodes
    .filter((node: any) => allowedNodes.has(node.node))
    .map((node: any) => {
      const filteredGuests = (node.guests ?? []).filter((guest: any) => {
        // VMs without a pool are hidden for vDC-scoped tenants
        const pool = guest.pool
        if (!pool || pool === '') return false

        return allowedPools.has(pool)
      })

      return { ...node, guests: filteredGuests }
    })

  return { ...cluster, nodes: filteredNodes }
}

// ---------------------------------------------------------------------------
// clearVdcScopeCache
// ---------------------------------------------------------------------------

/**
 * Clears the in-memory vDC scope cache.
 *
 * Call this when vDCs are created, updated, or deleted to ensure the next
 * scope resolution picks up the latest state.
 *
 * @param tenantId  Optional. If provided, only the cache for that tenant is cleared.
 *                  If omitted, the entire cache is flushed.
 */
export function clearVdcScopeCache(tenantId?: string): void {
  if (tenantId) {
    scopeCache.delete(tenantId)
  } else {
    scopeCache.clear()
  }
}
