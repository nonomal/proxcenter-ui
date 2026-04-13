# MSP IaaS Phase 2: vDC Inventory Filtering

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tenant users only see the nodes, VMs, and storages that belong to their vDCs. Admin/provider users see everything (no filtering). The filtering happens server-side in the inventory API routes.

**Architecture:** New `getVdcScope(tenantId, connectionId?)` helper resolves authorized nodes/storages/pools for a tenant. A new `applyVdcFilter(cluster, vdcScope)` function filters cluster data after RBAC. Applied in inventory/stream, inventory (non-stream), vms, and dashboard routes. No changes to CRITICAL-risk functions (`getConnectionById`, `getTenantPrisma`, `checkPermission`).

**Tech Stack:** TypeScript, SQLite queries, existing inventory stream/route patterns

**Worktree:** `/root/saas/proxcenter-frontend-msp-iaas/` (branch `feature/msp-iaas`)

---

## File Structure

### New files

| File | Responsibility |
|------|---------------|
| `src/lib/vdc/scope.ts` | `getVdcScope()` and `applyVdcFilter()` - resolve tenant's vDC scope and filter cluster data |

### Modified files

| File | Change | GitNexus Risk |
|------|--------|---------------|
| `src/app/api/v1/inventory/stream/route.ts` | Import vDC scope, apply filter after RBAC in `applyRbacToCluster` and cache path | LOW (fetchOneCluster) |
| `src/app/api/v1/inventory/route.ts` | Same pattern - apply vDC filter after RBAC | LOW |
| `src/app/api/v1/vms/route.ts` | Filter VM list by vDC pool | MEDIUM |
| `src/app/api/v1/dashboard/route.ts` | Filter dashboard data by vDC scope | MEDIUM |

### NOT modified (CRITICAL risk - build on top, don't touch)

| File | Reason |
|------|--------|
| `src/lib/rbac/index.ts` | 428 dependants, CRITICAL |
| `src/lib/connections/getConnection.ts` | 174 dependants, CRITICAL |
| `src/lib/tenant/index.ts` | 193 dependants, CRITICAL |

---

## Task 1: vDC Scope Helper

**Files:**
- Create: `src/lib/vdc/scope.ts`

- [ ] **Step 1: Create the vDC scope module**

This module exports two functions:

### `getVdcScope(tenantId, connectionId?)`

Queries the DB for all vDCs belonging to a tenant. Returns a scope object that can be used to filter PVE data. If no vDCs exist for the tenant, returns `null` (meaning no filtering - backwards compatible for tenants without vDCs).

```typescript
// src/lib/vdc/scope.ts
import { getDb } from '@/lib/db/sqlite'
import { DEFAULT_TENANT_ID } from '@/lib/tenant'

export interface VdcScope {
  /** Set of connection IDs that have vDCs for this tenant */
  connectionIds: Set<string>
  /** Per-connection: allowed node names */
  nodesByConnection: Map<string, Set<string>>
  /** Per-connection: allowed storage IDs */
  storagesByConnection: Map<string, Set<string>>
  /** Per-connection: PVE pool names (VMs must be in one of these pools) */
  poolsByConnection: Map<string, Set<string>>
}
```

Logic:
1. If `tenantId === DEFAULT_TENANT_ID`, return `null` (default tenant = provider, sees everything)
2. Query `vdcs` table for this tenant (+ optional connectionId filter), join `vdc_nodes` and `vdc_storages`
3. If no vDCs found, return `null` (tenant has no vDC restrictions)
4. Build the `VdcScope` maps
5. Cache in-memory with 60s TTL keyed by `tenantId`

### `applyVdcFilter(cluster, vdcScope)`

Filters a ClusterData object by vDC scope. Used after RBAC filtering.

```typescript
export function applyVdcFilter(cluster: any, scope: VdcScope | null): any
```

Logic:
1. If `scope === null`, return cluster unchanged
2. If cluster's connectionId is not in `scope.connectionIds`, return cluster with empty nodes (tenant has no vDC on this cluster)
3. Get allowed nodes, storages, pools for this connection
4. Filter `cluster.nodes` to only include nodes in the allowed set
5. For each remaining node, filter `node.guests` to only include VMs whose `pool` matches one of the allowed PVE pool names
6. Return the filtered cluster

Important: the `pool` field on guest data comes from PVE `/cluster/resources?type=vm` and is already present in the GuestData type.

- [ ] **Step 2: Verify and commit**

```bash
git add src/lib/vdc/scope.ts
git commit -m "feat(vdc): add vDC scope resolver and cluster filter"
```

---

## Task 2: Filter Inventory Stream

**Files:**
- Modify: `src/app/api/v1/inventory/stream/route.ts`

