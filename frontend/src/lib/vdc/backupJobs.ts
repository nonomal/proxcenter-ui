// src/lib/vdc/backupJobs.ts
//
// Tenant scoping for PVE backup jobs (/cluster/backup). PVE has no
// per-tenant namespace for vzdump jobs — the cluster-wide list returned
// by GET /cluster/backup contains every job regardless of who created
// it. We compensate at the ProxCenter API layer:
//
//   - tenants only see jobs whose `pool` matches one of their vDC pools
//     on the target connection
//   - tenants can only create/edit/delete/run jobs that target one of
//     their pools — `selectionMode='pool'` with a pool they own
//
// Provider (default tenant) gets the unfiltered cluster-wide view, same
// as before. The function returns `null` to signal "no filter applies"
// so callers can short-circuit cleanly.
//
// The strict pool-only contract for tenant-side mutations is intentional:
// `selectionMode='include'` (vmid list) and `selectionMode='all'` would
// require validating every vmid against the tenant's pool membership on
// every write, and a job that drifts (a vmid leaves the pool) would
// silently keep backing up a foreign VM. The pool-based contract makes
// drift impossible.

import { getVdcScope } from './scope'

/**
 * Returns the set of PVE pool names a tenant is allowed to target via
 * backup jobs on the given connection. `null` means the caller is the
 * provider (default tenant) — no filter, full cluster view.
 *
 * An empty Set means the tenant has no vDC on this connection: every
 * job is forbidden, every list is empty.
 */
export function getAllowedJobPools(tenantId: string, connectionId: string): Set<string> | null {
  const scope = getVdcScope(tenantId)
  if (!scope) return null
  return scope.poolsByConnection.get(connectionId) ?? new Set<string>()
}

/**
 * True when a backup job's pool is in the allowed set. Jobs without a
 * pool (selectionMode='all' or 'include') are NEVER tenant-owned —
 * those flows are reserved to the provider.
 */
export function isJobOwnedByTenantPools(
  job: { pool?: string | null },
  allowedPools: Set<string>,
): boolean {
  return !!job.pool && allowedPools.has(job.pool)
}

/**
 * Validate a POST/PUT body coming from a tenant. Throws a `Response`
 * (caller short-circuits with `return validation`) when the body
 * doesn't match the pool-only contract. Returns `null` on success.
 *
 * The shape we accept: { selectionMode: 'pool', pool: <name> } where
 * <name> ∈ allowedPools. Anything else is refused.
 */
export function validateTenantJobBody(
  body: { selectionMode?: string; pool?: string | null },
  allowedPools: Set<string>,
): string | null {
  if (body.selectionMode !== 'pool') {
    return 'Tenant backup jobs must use selectionMode="pool" — pick a vDC pool to back up.'
  }
  if (!body.pool) {
    return 'Tenant backup jobs require a pool.'
  }
  if (!allowedPools.has(body.pool)) {
    return `Pool "${body.pool}" is not authorised for this tenant.`
  }
  return null
}
