# MSP IaaS Phase 4b: Tenant Self-Service VNet CRUD Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Livrer la couche tenant-facing pour la feature SDN: page "Mon vDC", CRUD de VNets en self-service, filtrage + enforcement du picker bridge côté VM/LXC creation. Le tenant peut créer/supprimer ses propres VNets dans la limite de son quota `max_vnets`, et ses NICs sont restreintes à ses VNets privés + bridges partagés autorisés.

**Architecture:** Nouveau lib `src/lib/vdc/vnets.ts` qui orchestre `vdc_vnets` DB + `sdn.ts` PVE. Routes tenant `/api/v1/vdcs/[id]/vnets/*` + `/shared-bridges`. Nouvel endpoint unifié `/connections/[id]/network-choices?node=X` consommé par les dialogs VM/LXC. Enforcement serveur dans les 3 routes guests write (create/clone/config). Page `/dashboard/my-vdc` avec CRUD UI. Item sidebar conditionnel.

**Tech Stack:** Next.js 16 API routes, SQLite + PVE REST, MUI 7 Dialog/DataGrid, TypeScript, Vitest.

**Spec reference:** `frontend/docs/superpowers/specs/2026-04-13-vdc-sdn-vnets-design.md` (§9.2).

**Worktree:** `/root/saas/proxcenter-frontend-msp-iaas/` (branche `feature/msp-iaas`).

**Dépendances:** Phase 4a mergée/présente sur la branche. `src/lib/vdc/sdn.ts` exporte `createVnetPve`, `updateVnetPve`, `deleteVnetPve`, `listVnetsPve`, `countVnetAttachments`, `reconcileVnets`, `allocateVni`, `applySdn`. Tables `vdc_vnets`, `vdc_shared_bridges`, col `vdc_quotas.max_vnets`, permissions `sdn.vnet.*` en place.

---

## File Structure

### New files

| File | Responsibility |
|------|---------------|
| `src/lib/vdc/vnets.ts` | Orchestration tenant-scoped: resolveVdcForTenant + CRUD VNet (DB+PVE+rollback), quota check, attachment check |
| `src/lib/vdc/vnets.test.ts` | Tests unitaires Vitest |
| `src/app/api/v1/vdcs/[id]/vnets/route.ts` | GET list + POST create |
| `src/app/api/v1/vdcs/[id]/vnets/[pveName]/route.ts` | GET + PUT + DELETE |
| `src/app/api/v1/vdcs/[id]/shared-bridges/route.ts` | GET tenant-scoped (read-only) |
| `src/app/api/v1/connections/[id]/network-choices/route.ts` | GET unified bridge picker |
| `src/app/(dashboard)/my-vdc/page.tsx` | Page tenant-facing overview + VNet CRUD |
| `src/components/mydc/MyVdcOverview.tsx` | Section overview (quotas, uplinks, usage) |
| `src/components/mydc/VnetList.tsx` | DataGrid + row actions |
| `src/components/mydc/VnetCreateDialog.tsx` | Create VNet dialog (name + description + firewall toggle) |
| `src/components/mydc/VnetEditDialog.tsx` | Edit VNet dialog (description + firewall toggle) |
| `src/components/mydc/VnetDeleteDialog.tsx` | Confirm delete with attachment count preview |

### Modified files

| File | Change |
|------|--------|
| `src/lib/vdc/scope.ts` | (existing from 4a) add helper `getNetworkChoices(scope, connectionId)` returning unified list OR keep inline in route |
| `src/app/api/v1/connections/[id]/guests/[type]/[node]/route.ts` | Add bridge whitelist validation after quota check (Phase 3) |
| `src/app/api/v1/connections/[id]/guests/[type]/[node]/[vmid]/clone/route.ts` | Same |
| `src/app/api/v1/connections/[id]/guests/[type]/[node]/[vmid]/config/route.ts` | Same |
| `src/app/(dashboard)/infrastructure/inventory/CreateVmDialog.tsx` | Replace `/nodes/{node}/network` fetch with `/network-choices?node=` |
| `src/app/(dashboard)/infrastructure/inventory/CreateLxcDialog.tsx` | Same |
| `src/components/hardware/AddNetworkDialog.tsx` | Same |
| `src/components/hardware/EditNetworkDialog.tsx` | Same |
| `src/@menu/menuData.js` | Add "Mon vDC" item in Infrastructure section, permission `sdn.vnet.view` |
| `src/messages/en.json` | Tenant-facing keys (`myVdc.*`, VNet labels) |
| `src/messages/fr.json` | Same, traduits |

---

## Task 1: Tenant VNet Library (TDD)

**Files:**
- Create: `src/lib/vdc/vnets.ts`
- Create: `src/lib/vdc/vnets.test.ts`

- [ ] **Step 1: Failing tests for `resolveVdcForVnet`**

Create `src/lib/vdc/vnets.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'

import { resolveVdcForVnetForTesting } from './vnets'

function newDb(): any {
  const db = new Database(':memory:')
  db.prepare(`
    CREATE TABLE vdcs (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      connection_id TEXT NOT NULL,
      slug TEXT NOT NULL,
      pve_pool_name TEXT NOT NULL,
      sdn_zone_name TEXT,
      enabled INTEGER DEFAULT 1
    )
  `).run()
  db.prepare(`
    CREATE TABLE vdc_quotas (
      vdc_id TEXT PRIMARY KEY,
      max_vnets INTEGER
    )
  `).run()
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

describe('resolveVdcForVnet', () => {
  it('returns vdc when owned by tenant and enabled', () => {
    const db = newDb()
    db.prepare('INSERT INTO vdcs (id, tenant_id, connection_id, slug, pve_pool_name, sdn_zone_name) VALUES (?, ?, ?, ?, ?, ?)')
      .run('vdc-1', 'tenant-a', 'conn-1', 'acme-prod', 'vdc-pool', 'zacmeprod')

    const vdc = resolveVdcForVnetForTesting(db, 'vdc-1', 'tenant-a')
    expect(vdc).not.toBeNull()
    expect(vdc?.sdnZoneName).toBe('zacmeprod')
  })

  it('returns null when vdc belongs to different tenant', () => {
    const db = newDb()
    db.prepare('INSERT INTO vdcs (id, tenant_id, connection_id, slug, pve_pool_name, sdn_zone_name) VALUES (?, ?, ?, ?, ?, ?)')
      .run('vdc-1', 'tenant-a', 'conn-1', 'acme', 'pool', 'zacme')
    expect(resolveVdcForVnetForTesting(db, 'vdc-1', 'tenant-b')).toBeNull()
  })

  it('returns null when vdc has no SDN zone (pre-Phase-4a vDC)', () => {
    const db = newDb()
    db.prepare('INSERT INTO vdcs (id, tenant_id, connection_id, slug, pve_pool_name, sdn_zone_name) VALUES (?, ?, ?, ?, ?, ?)')
      .run('vdc-1', 'tenant-a', 'conn-1', 'acme', 'pool', null)
    expect(resolveVdcForVnetForTesting(db, 'vdc-1', 'tenant-a')).toBeNull()
  })

  it('returns null when vdc is disabled', () => {
    const db = newDb()
    db.prepare('INSERT INTO vdcs (id, tenant_id, connection_id, slug, pve_pool_name, sdn_zone_name, enabled) VALUES (?, ?, ?, ?, ?, ?, 0)')
      .run('vdc-1', 'tenant-a', 'conn-1', 'acme', 'pool', 'zacme')
    expect(resolveVdcForVnetForTesting(db, 'vdc-1', 'tenant-a')).toBeNull()
  })
})
```

- [ ] **Step 2: Tests for `checkVnetQuota`**

Append to `vnets.test.ts`:

