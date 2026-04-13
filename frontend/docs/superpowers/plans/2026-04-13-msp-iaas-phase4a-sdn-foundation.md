# MSP IaaS Phase 4a: SDN Foundation (admin-only) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ajouter la fondation SDN au modèle vDC: 1 zone VXLAN auto-créée par vDC, support de bridges partagés (uplinks autorisés par l'admin), quota `max_vnets`, et l'infrastructure DB + lib + endpoints admin nécessaires. Pas de surface tenant-facing dans cette phase.

**Architecture:** 2 nouvelles tables SQLite (`vdc_shared_bridges`, `vdc_vnets`), 1 colonne ajoutée à `vdcs` (`sdn_zone_name`), 1 colonne à `vdc_quotas` (`max_vnets`), 5 permissions RBAC. Nouveau module `src/lib/vdc/sdn.ts` pour CRUD zone/VNet côté PVE. Hooks dans `createVdc()` / `deleteVdc()` existants. Extension de `VdcScope` avec `vnetsByConnection` + `sharedBridgesByConnection`. UI admin `VdcTab` étendue (section Shared bridges + champ `max_vnets`).

**Tech Stack:** Next.js 16 API routes, SQLite (better-sqlite3), TypeScript, MUI 7 Checkbox/TextField, PVE REST API (`/cluster/sdn/*`), `node --test`.

**Spec reference:** `frontend/docs/superpowers/specs/2026-04-13-vdc-sdn-vnets-design.md`

**Worktree:** `/root/saas/proxcenter-frontend-msp-iaas/` (branche `feature/msp-iaas`)

**Dépendances:** Phases 1, 2, 3 doivent être mergées OU présentes dans la même branche (le code actuel de la branche `feature/msp-iaas` les contient en working copy).

---

## File Structure

### New files

| File | Responsibility |
|------|---------------|
| `src/lib/vdc/sdn.ts` | CRUD zone VXLAN + VNet via PVE API, allocation VNI, reconcile, generateZoneName |
| `src/lib/vdc/sdn.test.ts` | Tests unitaires Node test runner |
| `src/app/api/v1/admin/connections/[id]/provider-bridges/route.ts` | GET bridges physiques détectés sur le cluster |
| `src/app/api/v1/admin/vdcs/[id]/shared-bridges/route.ts` | GET, PUT bridges partagés d'un vDC |

### Modified files

| File | Change |
|------|--------|
| `src/lib/db/sqlite.ts` | + tables `vdc_shared_bridges`, `vdc_vnets`; + col `vdcs.sdn_zone_name` + index unique; + col `vdc_quotas.max_vnets`; + 5 permissions `sdn.vnet.*`; + attributions roles |
| `src/lib/vdc/types.ts` | + types `VdcSharedBridge`, `VdcVnet`, `SdnZone`, `SdnVnet`; extension `VdcQuota` avec `maxVnets`; extension `Vdc` avec `sdnZoneName`; extension `VdcWithDetails` avec `sharedBridges`, `vnets` |
| `src/lib/vdc/index.ts` | `createVdc()` crée la zone SDN; `deleteVdc()` supprime VNets + zone; `listVdcs()` joint les nouvelles relations; sérialisation `sdnZoneName` |
| `src/lib/vdc/scope.ts` | Ajout de `vnetsByConnection` et `sharedBridgesByConnection` à `VdcScope` |
| `src/components/settings/VdcTab.tsx` | Section "Shared bridges" dans dialog Create/Edit + champ `max_vnets` dans quotas |
| `src/messages/en.json` | Clés i18n pour nouveaux labels admin |
| `src/messages/fr.json` | Même chose en français |

---

## Task 1: Database Schema Extensions

**Files:**
- Modify: `src/lib/db/sqlite.ts`

- [ ] **Step 1: Add `vdc_shared_bridges` and `vdc_vnets` tables**

Open `src/lib/db/sqlite.ts`. Locate the existing multi-statement SQL block that creates `vdc_nodes`, `vdc_storages`, `vdc_quotas`, `vdc_usage_cache` (around line 380-420). Immediately after the closing `);` of `vdc_usage_cache`, inside the SAME SQL block, add:

```sql
    CREATE TABLE IF NOT EXISTS vdc_shared_bridges (
      id         TEXT PRIMARY KEY,
      vdc_id     TEXT NOT NULL REFERENCES vdcs(id) ON DELETE CASCADE,
      bridge     TEXT NOT NULL,
      label      TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(vdc_id, bridge)
    );
    CREATE INDEX IF NOT EXISTS idx_vdc_shared_bridges_vdc ON vdc_shared_bridges(vdc_id);

    CREATE TABLE IF NOT EXISTS vdc_vnets (
      id          TEXT PRIMARY KEY,
      vdc_id      TEXT NOT NULL REFERENCES vdcs(id) ON DELETE CASCADE,
      pve_name    TEXT NOT NULL,
      description TEXT,
      vxlan_tag   INTEGER NOT NULL,
      firewall    INTEGER DEFAULT 1,
      created_by  TEXT,
      created_at  TEXT DEFAULT (datetime('now')),
      UNIQUE(vdc_id, pve_name),
      UNIQUE(vdc_id, vxlan_tag)
    );
    CREATE INDEX IF NOT EXISTS idx_vdc_vnets_vdc ON vdc_vnets(vdc_id);
```

- [ ] **Step 2: Add `max_vnets` column to `vdc_quotas` (idempotent migration)**

Right after the block that creates vDC tables, add an idempotent column migration. Use the same try/catch pattern that handles "duplicate column" errors. Append this code:

```typescript
  // Phase 4a migration: vdc_quotas.max_vnets (nullable = unlimited)
  try {
    db.prepare('ALTER TABLE vdc_quotas ADD COLUMN max_vnets INTEGER').run()
  } catch (e: any) {
    if (!String(e?.message || '').includes('duplicate column')) {
      throw e
    }
  }
```

- [ ] **Step 3: Add `sdn_zone_name` column to `vdcs`**

Append right after the `max_vnets` migration:

```typescript
  // Phase 4a migration: vdcs.sdn_zone_name + unique index per connection
  try {
    db.prepare('ALTER TABLE vdcs ADD COLUMN sdn_zone_name TEXT').run()
  } catch (e: any) {
    if (!String(e?.message || '').includes('duplicate column')) {
      throw e
    }
  }
  db.prepare(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_vdcs_sdn_zone_name ON vdcs(connection_id, sdn_zone_name)'
  ).run()
```

Note: SQLite allows multiple NULL values in a UNIQUE column so pre-migration vDCs (null `sdn_zone_name`) do not collide.

- [ ] **Step 4: Seed the 5 new SDN permissions**

Find the block that inserts permissions (search for `INSERT OR IGNORE INTO rbac_permissions`, around line 638). Locate the array of permission definitions. Add these entries to that array (match the existing object shape):

```typescript
    { id: 'sdn.vnet.view',     name: 'View SDN VNets',       category: 'SDN', description: 'List and view VNets in own vDCs', is_dangerous: 0 },
    { id: 'sdn.vnet.create',   name: 'Create SDN VNets',     category: 'SDN', description: 'Create new VNets in own vDCs', is_dangerous: 0 },
    { id: 'sdn.vnet.edit',     name: 'Edit SDN VNets',       category: 'SDN', description: 'Edit VNet metadata and firewall toggle', is_dangerous: 0 },
    { id: 'sdn.vnet.delete',   name: 'Delete SDN VNets',     category: 'SDN', description: 'Delete VNets that have no NIC attached', is_dangerous: 1 },
    { id: 'sdn.vnet.firewall', name: 'Manage VNet firewall', category: 'SDN', description: 'CRUD firewall rules, ipsets, aliases per VNet', is_dangerous: 1 },
```

