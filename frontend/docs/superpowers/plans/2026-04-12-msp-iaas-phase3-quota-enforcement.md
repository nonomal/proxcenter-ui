# MSP IaaS Phase 3: Quota Enforcement & Auto-Pool Assignment

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a tenant creates/clones a VM, the system automatically assigns it to the vDC's PVE pool and verifies quotas. Modifications (CPU/RAM changes, disk resize) also check quotas. Operations that would exceed quotas are blocked with a clear error message.

**Architecture:** New `checkVdcQuota(tenantId, connectionId, operation)` function in `src/lib/vdc/quota.ts` does a fresh PVE query to sum current pool usage and compare against quotas. Each write route calls this before proceeding. Pool assignment is injected into the PVE API call params. No changes to CRITICAL-risk functions.

**Tech Stack:** TypeScript, PVE REST API (`/pools/{name}`, `/nodes/{node}/qemu`), SQLite

**Worktree:** `/root/saas/proxcenter-frontend-msp-iaas/` (branch `feature/msp-iaas`)

---

## File Structure

### New files

| File | Responsibility |
|------|---------------|
| `src/lib/vdc/quota.ts` | `resolveVdcForTenant()`, `checkVdcQuota()`, `QuotaCheckResult` type |

### Modified files

| File | Change |
|------|--------|
| `src/app/api/v1/connections/[id]/guests/[type]/[node]/route.ts` | Add quota check + auto-pool on VM/LXC creation |
| `src/app/api/v1/connections/[id]/guests/[type]/[node]/[vmid]/clone/route.ts` | Add quota check + auto-pool on clone |
| `src/app/api/v1/connections/[id]/guests/[type]/[node]/[vmid]/config/route.ts` | Add quota check on CPU/RAM increase |
| `src/app/api/v1/connections/[id]/guests/[type]/[node]/[vmid]/disk/resize/route.ts` | Add quota check on disk resize |

---

## Task 1: Quota Check Library

**Files:**
- Create: `src/lib/vdc/quota.ts`

- [ ] **Step 1: Create the quota check module**

### `resolveVdcForTenant(tenantId, connectionId, node?)`

Finds the vDC for a tenant on a given connection. If `node` is provided, verifies the node is in the vDC.

Returns: `{ vdc, poolName, quota } | null`
- `null` if tenant is default or has no vDC on this connection (no enforcement)
- Throws if tenant has vDC but the node is NOT in the allowed list (403 - node not authorized)

Logic:
1. If `tenantId === DEFAULT_TENANT_ID`, return `null`
2. Query `vdcs` for this tenant + connection (enabled only)
3. If no vDC found, return `null` (backwards compatible)
4. If `node` provided: check `vdc_nodes` - if node not in list, throw error
5. Load quota from `vdc_quotas`
6. Return `{ vdc, poolName: vdc.pve_pool_name, quota }`

### `checkVdcQuota(connectionId, poolName, quota, operation)`

Performs a fresh PVE query to check if an operation would exceed quotas.

```typescript
export interface QuotaOperation {
  type: 'create' | 'clone' | 'resize' | 'config'
  addVcpus?: number     // vCPUs requested (create/clone) or delta (config)
  addRamMb?: number     // RAM in MB requested or delta
  addStorageMb?: number // Storage in MB requested or delta
  addVms?: number       // Usually 1 for create/clone, 0 for config/resize
}

export interface QuotaCheckResult {
  allowed: boolean
  violations: string[]  // Human-readable: "RAM: 252/256 GB, +8 GB exceeds quota"
  currentUsage: { vcpus: number; ramMb: number; storageMb: number; vms: number }
}
```

Logic:
1. Fetch pool members from PVE: `GET /pools/{poolName}`
2. Sum current usage from members (vcpus from maxcpu, RAM from maxmem, storage from maxdisk, VM count)
3. For each quota field that is not null: check if `current + requested > max`
4. Build violations array with clear messages
5. Return result

Important: This does a FRESH PVE query every time (not from cache). The cache is only for dashboard display.

Import `getConnectionById` with the connection's owner tenantId (use `getConnectionOwnerTenantId` from `src/lib/vdc/index.ts`, or inline the Prisma lookup).

- [ ] **Step 2: Commit**

---

## Task 2: Enforce on VM/LXC Creation

**Files:**
- Modify: `src/app/api/v1/connections/[id]/guests/[type]/[node]/route.ts`

- [ ] **Step 1: Add vDC quota check and pool injection**

After the RBAC check and before calling `pveFetch` to create the VM, add:

```typescript
import { getCurrentTenantId } from '@/lib/tenant'
import { resolveVdcForTenant, checkVdcQuota } from '@/lib/vdc/quota'

// After checkPermission, before pveFetch:
const tenantId = await getCurrentTenantId()
const vdcInfo = await resolveVdcForTenant(tenantId, id, node)

if (vdcInfo) {
  // Check quotas with fresh PVE data
  const vcpus = parseInt(body.cores || '1') * parseInt(body.sockets || '1')
  const ramMb = parseInt(body.memory || '512')
  const storageMb = /* parse from disk params - e.g. body.scsi0 size */ 0 // Best effort

  const quotaCheck = await checkVdcQuota(id, vdcInfo.poolName, vdcInfo.quota, {
    type: 'create',
    addVcpus: vcpus,
    addRamMb: ramMb,
    addStorageMb: storageMb,
    addVms: 1,
  })

  if (!quotaCheck.allowed) {
    return NextResponse.json({
      error: 'Quota exceeded',
      violations: quotaCheck.violations,
      currentUsage: quotaCheck.currentUsage,
    }, { status: 409 })
  }

  // Force pool assignment
  body.pool = vdcInfo.poolName
}
```