```typescript
import { checkVnetQuotaForTesting } from './vnets'

describe('checkVnetQuota', () => {
  it('allows when quota null (unlimited)', () => {
    const db = newDb()
    db.prepare('INSERT INTO vdc_quotas (vdc_id, max_vnets) VALUES (?, NULL)').run('vdc-1')
    expect(checkVnetQuotaForTesting(db, 'vdc-1')).toEqual({ allowed: true, current: 0, max: null })
  })

  it('allows under limit', () => {
    const db = newDb()
    db.prepare('INSERT INTO vdc_quotas (vdc_id, max_vnets) VALUES (?, 5)').run('vdc-1')
    db.prepare('INSERT INTO vdc_vnets (id, vdc_id, pve_name, vxlan_tag) VALUES (?, ?, ?, ?)').run('x', 'vdc-1', 'a', 10000)
    db.prepare('INSERT INTO vdc_vnets (id, vdc_id, pve_name, vxlan_tag) VALUES (?, ?, ?, ?)').run('y', 'vdc-1', 'b', 10001)
    expect(checkVnetQuotaForTesting(db, 'vdc-1')).toEqual({ allowed: true, current: 2, max: 5 })
  })

  it('blocks at limit', () => {
    const db = newDb()
    db.prepare('INSERT INTO vdc_quotas (vdc_id, max_vnets) VALUES (?, 2)').run('vdc-1')
    db.prepare('INSERT INTO vdc_vnets (id, vdc_id, pve_name, vxlan_tag) VALUES (?, ?, ?, ?)').run('x', 'vdc-1', 'a', 10000)
    db.prepare('INSERT INTO vdc_vnets (id, vdc_id, pve_name, vxlan_tag) VALUES (?, ?, ?, ?)').run('y', 'vdc-1', 'b', 10001)
    expect(checkVnetQuotaForTesting(db, 'vdc-1')).toEqual({ allowed: false, current: 2, max: 2 })
  })
})
```

- [ ] **Step 3: Verify tests FAIL**

```bash
cd frontend && npx vitest run src/lib/vdc/vnets.test.ts
```

Expected: all tests fail with "module not found".

- [ ] **Step 4: Implement `vnets.ts`**

Create `src/lib/vdc/vnets.ts`:

```typescript
// src/lib/vdc/vnets.ts
// Tenant-scoped VNet orchestration (DB mirror + PVE SDN operations).

import { randomUUID } from 'crypto'

import { getDb } from '@/lib/db/sqlite'
import { getConnectionById } from '@/lib/connections/getConnection'
import { prisma } from '@/lib/db/prisma'

import type { Vdc, VdcVnet } from './types'
import {
  createVnetPve,
  updateVnetPve,
  deleteVnetPve,
  allocateVni,
  applySdn,
  countVnetAttachments,
  reconcileVnets,
} from './sdn'

// ---------------------------------------------------------------------------
// resolveVdcForVnet
// ---------------------------------------------------------------------------

interface ResolvedVdc {
  id: string
  tenantId: string
  connectionId: string
  sdnZoneName: string
}

function resolveVdcForVnetImpl(db: any, vdcId: string, tenantId: string): ResolvedVdc | null {
  const row = db
    .prepare(
      `SELECT id, tenant_id, connection_id, sdn_zone_name, enabled
       FROM vdcs WHERE id = ? AND tenant_id = ?`
    )
    .get(vdcId, tenantId) as any
  if (!row) return null
  if (!row.enabled) return null
  if (!row.sdn_zone_name) return null
  return {
    id: row.id,
    tenantId: row.tenant_id,
    connectionId: row.connection_id,
    sdnZoneName: row.sdn_zone_name,
  }
}

/** @internal */
export function resolveVdcForVnetForTesting(db: any, vdcId: string, tenantId: string): ResolvedVdc | null {
  return resolveVdcForVnetImpl(db, vdcId, tenantId)
}

export function resolveVdcForVnet(vdcId: string, tenantId: string): ResolvedVdc | null {
  return resolveVdcForVnetImpl(getDb(), vdcId, tenantId)
}

// ---------------------------------------------------------------------------
// checkVnetQuota
// ---------------------------------------------------------------------------

export interface VnetQuotaResult {
  allowed: boolean
  current: number
  max: number | null
}

function checkVnetQuotaImpl(db: any, vdcId: string): VnetQuotaResult {
  const quotaRow = db.prepare('SELECT max_vnets FROM vdc_quotas WHERE vdc_id = ?').get(vdcId) as any
  const max: number | null = quotaRow?.max_vnets ?? null
  const countRow = db.prepare('SELECT COUNT(*) AS n FROM vdc_vnets WHERE vdc_id = ?').get(vdcId) as any
  const current: number = countRow?.n ?? 0
  if (max === null) return { allowed: true, current, max: null }
  return { allowed: current < max, current, max }
}

/** @internal */
export function checkVnetQuotaForTesting(db: any, vdcId: string): VnetQuotaResult {
  return checkVnetQuotaImpl(db, vdcId)
}

export function checkVnetQuota(vdcId: string): VnetQuotaResult {
  return checkVnetQuotaImpl(getDb(), vdcId)
}

// ---------------------------------------------------------------------------
// listVnetsForTenant
// ---------------------------------------------------------------------------

export function listVnetsForTenant(vdcId: string): VdcVnet[] {
  const db = getDb()
  const rows = db
    .prepare('SELECT id, vdc_id, pve_name, description, vxlan_tag, firewall, created_by, created_at FROM vdc_vnets WHERE vdc_id = ? ORDER BY pve_name')
    .all(vdcId) as any[]
  return rows.map((r) => ({
    id: r.id,
    vdcId: r.vdc_id,
    pveName: r.pve_name,
    description: r.description ?? null,
    vxlanTag: r.vxlan_tag,
    firewall: !!r.firewall,
    createdBy: r.created_by ?? null,
    createdAt: r.created_at,
  }))
}

// ---------------------------------------------------------------------------
// createVnetForTenant
// ---------------------------------------------------------------------------

export interface CreateVnetInput {
  vdcId: string
  tenantId: string
  pveName: string
  description?: string
  firewall?: boolean
  createdBy: string | null
}

const VNET_NAME_REGEX = /^[a-z][a-z0-9]{0,14}$/

async function getConn(vdc: ResolvedVdc): Promise<any> {
  const connMeta = await prisma.connection.findUnique({
    where: { id: vdc.connectionId },
    select: { tenantId: true },
  })
  if (!connMeta) throw new Error(`Connection not found: ${vdc.connectionId}`)
  return getConnectionById(vdc.connectionId, connMeta.tenantId)
}

export async function createVnetForTenant(input: CreateVnetInput): Promise<VdcVnet> {
  const vdc = resolveVdcForVnet(input.vdcId, input.tenantId)
  if (!vdc) throw new Error('vDC not found')

  if (!VNET_NAME_REGEX.test(input.pveName)) {
    throw new Error('Invalid VNet name (must match ^[a-z][a-z0-9]{0,14}$)')
  }

  const db = getDb()

  const existing = db.prepare('SELECT id FROM vdc_vnets WHERE vdc_id = ? AND pve_name = ?').get(vdc.id, input.pveName)
  if (existing) throw new Error(`VNet "${input.pveName}" already exists in this vDC`)

  const quota = checkVnetQuota(vdc.id)
  if (!quota.allowed) {
    throw new Error(`Quota exceeded: max_vnets=${quota.max}, current=${quota.current}`)
  }

  const tag = allocateVni(vdc.id)
  const conn = await getConn(vdc)
  const firewall = input.firewall !== false

  await createVnetPve(conn, {
    pveName: input.pveName,
    zoneName: vdc.sdnZoneName,
    tag,
    firewall,
  })

  const id = randomUUID()
  const now = new Date().toISOString()

  try {
    db.prepare(
      'INSERT INTO vdc_vnets (id, vdc_id, pve_name, description, vxlan_tag, firewall, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(id, vdc.id, input.pveName, input.description ?? null, tag, firewall ? 1 : 0, input.createdBy, now)
  } catch (err: any) {
    try { await deleteVnetPve(conn, input.pveName) } catch {}
    throw new Error(`Failed to persist VNet: ${err?.message}`)
  }

  try { await applySdn(conn) } catch (err: any) {
    console.warn(`[vdc-vnets] applySdn failed after create: ${err?.message}`)
  }

  return {
    id,
    vdcId: vdc.id,
    pveName: input.pveName,
    description: input.description ?? null,
    vxlanTag: tag,
    firewall,
    createdBy: input.createdBy,
    createdAt: now,
  }
}

// ---------------------------------------------------------------------------
// updateVnetForTenant
// ---------------------------------------------------------------------------

export async function updateVnetForTenant(
  vdcId: string,
  tenantId: string,
  pveName: string,
  patch: { description?: string; firewall?: boolean }
): Promise<VdcVnet> {
  const vdc = resolveVdcForVnet(vdcId, tenantId)
  if (!vdc) throw new Error('vDC not found')

  const db = getDb()
  const row = db
    .prepare('SELECT id FROM vdc_vnets WHERE vdc_id = ? AND pve_name = ?')
    .get(vdc.id, pveName) as any
  if (!row) throw new Error(`VNet "${pveName}" not found`)

  if (patch.firewall !== undefined) {
    const conn = await getConn(vdc)
    await updateVnetPve(conn, pveName, { firewall: patch.firewall })
    try { await applySdn(conn) } catch (err: any) {
      console.warn(`[vdc-vnets] applySdn failed after update: ${err?.message}`)
    }
  }

  const now = new Date().toISOString()
  void now // for consistency; not persisted (no updated_at column on vdc_vnets)

  db.prepare(
    `UPDATE vdc_vnets SET
       description = COALESCE(?, description),
       firewall = COALESCE(?, firewall)
     WHERE id = ?`
  ).run(
    patch.description !== undefined ? patch.description : null,
    patch.firewall !== undefined ? (patch.firewall ? 1 : 0) : null,
    row.id
  )

  const updated = db.prepare(
    'SELECT id, vdc_id, pve_name, description, vxlan_tag, firewall, created_by, created_at FROM vdc_vnets WHERE id = ?'
  ).get(row.id) as any
  return {
    id: updated.id,
    vdcId: updated.vdc_id,
    pveName: updated.pve_name,
    description: updated.description ?? null,
    vxlanTag: updated.vxlan_tag,
    firewall: !!updated.firewall,
    createdBy: updated.created_by ?? null,
    createdAt: updated.created_at,
  }
}

// ---------------------------------------------------------------------------
// deleteVnetForTenant
// ---------------------------------------------------------------------------

export async function deleteVnetForTenant(
  vdcId: string,
  tenantId: string,
  pveName: string
): Promise<{ deleted: true } | { deleted: false; attachmentCount: number }> {
  const vdc = resolveVdcForVnet(vdcId, tenantId)
  if (!vdc) throw new Error('vDC not found')

  const db = getDb()
  const row = db.prepare('SELECT id FROM vdc_vnets WHERE vdc_id = ? AND pve_name = ?').get(vdc.id, pveName) as any
  if (!row) throw new Error(`VNet "${pveName}" not found`)

  const conn = await getConn(vdc)
  const attachments = await countVnetAttachments(conn, pveName)
  if (attachments > 0) {
    return { deleted: false, attachmentCount: attachments }
  }

  await deleteVnetPve(conn, pveName)

  db.prepare('DELETE FROM vdc_vnets WHERE id = ?').run(row.id)

  try { await applySdn(conn) } catch (err: any) {
    console.warn(`[vdc-vnets] applySdn failed after delete: ${err?.message}`)
  }

  return { deleted: true }
}

// ---------------------------------------------------------------------------
// listSharedBridgesForTenant
// ---------------------------------------------------------------------------

export function listSharedBridgesForTenant(vdcId: string, tenantId: string): Array<{ bridge: string; label: string | null }> {
  const db = getDb()
  const vdc = db
    .prepare('SELECT id FROM vdcs WHERE id = ? AND tenant_id = ?')
    .get(vdcId, tenantId) as any
  if (!vdc) return []
  const rows = db
    .prepare('SELECT bridge, label FROM vdc_shared_bridges WHERE vdc_id = ? ORDER BY bridge')
    .all(vdcId) as any[]
  return rows.map((r) => ({ bridge: r.bridge, label: r.label ?? null }))
}
```