If the existing array uses `is_system: 1` or other fields, match that shape — the important part is the 5 IDs, their `name`, `category: 'SDN'`, and `description`.

- [ ] **Step 5: Attribute SDN permissions to MSP roles**

Find the `rolePermMap` object added in Phase 1 (search for `role_tenant_admin:` key). Extend each MSP role to include the SDN permissions:

```typescript
      role_tenant_admin: [
        // ... existing permissions ...
        'sdn.vnet.view', 'sdn.vnet.create', 'sdn.vnet.edit', 'sdn.vnet.delete', 'sdn.vnet.firewall',
      ],
      role_tenant_operator: [
        // ... existing permissions ...
        'sdn.vnet.view',
      ],
      role_tenant_viewer: [
        // ... existing permissions ...
        'sdn.vnet.view',
      ],
```

`role_provider_admin` and `role_super_admin` have wildcard `*` so they already cover these.

Apply the same permissions to the role definitions array used at seed time (where you pasted the MSP role objects in Phase 1 — the `permissions: [...]` field on `role_tenant_admin`, etc.).

- [ ] **Step 6: Verify migrations apply cleanly**

```bash
cd frontend
rm -f data/proxcenter.db
pnpm dev &  # let it run for a couple seconds to init the DB
sleep 3
kill %1 2>/dev/null || true
```

Then inspect:

```bash
sqlite3 frontend/data/proxcenter.db ".schema vdc_shared_bridges"
sqlite3 frontend/data/proxcenter.db ".schema vdc_vnets"
sqlite3 frontend/data/proxcenter.db "PRAGMA table_info(vdc_quotas)" | grep max_vnets
sqlite3 frontend/data/proxcenter.db "PRAGMA table_info(vdcs)" | grep sdn_zone_name
sqlite3 frontend/data/proxcenter.db "SELECT id FROM rbac_permissions WHERE id LIKE 'sdn.vnet.%'"
```

Expected:
- Both tables exist with all columns listed.
- `max_vnets` row present in `vdc_quotas` PRAGMA output.
- `sdn_zone_name` row present in `vdcs` PRAGMA output.
- 5 permission IDs listed.

- [ ] **Step 7: Commit**

```bash
git add src/lib/db/sqlite.ts
git commit -m "feat(vdc-sdn): add SDN tables, columns and permissions (Phase 4a)"
```

---

## Task 2: Type Extensions

**Files:**
- Modify: `src/lib/vdc/types.ts`

- [ ] **Step 1: Add new types**

Open `src/lib/vdc/types.ts`. After the existing `VdcUsage` interface, add:

```typescript
export interface VdcSharedBridge {
  id: string
  vdcId: string
  bridge: string
  label: string | null
  createdAt: string
}

export interface VdcVnet {
  id: string
  vdcId: string
  pveName: string
  description: string | null
  vxlanTag: number
  firewall: boolean
  createdBy: string | null
  createdAt: string
}

// PVE-native shapes used by lib/vdc/sdn.ts
export interface SdnZone {
  zone: string
  type: 'vxlan'
  peers: string[]
}

export interface SdnVnet {
  vnet: string
  zone: string
  tag: number
  firewall: 0 | 1
}
```

- [ ] **Step 2: Extend `Vdc` with `sdnZoneName`**

```typescript
export interface Vdc {
  id: string
  tenantId: string
  connectionId: string
  name: string
  slug: string
  description: string | null
  pvePoolName: string
  sdnZoneName: string | null   // <-- new
  enabled: boolean
  createdBy: string | null
  createdAt: string
  updatedAt: string
}
```

- [ ] **Step 3: Extend `VdcQuota` with `maxVnets`**

```typescript
export interface VdcQuota {
  maxVcpus: number | null
  maxRamMb: number | null
  maxStorageMb: number | null
  maxVms: number | null
  maxSnapshots: number | null
  maxBackups: number | null
  maxVnets: number | null      // <-- new
}
```

- [ ] **Step 4: Extend `VdcWithDetails`**

```typescript
export interface VdcWithDetails extends Vdc {
  tenantName?: string
  connectionName?: string
  nodes: string[]
  storages: string[]
  quota: VdcQuota | null
  usage: VdcUsage | null
  sharedBridges: VdcSharedBridge[]   // <-- new
  vnets: VdcVnet[]                   // <-- new
}
```

- [ ] **Step 5: Extend `CreateVdcInput` and `UpdateVdcInput`**

```typescript
export interface CreateVdcInput {
  tenantId: string
  connectionId: string
  name: string
  slug: string
  description?: string
  nodes: string[]
  storages: string[]
  quota?: Partial<VdcQuota>
  sharedBridges?: Array<{ bridge: string; label?: string }>  // <-- new
}

export interface UpdateVdcInput {
  name?: string
  description?: string
  enabled?: boolean
  nodes?: string[]
  storages?: string[]
  quota?: Partial<VdcQuota>
  sharedBridges?: Array<{ bridge: string; label?: string }>  // <-- new
}
```

- [ ] **Step 6: Commit**

```bash
git add src/lib/vdc/types.ts
git commit -m "feat(vdc-sdn): extend types with shared bridges, vnets and sdn zone (Phase 4a)"
```

---

## Task 3: SDN Lib — Zone Name Generator (TDD)

**Files:**
- Create: `src/lib/vdc/sdn.ts`
- Create: `src/lib/vdc/sdn.test.ts`

- [ ] **Step 1: Write failing test for `generateZoneName`**

Create `src/lib/vdc/sdn.test.ts`:

```typescript
import { test } from 'node:test'
import assert from 'node:assert/strict'
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

test('generateZoneName: strips hyphens, prefixes with z', () => {
  const db = newDb()
  const name = generateZoneNameForTesting(db, 'conn1', { id: 'vdc-1', slug: 'acme-prod' })
  assert.equal(name, 'zacmeprod')
})

test('generateZoneName: truncates long slugs to 14 chars after z', () => {
  const db = newDb()
  const name = generateZoneNameForTesting(db, 'conn1', { id: 'vdc-2', slug: 'very-long-slug-name' })
  assert.equal(name, 'zverylongslugn')
  assert.equal(name.length, 15)
})

test('generateZoneName: collision suffix uses sha1(vdc.id)[:2]', () => {
  const db = newDb()
  db.prepare(
    'INSERT INTO vdcs (id, connection_id, slug, sdn_zone_name) VALUES (?, ?, ?, ?)'
  ).run('other-vdc', 'conn1', 'acme-prod', 'zacmeprod')

  const name = generateZoneNameForTesting(db, 'conn1', { id: 'vdc-3', slug: 'acme-prod' })
  const hash = crypto.createHash('sha1').update('vdc-3').digest('hex').slice(0, 2)
  assert.equal(name, 'zacmeprod' + hash)
})
```

- [ ] **Step 2: Run test and verify FAIL**

```bash
cd frontend
node --test --experimental-strip-types src/lib/vdc/sdn.test.ts
```

Expected: FAIL (module not found or export not defined).

- [ ] **Step 3: Create `src/lib/vdc/sdn.ts` with the generator**