- [ ] **Step 1: Import vDC scope**

Add import at top of file:
```typescript
import { getVdcScope, applyVdcFilter } from '@/lib/vdc/scope'
```

- [ ] **Step 2: Resolve vDC scope once in the GET handler**

In the `GET` function, after `const rbacCtx = await getRBACContext()` (around line 588), add:
```typescript
const vdcScope = await getVdcScope(tenantId)
```

Also do the same in the cached path (around line 543):
```typescript
const vdcScope = await getVdcScope(tenantId)
```

- [ ] **Step 3: Apply vDC filter after RBAC**

In both the cached path and the live path, where `applyRbacToCluster` is called, chain the vDC filter:

Cached path (line ~558):
```typescript
send('cluster', applyVdcFilter(applyRbacToCluster(cluster, rbacCtx), vdcScope))
```

Live path (line ~643):
```typescript
send('cluster', applyVdcFilter(applyRbacToCluster(cluster, rbacCtx), vdcScope))
```

- [ ] **Step 4: Filter connections by vDC scope**

If a tenant has vDCs, they should only see clusters that have a vDC assigned to them. After loading `pveConnections` (line ~604), filter:

```typescript
// If tenant has vDCs, only show clusters with a vDC assigned
const visiblePveConnections = vdcScope
  ? pveConnections.filter(c => vdcScope.connectionIds.has(c.id))
  : pveConnections
```

Use `visiblePveConnections` in the rest of the function instead of `pveConnections`.

- [ ] **Step 5: Commit**

---

## Task 3: Filter Inventory (non-stream)

**Files:**
- Modify: `src/app/api/v1/inventory/route.ts`

Same pattern as Task 2 but for the non-stream `/api/v1/inventory` endpoint. This route has a very similar structure (cache check, then fetch, then RBAC filter).

- [ ] **Step 1: Add imports and resolve vDC scope**
- [ ] **Step 2: Apply `applyVdcFilter` after RBAC filtering on each cluster**
- [ ] **Step 3: Filter connections to only those with vDCs (if scope exists)**
- [ ] **Step 4: Commit**

---

## Task 4: Filter VMs Route

**Files:**
- Modify: `src/app/api/v1/vms/route.ts`

This route returns a flat list of all VMs. The vDC filter needs to remove VMs not in the tenant's pools.

- [ ] **Step 1: Read the current file to understand its structure**

The `/api/v1/vms` route likely fetches VMs via PVE or from cached inventory data. The filter should:
1. Import `getVdcScope` from `@/lib/vdc/scope`
2. After fetching VMs, if `vdcScope` exists, filter to only VMs whose `pool` is in the allowed pools for that connection

- [ ] **Step 2: Apply the filter**
- [ ] **Step 3: Commit**

---

## Task 5: Filter Dashboard Route

**Files:**
- Modify: `src/app/api/v1/dashboard/route.ts`

The dashboard route aggregates cluster data. Apply the same vDC filter pattern.

- [ ] **Step 1: Read current file structure**
- [ ] **Step 2: Import vDC scope, resolve once, apply to cluster data before aggregation**
- [ ] **Step 3: Commit**

---

## Task 6: Tenant Endpoint - My vDCs

**Files:**
- Create: `src/app/api/v1/vdcs/route.ts`

Tenant-facing endpoint so the frontend can show the tenant's vDCs with usage/quotas.

- [ ] **Step 1: Create the route**

```
GET /api/v1/vdcs  - returns vDCs for the current tenant (from JWT)
```

- Permission: `PERMISSIONS.VM_VIEW` (any authenticated tenant user)
- Calls `listVdcs(tenantId)` from `@/lib/vdc`
- Returns `{ data: vdcs }` with quota + usage

- [ ] **Step 2: Commit**

---

## Summary

| Task | What it does | Files |
|------|-------------|-------|
| 1 | vDC scope resolver + cluster filter helper | `src/lib/vdc/scope.ts` (new) |
| 2 | Filter inventory stream by vDC | `inventory/stream/route.ts` |
| 3 | Filter inventory (non-stream) by vDC | `inventory/route.ts` |
| 4 | Filter VMs list by vDC | `vms/route.ts` |
| 5 | Filter dashboard data by vDC | `dashboard/route.ts` |
| 6 | Tenant-facing "my vDCs" endpoint | `vdcs/route.ts` (new) |

**What this enables:** A user in tenant "Client-A" logs in and sees ONLY the nodes/VMs/storages from their vDC(s). The provider admin still sees everything. No frontend changes needed - the backend filters the data.

**Backwards compatible:** Tenants without vDCs (including "default") see everything as before. The filter is a no-op when `getVdcScope()` returns `null`.