- [ ] **Step 5: Verify PASS**

```bash
npx vitest run src/lib/vdc/vnets.test.ts
```

Expected: 7/7 pass.

- [ ] **Step 6: Commit**

```bash
git add src/lib/vdc/vnets.ts src/lib/vdc/vnets.test.ts
git commit -m "feat(vdc-sdn): add tenant-scoped VNet orchestration lib (Phase 4b)"
```

---

## Task 2: Tenant API — VNet CRUD routes

**Files:**
- Create: `src/app/api/v1/vdcs/[id]/vnets/route.ts`
- Create: `src/app/api/v1/vdcs/[id]/vnets/[pveName]/route.ts`

- [ ] **Step 1: Create collection route (GET + POST)**

`src/app/api/v1/vdcs/[id]/vnets/route.ts`:

```typescript
import { NextResponse } from "next/server"
import { getServerSession } from "next-auth"

import { authOptions } from "@/lib/auth"
import { getCurrentTenantId } from "@/lib/tenant"
import { checkPermission, PERMISSIONS } from "@/lib/rbac"
import { listVnetsForTenant, createVnetForTenant } from "@/lib/vdc/vnets"

export const runtime = "nodejs"

type RouteContext = { params: Promise<{ id: string }> | { id: string } }

// GET /api/v1/vdcs/{id}/vnets
export async function GET(_req: Request, ctx: RouteContext) {
  try {
    const params = await Promise.resolve(ctx.params)
    const vdcId = (params as any)?.id
    if (!vdcId) return NextResponse.json({ error: "Missing vDC ID" }, { status: 400 })

    const denied = await checkPermission("sdn.vnet.view")
    if (denied) return denied

    const vnets = listVnetsForTenant(vdcId)
    return NextResponse.json({ data: vnets })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 })
  }
}

// POST /api/v1/vdcs/{id}/vnets
export async function POST(req: Request, ctx: RouteContext) {
  try {
    const params = await Promise.resolve(ctx.params)
    const vdcId = (params as any)?.id
    if (!vdcId) return NextResponse.json({ error: "Missing vDC ID" }, { status: 400 })

    const denied = await checkPermission("sdn.vnet.create")
    if (denied) return denied

    const body = await req.json().catch(() => ({}))
    const pveName = typeof body?.pveName === "string" ? body.pveName.trim() : ""
    const description = typeof body?.description === "string" ? body.description.trim() : undefined
    const firewall = body?.firewall !== false

    if (!pveName) return NextResponse.json({ error: "pveName required" }, { status: 400 })

    const session = await getServerSession(authOptions)
    const createdBy = session?.user?.id ?? null
    const tenantId = await getCurrentTenantId()

    try {
      const vnet = await createVnetForTenant({ vdcId, tenantId, pveName, description, firewall, createdBy })
      return NextResponse.json({ data: vnet }, { status: 201 })
    } catch (err: any) {
      const msg = err?.message || String(err)
      if (msg.includes("Quota exceeded")) return NextResponse.json({ error: msg }, { status: 409 })
      if (msg.includes("already exists")) return NextResponse.json({ error: msg }, { status: 409 })
      if (msg.includes("Invalid VNet name")) return NextResponse.json({ error: msg }, { status: 400 })
      if (msg.includes("vDC not found")) return NextResponse.json({ error: msg }, { status: 404 })
      throw err
    }
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 })
  }
}
```

- [ ] **Step 2: Create item route (GET + PUT + DELETE)**

`src/app/api/v1/vdcs/[id]/vnets/[pveName]/route.ts`:

```typescript
import { NextResponse } from "next/server"

import { getCurrentTenantId } from "@/lib/tenant"
import { checkPermission } from "@/lib/rbac"
import { getDb } from "@/lib/db/sqlite"
import { updateVnetForTenant, deleteVnetForTenant } from "@/lib/vdc/vnets"

export const runtime = "nodejs"

type RouteContext = { params: Promise<{ id: string; pveName: string }> | { id: string; pveName: string } }

// GET
export async function GET(_req: Request, ctx: RouteContext) {
  try {
    const params = await Promise.resolve(ctx.params)
    const vdcId = (params as any)?.id
    const pveName = (params as any)?.pveName
    if (!vdcId || !pveName) return NextResponse.json({ error: "Missing params" }, { status: 400 })

    const denied = await checkPermission("sdn.vnet.view")
    if (denied) return denied

    const tenantId = await getCurrentTenantId()
    const db = getDb()
    const row = db.prepare(`
      SELECT v.id, v.vdc_id, v.pve_name, v.description, v.vxlan_tag, v.firewall, v.created_by, v.created_at
      FROM vdc_vnets v
      JOIN vdcs d ON d.id = v.vdc_id
      WHERE v.vdc_id = ? AND v.pve_name = ? AND d.tenant_id = ?
    `).get(vdcId, pveName, tenantId) as any

    if (!row) return NextResponse.json({ error: "VNet not found" }, { status: 404 })

    return NextResponse.json({
      data: {
        id: row.id,
        vdcId: row.vdc_id,
        pveName: row.pve_name,
        description: row.description ?? null,
        vxlanTag: row.vxlan_tag,
        firewall: !!row.firewall,
        createdBy: row.created_by ?? null,
        createdAt: row.created_at,
      },
    })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 })
  }
}

// PUT
export async function PUT(req: Request, ctx: RouteContext) {
  try {
    const params = await Promise.resolve(ctx.params)
    const vdcId = (params as any)?.id
    const pveName = (params as any)?.pveName
    if (!vdcId || !pveName) return NextResponse.json({ error: "Missing params" }, { status: 400 })

    const denied = await checkPermission("sdn.vnet.edit")
    if (denied) return denied

    const body = await req.json().catch(() => ({}))
    const patch: { description?: string; firewall?: boolean } = {}
    if (typeof body?.description === "string") patch.description = body.description.trim()
    if (typeof body?.firewall === "boolean") patch.firewall = body.firewall

    const tenantId = await getCurrentTenantId()

    try {
      const vnet = await updateVnetForTenant(vdcId, tenantId, pveName, patch)
      return NextResponse.json({ data: vnet })
    } catch (err: any) {
      const msg = err?.message || String(err)
      if (msg.includes("vDC not found") || msg.includes("VNet") && msg.includes("not found")) {
        return NextResponse.json({ error: msg }, { status: 404 })
      }
      throw err
    }
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 })
  }
}

// DELETE
export async function DELETE(_req: Request, ctx: RouteContext) {
  try {
    const params = await Promise.resolve(ctx.params)
    const vdcId = (params as any)?.id
    const pveName = (params as any)?.pveName
    if (!vdcId || !pveName) return NextResponse.json({ error: "Missing params" }, { status: 400 })

    const denied = await checkPermission("sdn.vnet.delete")
    if (denied) return denied

    const tenantId = await getCurrentTenantId()

    try {
      const result = await deleteVnetForTenant(vdcId, tenantId, pveName)
      if (!result.deleted) {
        return NextResponse.json(
          { error: `VNet in use by ${result.attachmentCount} NIC(s)`, attachmentCount: result.attachmentCount },
          { status: 409 }
        )
      }
      return NextResponse.json({ success: true })
    } catch (err: any) {
      const msg = err?.message || String(err)
      if (msg.includes("vDC not found") || (msg.includes("VNet") && msg.includes("not found"))) {
        return NextResponse.json({ error: msg }, { status: 404 })
      }
      throw err
    }
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 })
  }
}
```

- [ ] **Step 3: tsc + smoke + commit**

```bash
cd frontend && npx tsc --noEmit
```

Manual smoke (with the app running + a vDC existing):

```bash
# List VNets (empty initially)
curl -s -b "$AUTH" "http://localhost:3000/api/v1/vdcs/$VDC_ID/vnets" | jq .

# Create
curl -s -b "$AUTH" -X POST -H 'Content-Type: application/json' \
  -d '{"pveName":"prodlan","description":"Production LAN"}' \
  "http://localhost:3000/api/v1/vdcs/$VDC_ID/vnets" | jq .

# Delete (should succeed if no VM attached)
curl -s -b "$AUTH" -X DELETE "http://localhost:3000/api/v1/vdcs/$VDC_ID/vnets/prodlan" | jq .
```

```bash
git add "src/app/api/v1/vdcs/[id]/vnets/"
git commit -m "feat(vdc-sdn): tenant API for VNet CRUD (Phase 4b)"
```

---

## Task 3: Tenant APIs — shared-bridges + network-choices

**Files:**
- Create: `src/app/api/v1/vdcs/[id]/shared-bridges/route.ts` (tenant, read-only)
- Create: `src/app/api/v1/connections/[id]/network-choices/route.ts`

- [ ] **Step 1: Shared-bridges tenant route**

```typescript
// src/app/api/v1/vdcs/[id]/shared-bridges/route.ts
import { NextResponse } from "next/server"

import { getCurrentTenantId } from "@/lib/tenant"
import { checkPermission } from "@/lib/rbac"
import { listSharedBridgesForTenant } from "@/lib/vdc/vnets"

export const runtime = "nodejs"

type RouteContext = { params: Promise<{ id: string }> | { id: string } }

export async function GET(_req: Request, ctx: RouteContext) {
  try {
    const params = await Promise.resolve(ctx.params)
    const vdcId = (params as any)?.id
    if (!vdcId) return NextResponse.json({ error: "Missing vDC ID" }, { status: 400 })

    const denied = await checkPermission("sdn.vnet.view")
    if (denied) return denied

    const tenantId = await getCurrentTenantId()
    const data = listSharedBridgesForTenant(vdcId, tenantId)
    return NextResponse.json({ data })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 })
  }
}
```

- [ ] **Step 2: Network-choices unified endpoint**

```typescript
// src/app/api/v1/connections/[id]/network-choices/route.ts
import { NextResponse } from "next/server"

import { getCurrentTenantId } from "@/lib/tenant"
import { checkPermission, PERMISSIONS, buildNodeResourceId } from "@/lib/rbac"
import { getDb } from "@/lib/db/sqlite"
import { getVdcScope } from "@/lib/vdc/scope"
import { pveFetch } from "@/lib/proxmox/client"
import { getConnectionById } from "@/lib/connections/getConnection"
import { prisma } from "@/lib/db/prisma"

export const runtime = "nodejs"

type RouteContext = { params: Promise<{ id: string }> | { id: string } }

// GET /api/v1/connections/{id}/network-choices?node=X
// Returns unified list: VNets private to tenant's vDC + shared bridges authorized
// for tenant. For super admin / tenants without vDC, falls back to all bridges.
export async function GET(req: Request, ctx: RouteContext) {
  try {
    const params = await Promise.resolve(ctx.params)
    const connId = (params as any)?.id
    if (!connId) return NextResponse.json({ error: "Missing connection ID" }, { status: 400 })

    const url = new URL(req.url)
    const node = url.searchParams.get("node")
    if (!node) return NextResponse.json({ error: "Missing node query param" }, { status: 400 })

    const resourceId = buildNodeResourceId(connId, node)
    const denied = await checkPermission(PERMISSIONS.NODE_NETWORK, "node", resourceId)
    if (denied) return denied

    const tenantId = await getCurrentTenantId()
    const scope = getVdcScope(tenantId)
    const db = getDb()

    const connMeta = await prisma.connection.findUnique({ where: { id: connId }, select: { tenantId: true } })
    if (!connMeta) return NextResponse.json({ error: "Connection not found" }, { status: 404 })
    const pveConn = await getConnectionById(connId, connMeta.tenantId)

    type Choice =
      | { kind: "vnet"; name: string; vdc: string; zone: string }
      | { kind: "shared"; name: string; label: string | null }
      | { kind: "bridge"; name: string; type: string }

    const choices: Choice[] = []

    if (scope === null) {
      // Super admin or tenant without vDC - return all physical bridges
      const ifaces = await pveFetch<any[]>(pveConn, `/nodes/${encodeURIComponent(node)}/network`)
      for (const ifc of ifaces || []) {
        if (ifc.type !== "bridge" && ifc.type !== "OVSBridge") continue
        choices.push({ kind: "bridge", name: ifc.iface, type: ifc.type })
      }
      // Also include VNets from all zones (admin can see them)
      try {
        const vnets = await pveFetch<any[]>(pveConn, "/cluster/sdn/vnets")
        for (const v of vnets || []) {
          choices.push({ kind: "vnet", name: v.vnet, vdc: "*", zone: v.zone })
        }
      } catch {}
    } else {
      // Tenant with vDC(s) on this connection
      const allowedVnets = scope.vnetsByConnection.get(connId) ?? new Set<string>()
      const allowedShared = scope.sharedBridgesByConnection.get(connId) ?? new Set<string>()

      // Add tenant's VNets (with vdc name for grouping/display)
      const vnetRows = db.prepare(`
        SELECT v.pve_name, v.vdc_id, d.slug AS vdc_slug, d.sdn_zone_name
        FROM vdc_vnets v
        JOIN vdcs d ON d.id = v.vdc_id
        WHERE d.tenant_id = ? AND d.connection_id = ?
      `).all(tenantId, connId) as any[]
      for (const v of vnetRows) {
        if (allowedVnets.has(v.pve_name)) {
          choices.push({ kind: "vnet", name: v.pve_name, vdc: v.vdc_slug, zone: v.sdn_zone_name })
        }
      }

      // Add shared bridges (with labels from DB)
      if (allowedShared.size > 0) {
        const sharedRows = db.prepare(`
          SELECT b.bridge, b.label
          FROM vdc_shared_bridges b
          JOIN vdcs d ON d.id = b.vdc_id
          WHERE d.tenant_id = ? AND d.connection_id = ?
        `).all(tenantId, connId) as any[]
        const labelMap = new Map<string, string | null>()
        for (const r of sharedRows) labelMap.set(r.bridge, r.label ?? null)
        for (const bridge of allowedShared) {
          choices.push({ kind: "shared", name: bridge, label: labelMap.get(bridge) ?? null })
        }
      }
    }

    return NextResponse.json({ data: choices })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 })
  }
}
```