```typescript
// src/lib/vdc/sdn.ts
// Proxmox SDN zone + VNet CRUD for vDCs.

import crypto from 'crypto'

import { getDb } from '@/lib/db/sqlite'
import { pveFetch } from '@/lib/proxmox/client'

import type { SdnVnet } from './types'

// ---------------------------------------------------------------------------
// Zone name generation
// ---------------------------------------------------------------------------

function stripSlug(slug: string): string {
  return slug.replace(/-/g, '').slice(0, 14)
}

interface ZoneNameInput { id: string; slug: string }

function generateZoneNameImpl(db: any, connectionId: string, vdc: ZoneNameInput): string {
  const base = 'z' + stripSlug(vdc.slug)

  const existing = db
    .prepare('SELECT sdn_zone_name FROM vdcs WHERE connection_id = ? AND sdn_zone_name = ?')
    .get(connectionId, base)

  if (!existing) return base

  const hash = crypto.createHash('sha1').update(vdc.id).digest('hex').slice(0, 2)
  const withSuffix = 'z' + stripSlug(vdc.slug).slice(0, 12) + hash

  const collision2 = db
    .prepare('SELECT sdn_zone_name FROM vdcs WHERE connection_id = ? AND sdn_zone_name = ?')
    .get(connectionId, withSuffix)

  if (collision2) {
    throw new Error(`Cannot generate unique SDN zone name for vDC ${vdc.id} (slug=${vdc.slug})`)
  }
  return withSuffix
}

/** @internal exported only for testing */
export function generateZoneNameForTesting(db: any, connectionId: string, vdc: ZoneNameInput): string {
  return generateZoneNameImpl(db, connectionId, vdc)
}

export function generateZoneName(connectionId: string, vdc: ZoneNameInput): string {
  return generateZoneNameImpl(getDb(), connectionId, vdc)
}
```

- [ ] **Step 4: Run tests and verify PASS**

```bash
node --test --experimental-strip-types src/lib/vdc/sdn.test.ts
```

Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/vdc/sdn.ts src/lib/vdc/sdn.test.ts
git commit -m "feat(vdc-sdn): add generateZoneName with collision-safe hash (Phase 4a)"
```

---

## Task 4: SDN Lib — VNI Allocator (TDD)

**Files:**
- Modify: `src/lib/vdc/sdn.ts`
- Modify: `src/lib/vdc/sdn.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `src/lib/vdc/sdn.test.ts`:

```typescript
import { allocateVniForTesting } from './sdn'

function newVnetDb(): any {
  const db = new Database(':memory:')
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

test('allocateVni: first VNet in vDC returns 10000', () => {
  const db = newVnetDb()
  const tag = allocateVniForTesting(db, 'vdc-1')
  assert.equal(tag, 10000)
})

test('allocateVni: subsequent VNets increment from max', () => {
  const db = newVnetDb()
  db.prepare('INSERT INTO vdc_vnets (id, vdc_id, pve_name, vxlan_tag) VALUES (?, ?, ?, ?)')
    .run('x', 'vdc-1', 'prodlan', 10000)
  db.prepare('INSERT INTO vdc_vnets (id, vdc_id, pve_name, vxlan_tag) VALUES (?, ?, ?, ?)')
    .run('y', 'vdc-1', 'dmz', 10001)

  const tag = allocateVniForTesting(db, 'vdc-1')
  assert.equal(tag, 10002)
})

test('allocateVni: skips holes, uses max+1', () => {
  const db = newVnetDb()
  db.prepare('INSERT INTO vdc_vnets (id, vdc_id, pve_name, vxlan_tag) VALUES (?, ?, ?, ?)')
    .run('x', 'vdc-1', 'prodlan', 10000)
  db.prepare('INSERT INTO vdc_vnets (id, vdc_id, pve_name, vxlan_tag) VALUES (?, ?, ?, ?)')
    .run('y', 'vdc-1', 'dmz', 10005)

  const tag = allocateVniForTesting(db, 'vdc-1')
  assert.equal(tag, 10006)
})

test('allocateVni: isolated per vdc', () => {
  const db = newVnetDb()
  db.prepare('INSERT INTO vdc_vnets (id, vdc_id, pve_name, vxlan_tag) VALUES (?, ?, ?, ?)')
    .run('x', 'vdc-A', 'prodlan', 10042)

  const tag = allocateVniForTesting(db, 'vdc-B')
  assert.equal(tag, 10000)
})
```

- [ ] **Step 2: Verify FAIL**

```bash
node --test --experimental-strip-types src/lib/vdc/sdn.test.ts
```

Expected: 4 new tests fail with missing export.

- [ ] **Step 3: Implement `allocateVni`**

Append to `src/lib/vdc/sdn.ts`:

```typescript
// ---------------------------------------------------------------------------
// VNI allocation (local per vDC)
// ---------------------------------------------------------------------------

const VNI_BASE = 10000

function allocateVniImpl(db: any, vdcId: string): number {
  const row = db
    .prepare('SELECT MAX(vxlan_tag) AS max_tag FROM vdc_vnets WHERE vdc_id = ?')
    .get(vdcId) as { max_tag: number | null } | undefined

  const maxTag = row?.max_tag ?? null
  return maxTag === null ? VNI_BASE : maxTag + 1
}

/** @internal exported only for testing */
export function allocateVniForTesting(db: any, vdcId: string): number {
  return allocateVniImpl(db, vdcId)
}

export function allocateVni(vdcId: string): number {
  return allocateVniImpl(getDb(), vdcId)
}
```

- [ ] **Step 4: Verify PASS**

```bash
node --test --experimental-strip-types src/lib/vdc/sdn.test.ts
```

Expected: all 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/vdc/sdn.ts src/lib/vdc/sdn.test.ts
git commit -m "feat(vdc-sdn): add allocateVni (local per vDC, base 10000) (Phase 4a)"
```

---

## Task 5: SDN Lib — Zone CRUD + applySdn

**Files:**
- Modify: `src/lib/vdc/sdn.ts`

- [ ] **Step 1: Add zone CRUD**

Append to `src/lib/vdc/sdn.ts`:

```typescript
// ---------------------------------------------------------------------------
// PVE SDN: apply pending changes
// ---------------------------------------------------------------------------

/**
 * Applies pending SDN changes: triggers ifreload on every node.
 * Should be called once at the end of a batch of SDN mutations.
 */
export async function applySdn(conn: any): Promise<void> {
  await pveFetch(conn, '/cluster/sdn', { method: 'PUT' })
}

// ---------------------------------------------------------------------------
// Zone CRUD
// ---------------------------------------------------------------------------

async function listClusterNodeIps(conn: any): Promise<string[]> {
  const entries = await pveFetch<any[]>(conn, '/cluster/status')
  return (entries || [])
    .filter((e: any) => e.type === 'node' && e.ip)
    .map((e: any) => e.ip as string)
}

/**
 * Creates a VXLAN zone on PVE. Caller must invoke applySdn(conn) afterwards.
 */
export async function createZone(conn: any, zoneName: string): Promise<void> {
  const peers = await listClusterNodeIps(conn)
  const params = new URLSearchParams()
  params.append('type', 'vxlan')
  params.append('zone', zoneName)
  params.append('peers', peers.join(','))

  try {
    await pveFetch(conn, '/cluster/sdn/zones', { method: 'POST', body: params })
  } catch (err: any) {
    const msg = String(err?.message || '')
    if (!msg.includes('already exists')) {
      throw new Error(`Failed to create SDN zone "${zoneName}": ${msg}`)
    }
    console.warn(`[vdc-sdn] SDN zone "${zoneName}" already exists, proceeding`)
  }
}

/**
 * Deletes a VXLAN zone (idempotent - tolerates "not found").
 * Caller must invoke applySdn(conn) afterwards.
 */
export async function deleteZone(conn: any, zoneName: string): Promise<void> {
  try {
    await pveFetch(conn, `/cluster/sdn/zones/${encodeURIComponent(zoneName)}`, { method: 'DELETE' })
  } catch (err: any) {
    const msg = String(err?.message || '')
    if (!msg.toLowerCase().includes('not found') && !msg.includes('404')) {
      throw new Error(`Failed to delete SDN zone "${zoneName}": ${msg}`)
    }
    console.warn(`[vdc-sdn] SDN zone "${zoneName}" not found, skipping`)
  }
}
```

- [ ] **Step 2: TypeScript check**

```bash
cd frontend
npx tsc --noEmit
```

Expected: no new errors in `src/lib/vdc/sdn.ts`.

- [ ] **Step 3: Commit**

```bash
git add src/lib/vdc/sdn.ts
git commit -m "feat(vdc-sdn): add zone CRUD + applySdn (Phase 4a)"
```

---

## Task 6: SDN Lib — VNet CRUD, List, Reconcile, Attachment Count

**Files:**
- Modify: `src/lib/vdc/sdn.ts`

- [ ] **Step 1: Add VNet CRUD**

Append to `src/lib/vdc/sdn.ts`:

```typescript
// ---------------------------------------------------------------------------
// VNet CRUD
// ---------------------------------------------------------------------------