Note on storage parsing: PVE VM creation params have disk sizes in various formats (e.g. `scsi0: local-lvm:32` or `rootfs: local-lvm:8`). For Phase 3, do a best-effort parse. If the size can't be determined, skip storage quota check (don't block the operation).

- [ ] **Step 2: Verify node authorization**

`resolveVdcForTenant` throws if the node is not in the vDC. The try/catch in the route will catch this and return 500. Change it to return 403:

```typescript
if (vdcInfo === 'node_not_authorized') {
  return NextResponse.json({ error: 'Node not authorized for this vDC' }, { status: 403 })
}
```

Actually, better: make `resolveVdcForTenant` return a discriminated result instead of throwing. Or catch the specific error message.

- [ ] **Step 3: Commit**

---

## Task 3: Enforce on Clone

**Files:**
- Modify: `src/app/api/v1/connections/[id]/guests/[type]/[node]/[vmid]/clone/route.ts`

- [ ] **Step 1: Add vDC quota check and pool injection**

Same pattern as Task 2. After RBAC check, before pveFetch:

1. Resolve vDC for tenant
2. Estimate resources: fetch source VM config to get CPU/RAM/disk size
3. Check quota with `{ type: 'clone', addVcpus, addRamMb, addStorageMb, addVms: 1 }`
4. If blocked, return 409
5. Force `pool` in the clone params (formData)

For clones, the resource estimation requires fetching the source VM's config:
```typescript
const vmConfig = await pveFetch<any>(conn, `/nodes/${node}/${type}/${vmid}/config`)
const vcpus = (vmConfig.cores || 1) * (vmConfig.sockets || 1)
const ramMb = vmConfig.memory || 512
```

- [ ] **Step 2: Commit**

---

## Task 4: Enforce on Config Change (CPU/RAM)

**Files:**
- Modify: `src/app/api/v1/connections/[id]/guests/[type]/[node]/[vmid]/config/route.ts`

- [ ] **Step 1: Add quota check on resource increases**

Only check quotas when resources INCREASE. For this:

1. Resolve vDC for tenant
2. If vDC exists and body contains `cores`, `sockets`, `memory`, or `balloon`:
   - Fetch current VM config
   - Calculate delta (new - current)
   - If delta > 0 for any resource, check quota
3. If quota exceeded, return 409

```typescript
const tenantId = await getCurrentTenantId()
const vdcInfo = await resolveVdcForTenant(tenantId, id, node)

if (vdcInfo) {
  const currentConfig = await pveFetch<any>(conn, `/nodes/${node}/${type}/${vmid}/config`)

  const currentVcpus = (currentConfig.cores || 1) * (currentConfig.sockets || 1)
  const newVcpus = (parseInt(body.cores) || currentConfig.cores || 1) * (parseInt(body.sockets) || currentConfig.sockets || 1)
  const vcpuDelta = newVcpus - currentVcpus

  const currentRamMb = currentConfig.memory || 512
  const newRamMb = body.memory ? parseInt(body.memory) : currentRamMb
  const ramDelta = newRamMb - currentRamMb

  if (vcpuDelta > 0 || ramDelta > 0) {
    const quotaCheck = await checkVdcQuota(id, vdcInfo.poolName, vdcInfo.quota, {
      type: 'config',
      addVcpus: Math.max(0, vcpuDelta),
      addRamMb: Math.max(0, ramDelta),
      addVms: 0,
    })

    if (!quotaCheck.allowed) {
      return NextResponse.json({
        error: 'Quota exceeded',
        violations: quotaCheck.violations,
      }, { status: 409 })
    }
  }
}
```

- [ ] **Step 2: Commit**

---

## Task 5: Enforce on Disk Resize

**Files:**
- Modify: `src/app/api/v1/connections/[id]/guests/[type]/[node]/[vmid]/disk/resize/route.ts`

- [ ] **Step 1: Add storage quota check**

Disk resize is always an increase (PVE only allows growing). Check storage quota:

1. Resolve vDC for tenant
2. Parse the requested size increase from the `size` param (format: `+10G`, `+500M`, etc.)
3. Check quota with `{ type: 'resize', addStorageMb: deltaMb, addVms: 0 }`
4. If quota exceeded, return 409

```typescript
// Parse size delta: "+10G" -> 10240 MB, "+500M" -> 500 MB
function parseSizeDeltaMb(size: string): number {
  const match = size.match(/^\+?(\d+(?:\.\d+)?)(G|M|T)?$/i)
  if (!match) return 0
  const value = parseFloat(match[1])
  const unit = (match[2] || 'G').toUpperCase()
  if (unit === 'T') return value * 1024 * 1024
  if (unit === 'G') return value * 1024
  return value // MB
}
```

- [ ] **Step 2: Commit**

---

## Summary

| Task | Route | Enforcement |
|------|-------|-------------|
| 1 | New library | `resolveVdcForTenant` + `checkVdcQuota` |
| 2 | POST guests/[type]/[node] | Quota check + auto-pool on VM/LXC creation |
| 3 | POST .../clone | Quota check + auto-pool on clone |
| 4 | PUT .../config | Quota check on CPU/RAM increase |
| 5 | PUT .../disk/resize | Storage quota check on disk resize |

**What this enables:** Tenant VMs are automatically placed in the correct PVE pool. Resource consumption is checked against quotas before every creation/modification. Clear error messages when quotas are exceeded.

**Backwards compatible:** Default tenant and tenants without vDCs are not affected (no enforcement, no pool assignment).
