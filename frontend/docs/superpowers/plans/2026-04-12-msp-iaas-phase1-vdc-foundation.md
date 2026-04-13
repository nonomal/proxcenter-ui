# MSP IaaS Phase 1: vDC Foundation & MSP Roles

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create the Virtual Datacenter (vDC) data model, admin CRUD API, admin UI tab, PVE pool auto-creation, and MSP-specific roles so a super admin can allocate cluster resources to tenants with quotas.

**Architecture:** vDCs are created in SQLite (not Prisma) like other tenant-scoped tables. Each vDC maps to one tenant + one PVE cluster, with assigned nodes/storages and quotas. A PVE pool is auto-created on the cluster to provide native isolation. New MSP roles (tenant_admin, tenant_operator, tenant_viewer, provider_admin) are seeded alongside existing system roles.

**Tech Stack:** Next.js 16 API routes, SQLite (better-sqlite3), MUI 7 DataGrid + Dialog, PVE REST API (pool creation), TypeScript

**Spec reference:** `frontend/docs/superpowers/specs/2026-04-07-vdc-resource-abstraction-design.md`

**Worktree:** `/root/saas/proxcenter-frontend-msp-iaas/` (branch `feature/msp-iaas`)

---

## File Structure

### New files

| File | Responsibility |
|------|---------------|
| `src/lib/vdc/index.ts` | vDC CRUD functions, quota helpers, PVE pool management |
| `src/lib/vdc/types.ts` | TypeScript interfaces for vDC, quota, usage |
| `src/app/api/v1/admin/vdcs/route.ts` | GET (list all vDCs) + POST (create vDC) |
| `src/app/api/v1/admin/vdcs/[id]/route.ts` | GET (detail) + PUT (update) + DELETE (delete vDC) |
| `src/app/api/v1/admin/vdcs/[id]/usage/route.ts` | GET current usage for a vDC |
| `src/app/api/v1/admin/connections/[id]/available-resources/route.ts` | GET available nodes/storages for a connection |
| `src/components/settings/VdcTab.tsx` | Admin UI for vDC management (list + create/edit dialog) |

### Modified files

| File | Change |
|------|--------|
| `src/lib/db/sqlite.ts` | Add vDC tables + MSP roles seed |
| `src/app/(dashboard)/settings/page.jsx` | Add "Virtual Datacenters" tab |
| `src/messages/en.json` | Add i18n keys for vDC UI |
| `src/messages/fr.json` | Add i18n keys for vDC UI (French) |

---

## Task 1: Database Tables & MSP Roles

**Files:**
- Modify: `src/lib/db/sqlite.ts`
- Modify: `src/messages/en.json`
- Modify: `src/messages/fr.json`

- [ ] **Step 1: Add vDC tables after the multi-tenancy section**

In `src/lib/db/sqlite.ts`, find the comment `// Multi-tenancy tables` and the existing `tenants` + `user_tenants` CREATE TABLE block. After that block (after the closing `);`), add:

```typescript
  // ========================================
  // Virtual Datacenter (vDC) tables
  // ========================================
  db.exec(`
    CREATE TABLE IF NOT EXISTS vdcs (
      id              TEXT PRIMARY KEY,
      tenant_id       TEXT NOT NULL REFERENCES tenants(id),
      connection_id   TEXT NOT NULL,
      name            TEXT NOT NULL,
      slug            TEXT NOT NULL,
      description     TEXT,
      pve_pool_name   TEXT NOT NULL,
      enabled         INTEGER DEFAULT 1,
      created_by      TEXT,
      created_at      TEXT DEFAULT (datetime('now')),
      updated_at      TEXT DEFAULT (datetime('now')),
      UNIQUE(tenant_id, connection_id, slug)
    );
    CREATE INDEX IF NOT EXISTS idx_vdcs_tenant ON vdcs(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_vdcs_connection ON vdcs(connection_id);

    CREATE TABLE IF NOT EXISTS vdc_nodes (
      id              TEXT PRIMARY KEY,
      vdc_id          TEXT NOT NULL REFERENCES vdcs(id) ON DELETE CASCADE,
      node_name       TEXT NOT NULL,
      UNIQUE(vdc_id, node_name)
    );
    CREATE INDEX IF NOT EXISTS idx_vdc_nodes_vdc ON vdc_nodes(vdc_id);

    CREATE TABLE IF NOT EXISTS vdc_storages (
      id              TEXT PRIMARY KEY,
      vdc_id          TEXT NOT NULL REFERENCES vdcs(id) ON DELETE CASCADE,
      storage_id      TEXT NOT NULL,
      UNIQUE(vdc_id, storage_id)
    );
    CREATE INDEX IF NOT EXISTS idx_vdc_storages_vdc ON vdc_storages(vdc_id);

    CREATE TABLE IF NOT EXISTS vdc_quotas (
      id              TEXT PRIMARY KEY,
      vdc_id          TEXT NOT NULL UNIQUE REFERENCES vdcs(id) ON DELETE CASCADE,
      max_vcpus       INTEGER,
      max_ram_mb      INTEGER,
      max_storage_mb  INTEGER,
      max_vms         INTEGER,
      max_snapshots   INTEGER,
      max_backups     INTEGER,
      updated_at      TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS vdc_usage_cache (
      id              TEXT PRIMARY KEY,
      vdc_id          TEXT NOT NULL UNIQUE REFERENCES vdcs(id) ON DELETE CASCADE,
      used_vcpus      INTEGER DEFAULT 0,
      used_ram_mb     INTEGER DEFAULT 0,
      used_storage_mb INTEGER DEFAULT 0,
      used_vms        INTEGER DEFAULT 0,
      used_snapshots  INTEGER DEFAULT 0,
      used_backups    INTEGER DEFAULT 0,
      last_synced_at  TEXT
    );
  `)
```

- [ ] **Step 2: Add MSP roles to the roles seed array**

Find the `roles` array (around line 594) that defines system roles. Add 4 new MSP roles after `role_vm_user`:

```typescript
      {
        id: 'role_provider_admin',
        name: 'Provider Admin',
        description: 'MSP provider: full access + manages tenant identity and OIDC',
        is_system: 1,
        color: '#dc2626',
        permissions: ['*']
      },
      {
        id: 'role_tenant_admin',
        name: 'Tenant Admin',
        description: 'Tenant admin: create/delete/modify VMs, manage pools, backups, replication',
        is_system: 1,
        color: '#ea580c',
        permissions: [
          'vm.view', 'vm.console', 'vm.start', 'vm.stop', 'vm.restart', 'vm.suspend',
          'vm.snapshot', 'vm.backup', 'vm.clone', 'vm.migrate', 'vm.config', 'vm.delete', 'vm.create',
          'storage.view', 'storage.content', 'storage.upload', 'storage.delete',
          'node.view', 'connection.view',
          'backup.view', 'backup.restore', 'backup.delete',
          'backup.job.view', 'backup.job.create', 'backup.job.edit', 'backup.job.delete', 'backup.job.run',
          'events.view', 'tasks.view', 'alerts.view', 'alerts.manage',
          'automation.view', 'automation.manage', 'reports.view'
        ]
      },
      {
        id: 'role_tenant_operator',
        name: 'Tenant Operator',
        description: 'Tenant operator: start/stop/snap/move/console VMs',
        is_system: 1,
        color: '#2563eb',
        permissions: [
          'vm.view', 'vm.console', 'vm.start', 'vm.stop', 'vm.restart', 'vm.suspend',
          'vm.snapshot', 'vm.migrate',
          'node.view', 'connection.view', 'backup.view',
          'events.view', 'tasks.view', 'alerts.view', 'reports.view'
        ]
      },
      {
        id: 'role_tenant_viewer',
        name: 'Tenant Viewer',
        description: 'Tenant read-only: view VMs, console access only',
        is_system: 1,
        color: '#6b7280',
        permissions: [
          'vm.view', 'vm.console',
          'node.view', 'connection.view', 'backup.view',
          'events.view', 'tasks.view', 'alerts.view', 'reports.view'
        ]
      },
```

- [ ] **Step 3: Fix wildcard role permission sync**

Find the block that ensures super_admin has all permissions (around line 685). Replace the single-role block with a multi-role version that also covers `role_provider_admin`:

Replace:
```typescript
    const superAdminRole = db.prepare("SELECT id FROM rbac_roles WHERE id = 'role_super_admin'").get() as any
    if (superAdminRole) {
      const allPerms = db.prepare('SELECT id FROM rbac_permissions').all() as any[]
      const insertRolePerm = db.prepare(
        'INSERT OR IGNORE INTO rbac_role_permissions (role_id, permission_id) VALUES (?, ?)'
      )
      for (const p of allPerms) {
        insertRolePerm.run('role_super_admin', p.id)
      }
    }
```

With:
```typescript
    const wildcardRoles = db.prepare("SELECT id FROM rbac_roles WHERE id IN ('role_super_admin', 'role_provider_admin')").all() as any[]
    const allPerms = db.prepare('SELECT id FROM rbac_permissions').all() as any[]
    const insertRolePerm = db.prepare(
      'INSERT OR IGNORE INTO rbac_role_permissions (role_id, permission_id) VALUES (?, ?)'
    )
    for (const role of wildcardRoles) {
      for (const p of allPerms) {
        insertRolePerm.run(role.id, p.id)
      }
    }
```

- [ ] **Step 4: Add MSP role permissions to rolePermMap sync**

Find the `rolePermMap` object (around line 702). Add the 3 new non-wildcard MSP roles:

```typescript
      role_tenant_admin: [
        'vm.view', 'vm.console', 'vm.start', 'vm.stop', 'vm.restart', 'vm.suspend',
        'vm.snapshot', 'vm.backup', 'vm.clone', 'vm.migrate', 'vm.config', 'vm.delete', 'vm.create',
        'storage.view', 'storage.content', 'storage.upload', 'storage.delete',
        'node.view', 'connection.view',
        'backup.view', 'backup.restore', 'backup.delete',
        'backup.job.view', 'backup.job.create', 'backup.job.edit', 'backup.job.delete', 'backup.job.run',
        'events.view', 'tasks.view', 'alerts.view', 'alerts.manage',
        'automation.view', 'automation.manage', 'reports.view'
      ],
      role_tenant_operator: [
        'vm.view', 'vm.console', 'vm.start', 'vm.stop', 'vm.restart', 'vm.suspend',
        'vm.snapshot', 'vm.migrate',
        'node.view', 'connection.view', 'backup.view',
        'events.view', 'tasks.view', 'alerts.view', 'reports.view'
      ],
      role_tenant_viewer: [
        'vm.view', 'vm.console',
        'node.view', 'connection.view', 'backup.view',
        'events.view', 'tasks.view', 'alerts.view', 'reports.view'
      ],
```

- [ ] **Step 5: Add MSP role i18n keys**

In `src/messages/en.json`, in `rbac.roles` add:
```json
"role_provider_admin": "Provider Admin",
"role_tenant_admin": "Tenant Admin",
"role_tenant_operator": "Tenant Operator",
"role_tenant_viewer": "Tenant Viewer"
```

In `rbac.roleDesc` add:
```json
"role_provider_admin": "MSP provider with full access and tenant identity management",
"role_tenant_admin": "Full VM and backup administration within tenant scope",
"role_tenant_operator": "Day-to-day VM operations (start, stop, console, snapshots)",
"role_tenant_viewer": "Read-only access with console to assigned VMs"
```

Same in `src/messages/fr.json` with French translations.

- [ ] **Step 6: Verify DB initialization**

```bash
rm -f frontend/data/proxcenter.db
# Restart dev server, then:
sqlite3 frontend/data/proxcenter.db ".tables" | grep vdc
# Expected: vdc_nodes vdc_quotas vdc_storages vdc_usage_cache vdcs
sqlite3 frontend/data/proxcenter.db "SELECT id, name FROM rbac_roles WHERE id LIKE 'role_tenant%' OR id = 'role_provider_admin'"
# Expected: 4 MSP roles
```

- [ ] **Step 7: Commit**

```bash
git add src/lib/db/sqlite.ts src/messages/en.json src/messages/fr.json
git commit -m "feat(vdc): add vDC database tables and MSP roles seed"
```

---

## Task 2: vDC Type Definitions

**Files:**
- Create: `src/lib/vdc/types.ts`

- [ ] **Step 1: Create types file**

```typescript
// src/lib/vdc/types.ts

export interface Vdc {
  id: string
  tenantId: string
  connectionId: string
  name: string
  slug: string
  description: string | null
  pvePoolName: string
  enabled: boolean
  createdBy: string | null
  createdAt: string
  updatedAt: string
}

export interface VdcWithDetails extends Vdc {
  tenantName?: string
  connectionName?: string
  nodes: string[]
  storages: string[]
  quota: VdcQuota | null
  usage: VdcUsage | null
}

export interface VdcQuota {
  maxVcpus: number | null
  maxRamMb: number | null
  maxStorageMb: number | null
  maxVms: number | null
  maxSnapshots: number | null
  maxBackups: number | null
}

export interface VdcUsage {
  usedVcpus: number
  usedRamMb: number
  usedStorageMb: number
  usedVms: number
  usedSnapshots: number
  usedBackups: number
  lastSyncedAt: string | null
}

export interface CreateVdcInput {
  tenantId: string
  connectionId: string
  name: string
  slug: string
  description?: string
  nodes: string[]
  storages: string[]
  quota?: Partial<VdcQuota>
}

export interface UpdateVdcInput {
  name?: string
  description?: string
  enabled?: boolean
  nodes?: string[]
  storages?: string[]
  quota?: Partial<VdcQuota>
}
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/vdc/types.ts
git commit -m "feat(vdc): add vDC TypeScript type definitions"
```

---

## Task 3: vDC CRUD Library

**Files:**
- Create: `src/lib/vdc/index.ts`

- [ ] **Step 1: Create the vDC library**

Create `src/lib/vdc/index.ts` with these exported functions:

| Function | Purpose |
|----------|---------|
| `listVdcs(tenantId?)` | List all vDCs (optionally filtered by tenant). Joins tenant name, loads nodes/storages/quota/usage. |
| `getVdcById(id)` | Get single vDC with all details |
| `createVdc(input, createdBy)` | Create vDC: validate slug uniqueness, create PVE pool via API, insert vDC + nodes + storages + quota + usage cache in a transaction |
| `updateVdc(id, input)` | Update vDC fields, replace nodes/storages arrays, upsert quota. All in a transaction. |
| `deleteVdc(id)` | Check PVE pool has no VMs, delete PVE pool (best effort), delete from DB (CASCADE) |
| `refreshVdcUsage(vdcId)` | Query PVE pool members, sum vCPUs/RAM/storage/VMs/snapshots, upsert usage cache |

Key implementation details:
- PVE pool name generated as `vdc-{tenant_slug}-{vdc_slug}`
- `createVdc` calls `pveFetch(conn, '/pools', { method: 'POST' })` to create the PVE pool
- `deleteVdc` calls `pveFetch(conn, '/pools/{name}', { method: 'DELETE' })` after verifying no VMs remain
- `refreshVdcUsage` fetches `/pools/{name}` to get pool members, sums resources, counts snapshots per VM
- All DB writes use `db.transaction()` for atomicity
- Import `getConnectionById` with explicit tenantId from the vDC record (not from session) since admin manages cross-tenant

The implementing agent should read `src/lib/tenant/index.ts` for the exact SQLite patterns (prepared statements, row mapping, transaction usage) and `src/lib/proxmox/client.ts` for `pveFetch` signature.

- [ ] **Step 2: Commit**

```bash
git add src/lib/vdc/
git commit -m "feat(vdc): add vDC CRUD library with PVE pool integration"
```

---

## Task 4: Available Resources API

**Files:**
- Create: `src/app/api/v1/admin/connections/[id]/available-resources/route.ts`

- [ ] **Step 1: Create the route**

GET endpoint that returns nodes and storages for a PVE connection. Protected by `PERMISSIONS.ADMIN_SETTINGS`.

- Fetch `/nodes` from PVE: return `{ name, status, cpu, maxcpu, mem, maxmem }`
- Fetch `/storage` from PVE: return `{ id, type, content, shared, nodes }`
- Fetch `/pools` from PVE: return pool names (to show what's already allocated)

Return shape: `{ data: { nodes: [...], storages: [...], pools: [...] } }`

- [ ] **Step 2: Commit**

```bash
git add "src/app/api/v1/admin/connections/[id]/available-resources/"
git commit -m "feat(vdc): add available-resources API endpoint"
```

---

## Task 5: Admin vDC API Routes

**Files:**
- Create: `src/app/api/v1/admin/vdcs/route.ts`
- Create: `src/app/api/v1/admin/vdcs/[id]/route.ts`
- Create: `src/app/api/v1/admin/vdcs/[id]/usage/route.ts`

- [ ] **Step 1: Create list + create route** (`route.ts`)

- `GET /api/v1/admin/vdcs?tenantId=xxx` — calls `listVdcs(tenantId)`, protected by `PERMISSIONS.ADMIN_SETTINGS`
- `POST /api/v1/admin/vdcs` — validates required fields (tenantId, connectionId, name, slug, nodes, storages), slug format (`/^[a-z0-9-]+$/`), calls `createVdc()`, logs audit

- [ ] **Step 2: Create detail + update + delete route** (`[id]/route.ts`)

- `GET /api/v1/admin/vdcs/{id}` — calls `getVdcById(id)`
- `PUT /api/v1/admin/vdcs/{id}` — calls `updateVdc(id, body)`, logs audit
- `DELETE /api/v1/admin/vdcs/{id}` — calls `deleteVdc(id)`, returns 409 if VMs exist, logs audit

- [ ] **Step 3: Create usage route** (`[id]/usage/route.ts`)

- `GET /api/v1/admin/vdcs/{id}/usage?refresh=true` — returns quota + usage. If `refresh=true` or no `lastSyncedAt`, calls `refreshVdcUsage(id)` first.

- [ ] **Step 4: Verify API with curl**

```bash
# List vDCs (empty)
curl -s -b "$AUTH" http://localhost:3000/api/v1/admin/vdcs | jq .
# List resources for a connection
curl -s -b "$AUTH" http://localhost:3000/api/v1/admin/connections/<CONN_ID>/available-resources | jq .
```

- [ ] **Step 5: Commit**

```bash
git add src/app/api/v1/admin/vdcs/
git commit -m "feat(vdc): add admin vDC CRUD API routes"
```

---

## Task 6: i18n Keys

**Files:**
- Modify: `src/messages/en.json`
- Modify: `src/messages/fr.json`

- [ ] **Step 1: Add vDC i18n section**

Add a top-level `"vdc"` key in both language files with all labels needed for the admin UI: title, subtitle, form fields (name, slug, description, tenant, connection, nodes, storages), quota labels (maxVcpus, maxRam, maxStorage, maxVms, maxSnapshots, maxBackups), usage labels, empty state, confirmations, success/error messages.

Key entries (EN):
- `vdc.title` = "Virtual Datacenters"
- `vdc.create` = "Create vDC"
- `vdc.pvePoolPreview` = "Pool name: {pool}"
- `vdc.quotaUnlimited` = "Unlimited"
- `vdc.usedOf` = "{used} / {total}"
- `vdc.deleteBlocked` = "Cannot delete: VMs still exist in this vDC."
- `vdc.noVdcs` = "No Virtual Datacenters configured"

See the vDC spec for the full UI text requirements.

- [ ] **Step 2: Commit**

```bash
git add src/messages/en.json src/messages/fr.json
git commit -m "feat(vdc): add i18n keys for vDC admin UI"
```

---

## Task 7: Admin UI - VdcTab Component

**Files:**
- Create: `src/components/settings/VdcTab.tsx`
- Modify: `src/app/(dashboard)/settings/page.jsx`

- [ ] **Step 1: Create VdcTab component**

Create `src/components/settings/VdcTab.tsx` following the exact patterns from `TenantsTab.tsx` and `ConnectionsTab.tsx`. Structure:

**State:**
- `vdcs: VdcWithDetails[]` — fetched from `GET /api/v1/admin/vdcs`
- `editingVdc: VdcWithDetails | null` — null = create mode, non-null = edit mode
- `dialogOpen: boolean`
- `form: { name, slug, description, tenantId, connectionId, nodes: string[], storages: string[], quota: {...} }`
- `availableResources: { nodes: [...], storages: [...], pools: [...] } | null`
- `tenants: Tenant[]` — from `GET /api/v1/tenants`
- `connections: Connection[]` — from `GET /api/v1/connections`
- `deleteConfirmVdc: VdcWithDetails | null`

**Main view (DataGrid):**
- Columns: name, tenant (tenantName), cluster (connectionId lookup), nodes count, quota gauges (CPU/RAM/Storage as LinearProgress), enabled (Chip), actions (edit/delete IconButtons)
- "Create vDC" button in toolbar
- Empty state when no vDCs

**Create/Edit Dialog (MUI Dialog, ~600px wide):**
1. Name field (TextField)
2. Slug field (TextField) — auto-generated from name on create, readonly on edit
3. Description field (TextField, multiline)
4. Tenant selector (Autocomplete) — disabled on edit
5. Connection selector (Autocomplete) — disabled on edit. On change: fetch available-resources
6. Nodes section: list of checkboxes with node name + CPU/RAM metrics
7. Storages section: list of checkboxes with storage name + type + shared badge
8. Quotas section: 6 fields (vCPUs, RAM GB, Storage GB, VMs, Snapshots, Backups) each with "unlimited" Switch toggle
9. PVE pool name preview: `vdc-{tenantSlug}-{vdcSlug}` shown as read-only Chip
10. Submit button: "Create" or "Save"

**Quota gauges in DataGrid:**
- Use `LinearProgress` with `variant="determinate"`
- Color: green if < 70%, orange (warning) if < 90%, red (error) if >= 90%
- Show "N/A" if no quota set (unlimited)
- Show "{used}/{max}" label

**Delete Dialog:**
- MUI Dialog with warning text mentioning PVE pool name
- Blocked (button disabled + warning) if `usage.usedVms > 0`

- [ ] **Step 2: Register tab in Settings page**

In `src/app/(dashboard)/settings/page.jsx`, add import and tab entry:

```javascript
import VdcTab from '@/components/settings/VdcTab'
```

In the `allTabs` array, add BEFORE the Tenants tab entry:

```javascript
{
  label: t('vdc.title'),
  icon: 'ri-cloud-line',
  component: VdcTab,
  requiredFeature: Features.MULTI_TENANCY,
  superAdminOnly: true,
},
```

- [ ] **Step 3: Verify in browser**

1. Navigate to `/settings`, verify "Virtual Datacenters" tab appears
2. Click it, verify empty state
3. Click "Create vDC", fill tenant + connection, verify nodes/storages load
4. Create a vDC, verify it appears in list with quota gauges
5. Edit a vDC, modify quotas, verify update
6. Check PVE: `pvesh get /pools` should show the auto-created pool
7. Try delete — should work if no VMs in pool

- [ ] **Step 4: Commit**

```bash
git add src/components/settings/VdcTab.tsx "src/app/(dashboard)/settings/page.jsx"
git commit -m "feat(vdc): add Virtual Datacenters admin UI tab in Settings"
```

---

## Summary

| Deliverable | Task |
|-------------|------|
| vDC database tables (5 tables) | 1 |
| MSP roles (4 new system roles) | 1 |
| vDC TypeScript types | 2 |
| vDC CRUD library with PVE pool integration | 3 |
| Available resources API endpoint | 4 |
| Admin vDC CRUD API (list/create/get/update/delete/usage) | 5 |
| i18n keys (EN + FR) | 6 |
| Admin UI tab (Settings > Virtual Datacenters) | 7 |

**What this enables:** A super admin can create tenants, allocate cluster nodes/storages to vDCs with quotas, and see usage. PVE pools are auto-created for native isolation.

**Next phases:**
- **Phase 2:** vDC filtering middleware (tenant users only see their vDC resources)
- **Phase 3:** Quota enforcement on VM creation/modification
- **Phase 4:** Per-tenant metrics dashboard widgets