export interface CreateVnetParams {
  pveName: string
  zoneName: string
  tag: number
  firewall?: boolean
}

/**
 * Creates a VNet on PVE. Caller must invoke applySdn(conn) afterwards.
 */
export async function createVnetPve(conn: any, params: CreateVnetParams): Promise<void> {
  const body = new URLSearchParams()
  body.append('vnet', params.pveName)
  body.append('zone', params.zoneName)
  body.append('tag', String(params.tag))
  body.append('type', 'vnet')
  body.append('firewall', params.firewall === false ? '0' : '1')

  try {
    await pveFetch(conn, '/cluster/sdn/vnets', { method: 'POST', body })
  } catch (err: any) {
    throw new Error(`Failed to create SDN VNet "${params.pveName}": ${err?.message}`)
  }
}

export async function updateVnetPve(
  conn: any,
  pveName: string,
  patch: { firewall?: boolean; alias?: string }
): Promise<void> {
  const body = new URLSearchParams()
  if (patch.firewall !== undefined) body.append('firewall', patch.firewall ? '1' : '0')
  if (patch.alias !== undefined) body.append('alias', patch.alias)

  await pveFetch(conn, `/cluster/sdn/vnets/${encodeURIComponent(pveName)}`, { method: 'PUT', body })
}

export async function deleteVnetPve(conn: any, pveName: string): Promise<void> {
  try {
    await pveFetch(conn, `/cluster/sdn/vnets/${encodeURIComponent(pveName)}`, { method: 'DELETE' })
  } catch (err: any) {
    const msg = String(err?.message || '')
    if (!msg.toLowerCase().includes('not found') && !msg.includes('404')) {
      throw new Error(`Failed to delete SDN VNet "${pveName}": ${msg}`)
    }
    console.warn(`[vdc-sdn] SDN VNet "${pveName}" not found, skipping`)
  }
}

export async function listVnetsPve(conn: any): Promise<SdnVnet[]> {
  const items = await pveFetch<any[]>(conn, '/cluster/sdn/vnets')
  return (items || []).map((v: any) => ({
    vnet: v.vnet,
    zone: v.zone,
    tag: Number(v.tag),
    firewall: v.firewall ? 1 : 0,
  }))
}
```

- [ ] **Step 2: Add attachment counter**

```typescript
// ---------------------------------------------------------------------------
// Count NIC attachments for a VNet (used before delete)
// ---------------------------------------------------------------------------

/**
 * Returns the number of NICs across all VMs/CTs that reference `pveName` as bridge.
 * Best-effort: skips VMs whose config fails to fetch.
 */
export async function countVnetAttachments(conn: any, pveName: string): Promise<number> {
  const resources = await pveFetch<any[]>(conn, '/cluster/resources?type=vm')
  let count = 0

  for (const res of resources || []) {
    const vmid = res.vmid
    const node = res.node
    const type = res.type
    if (!vmid || !node || !type) continue

    try {
      const config = await pveFetch<any>(conn, `/nodes/${encodeURIComponent(node)}/${type}/${vmid}/config`)
      for (const key of Object.keys(config)) {
        if (!/^net\d+$/.test(key)) continue
        const val = String(config[key] || '')
        const m = val.match(/bridge=([^,]+)/)
        if (m && m[1] === pveName) count++
      }
    } catch {
      // Skip VMs whose config fails
    }
  }

  return count
}
```

- [ ] **Step 3: Add reconcile helper**

```typescript
// ---------------------------------------------------------------------------
// Reconcile DB mirror with PVE state
// ---------------------------------------------------------------------------

/**
 * Compare DB `vdc_vnets` rows with PVE SDN state for the given zone.
 * If a DB row exists for a VNet not in PVE: delete the DB row.
 * If PVE has a VNet in this zone not in DB: log warning (don't auto-create).
 */
export async function reconcileVnets(vdcId: string, zoneName: string, conn: any): Promise<void> {
  const db = getDb()
  const dbRows = db
    .prepare('SELECT id, pve_name FROM vdc_vnets WHERE vdc_id = ?')
    .all(vdcId) as Array<{ id: string; pve_name: string }>

  let pveVnets: SdnVnet[] = []
  try {
    const all = await listVnetsPve(conn)
    pveVnets = all.filter((v) => v.zone === zoneName)
  } catch (err: any) {
    console.warn(`[vdc-sdn] reconcileVnets: listVnetsPve failed for zone ${zoneName}: ${err?.message}`)
    return
  }

  const pveSet = new Set(pveVnets.map((v) => v.vnet))
  const dbSet = new Set(dbRows.map((r) => r.pve_name))

  for (const row of dbRows) {
    if (!pveSet.has(row.pve_name)) {
      db.prepare('DELETE FROM vdc_vnets WHERE id = ?').run(row.id)
      console.warn(`[vdc-sdn] reconcileVnets: removed stale DB row for VNet ${row.pve_name}`)
    }
  }

  for (const v of pveVnets) {
    if (!dbSet.has(v.vnet)) {
      console.warn(`[vdc-sdn] reconcileVnets: orphan VNet ${v.vnet} in zone ${zoneName} (not in DB)`)
    }
  }
}
```

- [ ] **Step 4: TypeScript check**

```bash
cd frontend
npx tsc --noEmit
```

- [ ] **Step 5: Commit**

```bash
git add src/lib/vdc/sdn.ts
git commit -m "feat(vdc-sdn): add VNet CRUD, list, reconcile, attachment count (Phase 4a)"
```

---

## Task 7: Hook SDN Zone Creation into `createVdc()`

**Files:**
- Modify: `src/lib/vdc/index.ts`

- [ ] **Step 1: Add imports**

At the top of `src/lib/vdc/index.ts`, alongside existing imports:

```typescript
import { generateZoneName, createZone, deleteZone, deleteVnetPve, applySdn } from './sdn'
```

- [ ] **Step 2: Update `createVdc()` — move `id` allocation up and create zone**

In `createVdc()`, find the current structure:
- Step 1: resolve tenant slug
- Step 2: check slug uniqueness
- Step 3: create PVE pool
- Step 4: DB transaction (inside which `const id = randomUUID()`)

Refactor so `id` is allocated BEFORE the pool creation, and the zone is created AFTER the pool but BEFORE the DB transaction:

Replace the existing "3. Create PVE pool" block through the start of Step 4 (DB transaction) with:

```typescript
  // 3. Allocate vDC id (needed for zone generation)
  const id = randomUUID()
  const now = new Date().toISOString()

  // 4. Create PVE pool (existing behavior)
  const poolName = generatePoolName(tenantSlug, input.slug)
  const connOwnerTenantId = await getConnectionOwnerTenantId(input.connectionId)
  const conn = await getConnectionById(input.connectionId, connOwnerTenantId)

  try {
    await pveFetch(conn, '/pools', {
      method: 'POST',
      body: new URLSearchParams({
        poolid: poolName,
        comment: `ProxCenter vDC: ${input.name}`,
      }),
    })
  } catch (err: any) {
    const msg = err?.message || ''
    if (!msg.includes('already exists')) {
      throw new Error(`Failed to create PVE pool "${poolName}": ${msg}`)
    }
    console.warn(`[vdc] PVE pool "${poolName}" already exists, proceeding`)
  }

  // 5. Create SDN zone on PVE
  const sdnZoneName = generateZoneName(input.connectionId, { id, slug: input.slug })
  try {
    await createZone(conn, sdnZoneName)
  } catch (err: any) {
    // Rollback: drop the pool we just created
    try {
      await pveFetch(conn, `/pools/${encodeURIComponent(poolName)}`, { method: 'DELETE' })
    } catch {}
    throw new Error(`Failed to create SDN zone: ${err?.message}`)
  }