- [ ] **Step 3: tsc + commit**

```bash
cd frontend && npx tsc --noEmit
git add "src/app/api/v1/vdcs/[id]/shared-bridges/" "src/app/api/v1/connections/[id]/network-choices/"
git commit -m "feat(vdc-sdn): tenant APIs for shared-bridges + unified network-choices (Phase 4b)"
```

---

## Task 4: Bridge Enforcement in Guest Routes

Goal: reject VM/LXC operations that attempt to attach NICs to bridges outside the tenant's network-choices scope.

**Files:**
- Modify: `src/app/api/v1/connections/[id]/guests/[type]/[node]/route.ts` (POST create)
- Modify: `src/app/api/v1/connections/[id]/guests/[type]/[node]/[vmid]/clone/route.ts` (POST clone)
- Modify: `src/app/api/v1/connections/[id]/guests/[type]/[node]/[vmid]/config/route.ts` (PUT config)

- [ ] **Step 1: Add a shared helper `validateBridgeScope`**

Create (if it doesn't exist) or append to `src/lib/vdc/vnets.ts`:

```typescript
// ---------------------------------------------------------------------------
// Bridge whitelist validation for guest operations
// ---------------------------------------------------------------------------

/**
 * Returns the set of bridge names a tenant is allowed to attach to on a given connection.
 * Returns null if no restrictions apply (super admin or tenant without vDCs).
 */
export function getAllowedBridgesForTenant(tenantId: string, connectionId: string): Set<string> | null {
  const db = getDb()
  const vdcRows = db
    .prepare('SELECT id FROM vdcs WHERE tenant_id = ? AND connection_id = ? AND enabled = 1')
    .all(tenantId, connectionId) as Array<{ id: string }>
  if (vdcRows.length === 0) return null // No vDC restrictions — permissive

  const allowed = new Set<string>()
  const stmtVnets = db.prepare('SELECT pve_name FROM vdc_vnets WHERE vdc_id = ?')
  const stmtShared = db.prepare('SELECT bridge FROM vdc_shared_bridges WHERE vdc_id = ?')
  for (const vdc of vdcRows) {
    for (const v of stmtVnets.all(vdc.id) as Array<{ pve_name: string }>) allowed.add(v.pve_name)
    for (const b of stmtShared.all(vdc.id) as Array<{ bridge: string }>) allowed.add(b.bridge)
  }
  return allowed
}

/** Parse bridge= from a PVE net config string */
export function parseBridgeFromNet(netStr: string): string | null {
  const m = String(netStr || '').match(/bridge=([^,]+)/)
  return m ? m[1] : null
}
```

Note: `getAllowedBridgesForTenant` is importable from `@/lib/vdc/vnets`. The `DEFAULT_TENANT_ID` case is handled: if the current tenant is default and has no vDCs, returns null (no restrictions). If it's a real tenant with no vDCs (odd case), also returns null.

- [ ] **Step 2: Enforce in `POST /guests/[type]/[node]`**

Read the current file (`src/app/api/v1/connections/[id]/guests/[type]/[node]/route.ts`). Locate where the request body's `net0`, `net1`, etc. are being processed or passed through. Right AFTER the existing Phase 3 quota check and BEFORE the `pveFetch` POST call to create the VM, add:

```typescript
import { getAllowedBridgesForTenant, parseBridgeFromNet } from "@/lib/vdc/vnets"
// (add to imports at top)

// Inside POST handler, after quota check:
const allowedBridges = getAllowedBridgesForTenant(tenantId, id)
if (allowedBridges !== null) {
  const keys = Object.keys(body || {}).filter((k) => /^net\d+$/.test(k))
  for (const key of keys) {
    const bridge = parseBridgeFromNet(String(body[key] || ""))
    if (bridge && !allowedBridges.has(bridge)) {
      return NextResponse.json(
        { error: `Bridge "${bridge}" is not authorized for this vDC. Allowed: ${Array.from(allowedBridges).join(", ")}` },
        { status: 403 }
      )
    }
  }
}
```

Where `tenantId` is already resolved in the route (Phase 3 also uses it). `id` is the connectionId path param.

- [ ] **Step 3: Enforce in clone route**

In `src/app/api/v1/connections/[id]/guests/[type]/[node]/[vmid]/clone/route.ts`: the clone body may include `net0` override (rare). The source VM config is also a target. Simplest: after the existing quota check, validate any `netN` in the clone body. If none present (pure clone), the source config's bridges carry over — which were already validated on creation.

Add similar block after quota check:

```typescript
import { getAllowedBridgesForTenant, parseBridgeFromNet } from "@/lib/vdc/vnets"

const allowedBridges = getAllowedBridgesForTenant(tenantId, id)
if (allowedBridges !== null) {
  const keys = Object.keys(body || {}).filter((k) => /^net\d+$/.test(k))
  for (const key of keys) {
    const bridge = parseBridgeFromNet(String(body[key] || ""))
    if (bridge && !allowedBridges.has(bridge)) {
      return NextResponse.json(
        { error: `Bridge "${bridge}" is not authorized for this vDC` },
        { status: 403 }
      )
    }
  }
}
```

- [ ] **Step 4: Enforce in config route**

In `src/app/api/v1/connections/[id]/guests/[type]/[node]/[vmid]/config/route.ts` (PUT): user can update `netN` to attach to another bridge. Same validation:

```typescript
import { getAllowedBridgesForTenant, parseBridgeFromNet } from "@/lib/vdc/vnets"

const allowedBridges = getAllowedBridgesForTenant(tenantId, id)
if (allowedBridges !== null) {
  for (const key of Object.keys(body || {})) {
    if (!/^net\d+$/.test(key)) continue
    const bridge = parseBridgeFromNet(String(body[key] || ""))
    if (bridge && !allowedBridges.has(bridge)) {
      return NextResponse.json(
        { error: `Bridge "${bridge}" is not authorized for this vDC` },
        { status: 403 }
      )
    }
  }
}
```

- [ ] **Step 5: tsc + commit**

```bash
cd frontend && npx tsc --noEmit
git add "src/app/api/v1/connections/[id]/guests/" src/lib/vdc/vnets.ts
git commit -m "feat(vdc-sdn): enforce bridge whitelist on guest create/clone/config (Phase 4b)"
```

---

## Task 5: Dialog Updates — Use `network-choices`

**Files:**
- Modify: `src/app/(dashboard)/infrastructure/inventory/CreateVmDialog.tsx`
- Modify: `src/app/(dashboard)/infrastructure/inventory/CreateLxcDialog.tsx`
- Modify: `src/components/hardware/AddNetworkDialog.tsx`
- Modify: `src/components/hardware/EditNetworkDialog.tsx`

The 4 dialogs currently fetch `/api/v1/connections/{id}/nodes/{node}/network` and filter type=bridge|OVSBridge. Replace with `/api/v1/connections/{id}/network-choices?node={node}` which returns a unified list.

- [ ] **Step 1: Replace bridge-loading in `CreateVmDialog.tsx`**

Find the `loadBridges` function (around line 205). Replace with:

```typescript
const loadBridges = async (connId: string, node: string) => {
  try {
    const res = await fetch(
      `/api/v1/connections/${encodeURIComponent(connId)}/network-choices?node=${encodeURIComponent(node)}`
    )
    if (res.ok) {
      const json = await res.json()
      const choices = Array.isArray(json.data) ? json.data : []
      // Adapt to existing `bridges` state shape: it expects { iface, type, ... }.
      // Map choices to a compatible shape, tagging the kind for optional grouping.
      const bridgeList = choices.map((c: any) => ({
        iface: c.name,
        type: c.kind === "vnet" ? "vnet" : c.kind === "shared" ? "shared" : (c.type || "bridge"),
        label: c.label,
        vdc: c.vdc,
      }))
      setBridges(bridgeList)
      if (bridgeList.length > 0) {
        setNics((prev) =>
          prev.map((nic) =>
            bridgeList.some((b: any) => b.iface === nic.bridge) ? nic : { ...nic, bridge: bridgeList[0].iface }
          )
        )
      }
    }
  } catch (e) {
    console.error("Error loading network choices:", e)
    setBridges([])
  }
}
```

No structural changes needed in the Select rendering — `bridge.iface` is what's displayed. Optional: add visual distinction (icon / sub-text) per kind, but out-of-scope MVP.

- [ ] **Step 2: Same replacement in `CreateLxcDialog.tsx`**

Find the equivalent bridge-loading effect and apply the same substitution.

- [ ] **Step 3: Same replacement in `AddNetworkDialog.tsx`**

Locate the `loadBridges` inside the `useEffect` (around line 64). Replace the fetch URL and mapping similarly. The existing fallback `['vmbr0', 'vmbr1']` can remain as a last-resort display.

- [ ] **Step 4: Same in `EditNetworkDialog.tsx`**

Similar pattern.

- [ ] **Step 5: Manual test in browser**

Ouvre CreateVmDialog → choisis node → le dropdown `bridge` doit lister les VNets + bridges partagés. Si tu es super_admin ou tenant sans vDC, tu vois tous les bridges + VNets (comportement permissif hérité).

- [ ] **Step 6: Commit**

```bash
git add src/app/\(dashboard\)/infrastructure/inventory/CreateVmDialog.tsx src/app/\(dashboard\)/infrastructure/inventory/CreateLxcDialog.tsx src/components/hardware/AddNetworkDialog.tsx src/components/hardware/EditNetworkDialog.tsx
git commit -m "feat(vdc-sdn): dialogs use network-choices for bridge picker (Phase 4b)"
```

---

## Task 6: Tenant Page `/dashboard/my-vdc`

**Files:**
- Create: `src/app/(dashboard)/my-vdc/page.tsx`
- Create: `src/components/mydc/MyVdcOverview.tsx`
- Create: `src/components/mydc/VnetList.tsx`
- Create: `src/components/mydc/VnetCreateDialog.tsx`
- Create: `src/components/mydc/VnetEditDialog.tsx`
- Create: `src/components/mydc/VnetDeleteDialog.tsx`

- [ ] **Step 1: Page container**

`src/app/(dashboard)/my-vdc/page.tsx`:

```tsx
'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'

import { Box, Typography, MenuItem, Select, FormControl, InputLabel, Alert, Stack, Divider } from '@mui/material'

import MyVdcOverview from '@/components/mydc/MyVdcOverview'
import VnetList from '@/components/mydc/VnetList'

export default function MyVdcPage() {
  const t = useTranslations()
  const [vdcs, setVdcs] = useState<any[]>([])
  const [selectedVdcId, setSelectedVdcId] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch('/api/v1/vdcs')
        const json = await res.json()
        const list = Array.isArray(json.data) ? json.data : []
        setVdcs(list)
        if (list.length > 0) setSelectedVdcId(list[0].id)
      } catch (e: any) {
        setError(e?.message || String(e))
      } finally {
        setLoading(false)
      }
    })()
  }, [])

  const selectedVdc = vdcs.find((v) => v.id === selectedVdcId)

  if (loading) return <Box p={3}>{t('common.loading')}</Box>
  if (error) return <Box p={3}><Alert severity="error">{error}</Alert></Box>
  if (vdcs.length === 0) {
    return (
      <Box p={3}>
        <Typography variant="h5" gutterBottom>{t('myVdc.title')}</Typography>
        <Alert severity="info">{t('myVdc.noVdcs')}</Alert>
      </Box>
    )
  }

  return (
    <Box p={3}>
      <Stack direction="row" alignItems="center" spacing={2} mb={2}>
        <Typography variant="h5">{t('myVdc.title')}</Typography>
        {vdcs.length > 1 && (
          <FormControl size="small" sx={{ minWidth: 240 }}>
            <InputLabel>{t('myVdc.selectVdc')}</InputLabel>
            <Select
              value={selectedVdcId}
              label={t('myVdc.selectVdc')}
              onChange={(e) => setSelectedVdcId(e.target.value)}
            >
              {vdcs.map((v) => (
                <MenuItem key={v.id} value={v.id}>{v.name}</MenuItem>
              ))}
            </Select>
          </FormControl>
        )}
      </Stack>

      {selectedVdc && (
        <>
          <MyVdcOverview vdc={selectedVdc} />
          <Divider sx={{ my: 3 }} />
          <VnetList vdcId={selectedVdc.id} quota={selectedVdc.quota} />
        </>
      )}
    </Box>
  )
}
```

- [ ] **Step 2: MyVdcOverview component**

`src/components/mydc/MyVdcOverview.tsx`:

```tsx
'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'

import { Box, Typography, Stack, Chip, LinearProgress, Paper } from '@mui/material'

interface Props {
  vdc: any
}

export default function MyVdcOverview({ vdc }: Props) {
  const t = useTranslations()
  const [sharedBridges, setSharedBridges] = useState<Array<{ bridge: string; label: string | null }>>([])

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch(`/api/v1/vdcs/${encodeURIComponent(vdc.id)}/shared-bridges`)
        const json = await res.json()
        setSharedBridges(Array.isArray(json.data) ? json.data : [])
      } catch {}
    })()
  }, [vdc.id])

  const usage = vdc.usage || {}
  const quota = vdc.quota || {}

  const qRow = (label: string, used: number, max: number | null | undefined) => {
    const pct = max ? Math.round((used / max) * 100) : 0
    return (
      <Stack direction="row" alignItems="center" spacing={2}>
        <Typography variant="body2" sx={{ minWidth: 120 }}>{label}</Typography>
        <Box sx={{ flex: 1 }}>
          {max ? (
            <LinearProgress variant="determinate" value={Math.min(pct, 100)} color={pct >= 90 ? 'error' : pct >= 70 ? 'warning' : 'primary'} />
          ) : (
            <Typography variant="caption">{t('vdc.quotaUnlimited')}</Typography>
          )}
        </Box>
        <Typography variant="body2" sx={{ minWidth: 100 }}>
          {used}{max ? ` / ${max}` : ''}
        </Typography>
      </Stack>
    )
  }

  return (
    <Paper sx={{ p: 2 }}>
      <Typography variant="h6" gutterBottom>{vdc.name}</Typography>

      <Stack direction="row" spacing={3} mb={2} flexWrap="wrap">
        <Box><Typography variant="caption" color="text.secondary">{t('myVdc.nodes')}</Typography><Typography>{(vdc.nodes || []).join(', ')}</Typography></Box>
        <Box><Typography variant="caption" color="text.secondary">{t('myVdc.storages')}</Typography><Typography>{(vdc.storages || []).join(', ')}</Typography></Box>
      </Stack>

      <Typography variant="subtitle2" sx={{ mt: 2 }}>{t('myVdc.quotas')}</Typography>
      <Stack spacing={1} mt={1}>
        {qRow(t('vdc.maxVcpus'), usage.usedVcpus || 0, quota.maxVcpus)}
        {qRow(t('vdc.maxRam'), Math.round((usage.usedRamMb || 0) / 1024), quota.maxRamMb ? Math.round(quota.maxRamMb / 1024) : null)}
        {qRow(t('vdc.maxVms'), usage.usedVms || 0, quota.maxVms)}
        {qRow(t('vdc.maxVnets'), (vdc.vnets || []).length, quota.maxVnets)}
      </Stack>

      <Typography variant="subtitle2" sx={{ mt: 2 }}>{t('myVdc.uplinks')}</Typography>
      <Stack direction="row" spacing={1} flexWrap="wrap" mt={1}>
        {sharedBridges.length === 0 ? (
          <Typography variant="caption" color="text.secondary">{t('myVdc.noUplinks')}</Typography>
        ) : (
          sharedBridges.map((sb) => (
            <Chip
              key={sb.bridge}
              label={sb.label ? `${sb.bridge} — ${sb.label}` : sb.bridge}
              size="small"
              sx={{ fontFamily: 'monospace' }}
            />
          ))
        )}
      </Stack>
    </Paper>
  )
}
```

- [ ] **Step 3: VnetList component**

`src/components/mydc/VnetList.tsx`:

```tsx
'use client'

import { useCallback, useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'

import { Box, Button, Typography, Stack, IconButton, Chip } from '@mui/material'
import { DataGrid, type GridColDef } from '@mui/x-data-grid'

import VnetCreateDialog from './VnetCreateDialog'
import VnetEditDialog from './VnetEditDialog'
import VnetDeleteDialog from './VnetDeleteDialog'

interface Props {
  vdcId: string
  quota: { maxVnets?: number | null } | null
}

export default function VnetList({ vdcId, quota }: Props) {
  const t = useTranslations()
  const [rows, setRows] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [createOpen, setCreateOpen] = useState(false)
  const [editVnet, setEditVnet] = useState<any | null>(null)
  const [deleteVnet, setDeleteVnet] = useState<any | null>(null)

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`/api/v1/vdcs/${encodeURIComponent(vdcId)}/vnets`)
      const json = await res.json()
      setRows(Array.isArray(json.data) ? json.data : [])
    } finally {
      setLoading(false)
    }
  }, [vdcId])

  useEffect(() => { void reload() }, [reload])

  const quotaReached = quota?.maxVnets != null && rows.length >= quota.maxVnets

  const columns: GridColDef[] = [
    { field: 'pveName', headerName: t('myVdc.vnetName'), flex: 1, renderCell: (p) => <Typography fontFamily="monospace">{p.value}</Typography> },
    { field: 'description', headerName: t('myVdc.vnetDescription'), flex: 2 },
    { field: 'vxlanTag', headerName: 'VNI', width: 100 },
    {
      field: 'firewall',
      headerName: t('myVdc.vnetFirewall'),
      width: 120,
      renderCell: (p) => <Chip size="small" label={p.value ? t('myVdc.fwOn') : t('myVdc.fwOff')} color={p.value ? 'success' : 'default'} />,
    },
    {
      field: 'actions',
      headerName: '',
      width: 120,
      sortable: false,
      renderCell: (p) => (
        <Stack direction="row" spacing={1}>
          <IconButton size="small" onClick={() => setEditVnet(p.row)}><i className="ri-pencil-line" /></IconButton>
          <IconButton size="small" color="error" onClick={() => setDeleteVnet(p.row)}><i className="ri-delete-bin-line" /></IconButton>
        </Stack>
      ),
    },
  ]

  return (
    <Box>
      <Stack direction="row" justifyContent="space-between" alignItems="center" mb={2}>
        <Typography variant="h6">{t('myVdc.vnetsTitle')}</Typography>
        <Button
          variant="contained"
          startIcon={<i className="ri-add-line" />}
          disabled={quotaReached}
          onClick={() => setCreateOpen(true)}
        >
          {t('myVdc.createVnet')}
        </Button>
      </Stack>

      <DataGrid
        rows={rows}
        columns={columns}
        getRowId={(r) => r.id}
        loading={loading}
        disableRowSelectionOnClick
        autoHeight
        pageSizeOptions={[10, 25, 50]}
      />

      <VnetCreateDialog open={createOpen} vdcId={vdcId} onClose={() => setCreateOpen(false)} onCreated={() => { setCreateOpen(false); void reload() }} />
      {editVnet && <VnetEditDialog vnet={editVnet} vdcId={vdcId} onClose={() => setEditVnet(null)} onSaved={() => { setEditVnet(null); void reload() }} />}
      {deleteVnet && <VnetDeleteDialog vnet={deleteVnet} vdcId={vdcId} onClose={() => setDeleteVnet(null)} onDeleted={() => { setDeleteVnet(null); void reload() }} />}
    </Box>
  )
}
```

- [ ] **Step 4: VnetCreateDialog**

`src/components/mydc/VnetCreateDialog.tsx`:

```tsx
'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'

import { Dialog, DialogContent, DialogActions, Button, TextField, FormControlLabel, Switch, Alert, Stack, Typography } from '@mui/material'

import AppDialogTitle from '@/components/ui/AppDialogTitle'

interface Props {
  open: boolean
  vdcId: string
  onClose: () => void
  onCreated: () => void
}

const NAME_REGEX = /^[a-z][a-z0-9]{0,14}$/

export default function VnetCreateDialog({ open, vdcId, onClose, onCreated }: Props) {
  const t = useTranslations()
  const [pveName, setPveName] = useState('')
  const [description, setDescription] = useState('')
  const [firewall, setFirewall] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const nameValid = pveName === '' || NAME_REGEX.test(pveName)

  const handleSubmit = async () => {
    if (!NAME_REGEX.test(pveName)) {
      setError(t('myVdc.errorInvalidName'))
      return
    }
    setSaving(true); setError(null)
    try {
      const res = await fetch(`/api/v1/vdcs/${encodeURIComponent(vdcId)}/vnets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pveName, description: description || undefined, firewall }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
      onCreated()
      setPveName(''); setDescription(''); setFirewall(true)
    } catch (e: any) {
      setError(e?.message || String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onClose={saving ? undefined : onClose} maxWidth="sm" fullWidth>
      <AppDialogTitle onClose={onClose}>{t('myVdc.createVnet')}</AppDialogTitle>
      <DialogContent>
        <Stack spacing={2} mt={1}>
          <TextField
            label={t('myVdc.vnetName')}
            value={pveName}
            onChange={(e) => setPveName(e.target.value)}
            error={!nameValid}
            helperText={nameValid ? t('myVdc.vnetNameHint') : t('myVdc.errorInvalidName')}
            fullWidth
            autoFocus
            slotProps={{ htmlInput: { maxLength: 15, pattern: '^[a-z][a-z0-9]{0,14}$' } }}
          />
          <TextField
            label={t('myVdc.vnetDescription')}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            fullWidth
            multiline
            rows={2}
          />
          <FormControlLabel
            control={<Switch checked={firewall} onChange={(e) => setFirewall(e.target.checked)} />}
            label={t('myVdc.vnetFirewallToggle')}
          />
          <Typography variant="caption" color="text.secondary">{t('myVdc.vnetVniAutoAllocated')}</Typography>
          {error && <Alert severity="error">{error}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={saving}>{t('common.cancel')}</Button>
        <Button variant="contained" onClick={handleSubmit} disabled={!pveName || !nameValid || saving}>{t('common.create')}</Button>
      </DialogActions>
    </Dialog>
  )
}
```

- [ ] **Step 5: VnetEditDialog**

`src/components/mydc/VnetEditDialog.tsx`:

```tsx
'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'

import { Dialog, DialogContent, DialogActions, Button, TextField, FormControlLabel, Switch, Alert, Stack } from '@mui/material'

import AppDialogTitle from '@/components/ui/AppDialogTitle'

interface Props {
  vnet: any
  vdcId: string
  onClose: () => void
  onSaved: () => void
}

export default function VnetEditDialog({ vnet, vdcId, onClose, onSaved }: Props) {
  const t = useTranslations()
  const [description, setDescription] = useState(vnet.description ?? '')
  const [firewall, setFirewall] = useState(!!vnet.firewall)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async () => {
    setSaving(true); setError(null)
    try {
      const res = await fetch(
        `/api/v1/vdcs/${encodeURIComponent(vdcId)}/vnets/${encodeURIComponent(vnet.pveName)}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ description, firewall }),
        }
      )
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
      onSaved()
    } catch (e: any) {
      setError(e?.message || String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onClose={saving ? undefined : onClose} maxWidth="sm" fullWidth>
      <AppDialogTitle onClose={onClose}>{vnet.pveName}</AppDialogTitle>
      <DialogContent>
        <Stack spacing={2} mt={1}>
          <TextField label={t('myVdc.vnetDescription')} value={description} onChange={(e) => setDescription(e.target.value)} fullWidth multiline rows={2} />
          <FormControlLabel control={<Switch checked={firewall} onChange={(e) => setFirewall(e.target.checked)} />} label={t('myVdc.vnetFirewallToggle')} />
          {error && <Alert severity="error">{error}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={saving}>{t('common.cancel')}</Button>
        <Button variant="contained" onClick={handleSubmit} disabled={saving}>{t('common.save')}</Button>
      </DialogActions>
    </Dialog>
  )
}
```

- [ ] **Step 6: VnetDeleteDialog**

`src/components/mydc/VnetDeleteDialog.tsx`:

```tsx
'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'

import { Dialog, DialogContent, DialogActions, Button, Alert, Typography, Stack } from '@mui/material'

import AppDialogTitle from '@/components/ui/AppDialogTitle'

interface Props {
  vnet: any
  vdcId: string
  onClose: () => void
  onDeleted: () => void
}

export default function VnetDeleteDialog({ vnet, vdcId, onClose, onDeleted }: Props) {
  const t = useTranslations()
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleDelete = async () => {
    setDeleting(true); setError(null)
    try {
      const res = await fetch(
        `/api/v1/vdcs/${encodeURIComponent(vdcId)}/vnets/${encodeURIComponent(vnet.pveName)}`,
        { method: 'DELETE' }
      )
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
      onDeleted()
    } catch (e: any) {
      setError(e?.message || String(e))
    } finally {
      setDeleting(false)
    }
  }

  return (
    <Dialog open onClose={deleting ? undefined : onClose} maxWidth="sm" fullWidth>
      <AppDialogTitle onClose={onClose}>{t('myVdc.deleteVnetTitle')}</AppDialogTitle>
      <DialogContent>
        <Stack spacing={2} mt={1}>
          <Typography>{t('myVdc.deleteVnetConfirm', { name: vnet.pveName })}</Typography>
          <Typography variant="caption" color="text.secondary">{t('myVdc.deleteVnetHint')}</Typography>
          {error && <Alert severity="error">{error}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={deleting}>{t('common.cancel')}</Button>
        <Button variant="contained" color="error" onClick={handleDelete} disabled={deleting}>{t('common.delete')}</Button>
      </DialogActions>
    </Dialog>
  )
}
```

- [ ] **Step 7: Commit**

```bash
git add "src/app/(dashboard)/my-vdc/" src/components/mydc/
git commit -m "feat(vdc-sdn): tenant page /my-vdc with VNet CRUD UI (Phase 4b)"
```

---

## Task 7: Menu item + i18n

**Files:**
- Modify: `src/@menu/menuData.js`
- Modify: `src/messages/en.json`
- Modify: `src/messages/fr.json`

- [ ] **Step 1: Add menu item**

In `src/@menu/menuData.js`, locate the Infrastructure section (`isSection: true, label: t('navigation.infrastructure')`). Add a new child item AFTER Inventory:

```javascript
{
  label: t('navigation.myVdc'),
  icon: 'ri-cloud-line',
  href: '/my-vdc',
  permissions: ['sdn.vnet.view'],
},
```

- [ ] **Step 2: i18n keys EN**

In `src/messages/en.json`:

```json
"navigation": {
  ...
  "myVdc": "My Datacenter",
  ...
},
"myVdc": {
  "title": "My Datacenter",
  "selectVdc": "Select vDC",
  "noVdcs": "No virtual datacenter is assigned to your tenant.",
  "nodes": "Nodes",
  "storages": "Storages",
  "quotas": "Quotas & usage",
  "uplinks": "Provider uplinks (authorized shared bridges)",
  "noUplinks": "No uplinks authorized by the provider.",
  "vnetsTitle": "My VNets",
  "createVnet": "Create VNet",
  "vnetName": "Name",
  "vnetNameHint": "Lowercase letters and digits, starting with a letter, max 15 chars.",
  "vnetDescription": "Description",
  "vnetFirewall": "Firewall",
  "vnetFirewallToggle": "Enable VNet firewall",
  "vnetVniAutoAllocated": "VNI is auto-allocated by ProxCenter.",
  "fwOn": "On",
  "fwOff": "Off",
  "errorInvalidName": "Invalid name. Must match ^[a-z][a-z0-9]{0,14}$ (e.g. prodlan, dmz, app1).",
  "deleteVnetTitle": "Delete VNet",
  "deleteVnetConfirm": "Are you sure you want to delete VNet \"{name}\"?",
  "deleteVnetHint": "The VNet must have no NIC attached. If VMs are still using it, the delete will be rejected."
}
```

- [ ] **Step 3: i18n keys FR**

In `src/messages/fr.json` (same structure, real French translations):

```json
"navigation": {
  ...
  "myVdc": "Mon datacenter",
  ...
},
"myVdc": {
  "title": "Mon datacenter",
  "selectVdc": "Sélectionner un vDC",
  "noVdcs": "Aucun datacenter virtuel n'est assigné à votre tenant.",
  "nodes": "Nœuds",
  "storages": "Stockages",
  "quotas": "Quotas et usage",
  "uplinks": "Uplinks provider (bridges partagés autorisés)",
  "noUplinks": "Aucun uplink autorisé par le provider.",
  "vnetsTitle": "Mes VNets",
  "createVnet": "Créer un VNet",
  "vnetName": "Nom",
  "vnetNameHint": "Lettres minuscules et chiffres, commence par une lettre, 15 caractères maximum.",
  "vnetDescription": "Description",
  "vnetFirewall": "Firewall",
  "vnetFirewallToggle": "Activer le firewall VNet",
  "vnetVniAutoAllocated": "Le VNI est alloué automatiquement par ProxCenter.",
  "fwOn": "Actif",
  "fwOff": "Inactif",
  "errorInvalidName": "Nom invalide. Doit matcher ^[a-z][a-z0-9]{0,14}$ (ex: prodlan, dmz, app1).",
  "deleteVnetTitle": "Supprimer le VNet",
  "deleteVnetConfirm": "Êtes-vous sûr de vouloir supprimer le VNet « {name} » ?",
  "deleteVnetHint": "Le VNet ne doit plus avoir de NIC attachée. Si des VMs l'utilisent encore, la suppression sera rejetée."
}
```

- [ ] **Step 4: Commit**

```bash
git add src/@menu/menuData.js src/messages/en.json src/messages/fr.json
git commit -m "feat(vdc-sdn): add 'My Datacenter' menu item + tenant i18n (Phase 4b)"
```

---

## Task 8: E2E Validation

Manual. No code.

- [ ] **Step 1: Connect as a tenant_admin user**

Create (or reuse) a tenant user with `role_tenant_admin` assigned to a tenant that owns a vDC (with SDN zone = output of Phase 4a). Log in as that user.

- [ ] **Step 2: Navigate to `/my-vdc`**

- Page renders
- Overview shows quotas + uplinks (shared bridges labels)
- VNet list empty initially

- [ ] **Step 3: Create a VNet**

- Click "Create VNet"
- Enter name `prodlan`, description "LAN", firewall ON
- Submit → row appears in list

Verify on PVE:
```bash
curl -sk -H "Authorization: PVEAPIToken=..." "https://{pve}:8006/api2/json/cluster/sdn/vnets" | jq '.data[] | select(.vnet=="prodlan")'
```

- [ ] **Step 4: Attach a VM NIC to the VNet**

As the same tenant user, Inventory > Create VM. In the bridge picker, `prodlan` must appear (along with the authorized shared bridges). Select it. Create the VM.

Verify in PVE the VM has `net0: virtio,bridge=prodlan`.

- [ ] **Step 5: Attempt to bypass — attach to unauthorized bridge**

Use curl directly to POST VM create with `net0=bridge=some-random-bridge`. Expect 403.

- [ ] **Step 6: Delete attempt fails while VM attached**

In `/my-vdc`, click delete on `prodlan`. Expect 409 with attachmentCount=1.

- [ ] **Step 7: Delete VM, then delete VNet**

Remove the VM. Retry delete on `prodlan`. Expect success.

Verify on PVE: `prodlan` gone.

- [ ] **Step 8: Quota enforcement**

Set the vDC `max_vnets=2` via admin. Create 2 VNets. The 3rd creation attempt should fail with 409 "Quota exceeded".

- [ ] **Step 9: Commit any small fixes if E2E revealed issues.**

---

## Summary

| Task | Deliverable |
|------|-------------|
| 1 | `lib/vdc/vnets.ts` — orchestration tenant VNet CRUD + tests |
| 2 | Tenant API `/vdcs/[id]/vnets/*` (GET, POST, GET item, PUT, DELETE) |
| 3 | Tenant APIs `/vdcs/[id]/shared-bridges` + unified `/connections/[id]/network-choices` |
| 4 | Enforcement whitelist bridge dans routes guests create/clone/config |
| 5 | 4 dialogs VM/LXC utilisent `network-choices` |
| 6 | Page `/dashboard/my-vdc` + 5 composants MuiDc |
| 7 | Menu "Mon vDC" + i18n EN/FR |
| 8 | E2E validation manuelle |

**Ce que ça livre:** tenant_admin peut créer/supprimer/modifier ses VNets en self-service, ses VMs/LXC sont restreints aux bridges autorisés (VNets privés + uplinks cochés par l'admin). Enforcement backend robuste. Aucun impact sur super_admin / tenants sans vDC.

**Next:** Phase 4c — UI firewall VNet (CRUD règles + IPSets + aliases).