```

- [ ] **Step 3: Update DB INSERT to include `sdn_zone_name` + shared bridges**

Update the prepared statement for `vdcs`:

```typescript
  const insertVdc = db.prepare(`
    INSERT INTO vdcs (id, tenant_id, connection_id, name, slug, description, pve_pool_name, sdn_zone_name, enabled, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
  `)
```

And its `.run()` inside the transaction:

```typescript
    insertVdc.run(
      id, input.tenantId, input.connectionId, input.name, input.slug,
      input.description ?? null, poolName, sdnZoneName, createdBy, now, now
    )
```

Remove the local `const id = randomUUID()` and `const now = new Date().toISOString()` from inside the transaction block — they're now defined earlier in the outer scope (step 3 above).

Inside the transaction, after the existing quota insert, add shared bridges:

```typescript
    const insertShared = db.prepare(
      'INSERT INTO vdc_shared_bridges (id, vdc_id, bridge, label, created_at) VALUES (?, ?, ?, ?, ?)'
    )
    for (const sb of input.sharedBridges ?? []) {
      insertShared.run(randomUUID(), id, sb.bridge, sb.label ?? null, now)
    }
```

- [ ] **Step 4: Update quota INSERT to include `max_vnets`**

Update the prepared statement:

```typescript
  const insertQuota = db.prepare(`
    INSERT INTO vdc_quotas (id, vdc_id, max_vcpus, max_ram_mb, max_storage_mb, max_vms, max_snapshots, max_backups, max_vnets, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
```

And its `.run()`:

```typescript
      insertQuota.run(
        randomUUID(), id,
        input.quota.maxVcpus ?? null,
        input.quota.maxRamMb ?? null,
        input.quota.maxStorageMb ?? null,
        input.quota.maxVms ?? null,
        input.quota.maxSnapshots ?? null,
        input.quota.maxBackups ?? null,
        input.quota.maxVnets ?? null,
        now
      )
```

- [ ] **Step 5: Apply SDN after DB transaction succeeds**

After `runTransaction()` and before `return getVdcById(id)!`, add:

```typescript
  try {
    await applySdn(conn)
  } catch (err: any) {
    console.warn(`[vdc] applySdn failed after creating zone "${sdnZoneName}": ${err?.message}`)
    // Do not roll back - config is written to /etc/pve/sdn/*.cfg; admin can retry apply.
  }
```

- [ ] **Step 6: Update `rowToVdc()` to map `sdnZoneName`**

```typescript
function rowToVdc(row: any): Vdc {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    connectionId: row.connection_id,
    name: row.name,
    slug: row.slug,
    description: row.description ?? null,
    pvePoolName: row.pve_pool_name,
    sdnZoneName: row.sdn_zone_name ?? null,
    enabled: !!row.enabled,
    createdBy: row.created_by ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}
```

- [ ] **Step 7: Update `rowToQuota()`**

```typescript
function rowToQuota(row: any): VdcQuota | null {
  if (!row) return null
  return {
    maxVcpus: row.max_vcpus ?? null,
    maxRamMb: row.max_ram_mb ?? null,
    maxStorageMb: row.max_storage_mb ?? null,
    maxVms: row.max_vms ?? null,
    maxSnapshots: row.max_snapshots ?? null,
    maxBackups: row.max_backups ?? null,
    maxVnets: row.max_vnets ?? null,
  }
}
```

- [ ] **Step 8: TypeScript check + commit**

```bash
cd frontend
npx tsc --noEmit
git add src/lib/vdc/index.ts
git commit -m "feat(vdc-sdn): auto-create SDN zone + persist shared bridges on createVdc (Phase 4a)"
```

---

## Task 8: Hook SDN Cleanup into `deleteVdc()` + Extend `listVdcs()` / `getVdcById()` / `updateVdc()`

**Files:**
- Modify: `src/lib/vdc/index.ts`

- [ ] **Step 1: Update `deleteVdc()` to delete VNets + zone**

In `deleteVdc()`, before the "3. Delete PVE pool" block, insert:

```typescript
  // Delete all VNets in the vDC zone (best effort)
  if (vdc.sdnZoneName) {
    const vnetRows = db.prepare('SELECT pve_name FROM vdc_vnets WHERE vdc_id = ?').all(id) as Array<{ pve_name: string }>
    for (const v of vnetRows) {
      try {
        await deleteVnetPve(conn, v.pve_name)
      } catch (err: any) {
        console.warn(`[vdc] Failed to delete VNet "${v.pve_name}": ${err?.message}`)
      }
    }

    // Delete the SDN zone
    try {
      await deleteZone(conn, vdc.sdnZoneName)
    } catch (err: any) {
      console.warn(`[vdc] Failed to delete SDN zone "${vdc.sdnZoneName}": ${err?.message}`)
    }
  }
```

After the pool DELETE (and before the DB DELETE), apply SDN if the zone was removed:

```typescript
  if (vdc.sdnZoneName) {
    try {
      await applySdn(conn)
    } catch (err: any) {
      console.warn(`[vdc] applySdn failed after deleting zone "${vdc.sdnZoneName}": ${err?.message}`)
    }
  }
```

- [ ] **Step 2: Extend `listVdcs()` with `sharedBridges` + `vnets`**

In `listVdcs()`, add near the existing prepared statements:

```typescript
  const stmtShared = db.prepare('SELECT id, vdc_id, bridge, label, created_at FROM vdc_shared_bridges WHERE vdc_id = ? ORDER BY bridge')
  const stmtVnets = db.prepare('SELECT id, vdc_id, pve_name, description, vxlan_tag, firewall, created_by, created_at FROM vdc_vnets WHERE vdc_id = ? ORDER BY pve_name')
```

Inside the `.map()` loop, add before the `return`:

```typescript
    const sharedBridges = (stmtShared.all(vdc.id) as any[]).map((r) => ({
      id: r.id,
      vdcId: r.vdc_id,
      bridge: r.bridge,
      label: r.label ?? null,
      createdAt: r.created_at,
    }))
    const vnets = (stmtVnets.all(vdc.id) as any[]).map((r) => ({
      id: r.id,
      vdcId: r.vdc_id,
      pveName: r.pve_name,
      description: r.description ?? null,
      vxlanTag: r.vxlan_tag,
      firewall: !!r.firewall,
      createdBy: r.created_by ?? null,
      createdAt: r.created_at,
    }))
```

Include both in the returned object:

```typescript
    return {
      ...vdc,
      tenantName: row.tenant_name ?? undefined,
      nodes,
      storages,
      quota,
      usage,
      sharedBridges,
      vnets,
    } as VdcWithDetails
```

- [ ] **Step 3: Mirror in `getVdcById()`**

Do the same additions in `getVdcById()`: fetch `sharedBridges` + `vnets` and include them in the returned object. Reuse the same mapping shape.

- [ ] **Step 4: Update `updateVdc()` to handle `sharedBridges` replacement + `max_vnets`**

Inside the transaction, after the `input.storages` block:

```typescript
    if (input.sharedBridges) {
      db.prepare('DELETE FROM vdc_shared_bridges WHERE vdc_id = ?').run(id)
      const insertShared = db.prepare(
        'INSERT INTO vdc_shared_bridges (id, vdc_id, bridge, label, created_at) VALUES (?, ?, ?, ?, ?)'
      )
      for (const sb of input.sharedBridges) {
        insertShared.run(randomUUID(), id, sb.bridge, sb.label ?? null, now)
      }
    }
```

Update the quota UPSERT prepared statement:

```typescript
  const upsertQuota = db.prepare(`
    INSERT INTO vdc_quotas (id, vdc_id, max_vcpus, max_ram_mb, max_storage_mb, max_vms, max_snapshots, max_backups, max_vnets, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(vdc_id) DO UPDATE SET
      max_vcpus = excluded.max_vcpus,
      max_ram_mb = excluded.max_ram_mb,
      max_storage_mb = excluded.max_storage_mb,
      max_vms = excluded.max_vms,
      max_snapshots = excluded.max_snapshots,
      max_backups = excluded.max_backups,
      max_vnets = excluded.max_vnets,
      updated_at = excluded.updated_at
  `)
```

And its `.run()`:

```typescript
      upsertQuota.run(
        randomUUID(), id,
        input.quota.maxVcpus ?? null,
        input.quota.maxRamMb ?? null,
        input.quota.maxStorageMb ?? null,
        input.quota.maxVms ?? null,
        input.quota.maxSnapshots ?? null,
        input.quota.maxBackups ?? null,
        input.quota.maxVnets ?? null,
        now
      )
```

- [ ] **Step 5: TypeScript + commit**

```bash
cd frontend
npx tsc --noEmit
git add src/lib/vdc/index.ts
git commit -m "feat(vdc-sdn): zone/vnet cleanup on deleteVdc + list extensions (Phase 4a)"
```

---

## Task 9: Extend `VdcScope` with `vnetsByConnection` + `sharedBridgesByConnection`

**Files:**
- Modify: `src/lib/vdc/scope.ts`

- [ ] **Step 1: Extend `VdcScope` interface**

```typescript
export interface VdcScope {
  connectionIds: Set<string>
  nodesByConnection: Map<string, Set<string>>
  storagesByConnection: Map<string, Set<string>>
  poolsByConnection: Map<string, Set<string>>
  vnetsByConnection: Map<string, Set<string>>
  sharedBridgesByConnection: Map<string, Set<string>>
}
```

- [ ] **Step 2: Populate the new maps in `buildVdcScope()`**

Add next to the existing prepared statements:

```typescript
  const stmtVnets = db.prepare('SELECT pve_name FROM vdc_vnets WHERE vdc_id = ?')
  const stmtShared = db.prepare('SELECT bridge FROM vdc_shared_bridges WHERE vdc_id = ?')
```

Declare the maps alongside the existing ones:

```typescript
  const vnetsByConnection = new Map<string, Set<string>>()
  const sharedBridgesByConnection = new Map<string, Set<string>>()
```

In the aggregation loop, add:

```typescript
    if (!vnetsByConnection.has(connId)) {
      vnetsByConnection.set(connId, new Set())
    }
    for (const vr of stmtVnets.all(row.id) as Array<{ pve_name: string }>) {
      vnetsByConnection.get(connId)!.add(vr.pve_name)
    }

    if (!sharedBridgesByConnection.has(connId)) {
      sharedBridgesByConnection.set(connId, new Set())
    }
    for (const sb of stmtShared.all(row.id) as Array<{ bridge: string }>) {
      sharedBridgesByConnection.get(connId)!.add(sb.bridge)
    }
```

Include both in the return:

```typescript
  return {
    connectionIds,
    nodesByConnection,
    storagesByConnection,
    poolsByConnection,
    vnetsByConnection,
    sharedBridgesByConnection,
  }
```

- [ ] **Step 3: `applyVdcFilter()` remains unchanged**

VNet-based filtering happens at the `network-choices` endpoint level (Phase 4b). No changes needed here.

- [ ] **Step 4: TypeScript + commit**

```bash
cd frontend
npx tsc --noEmit
git add src/lib/vdc/scope.ts
git commit -m "feat(vdc-sdn): extend VdcScope with vnets and sharedBridges (Phase 4a)"
```

---

## Task 10: Admin API — `GET /admin/connections/[id]/provider-bridges`

**Files:**
- Create: `src/app/api/v1/admin/connections/[id]/provider-bridges/route.ts`

- [ ] **Step 1: Create the route**

```typescript
// src/app/api/v1/admin/connections/[id]/provider-bridges/route.ts
import { NextResponse } from 'next/server'

import { pveFetch } from '@/lib/proxmox/client'
import { getConnectionById } from '@/lib/connections/getConnection'
import { checkPermission, PERMISSIONS } from '@/lib/rbac'
import { prisma } from '@/lib/db/prisma'

export const runtime = 'nodejs'

// GET /api/v1/admin/connections/{id}/provider-bridges
// Returns physical (non-SDN) bridges available on the cluster, deduplicated across nodes.
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await ctx.params

    const denied = await checkPermission(PERMISSIONS.ADMIN_SETTINGS, 'connection', id)
    if (denied) return denied

    const conn = await prisma.connection.findUnique({ where: { id }, select: { tenantId: true } })
    if (!conn) return NextResponse.json({ error: 'Connection not found' }, { status: 404 })
    const pveConn = await getConnectionById(id, conn.tenantId)

    // Exclude SDN-managed bridges
    const sdnBridges: Set<string> = new Set()
    try {
      const zones = await pveFetch<any[]>(pveConn, '/cluster/sdn/zones')
      for (const z of zones || []) {
        if (z.bridge) sdnBridges.add(String(z.bridge))
      }
      const vnets = await pveFetch<any[]>(pveConn, '/cluster/sdn/vnets')
      for (const v of vnets || []) {
        if (v.vnet) sdnBridges.add(String(v.vnet))
      }
    } catch (err: any) {
      console.warn(`[provider-bridges] Failed to fetch SDN config: ${err?.message}`)
    }

    const nodes = await pveFetch<any[]>(pveConn, '/nodes')
    const bridgeMap = new Map<string, { iface: string; nodes: string[]; type: string; active?: number; comments?: string }>()

    for (const n of nodes || []) {
      const nodeName = n.node
      if (!nodeName) continue

      try {
        const ifaces = await pveFetch<any[]>(pveConn, `/nodes/${encodeURIComponent(nodeName)}/network`)
        for (const ifc of ifaces || []) {
          if (ifc.type !== 'bridge' && ifc.type !== 'OVSBridge') continue
          if (sdnBridges.has(ifc.iface)) continue

          const existing = bridgeMap.get(ifc.iface)
          if (existing) {
            existing.nodes.push(nodeName)
          } else {
            bridgeMap.set(ifc.iface, {
              iface: ifc.iface,
              nodes: [nodeName],
              type: ifc.type,
              active: ifc.active,
              comments: ifc.comments,
            })
          }
        }
      } catch (err: any) {
        console.warn(`[provider-bridges] Failed to list ${nodeName}/network: ${err?.message}`)
      }
    }

    const bridges = Array.from(bridgeMap.values()).sort((a, b) => a.iface.localeCompare(b.iface))
    return NextResponse.json({ data: bridges })
  } catch (e: any) {
    console.error('[provider-bridges] error:', e)
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 })
  }
}
```

- [ ] **Step 2: Smoke test**

```bash
# Start dev server in frontend/, then with $AUTH set to a super-admin session cookie:
curl -s -b "$AUTH" "http://localhost:3000/api/v1/admin/connections/$CONN_ID/provider-bridges" | jq .
```

Expected: `{ data: [{ iface: 'vmbr0', nodes: [...], type: 'bridge', active: 1 }, ...] }`.

- [ ] **Step 3: Commit**

```bash
git add "src/app/api/v1/admin/connections/[id]/provider-bridges/"
git commit -m "feat(vdc-sdn): add admin provider-bridges API endpoint (Phase 4a)"
```

---

## Task 11: Admin API — `/admin/vdcs/[id]/shared-bridges` (GET + PUT)

**Files:**
- Create: `src/app/api/v1/admin/vdcs/[id]/shared-bridges/route.ts`

- [ ] **Step 1: Create the route**

```typescript
// src/app/api/v1/admin/vdcs/[id]/shared-bridges/route.ts
import { randomUUID } from 'crypto'

import { NextResponse } from 'next/server'

import { getDb } from '@/lib/db/sqlite'
import { checkPermission, PERMISSIONS } from '@/lib/rbac'
import { clearVdcScopeCache } from '@/lib/vdc/scope'

export const runtime = 'nodejs'

// GET /api/v1/admin/vdcs/{id}/shared-bridges
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params
  const denied = await checkPermission(PERMISSIONS.ADMIN_SETTINGS, 'vdc', id)
  if (denied) return denied

  const db = getDb()
  const rows = db
    .prepare('SELECT id, vdc_id, bridge, label, created_at FROM vdc_shared_bridges WHERE vdc_id = ? ORDER BY bridge')
    .all(id) as any[]

  const data = rows.map((r) => ({
    id: r.id,
    vdcId: r.vdc_id,
    bridge: r.bridge,
    label: r.label ?? null,
    createdAt: r.created_at,
  }))

  return NextResponse.json({ data })
}

// PUT /api/v1/admin/vdcs/{id}/shared-bridges
// Body: { bridges: [{ bridge, label? }, ...] } - replaces the full set.
export async function PUT(
  req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params
  const denied = await checkPermission(PERMISSIONS.ADMIN_SETTINGS, 'vdc', id)
  if (denied) return denied

  const body = await req.json().catch(() => ({}))
  const incoming: Array<{ bridge?: unknown; label?: unknown }> = Array.isArray(body?.bridges) ? body.bridges : []

  const cleaned: Array<{ bridge: string; label: string | null }> = []
  for (const item of incoming) {
    if (typeof item?.bridge !== 'string' || !item.bridge.trim()) continue
    cleaned.push({
      bridge: item.bridge.trim(),
      label: typeof item.label === 'string' ? item.label.trim() : null,
    })
  }

  const seen = new Set<string>()
  const unique = cleaned.filter((c) => {
    if (seen.has(c.bridge)) return false
    seen.add(c.bridge)
    return true
  })

  const db = getDb()
  const vdc = db.prepare('SELECT tenant_id FROM vdcs WHERE id = ?').get(id) as any
  if (!vdc) return NextResponse.json({ error: 'vDC not found' }, { status: 404 })

  const now = new Date().toISOString()
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM vdc_shared_bridges WHERE vdc_id = ?').run(id)
    const insert = db.prepare(
      'INSERT INTO vdc_shared_bridges (id, vdc_id, bridge, label, created_at) VALUES (?, ?, ?, ?, ?)'
    )
    for (const sb of unique) {
      insert.run(randomUUID(), id, sb.bridge, sb.label, now)
    }
  })
  tx()

  clearVdcScopeCache(vdc.tenant_id)

  return NextResponse.json({ success: true, count: unique.length })
}
```

- [ ] **Step 2: Smoke test**

```bash
curl -s -b "$AUTH" -X PUT \
  -H 'Content-Type: application/json' \
  -d '{"bridges":[{"bridge":"vmbr0","label":"Default LAN"},{"bridge":"vmbr-pub.100","label":"WAN /29"}]}' \
  "http://localhost:3000/api/v1/admin/vdcs/$VDC_ID/shared-bridges" | jq .

curl -s -b "$AUTH" "http://localhost:3000/api/v1/admin/vdcs/$VDC_ID/shared-bridges" | jq .
```

Expected: PUT returns `{ success: true, count: 2 }`. GET returns both bridges.

- [ ] **Step 3: Commit**

```bash
git add "src/app/api/v1/admin/vdcs/[id]/shared-bridges/"
git commit -m "feat(vdc-sdn): add admin shared-bridges API (GET + PUT) (Phase 4a)"
```

---

## Task 12: Admin UI — `VdcTab` Shared Bridges + `max_vnets`

**Files:**
- Modify: `src/components/settings/VdcTab.tsx`
- Modify: `src/messages/en.json`
- Modify: `src/messages/fr.json`

- [ ] **Step 1: Add i18n keys (EN)**

In `src/messages/en.json`, find the existing `"vdc"` top-level key. Add these entries inside it (merge, don't overwrite):

```json
"sharedBridgesTitle": "Shared bridges (uplinks)",
"sharedBridgesHint": "Bridges from the cluster that this vDC is allowed to attach to (in addition to its own VNets). Typically used for WAN or management uplinks.",
"sharedBridgesDetected": "Detected bridges on this cluster",
"sharedBridgesNoDetected": "No bridges detected on this cluster.",
"sharedBridgeLabelPlaceholder": "Optional label (e.g. WAN /29 - 203.0.113.24/29)",
"maxVnets": "Max VNets",
"maxVnetsHint": "Maximum number of VNets the tenant can create in this vDC. Empty = unlimited."
```

- [ ] **Step 2: Same keys in FR**

In `src/messages/fr.json`, inside `"vdc"`:

```json
"sharedBridgesTitle": "Bridges partagés (uplinks)",
"sharedBridgesHint": "Bridges du cluster que ce vDC peut utiliser en plus de ses propres VNets. Typiquement pour les uplinks WAN ou management.",
"sharedBridgesDetected": "Bridges détectés sur ce cluster",
"sharedBridgesNoDetected": "Aucun bridge détecté sur ce cluster.",
"sharedBridgeLabelPlaceholder": "Libellé optionnel (ex: WAN /29 - 203.0.113.24/29)",
"maxVnets": "Max VNets",
"maxVnetsHint": "Nombre maximal de VNets que le tenant peut créer dans ce vDC. Vide = illimité."
```

- [ ] **Step 3: Add state + data loading in `VdcTab.tsx`**

Near the other `useState` declarations, add:

```typescript
const [providerBridges, setProviderBridges] = useState<Array<{ iface: string; nodes: string[]; type: string }>>([])
const [selectedSharedBridges, setSelectedSharedBridges] = useState<Map<string, string>>(new Map())
```

Add a new `useEffect` that loads provider-bridges whenever the selected connection changes:

```typescript
useEffect(() => {
  if (!form.connectionId) {
    setProviderBridges([])
    return
  }
  void (async () => {
    try {
      const res = await fetch(`/api/v1/admin/connections/${encodeURIComponent(form.connectionId)}/provider-bridges`)
      if (res.ok) {
        const json = await res.json()
        setProviderBridges(Array.isArray(json.data) ? json.data : [])
      }
    } catch (err) {
      console.error('Failed to load provider bridges', err)
      setProviderBridges([])
    }
  })()
}, [form.connectionId])
```

When the dialog opens for edit, pre-fill `selectedSharedBridges`:

```typescript
// In the effect that hydrates the form from editingVdc:
if (editingVdc?.sharedBridges?.length) {
  const map = new Map<string, string>()
  for (const sb of editingVdc.sharedBridges) {
    map.set(sb.bridge, sb.label ?? '')
  }
  setSelectedSharedBridges(map)
} else {
  setSelectedSharedBridges(new Map())
}
```

- [ ] **Step 4: Render the Shared Bridges section inside the Dialog**

Add this JSX block inside the Dialog content, between the Storages section and the Quotas section:

```tsx
<Box sx={{ mt: 2 }}>
  <Typography variant="subtitle2" gutterBottom>{t('vdc.sharedBridgesTitle')}</Typography>
  <Typography variant="caption" color="text.secondary">{t('vdc.sharedBridgesHint')}</Typography>

  {providerBridges.length === 0 ? (
    <Typography variant="body2" sx={{ mt: 1, fontStyle: 'italic' }}>
      {t('vdc.sharedBridgesNoDetected')}
    </Typography>
  ) : (
    <Stack spacing={1} sx={{ mt: 1 }}>
      {providerBridges.map((pb) => {
        const selected = selectedSharedBridges.has(pb.iface)
        const label = selectedSharedBridges.get(pb.iface) ?? ''
        return (
          <Stack key={pb.iface} direction="row" spacing={1} alignItems="center">
            <FormControlLabel
              sx={{ minWidth: 180 }}
              control={
                <Checkbox
                  checked={selected}
                  onChange={(e) => {
                    setSelectedSharedBridges((prev) => {
                      const next = new Map(prev)
                      if (e.target.checked) next.set(pb.iface, label)
                      else next.delete(pb.iface)
                      return next
                    })
                  }}
                />
              }
              label={<Typography fontFamily="monospace">{pb.iface}</Typography>}
            />
            <TextField
              size="small"
              fullWidth
              placeholder={t('vdc.sharedBridgeLabelPlaceholder')}
              value={label}
              disabled={!selected}
              onChange={(e) => {
                setSelectedSharedBridges((prev) => {
                  const next = new Map(prev)
                  if (next.has(pb.iface)) next.set(pb.iface, e.target.value)
                  return next
                })
              }}
            />
          </Stack>
        )
      })}
    </Stack>
  )}
</Box>
```

- [ ] **Step 5: Add `max_vnets` field to the Quotas section**

Alongside the existing 6 quota fields, add:

```tsx
<TextField
  label={t('vdc.maxVnets')}
  type="number"
  value={form.quota.maxVnets ?? ''}
  onChange={(e) => {
    const v = e.target.value === '' ? null : parseInt(e.target.value, 10)
    setForm((f) => ({ ...f, quota: { ...f.quota, maxVnets: isNaN(v as number) ? null : v } }))
  }}
  helperText={t('vdc.maxVnetsHint')}
  inputProps={{ min: 0 }}
  size="small"
  fullWidth
/>
```

Make sure the form's initial `quota` state includes `maxVnets: null`.

- [ ] **Step 6: Include `sharedBridges` + `maxVnets` in the submit payload**

Find the submit handler (POST/PUT to `/api/v1/admin/vdcs`). Build the payload:

```typescript
const sharedBridgesPayload = Array.from(selectedSharedBridges.entries()).map(([bridge, label]) => ({
  bridge,
  label: label.trim() || undefined,
}))

const payload = {
  ...form,
  sharedBridges: sharedBridgesPayload,
}

// POST or PUT with payload as JSON body
```

Ensure `form.quota.maxVnets` is preserved in the quota part of the payload.

- [ ] **Step 7: Browser verification**

1. `pnpm dev` in `frontend/`
2. Navigate to `/settings` > "Virtual Datacenters" tab (as super_admin)
3. Click "Create vDC"
4. Fill tenant + connection → "Shared bridges" section populates with detected bridges
5. Check 1-2 bridges, add labels
6. Set `max_vnets` = 8
7. Submit → success; the list shows the new vDC
8. Edit the vDC → bridges + labels + `max_vnets` pre-filled correctly
9. Uncheck one bridge, Save → verify via `curl /api/v1/admin/vdcs/$VDC_ID/shared-bridges` that the row is gone

- [ ] **Step 8: Commit**

```bash
git add src/components/settings/VdcTab.tsx src/messages/en.json src/messages/fr.json
git commit -m "feat(vdc-sdn): admin UI for shared bridges and max_vnets (Phase 4a)"
```

---

## Task 13: End-to-End Manual Validation

No code changes. Run the full validation scenario.

- [ ] **Step 1: Fresh DB**

```bash
cd frontend
rm -f data/proxcenter.db
pnpm dev &
sleep 5
# server stays running for manual tests below
```

- [ ] **Step 2: Verify DB schema**

```bash
sqlite3 frontend/data/proxcenter.db ".schema vdc_vnets"
sqlite3 frontend/data/proxcenter.db ".schema vdc_shared_bridges"
sqlite3 frontend/data/proxcenter.db "PRAGMA table_info(vdcs)" | grep sdn_zone_name
sqlite3 frontend/data/proxcenter.db "PRAGMA table_info(vdc_quotas)" | grep max_vnets
sqlite3 frontend/data/proxcenter.db "SELECT id FROM rbac_permissions WHERE id LIKE 'sdn.%'"
sqlite3 frontend/data/proxcenter.db "SELECT role_id, permission_id FROM rbac_role_permissions WHERE permission_id LIKE 'sdn.%'"
```

Expected: all tables/columns/permissions present; MSP roles have their SDN permission attributions.

- [ ] **Step 3: Create a vDC via the admin UI**

Name: `Acme Prod`, slug: `acme-prod`, tenant: Acme, connection: your test PVE, 1-2 nodes, 1 storage, `max_vnets=8`, shared bridges: `vmbr0` with label "Default LAN".

Submit.

- [ ] **Step 4: Verify the zone on PVE**

On the PVE host:

```bash
pvesh get /cluster/sdn/zones --output-format json | jq '.[] | select(.type=="vxlan") | .zone'
```

Expected: `zacmeprod` is in the list.

- [ ] **Step 5: Verify DB state**

```bash
sqlite3 frontend/data/proxcenter.db "SELECT id, slug, sdn_zone_name FROM vdcs"
sqlite3 frontend/data/proxcenter.db "SELECT vdc_id, bridge, label FROM vdc_shared_bridges"
sqlite3 frontend/data/proxcenter.db "SELECT vdc_id, max_vnets FROM vdc_quotas"
```

All coherent.

- [ ] **Step 6: Delete the vDC via the admin UI**

Then:

```bash
pvesh get /cluster/sdn/zones --output-format json | jq '.[] | select(.zone=="zacmeprod")'
sqlite3 frontend/data/proxcenter.db "SELECT sdn_zone_name FROM vdcs"
```

Expected: empty on both sides.

- [ ] **Step 7: Stop dev server + final commit if fixes were needed**

```bash
kill %1 2>/dev/null || true
# git add / git commit only if small fixes surfaced during E2E
```

---

## Summary

| Task | What it does | Files |
|------|-------------|-------|
| 1 | DB schema: 2 new tables, 2 new columns, 5 permissions | `sqlite.ts` |
| 2 | TypeScript types | `vdc/types.ts` |
| 3 | `generateZoneName` collision-safe (TDD) | `vdc/sdn.ts` + test |
| 4 | `allocateVni` per vDC (TDD) | `vdc/sdn.ts` + test |
| 5 | Zone CRUD + `applySdn` | `vdc/sdn.ts` |
| 6 | VNet CRUD, list, reconcile, attachment count | `vdc/sdn.ts` |
| 7 | Hook zone creation in `createVdc()` | `vdc/index.ts` |
| 8 | Hook cleanup in `deleteVdc()` + list extensions | `vdc/index.ts` |
| 9 | `VdcScope` + vnets + sharedBridges | `vdc/scope.ts` |
| 10 | Admin API: provider-bridges detection | route |
| 11 | Admin API: vDC shared-bridges CRUD | route |
| 12 | Admin UI: shared bridges + `max_vnets` | `VdcTab.tsx`, i18n |
| 13 | E2E manual validation | — |

**What this enables:** Super admin creates a vDC and the PVE SDN zone is auto-provisioned. Shared bridges are stored per vDC. `max_vnets` quota is settable. Tenant self-service (Phase 4b) and firewall UI (Phase 4c) build on this foundation.

**Backwards-compatible:** Existing vDCs (pre-Phase 4a) have `sdn_zone_name = NULL` and no SDN zone on PVE. They continue to function as before. A follow-up migration script (§12.1 of the spec) can backfill zones on demand.

**Next phase:** Phase 4b — tenant self-service VNet CRUD, `/dashboard/my-vdc` page, `network-choices` endpoint, enforcement in VM/LXC creation routes.
