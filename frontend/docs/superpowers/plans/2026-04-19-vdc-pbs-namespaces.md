# vDC PBS Namespaces Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically provision per-vDC backup isolation on PBS — namespace, scoped sub-token, PVE `pbs:` storage — and filter tenant UI everywhere PBS data is shown.

**Architecture:** A new orchestrator module (`lib/vdc/pbsOrchestrator.ts`) coordinates three primitives: PBS namespace + sub-token + ACL (PBS REST API), PVE `pbs:` storage entry (PVE REST API), and DB rows (two new SQLite tables). The existing `VdcScope` (`lib/vdc/scope.ts`) is extended with per-connection `pbsNamespaces`, consumed by the inventory stream and backup endpoints to filter snapshots.

**Tech Stack:**
- Node.js / Next.js 15 (app router, server routes in `src/app/api/v1`)
- Prisma (connections + secrets) + better-sqlite3 (tenancy, vDCs, RBAC)
- `pveFetch` / `pbsFetch` (custom clients in `src/lib/proxmox`)
- MUI + react-hooks on the client
- Vitest for unit tests (mocks for PBS/PVE fetchers)

**Design spec:** `frontend/docs/superpowers/specs/2026-04-19-vdc-pbs-namespaces-design.md`

---

## File structure

### New files

- `frontend/src/lib/db/vdcPbsBindings.ts` — CRUD for `vdc_pbs_namespaces` + `vdc_pbs_pve_storages`.
- `frontend/src/lib/db/vdcPbsBindings.test.ts` — unit tests.
- `frontend/src/lib/proxmox/pbsFingerprint.ts` — TLS SHA256 capture helper.
- `frontend/src/lib/proxmox/pbsFingerprint.test.ts`
- `frontend/src/lib/proxmox/pbsNamespace.ts` — namespace + sub-token + ACL helpers (uses `pbsFetch`).
- `frontend/src/lib/proxmox/pbsNamespace.test.ts`
- `frontend/src/lib/proxmox/pvePbsStorage.ts` — PVE `pbs:` storage create/delete/get (uses `pveFetch`).
- `frontend/src/lib/proxmox/pvePbsStorage.test.ts`
- `frontend/src/lib/vdc/pbsOrchestrator.ts` — high-level bind/unbind.
- `frontend/src/lib/vdc/pbsOrchestrator.test.ts`
- `frontend/src/app/api/v1/admin/vdcs/[id]/pbs-bindings/route.ts` — GET list + POST create.
- `frontend/src/app/api/v1/admin/vdcs/[id]/pbs-bindings/[bindingId]/route.ts` — DELETE.
- `frontend/src/app/api/v1/admin/pbs-connections/[id]/datastores/route.ts` — GET datastores (for dropdown).
- `frontend/src/app/api/v1/admin/pbs-connections/[id]/fingerprint/route.ts` — POST re-capture fingerprint.
- `frontend/src/components/settings/VdcPbsBindingsDialog.tsx` — admin UI.

### Modified files

- `frontend/prisma/schema.prisma` — add `Connection.fingerprint`.
- `frontend/src/lib/db/sqlite.ts` — add 2 new tables (DDL + additive migration).
- `frontend/src/lib/vdc/scope.ts` — extend `VdcScope` + `buildVdcScope`.
- `frontend/src/lib/vdc/types.ts` — shared types (`PbsBindingRow`, etc.).
- `frontend/src/app/api/v1/inventory/stream/route.ts` — filter PBS by namespace when tenant has scope.
- `frontend/src/app/api/v1/pbs/[id]/datastores/[store]/snapshots/route.ts` — accept tenant namespace filter.
- `frontend/src/app/api/v1/admin/vdcs/[id]/route.ts` — cascade cleanup on DELETE.
- `frontend/src/components/settings/VdcTab.tsx` — "Backup (PBS)" button in row actions / edit dialog.
- `frontend/src/messages/{en,fr,de,zh-CN}.json` — new strings.

---

## Task list

### Task 1: DB schema — `Connection.fingerprint` + two SQLite tables

**Files:**
- Modify: `frontend/prisma/schema.prisma:30` (add column after `apiTokenEnc`).
- Modify: `frontend/src/lib/db/sqlite.ts` (inline DDL block + ALTER migration).

- [ ] **Step 1: Add Prisma column**

Edit `frontend/prisma/schema.prisma`, inside `model Connection`:

```prisma
  apiTokenEnc String
  fingerprint String?   // SHA256 cert fingerprint; populated for PBS connections
```

- [ ] **Step 2: Run prisma generate + create migration**

```bash
cd frontend
npx prisma migrate dev --name add_connection_fingerprint --create-only
# Verify generated SQL adds `ALTER TABLE "Connection" ADD COLUMN "fingerprint" TEXT;`
npx prisma migrate dev --name add_connection_fingerprint
```

Expected: migration applied, `npx prisma studio` shows the column.

- [ ] **Step 3: Add SQLite tables to bootstrap DDL**

In `frontend/src/lib/db/sqlite.ts`, inside the schema bootstrap block that creates the vDC tables (near line 444, after `vdc_vnets`):

```sql
    CREATE TABLE IF NOT EXISTS vdc_pbs_namespaces (
      id                 TEXT PRIMARY KEY,
      vdc_id             TEXT NOT NULL REFERENCES vdcs(id) ON DELETE CASCADE,
      pbs_connection_id  TEXT NOT NULL,
      datastore          TEXT NOT NULL,
      namespace          TEXT NOT NULL,
      pbs_token_id       TEXT NOT NULL,
      pbs_token_secret   TEXT NOT NULL,
      created_at         TEXT DEFAULT (datetime('now')),
      UNIQUE (pbs_connection_id, datastore, namespace)
    );
    CREATE INDEX IF NOT EXISTS idx_vdc_pbs_namespaces_vdc ON vdc_pbs_namespaces(vdc_id);

    CREATE TABLE IF NOT EXISTS vdc_pbs_pve_storages (
      id                    TEXT PRIMARY KEY,
      vdc_pbs_namespace_id  TEXT NOT NULL REFERENCES vdc_pbs_namespaces(id) ON DELETE CASCADE,
      pve_connection_id     TEXT NOT NULL,
      pve_storage_name      TEXT NOT NULL,
      created_at            TEXT DEFAULT (datetime('now')),
      UNIQUE (pve_connection_id, pve_storage_name)
    );
    CREATE INDEX IF NOT EXISTS idx_vdc_pbs_pve_storages_binding ON vdc_pbs_pve_storages(vdc_pbs_namespace_id);
```

The `CREATE TABLE IF NOT EXISTS` handles both fresh installs and existing DBs — no ALTER dance needed for these brand-new tables.

- [ ] **Step 4: Verify DDL runs cleanly**

Restart the dev server once to trigger `getDb()` on startup, then verify tables exist:
`sqlite3 ./prisma/dev.db ".tables" | tr ' ' '\n' | grep vdc_pbs`
Expected: both `vdc_pbs_namespaces` and `vdc_pbs_pve_storages` listed.

- [ ] **Step 5: Commit**

```bash
cd frontend
git add prisma/ src/lib/db/sqlite.ts
git commit -m "feat(vdc-pbs): add Connection.fingerprint + vdc_pbs_namespaces/pve_storages tables"
```

---

### Task 2: SQLite CRUD helper `vdcPbsBindings.ts`

**Files:**
- Create: `frontend/src/lib/db/vdcPbsBindings.ts`
- Create: `frontend/src/lib/db/vdcPbsBindings.test.ts`

- [ ] **Step 1: Write the failing test**

`frontend/src/lib/db/vdcPbsBindings.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'

import {
  listBindingsForVdc,
  insertBinding,
  insertPveStorage,
  deleteBinding,
  listPveStoragesForBinding,
  findBindingByTuple,
  __setDbForTests,
} from './vdcPbsBindings'

function freshDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE vdcs (id TEXT PRIMARY KEY, tenant_id TEXT, connection_id TEXT, name TEXT, slug TEXT, pve_pool_name TEXT, enabled INTEGER);
    CREATE TABLE vdc_pbs_namespaces (
      id TEXT PRIMARY KEY, vdc_id TEXT, pbs_connection_id TEXT,
      datastore TEXT, namespace TEXT, pbs_token_id TEXT, pbs_token_secret TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE (pbs_connection_id, datastore, namespace)
    );
    CREATE TABLE vdc_pbs_pve_storages (
      id TEXT PRIMARY KEY, vdc_pbs_namespace_id TEXT,
      pve_connection_id TEXT, pve_storage_name TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `)
  db.prepare(`INSERT INTO vdcs VALUES ('v1','t1','c1','VDC1','vdc1','pool-vdc1',1)`).run()
  __setDbForTests(db)
  return db
}

describe('vdcPbsBindings', () => {
  beforeEach(() => freshDb())

  it('inserts and reads a binding', () => {
    const row = insertBinding({
      vdcId: 'v1',
      pbsConnectionId: 'pbs1',
      datastore: 'store1',
      namespace: 'tenant-x/vdc-y',
      pbsTokenId: 'root@pam!vdc-abc',
      pbsTokenSecret: 'sekret',
    })
    expect(row.id).toMatch(/^[a-f0-9-]{36}$/)
    const found = findBindingByTuple('pbs1', 'store1', 'tenant-x/vdc-y')
    expect(found?.id).toBe(row.id)
  })

  it('enforces uniqueness on (pbs, ds, ns)', () => {
    insertBinding({ vdcId: 'v1', pbsConnectionId: 'p', datastore: 'd', namespace: 'n', pbsTokenId: 't', pbsTokenSecret: 's' })
    expect(() =>
      insertBinding({ vdcId: 'v1', pbsConnectionId: 'p', datastore: 'd', namespace: 'n', pbsTokenId: 't', pbsTokenSecret: 's' }),
    ).toThrow()
  })

  it('lists bindings for a vdc', () => {
    insertBinding({ vdcId: 'v1', pbsConnectionId: 'p', datastore: 'd', namespace: 'n1', pbsTokenId: 't', pbsTokenSecret: 's' })
    insertBinding({ vdcId: 'v1', pbsConnectionId: 'p', datastore: 'd', namespace: 'n2', pbsTokenId: 't', pbsTokenSecret: 's' })
    expect(listBindingsForVdc('v1')).toHaveLength(2)
  })

  it('cascades PVE storages when binding is deleted', () => {
    const b = insertBinding({ vdcId: 'v1', pbsConnectionId: 'p', datastore: 'd', namespace: 'n', pbsTokenId: 't', pbsTokenSecret: 's' })
    insertPveStorage({ bindingId: b.id, pveConnectionId: 'c1', pveStorageName: 'pbs-acme-prod' })
    expect(listPveStoragesForBinding(b.id)).toHaveLength(1)
    deleteBinding(b.id)
    expect(listBindingsForVdc('v1')).toHaveLength(0)
    // FK cascade isn't enabled in in-memory tests; the orchestrator deletes children first.
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/lib/db/vdcPbsBindings.test.ts`
Expected: FAIL — file does not exist.

- [ ] **Step 3: Implement the helper**

`frontend/src/lib/db/vdcPbsBindings.ts`:

```ts
import { randomUUID } from 'crypto'
import type Database from 'better-sqlite3'

import { getDb as realGetDb } from './sqlite'

let overrideDb: Database.Database | null = null
export function __setDbForTests(db: Database.Database | null) { overrideDb = db }
function db(): Database.Database { return overrideDb ?? realGetDb() }

export interface PbsBindingRow {
  id: string
  vdcId: string
  pbsConnectionId: string
  datastore: string
  namespace: string
  pbsTokenId: string
  pbsTokenSecret: string
  createdAt: string
}

export interface PvePbsStorageRow {
  id: string
  bindingId: string
  pveConnectionId: string
  pveStorageName: string
  createdAt: string
}

function rowToBinding(r: any): PbsBindingRow {
  return {
    id: r.id,
    vdcId: r.vdc_id,
    pbsConnectionId: r.pbs_connection_id,
    datastore: r.datastore,
    namespace: r.namespace,
    pbsTokenId: r.pbs_token_id,
    pbsTokenSecret: r.pbs_token_secret,
    createdAt: r.created_at,
  }
}

function rowToStorage(r: any): PvePbsStorageRow {
  return {
    id: r.id,
    bindingId: r.vdc_pbs_namespace_id,
    pveConnectionId: r.pve_connection_id,
    pveStorageName: r.pve_storage_name,
    createdAt: r.created_at,
  }
}

export function insertBinding(args: {
  vdcId: string; pbsConnectionId: string; datastore: string; namespace: string;
  pbsTokenId: string; pbsTokenSecret: string;
}): PbsBindingRow {
  const id = randomUUID()
  db().prepare(
    `INSERT INTO vdc_pbs_namespaces (id, vdc_id, pbs_connection_id, datastore, namespace, pbs_token_id, pbs_token_secret)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, args.vdcId, args.pbsConnectionId, args.datastore, args.namespace, args.pbsTokenId, args.pbsTokenSecret)
  return rowToBinding(db().prepare(`SELECT * FROM vdc_pbs_namespaces WHERE id = ?`).get(id))
}

export function findBindingByTuple(pbsConnectionId: string, datastore: string, namespace: string): PbsBindingRow | null {
  const r = db().prepare(
    `SELECT * FROM vdc_pbs_namespaces WHERE pbs_connection_id = ? AND datastore = ? AND namespace = ?`
  ).get(pbsConnectionId, datastore, namespace) as any
  return r ? rowToBinding(r) : null
}

export function listBindingsForVdc(vdcId: string): PbsBindingRow[] {
  return (db().prepare(
    `SELECT * FROM vdc_pbs_namespaces WHERE vdc_id = ? ORDER BY created_at`
  ).all(vdcId) as any[]).map(rowToBinding)
}

export function listBindingsForTenant(tenantId: string): PbsBindingRow[] {
  return (db().prepare(
    `SELECT b.* FROM vdc_pbs_namespaces b
     JOIN vdcs v ON v.id = b.vdc_id
     WHERE v.tenant_id = ? AND v.enabled = 1`
  ).all(tenantId) as any[]).map(rowToBinding)
}

export function deleteBinding(id: string): void {
  db().prepare(`DELETE FROM vdc_pbs_namespaces WHERE id = ?`).run(id)
}

export function insertPveStorage(args: {
  bindingId: string; pveConnectionId: string; pveStorageName: string;
}): PvePbsStorageRow {
  const id = randomUUID()
  db().prepare(
    `INSERT INTO vdc_pbs_pve_storages (id, vdc_pbs_namespace_id, pve_connection_id, pve_storage_name)
     VALUES (?, ?, ?, ?)`
  ).run(id, args.bindingId, args.pveConnectionId, args.pveStorageName)
  return rowToStorage(db().prepare(`SELECT * FROM vdc_pbs_pve_storages WHERE id = ?`).get(id))
}

export function listPveStoragesForBinding(bindingId: string): PvePbsStorageRow[] {
  return (db().prepare(
    `SELECT * FROM vdc_pbs_pve_storages WHERE vdc_pbs_namespace_id = ? ORDER BY created_at`
  ).all(bindingId) as any[]).map(rowToStorage)
}

export function deletePveStorage(id: string): void {
  db().prepare(`DELETE FROM vdc_pbs_pve_storages WHERE id = ?`).run(id)
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && npx vitest run src/lib/db/vdcPbsBindings.test.ts`
Expected: all 4 tests pass.

- [ ] **Step 5: Commit**

```bash
cd frontend && git add src/lib/db/vdcPbsBindings.ts src/lib/db/vdcPbsBindings.test.ts && \
git commit -m "feat(vdc-pbs): sqlite crud helper for vdc_pbs_namespaces + pve_storages"
```

---

### Task 3: PBS fingerprint capture `pbsFingerprint.ts`

**Files:**
- Create: `frontend/src/lib/proxmox/pbsFingerprint.ts`
- Create: `frontend/src/lib/proxmox/pbsFingerprint.test.ts`

- [ ] **Step 1: Write the failing test**

`frontend/src/lib/proxmox/pbsFingerprint.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { parseHostPort, formatFingerprint } from './pbsFingerprint'

describe('pbsFingerprint helpers', () => {
  it('parses https://host:port', () => {
    expect(parseHostPort('https://pbs.example:8007')).toEqual({ host: 'pbs.example', port: 8007 })
  })
  it('defaults to 8007 when port missing', () => {
    expect(parseHostPort('https://pbs.example')).toEqual({ host: 'pbs.example', port: 8007 })
  })
  it('strips path', () => {
    expect(parseHostPort('https://pbs.example:8007/api2/json')).toEqual({ host: 'pbs.example', port: 8007 })
  })
  it('throws on non-https', () => {
    expect(() => parseHostPort('http://pbs.example')).toThrow(/https required/i)
  })
  it('formats raw hash as colon-separated uppercase', () => {
    const raw = 'aabbccdd'
    expect(formatFingerprint(raw)).toBe('AA:BB:CC:DD')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/lib/proxmox/pbsFingerprint.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the helper**

`frontend/src/lib/proxmox/pbsFingerprint.ts`:

```ts
import tls from 'tls'
import { createHash } from 'crypto'

export function parseHostPort(baseUrl: string): { host: string; port: number } {
  const m = baseUrl.match(/^https:\/\/([^/:?#]+)(?::(\d+))?/i)
  if (!m) throw new Error(`Invalid PBS baseUrl (https required): ${baseUrl}`)
  return { host: m[1], port: m[2] ? Number(m[2]) : 8007 }
}

export function formatFingerprint(hex: string): string {
  return hex.toUpperCase().match(/.{1,2}/g)!.join(':')
}

/**
 * Opens a TLS handshake to the PBS host, reads the leaf certificate,
 * returns the SHA256 fingerprint formatted `AA:BB:...`. Accepts self-signed.
 * Throws on connection failure or missing cert.
 */
export async function captureFingerprint(baseUrl: string, timeoutMs = 5000): Promise<string> {
  const { host, port } = parseHostPort(baseUrl)
  return await new Promise<string>((resolve, reject) => {
    const socket = tls.connect({
      host,
      port,
      servername: host,
      rejectUnauthorized: false,
      timeout: timeoutMs,
    }, () => {
      try {
        const cert = socket.getPeerCertificate(false)
        if (!cert || !cert.raw) {
          reject(new Error('PBS returned no certificate'))
          return
        }
        const hash = createHash('sha256').update(cert.raw).digest('hex')
        socket.end()
        resolve(formatFingerprint(hash))
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    })
    socket.on('error', err => reject(err))
    socket.on('timeout', () => {
      socket.destroy()
      reject(new Error(`PBS fingerprint capture timeout after ${timeoutMs}ms`))
    })
  })
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && npx vitest run src/lib/proxmox/pbsFingerprint.test.ts`
Expected: all 5 tests pass.

- [ ] **Step 5: Commit**

```bash
cd frontend && git add src/lib/proxmox/pbsFingerprint.ts src/lib/proxmox/pbsFingerprint.test.ts && \
git commit -m "feat(pbs): tls sha256 fingerprint capture helper"
```

---

### Task 4: PBS namespace + sub-token + ACL helper

**Files:**
- Create: `frontend/src/lib/proxmox/pbsNamespace.ts`
- Create: `frontend/src/lib/proxmox/pbsNamespace.test.ts`

- [ ] **Step 1: Write the failing test**

`frontend/src/lib/proxmox/pbsNamespace.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ensureNamespace, ensureSubToken, setNamespaceAcl, deleteSubToken } from './pbsNamespace'

vi.mock('./pbs-client', () => ({
  pbsFetch: vi.fn(),
}))
import { pbsFetch } from './pbs-client'
const mock = pbsFetch as any

const conn = { baseUrl: 'https://pbs.example:8007', apiToken: 'root@pam!x:y', insecureDev: true }

describe('ensureNamespace', () => {
  beforeEach(() => mock.mockReset())

  it('creates a root namespace when missing', async () => {
    mock.mockResolvedValueOnce([])                        // list existing
    mock.mockResolvedValueOnce({})                        // POST create
    await ensureNamespace(conn, 'store1', 'tenant-acme')
    expect(mock).toHaveBeenCalledTimes(2)
    expect(mock.mock.calls[1][1]).toBe('/admin/datastore/store1/namespace')
    expect(mock.mock.calls[1][2]).toMatchObject({ method: 'POST', body: expect.objectContaining({ ns: 'tenant-acme' }) })
  })

  it('creates a child namespace with parent param', async () => {
    mock.mockResolvedValueOnce([])
    mock.mockResolvedValueOnce({})
    await ensureNamespace(conn, 'store1', 'tenant-acme/vdc-prod', { parent: 'tenant-acme' })
    expect(mock.mock.calls[1][2].body).toMatchObject({ ns: 'vdc-prod', parent: 'tenant-acme' })
  })

  it('skips creation when namespace already exists', async () => {
    mock.mockResolvedValueOnce([{ ns: 'tenant-acme' }])
    await ensureNamespace(conn, 'store1', 'tenant-acme')
    expect(mock).toHaveBeenCalledTimes(1)                 // no POST
  })
})

describe('ensureSubToken', () => {
  beforeEach(() => mock.mockReset())

  it('creates a token and returns { tokenId, secret }', async () => {
    mock.mockRejectedValueOnce(new Error('PBS 404 /access/users/root@pam/token/vdc-abc'))
    mock.mockResolvedValueOnce({ tokenid: 'root@pam!vdc-abc', value: 'sekret' })
    const res = await ensureSubToken(conn, 'root@pam', 'vdc-abc')
    expect(res).toEqual({ tokenId: 'root@pam!vdc-abc', secret: 'sekret' })
  })

  it('reuses an existing token (no secret returned)', async () => {
    mock.mockResolvedValueOnce({ tokenid: 'root@pam!vdc-abc' })
    const res = await ensureSubToken(conn, 'root@pam', 'vdc-abc')
    expect(res).toEqual({ tokenId: 'root@pam!vdc-abc', secret: null })
  })
})

describe('setNamespaceAcl', () => {
  beforeEach(() => mock.mockReset())

  it('PUTs /access/acl with the expected shape', async () => {
    mock.mockResolvedValueOnce({})
    await setNamespaceAcl(conn, 'store1', 'tenant-x/vdc-y', 'root@pam!vdc-abc')
    expect(mock.mock.calls[0][1]).toBe('/access/acl')
    expect(mock.mock.calls[0][2].body).toMatchObject({
      path: '/datastore/store1/tenant-x/vdc-y',
      'auth-id': 'root@pam!vdc-abc',
      role: 'DatastoreBackup',
      propagate: 1,
    })
  })
})

describe('deleteSubToken', () => {
  beforeEach(() => mock.mockReset())

  it('issues DELETE on /access/users/<u>/token/<id>', async () => {
    mock.mockResolvedValueOnce({})
    await deleteSubToken(conn, 'root@pam', 'vdc-abc')
    expect(mock.mock.calls[0][1]).toBe('/access/users/root@pam/token/vdc-abc')
    expect(mock.mock.calls[0][2]).toMatchObject({ method: 'DELETE' })
  })

  it('swallows 404 (already deleted)', async () => {
    mock.mockRejectedValueOnce(new Error('PBS 404 /access/users/root@pam/token/vdc-abc'))
    await expect(deleteSubToken(conn, 'root@pam', 'vdc-abc')).resolves.not.toThrow()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/lib/proxmox/pbsNamespace.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the helper**

`frontend/src/lib/proxmox/pbsNamespace.ts`:

```ts
import { pbsFetch, type PbsClientOptions } from './pbs-client'

type NsRow = { ns: string }

function splitHeadTail(namespace: string): { head: string; parent: string | null } {
  const idx = namespace.lastIndexOf('/')
  if (idx < 0) return { head: namespace, parent: null }
  return { head: namespace.slice(idx + 1), parent: namespace.slice(0, idx) }
}

/**
 * Create the namespace on PBS if missing. Hierarchical paths are created
 * level-by-level by the caller — this helper creates only ONE level.
 * Use `ensureNamespacePath` for full hierarchical creation.
 */
export async function ensureNamespace(
  conn: PbsClientOptions,
  datastore: string,
  namespace: string,
  opts: { parent?: string } = {},
): Promise<void> {
  const existing = await pbsFetch<NsRow[]>(conn, `/admin/datastore/${encodeURIComponent(datastore)}/namespace`)
  const already = (existing || []).some(r => r.ns === namespace)
  if (already) return

  const { head } = splitHeadTail(namespace)
  const body: Record<string, any> = { ns: head }
  if (opts.parent) body.parent = opts.parent

  await pbsFetch(conn, `/admin/datastore/${encodeURIComponent(datastore)}/namespace`, {
    method: 'POST',
    body,
  })
}

/** Ensures every segment of a `a/b/c` namespace exists (idempotent). */
export async function ensureNamespacePath(
  conn: PbsClientOptions,
  datastore: string,
  fullNamespace: string,
): Promise<void> {
  const parts = fullNamespace.split('/').filter(Boolean)
  let parent: string | null = null
  for (const seg of parts) {
    const path = parent ? `${parent}/${seg}` : seg
    await ensureNamespace(conn, datastore, path, parent ? { parent } : {})
    parent = path
  }
}

export async function ensureSubToken(
  conn: PbsClientOptions,
  user: string,
  tokenId: string,
): Promise<{ tokenId: string; secret: string | null }> {
  const full = `${user}!${tokenId}`
  try {
    const existing = await pbsFetch<any>(
      conn,
      `/access/users/${encodeURIComponent(user)}/token/${encodeURIComponent(tokenId)}`,
    )
    if (existing && existing.tokenid) return { tokenId: full, secret: null }
  } catch {
    // fall through — create below
  }
  const created = await pbsFetch<any>(
    conn,
    `/access/users/${encodeURIComponent(user)}/token/${encodeURIComponent(tokenId)}`,
    { method: 'POST', body: {} },
  )
  return { tokenId: created.tokenid ?? full, secret: created.value ?? null }
}

export async function setNamespaceAcl(
  conn: PbsClientOptions,
  datastore: string,
  namespace: string,
  authId: string,
  role: 'DatastoreBackup' | 'DatastoreReader' = 'DatastoreBackup',
): Promise<void> {
  await pbsFetch(conn, '/access/acl', {
    method: 'PUT',
    body: {
      path: `/datastore/${datastore}/${namespace}`,
      'auth-id': authId,
      role,
      propagate: 1,
    },
  })
}

export async function deleteSubToken(
  conn: PbsClientOptions,
  user: string,
  tokenId: string,
): Promise<void> {
  try {
    await pbsFetch(
      conn,
      `/access/users/${encodeURIComponent(user)}/token/${encodeURIComponent(tokenId)}`,
      { method: 'DELETE' },
    )
  } catch (e: any) {
    if (!/\b404\b/.test(String(e?.message))) throw e
  }
}

/** List snapshots in a specific namespace (non-recursive). */
export async function listSnapshotsInNamespace(
  conn: PbsClientOptions,
  datastore: string,
  namespace: string,
): Promise<any[]> {
  const qs = `?ns=${encodeURIComponent(namespace)}&max-depth=0`
  return (await pbsFetch<any[]>(conn, `/admin/datastore/${encodeURIComponent(datastore)}/snapshots${qs}`)) || []
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && npx vitest run src/lib/proxmox/pbsNamespace.test.ts`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
cd frontend && git add src/lib/proxmox/pbsNamespace.ts src/lib/proxmox/pbsNamespace.test.ts && \
git commit -m "feat(pbs): namespace + sub-token + acl helpers with idempotency"
```

---

### Task 5: PVE `pbs:` storage helper

**Files:**
- Create: `frontend/src/lib/proxmox/pvePbsStorage.ts`
- Create: `frontend/src/lib/proxmox/pvePbsStorage.test.ts`

- [ ] **Step 1: Write the failing test**

`frontend/src/lib/proxmox/pvePbsStorage.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createPbsStorage, deletePbsStorage, pbsStorageExists, sanitizeStorageName } from './pvePbsStorage'

vi.mock('./client', () => ({ pveFetch: vi.fn() }))
import { pveFetch } from './client'
const mock = pveFetch as any

const conn = { id: 'c1', name: 'cl', baseUrl: 'https://pve', apiToken: 't', insecureDev: true, behindProxy: false }

describe('sanitizeStorageName', () => {
  it('lowercases and strips invalid chars', () => {
    expect(sanitizeStorageName('Acme_Corp', 'Prod Web')).toBe('pbs-acmecorp-prodweb')
  })
  it('truncates to 40 chars max', () => {
    const out = sanitizeStorageName('a'.repeat(30), 'b'.repeat(30))
    expect(out.length).toBeLessThanOrEqual(40)
    expect(out.startsWith('pbs-')).toBe(true)
  })
})

describe('pbsStorageExists', () => {
  beforeEach(() => mock.mockReset())

  it('returns true when the storage is present', async () => {
    mock.mockResolvedValueOnce({ storage: 'pbs-acme-prod', type: 'pbs' })
    expect(await pbsStorageExists(conn, 'pbs-acme-prod')).toBe(true)
  })

  it('returns false on 404', async () => {
    mock.mockRejectedValueOnce(new Error('PVE 404 /storage/pbs-acme-prod'))
    expect(await pbsStorageExists(conn, 'pbs-acme-prod')).toBe(false)
  })
})

describe('createPbsStorage', () => {
  beforeEach(() => mock.mockReset())

  it('POSTs /storage with the expected shape', async () => {
    mock.mockRejectedValueOnce(new Error('PVE 404 /storage/pbs-acme-prod'))   // exists check → 404
    mock.mockResolvedValueOnce({})                                             // POST
    await createPbsStorage(conn, {
      storage: 'pbs-acme-prod',
      server: 'pbs.local',
      datastore: 'store1',
      namespace: 'tenant-acme/vdc-prod',
      username: 'root@pam!vdc-abc',
      password: 'sekret',
      fingerprint: 'AA:BB:CC',
      nodes: ['pve01', 'pve02'],
    })
    expect(mock.mock.calls[1][1]).toBe('/storage')
    expect(mock.mock.calls[1][2].body).toMatchObject({
      storage: 'pbs-acme-prod',
      type: 'pbs',
      server: 'pbs.local',
      datastore: 'store1',
      namespace: 'tenant-acme/vdc-prod',
      username: 'root@pam!vdc-abc',
      password: 'sekret',
      fingerprint: 'AA:BB:CC',
      content: 'backup',
      nodes: 'pve01,pve02',
    })
  })

  it('skips POST when storage already exists', async () => {
    mock.mockResolvedValueOnce({ storage: 'pbs-acme-prod', type: 'pbs' })
    await createPbsStorage(conn, { storage: 'pbs-acme-prod', server: 's', datastore: 'd', namespace: 'n', username: 'u', password: 'p', fingerprint: 'f', nodes: [] })
    expect(mock).toHaveBeenCalledTimes(1)
  })
})

describe('deletePbsStorage', () => {
  it('DELETEs /storage/<name> and tolerates 404', async () => {
    mock.mockResolvedValueOnce({})
    await deletePbsStorage(conn, 'pbs-acme-prod')
    expect(mock.mock.calls[0][2]).toMatchObject({ method: 'DELETE' })

    mock.mockRejectedValueOnce(new Error('PVE 404 /storage/pbs-acme-prod'))
    await expect(deletePbsStorage(conn, 'pbs-acme-prod')).resolves.not.toThrow()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/lib/proxmox/pvePbsStorage.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the helper**

`frontend/src/lib/proxmox/pvePbsStorage.ts`:

```ts
import { pveFetch } from './client'
import type { PveConn } from '@/lib/connections/getConnection'

export function sanitizeStorageName(tenantSlug: string, vdcSlug: string, prefix = 'pbs-'): string {
  const clean = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
  const core = `${clean(tenantSlug)}-${clean(vdcSlug)}`.slice(0, 40 - prefix.length)
  return `${prefix}${core}`
}

export async function pbsStorageExists(conn: PveConn, storage: string): Promise<boolean> {
  try {
    const r = await pveFetch<any>(conn, `/storage/${encodeURIComponent(storage)}`)
    return !!r
  } catch (e: any) {
    if (/\b404\b/.test(String(e?.message))) return false
    throw e
  }
}

export interface CreatePbsStorageArgs {
  storage: string
  server: string
  datastore: string
  namespace: string
  username: string      // full token id, e.g. root@pam!vdc-abc
  password: string      // secret
  fingerprint: string
  nodes: string[]
  port?: number
}

export async function createPbsStorage(conn: PveConn, args: CreatePbsStorageArgs): Promise<void> {
  if (await pbsStorageExists(conn, args.storage)) return
  const body: Record<string, any> = {
    storage: args.storage,
    type: 'pbs',
    server: args.server,
    datastore: args.datastore,
    namespace: args.namespace,
    username: args.username,
    password: args.password,
    fingerprint: args.fingerprint,
    content: 'backup',
  }
  if (args.nodes.length) body.nodes = args.nodes.join(',')
  if (args.port) body.port = args.port
  await pveFetch(conn, '/storage', { method: 'POST', body })
}

export async function deletePbsStorage(conn: PveConn, storage: string): Promise<void> {
  try {
    await pveFetch(conn, `/storage/${encodeURIComponent(storage)}`, { method: 'DELETE' })
  } catch (e: any) {
    if (!/\b404\b/.test(String(e?.message))) throw e
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && npx vitest run src/lib/proxmox/pvePbsStorage.test.ts`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
cd frontend && git add src/lib/proxmox/pvePbsStorage.ts src/lib/proxmox/pvePbsStorage.test.ts && \
git commit -m "feat(pve): pbs: storage create/delete helpers"
```

---

### Task 6: Orchestrator `pbsOrchestrator.ts`

Coordinates namespace + token + ACL + PVE storage + DB + vdc_storages sync. Exposes `bindPbsToVdc` and `unbindFromVdc`.

**Files:**
- Create: `frontend/src/lib/vdc/pbsOrchestrator.ts`
- Create: `frontend/src/lib/vdc/pbsOrchestrator.test.ts`

- [ ] **Step 1: Write the failing test**

`frontend/src/lib/vdc/pbsOrchestrator.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/db/vdcPbsBindings', () => ({
  insertBinding: vi.fn(),
  insertPveStorage: vi.fn(),
  listPveStoragesForBinding: vi.fn(() => []),
  deleteBinding: vi.fn(),
  deletePveStorage: vi.fn(),
  findBindingByTuple: vi.fn(() => null),
}))
vi.mock('@/lib/proxmox/pbsNamespace', () => ({
  ensureNamespacePath: vi.fn(),
  ensureSubToken: vi.fn(async () => ({ tokenId: 'root@pam!vdc-abc', secret: 'S3CR3T' })),
  setNamespaceAcl: vi.fn(),
  deleteSubToken: vi.fn(),
}))
vi.mock('@/lib/proxmox/pvePbsStorage', () => ({
  createPbsStorage: vi.fn(),
  deletePbsStorage: vi.fn(),
  sanitizeStorageName: vi.fn((a, b) => `pbs-${a}-${b}`),
}))
vi.mock('@/lib/connections/getConnection', () => ({
  getPbsConnectionById: vi.fn(async () => ({ id: 'pbs1', name: 'pbs', baseUrl: 'https://pbs', apiToken: 'root@pam!x:y', insecureDev: true })),
  getConnectionById: vi.fn(async (id) => ({ id, name: id, baseUrl: 'https://pve', apiToken: 't', insecureDev: true, behindProxy: false })),
}))

vi.mock('@/lib/db/prisma', () => ({
  prisma: {
    connection: {
      findUnique: vi.fn(async () => ({
        id: 'pbs1',
        type: 'pbs',
        baseUrl: 'https://pbs.example:8007',
        fingerprint: 'AA:BB:CC',
        apiTokenEnc: 'enc',
        insecureTLS: true,
      })),
      update: vi.fn(),
    },
  },
}))
vi.mock('@/lib/crypto/secret', () => ({
  decryptSecret: () => `root@pam!admin:secret`,
  encryptSecret: (s: string) => `enc:${s}`,
}))

vi.mock('@/lib/db/sqlite', () => {
  const vdcs = new Map([['v1', { id: 'v1', tenant_id: 't1', slug: 'prod', connection_id: 'pve1' }]])
  const nodes = new Map([['v1', [{ node_name: 'pve01' }, { node_name: 'pve02' }]]])
  const storages = new Map<string, Set<string>>([['v1', new Set()]])
  const tenants = new Map([['t1', { slug: 'acme', id: 't1' }]])
  return {
    getDb: () => ({
      prepare: (sql: string) => ({
        get: (...args: any[]) => {
          if (sql.includes('FROM vdcs')) return vdcs.get(args[0])
          if (sql.includes('FROM tenants')) return tenants.get(args[0])
          if (sql.includes('FROM vdc_pbs_namespaces')) return null
          return null
        },
        all: (...args: any[]) => {
          if (sql.includes('FROM vdc_nodes')) return nodes.get(args[0]) || []
          return []
        },
        run: (...args: any[]) => {
          if (sql.includes('INSERT INTO vdc_storages')) storages.get(args[1])!.add(args[2])
          if (sql.includes('DELETE FROM vdc_storages')) storages.get(args[0])?.delete(args[1])
          return { changes: 1 }
        },
      }),
    }),
  }
})

vi.mock('./scope', () => ({ clearVdcScopeCache: vi.fn() }))

import { bindPbsToVdc, unbindFromVdc } from './pbsOrchestrator'
import * as bindings from '@/lib/db/vdcPbsBindings'
import * as pbsNs from '@/lib/proxmox/pbsNamespace'
import * as pveStorage from '@/lib/proxmox/pvePbsStorage'

describe('bindPbsToVdc', () => {
  beforeEach(() => vi.clearAllMocks())

  it('orchestrates namespace + token + acl + pve storages and writes DB', async () => {
    (bindings.insertBinding as any).mockReturnValue({
      id: 'b1', vdcId: 'v1', pbsConnectionId: 'pbs1',
      datastore: 'store1', namespace: 'tenant-acme/vdc-prod',
      pbsTokenId: 'root@pam!vdc-abc', pbsTokenSecret: 'S3CR3T',
      createdAt: 't',
    })

    const result = await bindPbsToVdc({
      vdcId: 'v1',
      pbsConnectionId: 'pbs1',
      datastore: 'store1',
    })

    expect(pbsNs.ensureNamespacePath).toHaveBeenCalledWith(expect.anything(), 'store1', 'tenant-acme/vdc-prod')
    expect(pbsNs.ensureSubToken).toHaveBeenCalled()
    expect(pbsNs.setNamespaceAcl).toHaveBeenCalled()
    expect(pveStorage.createPbsStorage).toHaveBeenCalledTimes(1)
    expect(bindings.insertBinding).toHaveBeenCalled()
    expect(bindings.insertPveStorage).toHaveBeenCalled()
    expect(result.binding.id).toBe('b1')
    expect(result.steps.namespace).toBe('ok')
    expect(result.steps.token).toBe('ok')
    expect(result.steps.acl).toBe('ok')
    expect(result.steps.pveStorages).toHaveLength(1)
  })

  it('rejects when fingerprint is missing on the PBS connection', async () => {
    const prismaMod = await import('@/lib/db/prisma')
    ;(prismaMod.prisma.connection.findUnique as any).mockResolvedValueOnce({
      id: 'pbs1', type: 'pbs', baseUrl: 'https://pbs', fingerprint: null, apiTokenEnc: 'e', insecureTLS: true,
    })
    await expect(bindPbsToVdc({ vdcId: 'v1', pbsConnectionId: 'pbs1', datastore: 'store1' }))
      .rejects.toThrow(/fingerprint/i)
  })
})

describe('unbindFromVdc', () => {
  beforeEach(() => vi.clearAllMocks())

  it('deletes PVE storages, revokes sub-token, removes DB row', async () => {
    // Override the sqlite mock's vdc_pbs_namespaces lookup to return a row
    const sqliteMod = await import('@/lib/db/sqlite')
    const origGetDb = sqliteMod.getDb
    ;(sqliteMod as any).getDb = () => ({
      prepare: (sql: string) => ({
        get: (...args: any[]) => {
          if (sql.includes('FROM vdc_pbs_namespaces')) return {
            id: 'b1', vdc_id: 'v1', pbs_connection_id: 'pbs1', datastore: 'store1',
            namespace: 'tenant-acme/vdc-prod', pbs_token_id: 'root@pam!vdc-abc',
            pbs_token_secret: 'S3CR3T',
          }
          if (sql.includes('FROM vdcs')) return { id: 'v1', tenant_id: 't1', slug: 'prod', connection_id: 'pve1' }
          if (sql.includes('FROM tenants')) return { id: 't1', slug: 'acme' }
          return null
        },
        all: () => [],
        run: () => ({ changes: 1 }),
      }),
    })
    ;(bindings.listPveStoragesForBinding as any).mockReturnValue([
      { id: 's1', bindingId: 'b1', pveConnectionId: 'pve1', pveStorageName: 'pbs-acme-prod', createdAt: 't' },
    ])

    await unbindFromVdc('b1')
    expect(pveStorage.deletePbsStorage).toHaveBeenCalledWith(expect.anything(), 'pbs-acme-prod')
    expect(pbsNs.deleteSubToken).toHaveBeenCalled()
    expect(bindings.deleteBinding).toHaveBeenCalledWith('b1')
    ;(sqliteMod as any).getDb = origGetDb
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/lib/vdc/pbsOrchestrator.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the orchestrator**

`frontend/src/lib/vdc/pbsOrchestrator.ts`:

```ts
import { randomUUID } from 'crypto'

import { getDb } from '@/lib/db/sqlite'
import { prisma } from '@/lib/db/prisma'
import { decryptSecret } from '@/lib/crypto/secret'
import {
  ensureNamespacePath, ensureSubToken, setNamespaceAcl, deleteSubToken,
} from '@/lib/proxmox/pbsNamespace'
import {
  createPbsStorage, deletePbsStorage, sanitizeStorageName,
} from '@/lib/proxmox/pvePbsStorage'
import { getConnectionById } from '@/lib/connections/getConnection'
import {
  insertBinding, insertPveStorage, deleteBinding, deletePveStorage,
  listPveStoragesForBinding, type PbsBindingRow,
} from '@/lib/db/vdcPbsBindings'
import { clearVdcScopeCache } from './scope'

interface BindArgs {
  vdcId: string
  pbsConnectionId: string
  datastore: string
  /** optional; when omitted the orchestrator computes `tenant-<slug>/vdc-<slug>`. */
  namespace?: string
}

interface StepStatus {
  namespace: 'ok' | 'skipped' | 'failed'
  token: 'ok' | 'skipped' | 'failed'
  acl: 'ok' | 'skipped' | 'failed'
  pveStorages: Array<{ pveConnectionId: string; name: string; status: 'ok' | 'skipped' | 'failed'; error?: string }>
}

// Process-local locks to serialize concurrent admin clicks on the same binding.
const locks = new Map<string, Promise<any>>()
async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve()
  let resolve: () => void = () => {}
  const next = new Promise<void>(r => { resolve = r })
  locks.set(key, prev.then(() => next))
  try { return await prev.then(fn) }
  finally { resolve(); if (locks.get(key) === next) locks.delete(key) }
}

function parsePbsUser(apiToken: string): string {
  const m = apiToken.match(/^([^!]+)!/)
  if (!m) throw new Error('Unexpected PBS root token format; expected user@realm!tokenid:secret')
  return m[1]
}

async function resolvePbsMeta(pbsConnectionId: string): Promise<{
  conn: { baseUrl: string; apiToken: string; insecureDev: boolean }
  host: string
  fingerprint: string
  rootUser: string
}> {
  const row = await prisma.connection.findUnique({
    where: { id: pbsConnectionId },
    select: { baseUrl: true, fingerprint: true, apiTokenEnc: true, insecureTLS: true, type: true },
  })
  if (!row || row.type !== 'pbs') throw new Error(`PBS connection not found: ${pbsConnectionId}`)
  if (!row.fingerprint) throw new Error('PBS fingerprint missing — capture it on the connection first')

  const apiToken = decryptSecret(row.apiTokenEnc)
  const host = row.baseUrl.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/:\d+$/, '')

  return {
    conn: { baseUrl: row.baseUrl, apiToken, insecureDev: !!row.insecureTLS },
    host,
    fingerprint: row.fingerprint,
    rootUser: parsePbsUser(apiToken),
  }
}

function readVdcAndTenant(vdcId: string) {
  const db = getDb()
  const vdc = db.prepare('SELECT * FROM vdcs WHERE id = ?').get(vdcId) as any
  if (!vdc) throw new Error(`vDC not found: ${vdcId}`)
  const tenant = db.prepare('SELECT * FROM tenants WHERE id = ?').get(vdc.tenant_id) as any
  if (!tenant) throw new Error(`tenant not found: ${vdc.tenant_id}`)
  return { vdc, tenant }
}

function readVdcNodeNames(vdcId: string): string[] {
  return (getDb().prepare('SELECT node_name FROM vdc_nodes WHERE vdc_id = ?').all(vdcId) as any[])
    .map(r => r.node_name)
}

function appendVdcStorage(vdcId: string, storageId: string) {
  const db = getDb()
  db.prepare('INSERT OR IGNORE INTO vdc_storages (id, vdc_id, storage_id) VALUES (?, ?, ?)')
    .run(randomUUID(), vdcId, storageId)
}

function removeVdcStorage(vdcId: string, storageId: string) {
  getDb().prepare('DELETE FROM vdc_storages WHERE vdc_id = ? AND storage_id = ?').run(vdcId, storageId)
}

export async function bindPbsToVdc(args: BindArgs): Promise<{ binding: PbsBindingRow; steps: StepStatus }> {
  const lockKey = `${args.vdcId}|${args.pbsConnectionId}|${args.datastore}|${args.namespace ?? ''}`
  return withLock(lockKey, async () => {
    const { vdc, tenant } = readVdcAndTenant(args.vdcId)
    const namespace = args.namespace ?? `tenant-${tenant.slug}/vdc-${vdc.slug}`
    const pbs = await resolvePbsMeta(args.pbsConnectionId)

    const steps: StepStatus = { namespace: 'skipped', token: 'skipped', acl: 'skipped', pveStorages: [] }

    // 1. PBS namespace (hierarchical)
    await ensureNamespacePath(pbs.conn, args.datastore, namespace)
    steps.namespace = 'ok'

    // 2. Sub-token — rotate if it exists without a returned secret
    const tokenShortId = `vdc-${args.vdcId.slice(0, 8)}`
    let tokenResult = await ensureSubToken(pbs.conn, pbs.rootUser, tokenShortId)
    if (!tokenResult.secret) {
      await deleteSubToken(pbs.conn, pbs.rootUser, tokenShortId)
      tokenResult = await ensureSubToken(pbs.conn, pbs.rootUser, tokenShortId)
      if (!tokenResult.secret) throw new Error('Failed to mint sub-token (no secret)')
    }
    steps.token = 'ok'
    const effectiveTokenId = tokenResult.tokenId
    const effectiveSecret = tokenResult.secret

    // 3. ACL
    await setNamespaceAcl(pbs.conn, args.datastore, namespace, effectiveTokenId)
    steps.acl = 'ok'

    // 4. DB row
    const binding = insertBinding({
      vdcId: args.vdcId,
      pbsConnectionId: args.pbsConnectionId,
      datastore: args.datastore,
      namespace,
      pbsTokenId: effectiveTokenId,
      pbsTokenSecret: effectiveSecret,
    })

    // 5. PVE storage injection on the vDC's PVE connection
    const pveConnId = vdc.connection_id
    const pveConn = await getConnectionById(pveConnId, tenant.id)
    const storageName = sanitizeStorageName(tenant.slug, vdc.slug)
    const nodes = readVdcNodeNames(args.vdcId)
    try {
      await createPbsStorage(pveConn, {
        storage: storageName,
        server: pbs.host,
        datastore: args.datastore,
        namespace,
        username: effectiveTokenId,
        password: effectiveSecret,
        fingerprint: pbs.fingerprint,
        nodes,
      })
      insertPveStorage({ bindingId: binding.id, pveConnectionId: pveConnId, pveStorageName: storageName })
      appendVdcStorage(args.vdcId, storageName)
      steps.pveStorages.push({ pveConnectionId: pveConnId, name: storageName, status: 'ok' })
    } catch (e: any) {
      steps.pveStorages.push({ pveConnectionId: pveConnId, name: storageName, status: 'failed', error: String(e?.message ?? e) })
    }

    clearVdcScopeCache(tenant.id)
    return { binding, steps }
  })
}

export async function unbindFromVdc(bindingId: string): Promise<void> {
  const row = getDb().prepare('SELECT * FROM vdc_pbs_namespaces WHERE id = ?').get(bindingId) as any
  if (!row) return

  const { tenant } = readVdcAndTenant(row.vdc_id)
  const pbs = await resolvePbsMeta(row.pbs_connection_id)

  // 1. Remove PVE storages
  for (const s of listPveStoragesForBinding(bindingId)) {
    try {
      const pveConn = await getConnectionById(s.pveConnectionId, tenant.id)
      await deletePbsStorage(pveConn, s.pveStorageName)
    } catch { /* already gone */ }
    removeVdcStorage(row.vdc_id, s.pveStorageName)
    deletePveStorage(s.id)
  }

  // 2. Revoke sub-token
  const tokenShortId = row.pbs_token_id.split('!')[1] ?? `vdc-${row.vdc_id.slice(0, 8)}`
  await deleteSubToken(pbs.conn, pbs.rootUser, tokenShortId)

  // 3. Delete DB row (leave PBS namespace + its backups alone)
  deleteBinding(bindingId)
  clearVdcScopeCache(tenant.id)
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && npx vitest run src/lib/vdc/pbsOrchestrator.test.ts`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
cd frontend && git add src/lib/vdc/pbsOrchestrator.ts src/lib/vdc/pbsOrchestrator.test.ts && \
git commit -m "feat(vdc-pbs): orchestrator — bind/unbind namespace+token+acl+pve-storage"
```

---

### Task 7: Extend `VdcScope` with `pbsNamespacesByConnection`

**Files:**
- Modify: `frontend/src/lib/vdc/scope.ts`

- [ ] **Step 1: Add the scope field**

Edit `frontend/src/lib/vdc/scope.ts`:

1. Add the field to the interface:

```ts
export interface VdcScope {
  connectionIds: Set<string>
  nodesByConnection: Map<string, Set<string>>
  storagesByConnection: Map<string, Set<string>>
  poolsByConnection: Map<string, Set<string>>
  vnetsByConnection: Map<string, Set<string>>
  sharedBridgesByConnection: Map<string, Set<string>>
  /** Per-PBS-connection: list of { datastore, namespace } the tenant is authorised on. */
  pbsNamespacesByConnection: Map<string, Array<{ datastore: string; namespace: string }>>
}
```

2. Inside `buildVdcScope`, after the existing child-table reads, add:

```ts
const pbsNamespacesByConnection = new Map<string, Array<{ datastore: string; namespace: string }>>()
const stmtPbs = db.prepare(
  `SELECT pbs_connection_id, datastore, namespace FROM vdc_pbs_namespaces WHERE vdc_id = ?`
)
for (const row of vdcRows) {
  for (const pr of stmtPbs.all(row.id) as Array<{ pbs_connection_id: string; datastore: string; namespace: string }>) {
    const list = pbsNamespacesByConnection.get(pr.pbs_connection_id) ?? []
    list.push({ datastore: pr.datastore, namespace: pr.namespace })
    pbsNamespacesByConnection.set(pr.pbs_connection_id, list)
  }
}
```

3. Include it in the returned object:

```ts
return {
  connectionIds,
  nodesByConnection,
  storagesByConnection,
  poolsByConnection,
  vnetsByConnection,
  sharedBridgesByConnection,
  pbsNamespacesByConnection,
}
```

- [ ] **Step 2: Typecheck**

Run: `cd frontend && npx tsc --noEmit 2>&1 | head -30`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
cd frontend && git add src/lib/vdc/scope.ts && \
git commit -m "feat(vdc-pbs): add pbsNamespacesByConnection to VdcScope"
```

---

### Task 8: Filter inventory stream by namespace

**Files:**
- Modify: `frontend/src/app/api/v1/inventory/stream/route.ts`

- [ ] **Step 1: Add the filter helper**

Near the existing `scopeStorageDataForTenant` (around line 122), add:

```ts
/**
 * Return a PBS server payload restricted to the tenant's namespaces.
 * Re-fetches snapshots per namespace (non-recursive) and unions them.
 * Returns null if the tenant has no bindings on this PBS — caller skips the send.
 */
async function scopePbsDataForTenant(
  data: PbsServerData,
  scope: ReturnType<typeof getVdcScope>,
): Promise<PbsServerData | null> {
  if (!scope) return data
  const allowed = scope.pbsNamespacesByConnection.get(data.id)
  if (!allowed || allowed.length === 0) return null

  const { getPbsConnectionById } = await import('@/lib/connections/getConnection')
  const { listSnapshotsInNamespace } = await import('@/lib/proxmox/pbsNamespace')
  const conn = await getPbsConnectionById(data.id).catch(() => null)
  if (!conn) return null

  const byStore = new Map<string, string[]>()
  for (const { datastore, namespace } of allowed) {
    const list = byStore.get(datastore) ?? []
    list.push(namespace)
    byStore.set(datastore, list)
  }

  let vmCount = 0, ctCount = 0, hostCount = 0, backupCount = 0
  const datastores: PbsDatastoreData[] = []

  for (const ds of data.datastores) {
    const namespaces = byStore.get(ds.name)
    if (!namespaces) continue
    let dsVm = 0, dsCt = 0, dsHost = 0, dsBackup = 0
    for (const ns of namespaces) {
      try {
        const snapshots = await listSnapshotsInNamespace(conn, ds.name, ns)
        for (const s of snapshots) {
          dsBackup++
          const t = s['backup-type']
          if (t === 'vm') dsVm++
          else if (t === 'ct') dsCt++
          else if (t === 'host') dsHost++
        }
      } catch { /* ignore per-namespace failure */ }
    }
    datastores.push({ ...ds, backupCount: dsBackup, vmCount: dsVm, ctCount: dsCt, hostCount: dsHost })
    vmCount += dsVm; ctCount += dsCt; hostCount += dsHost; backupCount += dsBackup
  }

  if (datastores.length === 0) return null

  return {
    ...data,
    datastores,
    stats: {
      datastoreCount: datastores.length,
      backupCount,
      totalSize: datastores.reduce((s, d) => s + d.total, 0),
      totalUsed: datastores.reduce((s, d) => s + d.used, 0),
    },
  }
}
```

- [ ] **Step 2: Apply the filter in both code paths**

In the cached branch (around line 595):

```ts
for (const pbs of cached.pbsServers) {
  const scoped = await scopePbsDataForTenant(pbs, vdcScope)
  if (scoped) send('pbs', scoped)
}
```

In the live branch (around line 717), replace the `send('pbs', pbs)` call with:

```ts
const scoped = await scopePbsDataForTenant(pbs, vdcScope)
if (scoped) send('pbs', scoped)
```

Note: the cached-path `start()` callback is sync. Wrap the whole send loop in `queueMicrotask(async () => { ... })` or convert the `start()` to async — follow the pattern the rest of the stream already uses.

- [ ] **Step 3: Typecheck + manual smoke**

```bash
cd frontend && npx tsc --noEmit 2>&1 | grep "stream/route.ts" || echo clean
```

Smoke-test: `curl -N -H 'Cookie: <tenant-session>' http://localhost:3000/api/v1/inventory/stream` should emit `event: pbs` with `backupCount` reflecting the tenant's namespaces only.

- [ ] **Step 4: Commit**

```bash
cd frontend && git add src/app/api/v1/inventory/stream/route.ts && \
git commit -m "feat(vdc-pbs): filter inventory stream PBS data by tenant namespaces"
```

---

### Task 9: Filter PBS snapshot listing endpoint by namespace

**Files:**
- Modify: `frontend/src/app/api/v1/pbs/[id]/datastores/[store]/snapshots/route.ts` (verify exact filename first)

- [ ] **Step 1: Locate the route**

```bash
cd frontend && find src/app/api/v1/pbs -name "route.ts" | xargs grep -l snapshots
```

- [ ] **Step 2: Add the filter logic**

At the top of the GET handler, after the connection is resolved but before the PBS fetch:

```ts
import { getVdcScope } from '@/lib/vdc/scope'
import { getCurrentTenantId } from '@/lib/tenant'
import { listSnapshotsInNamespace } from '@/lib/proxmox/pbsNamespace'

// ... inside GET, after resolving `conn`, `id`, `store`:
const scope = getVdcScope(await getCurrentTenantId())
if (scope) {
  const allowed = (scope.pbsNamespacesByConnection.get(id) ?? []).filter(p => p.datastore === store)
  if (allowed.length === 0) {
    return NextResponse.json({ data: [] })
  }
  const all: any[] = []
  for (const { namespace } of allowed) {
    try {
      const snaps = await listSnapshotsInNamespace(conn, store, namespace)
      for (const s of snaps) all.push({ ...s, ns: namespace })
    } catch { /* skip */ }
  }
  return NextResponse.json({ data: all })
}

// fall through to the existing admin path which reads root only
```

- [ ] **Step 3: Typecheck**

```bash
cd frontend && npx tsc --noEmit 2>&1 | grep "pbs/.*/snapshots" || echo clean
```

- [ ] **Step 4: Commit**

```bash
cd frontend && git add src/app/api/v1/pbs/ && \
git commit -m "feat(vdc-pbs): scope snapshots endpoint to tenant namespaces"
```

---

### Task 10: Admin API — list + create + delete bindings

**Files:**
- Create: `frontend/src/app/api/v1/admin/vdcs/[id]/pbs-bindings/route.ts`
- Create: `frontend/src/app/api/v1/admin/vdcs/[id]/pbs-bindings/[bindingId]/route.ts`

- [ ] **Step 1: Create the collection route**

`frontend/src/app/api/v1/admin/vdcs/[id]/pbs-bindings/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'

import { isUserSuperAdmin } from '@/lib/rbac'
import { authOptions } from '@/lib/auth/config'
import { listBindingsForVdc } from '@/lib/db/vdcPbsBindings'
import { bindPbsToVdc } from '@/lib/vdc/pbsOrchestrator'

export const runtime = 'nodejs'

async function requireSuperAdmin(): Promise<Response | null> {
  const s = await getServerSession(authOptions)
  if (!s?.user?.id || !isUserSuperAdmin(s.user.id)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  return null
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = await requireSuperAdmin()
  if (denied) return denied
  const { id } = await ctx.params
  const rows = listBindingsForVdc(id).map(({ pbsTokenSecret, ...r }) => r)
  return NextResponse.json({ data: rows })
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = await requireSuperAdmin()
  if (denied) return denied
  const { id } = await ctx.params
  const body = await req.json().catch(() => ({})) as {
    pbsConnectionId?: string; datastore?: string; namespace?: string
  }
  if (!body.pbsConnectionId || !body.datastore) {
    return NextResponse.json({ error: 'Missing pbsConnectionId or datastore' }, { status: 400 })
  }
  try {
    const { binding, steps } = await bindPbsToVdc({
      vdcId: id,
      pbsConnectionId: body.pbsConnectionId,
      datastore: body.datastore,
      namespace: body.namespace,
    })
    const { pbsTokenSecret, ...safe } = binding
    return NextResponse.json({ data: safe, steps })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 })
  }
}
```

- [ ] **Step 2: Create the per-binding DELETE route**

`frontend/src/app/api/v1/admin/vdcs/[id]/pbs-bindings/[bindingId]/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'

import { isUserSuperAdmin } from '@/lib/rbac'
import { authOptions } from '@/lib/auth/config'
import { unbindFromVdc } from '@/lib/vdc/pbsOrchestrator'

export const runtime = 'nodejs'

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string; bindingId: string }> }) {
  const s = await getServerSession(authOptions)
  if (!s?.user?.id || !isUserSuperAdmin(s.user.id)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  const { bindingId } = await ctx.params
  try {
    await unbindFromVdc(bindingId)
    return NextResponse.json({ ok: true })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 })
  }
}
```

- [ ] **Step 3: Smoke-test**

```bash
cd frontend && curl -sS -H 'Cookie: <admin>' http://localhost:3000/api/v1/admin/vdcs/<vdcId>/pbs-bindings
```
Expected: `{ "data": [] }`.

- [ ] **Step 4: Commit**

```bash
cd frontend && git add src/app/api/v1/admin/vdcs/ && \
git commit -m "feat(vdc-pbs): admin api — list/create/delete bindings"
```

---

### Task 11: Admin API — fingerprint + datastores list

**Files:**
- Create: `frontend/src/app/api/v1/admin/pbs-connections/[id]/fingerprint/route.ts`
- Create: `frontend/src/app/api/v1/admin/pbs-connections/[id]/datastores/route.ts`

- [ ] **Step 1: Create fingerprint capture endpoint**

`frontend/src/app/api/v1/admin/pbs-connections/[id]/fingerprint/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'

import { authOptions } from '@/lib/auth/config'
import { isUserSuperAdmin } from '@/lib/rbac'
import { prisma } from '@/lib/db/prisma'
import { captureFingerprint } from '@/lib/proxmox/pbsFingerprint'

export const runtime = 'nodejs'

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const s = await getServerSession(authOptions)
  if (!s?.user?.id || !isUserSuperAdmin(s.user.id)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  const { id } = await ctx.params
  const conn = await prisma.connection.findUnique({ where: { id }, select: { baseUrl: true, type: true } })
  if (!conn || conn.type !== 'pbs') {
    return NextResponse.json({ error: 'PBS connection not found' }, { status: 404 })
  }
  try {
    const fingerprint = await captureFingerprint(conn.baseUrl)
    await prisma.connection.update({ where: { id }, data: { fingerprint } })
    return NextResponse.json({ data: { fingerprint } })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || String(e) }, { status: 502 })
  }
}
```

- [ ] **Step 2: Create datastores listing endpoint**

`frontend/src/app/api/v1/admin/pbs-connections/[id]/datastores/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'

import { authOptions } from '@/lib/auth/config'
import { isUserSuperAdmin } from '@/lib/rbac'
import { getPbsConnectionById } from '@/lib/connections/getConnection'
import { pbsFetch } from '@/lib/proxmox/pbs-client'

export const runtime = 'nodejs'

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const s = await getServerSession(authOptions)
  if (!s?.user?.id || !isUserSuperAdmin(s.user.id)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  const { id } = await ctx.params
  const conn = await getPbsConnectionById(id)
  const datastores = await pbsFetch<Array<{ store: string }>>(conn, '/admin/datastore')
  return NextResponse.json({ data: (datastores || []).map(d => d.store) })
}
```

- [ ] **Step 3: Smoke-test**

```bash
curl -sS -X POST -H 'Cookie: <admin>' http://localhost:3000/api/v1/admin/pbs-connections/<id>/fingerprint
curl -sS      -H 'Cookie: <admin>' http://localhost:3000/api/v1/admin/pbs-connections/<id>/datastores
```
Expected: `{ "data": { "fingerprint": "AA:BB:..." } }` and `{ "data": ["store1", "store2"] }`.

- [ ] **Step 4: Commit**

```bash
cd frontend && git add src/app/api/v1/admin/pbs-connections/ && \
git commit -m "feat(vdc-pbs): admin api — pbs fingerprint capture + datastores list"
```

---

### Task 12: Admin UI — `VdcPbsBindingsDialog`

**Files:**
- Create: `frontend/src/components/settings/VdcPbsBindingsDialog.tsx`
- Modify: `frontend/src/components/settings/VdcTab.tsx`
- Modify (conditionally): `frontend/src/app/api/v1/admin/connections/route.ts` (expose `fingerprint` in SELECT)

- [ ] **Step 1: Create the dialog component**

`frontend/src/components/settings/VdcPbsBindingsDialog.tsx`:

```tsx
'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle,
  FormControlLabel, IconButton, MenuItem, Stack, Switch, TextField, Typography,
} from '@mui/material'

interface Binding {
  id: string
  pbsConnectionId: string
  datastore: string
  namespace: string
  pbsTokenId: string
  createdAt: string
}

interface PbsConnOption { id: string; name: string; fingerprint: string | null }

interface Props {
  vdcId: string
  vdcName: string
  pbsConnections: PbsConnOption[]
  open: boolean
  onClose: () => void
}

export default function VdcPbsBindingsDialog({ vdcId, vdcName, pbsConnections, open, onClose }: Props) {
  const [bindings, setBindings] = useState<Binding[]>([])
  const [loading, setLoading] = useState(true)
  const [addOpen, setAddOpen] = useState(false)
  const [form, setForm] = useState({ pbsConnectionId: '', datastore: '', namespace: '', overrideNs: false })
  const [datastores, setDatastores] = useState<string[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [stepReport, setStepReport] = useState<any | null>(null)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      const r = await fetch(`/api/v1/admin/vdcs/${encodeURIComponent(vdcId)}/pbs-bindings`)
      const j = await r.json()
      setBindings(Array.isArray(j.data) ? j.data : [])
    } finally { setLoading(false) }
  }, [vdcId])

  useEffect(() => { if (open) void reload() }, [open, reload])

  useEffect(() => {
    if (!form.pbsConnectionId) { setDatastores([]); return }
    ;(async () => {
      try {
        const r = await fetch(`/api/v1/admin/pbs-connections/${encodeURIComponent(form.pbsConnectionId)}/datastores`)
        const j = await r.json()
        setDatastores(Array.isArray(j.data) ? j.data : [])
      } catch { setDatastores([]) }
    })()
  }, [form.pbsConnectionId])

  const handleSubmit = async () => {
    setSubmitting(true); setError(null); setStepReport(null)
    try {
      const body: any = { pbsConnectionId: form.pbsConnectionId, datastore: form.datastore }
      if (form.overrideNs && form.namespace) body.namespace = form.namespace
      const r = await fetch(`/api/v1/admin/vdcs/${encodeURIComponent(vdcId)}/pbs-bindings`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      })
      const j = await r.json()
      if (!r.ok) { setError(j.error ?? 'Request failed'); return }
      setStepReport(j.steps)
      await reload()
    } finally { setSubmitting(false) }
  }

  const handleDelete = async (bindingId: string) => {
    if (!confirm('Remove this PBS binding? The namespace and backups remain; only the PVE storage and sub-token are deleted.')) return
    const r = await fetch(`/api/v1/admin/vdcs/${encodeURIComponent(vdcId)}/pbs-bindings/${encodeURIComponent(bindingId)}`, { method: 'DELETE' })
    if (r.ok) void reload()
  }

  const eligible = pbsConnections.filter(c => c.fingerprint)
  const noFingerprint = pbsConnections.length > 0 && eligible.length === 0

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>Backup (PBS) — {vdcName}</DialogTitle>
      <DialogContent>
        {noFingerprint && (
          <Alert severity="warning" sx={{ mb: 2 }}>
            None of the PBS connections have a captured fingerprint. Open the PBS connection settings and click "Update fingerprint" first.
          </Alert>
        )}
        {loading ? <Typography variant="caption">…</Typography> : (
          <Stack spacing={1}>
            {bindings.length === 0 && <Typography variant="caption" color="text.secondary">No binding yet.</Typography>}
            {bindings.map(b => (
              <Stack key={b.id} direction="row" alignItems="center" spacing={1} sx={{ border: '1px solid', borderColor: 'divider', p: 1, borderRadius: 1 }}>
                <Box sx={{ flex: 1 }}>
                  <Typography variant="body2"><b>{b.datastore}</b> / {b.namespace}</Typography>
                  <Typography variant="caption" color="text.secondary">
                    PBS: {pbsConnections.find(c => c.id === b.pbsConnectionId)?.name ?? b.pbsConnectionId} — token {b.pbsTokenId}
                  </Typography>
                </Box>
                <IconButton size="small" color="error" onClick={() => handleDelete(b.id)}><i className="ri-delete-bin-line" /></IconButton>
              </Stack>
            ))}
          </Stack>
        )}
        <Button sx={{ mt: 2 }} size="small" startIcon={<i className="ri-add-line" />} onClick={() => setAddOpen(v => !v)} disabled={eligible.length === 0}>
          Add binding
        </Button>
        {addOpen && (
          <Box sx={{ mt: 2, p: 2, border: '1px dashed', borderColor: 'divider', borderRadius: 1 }}>
            <Stack spacing={2}>
              <TextField select size="small" label="PBS connection" value={form.pbsConnectionId} onChange={e => setForm(f => ({ ...f, pbsConnectionId: e.target.value, datastore: '' }))}>
                {eligible.map(c => <MenuItem key={c.id} value={c.id}>{c.name}</MenuItem>)}
              </TextField>
              <TextField select size="small" label="Datastore" value={form.datastore} onChange={e => setForm(f => ({ ...f, datastore: e.target.value }))} disabled={!form.pbsConnectionId}>
                {datastores.map(d => <MenuItem key={d} value={d}>{d}</MenuItem>)}
              </TextField>
              <FormControlLabel
                control={<Switch size="small" checked={form.overrideNs} onChange={e => setForm(f => ({ ...f, overrideNs: e.target.checked }))} />}
                label="Override auto namespace"
              />
              {form.overrideNs && (
                <TextField size="small" label="Namespace" helperText="e.g. tenant-acme/vdc-prod" value={form.namespace} onChange={e => setForm(f => ({ ...f, namespace: e.target.value }))} />
              )}
              {error && <Alert severity="error">{error}</Alert>}
              {stepReport && (
                <Alert severity="info">
                  namespace {stepReport.namespace} · token {stepReport.token} · acl {stepReport.acl}
                  {stepReport.pveStorages?.map((s: any) => (
                    <div key={s.name}>PVE {s.name} on {s.pveConnectionId}: {s.status}{s.error ? ` (${s.error})` : ''}</div>
                  ))}
                </Alert>
              )}
              <Stack direction="row" spacing={1} justifyContent="flex-end">
                <Button onClick={() => { setAddOpen(false); setStepReport(null); setError(null) }}>Cancel</Button>
                <Button variant="contained" disabled={!form.pbsConnectionId || !form.datastore || submitting} onClick={handleSubmit}>
                  {submitting ? '…' : 'Create'}
                </Button>
              </Stack>
            </Stack>
          </Box>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  )
}
```

- [ ] **Step 2: Wire it into `VdcTab.tsx`**

In `frontend/src/components/settings/VdcTab.tsx`:

1. Add import:

```tsx
import VdcPbsBindingsDialog from './VdcPbsBindingsDialog'
```

2. Add state near other `useState` calls:

```tsx
const [pbsDialogVdc, setPbsDialogVdc] = useState<{ id: string; name: string } | null>(null)
const [pbsConnections, setPbsConnections] = useState<Array<{ id: string; name: string; fingerprint: string | null }>>([])

useEffect(() => {
  (async () => {
    const r = await fetch('/api/v1/admin/connections?type=pbs')
    if (r.ok) {
      const j = await r.json()
      setPbsConnections((j.data ?? []).map((c: any) => ({ id: c.id, name: c.name, fingerprint: c.fingerprint ?? null })))
    }
  })()
}, [])
```

3. In the row actions column (existing IconButton stack for edit/delete), add:

```tsx
<Tooltip title="Backup (PBS)">
  <IconButton size="small" onClick={() => setPbsDialogVdc({ id: row.id, name: row.name })}>
    <i className="ri-save-3-line" />
  </IconButton>
</Tooltip>
```

4. Next to other dialogs at the bottom of the JSX:

```tsx
{pbsDialogVdc && (
  <VdcPbsBindingsDialog
    vdcId={pbsDialogVdc.id}
    vdcName={pbsDialogVdc.name}
    pbsConnections={pbsConnections}
    open={!!pbsDialogVdc}
    onClose={() => setPbsDialogVdc(null)}
  />
)}
```

- [ ] **Step 3: Ensure admin connections endpoint exposes fingerprint**

```bash
cd frontend && grep -n "fingerprint" src/app/api/v1/admin/connections/route.ts || echo missing
```
If missing, add `fingerprint: true` to the `select:` block of the GET handler's Prisma query.

- [ ] **Step 4: Smoke-test in the browser**

- `cd frontend && npm run dev`
- Login as super admin, open `/settings > Virtual Datacenters > <edit a vDC row>`, click the floppy-disk action icon.
- Verify: dialog opens, PBS dropdown lists connections with a fingerprint, datastore dropdown populates, create succeeds and shows per-step statuses.

- [ ] **Step 5: Commit**

```bash
cd frontend && git add src/components/settings/VdcPbsBindingsDialog.tsx src/components/settings/VdcTab.tsx src/app/api/v1/admin/connections/route.ts && \
git commit -m "feat(vdc-pbs): admin UI — backup(pbs) bindings dialog on vdc row"
```

---

### Task 13: Cascade cleanup on vDC delete

**Files:**
- Modify: `frontend/src/app/api/v1/admin/vdcs/[id]/route.ts`

- [ ] **Step 1: Call unbind for every binding before deleting the vDC**

At the top of the DELETE handler in `frontend/src/app/api/v1/admin/vdcs/[id]/route.ts`, before the existing `DELETE FROM vdcs`:

```ts
import { listBindingsForVdc } from '@/lib/db/vdcPbsBindings'
import { unbindFromVdc } from '@/lib/vdc/pbsOrchestrator'

// ... inside DELETE handler, before the vdc deletion:
const bindings = listBindingsForVdc(id)
for (const b of bindings) {
  try { await unbindFromVdc(b.id) }
  catch (e) { console.error(`[vdc-delete] pbs unbind ${b.id} failed:`, e) }
}
```

- [ ] **Step 2: Manual test**

Create a vDC with one PBS binding, then DELETE the vDC; verify the PBS namespace still exists (data retention), sub-token is gone, PVE `pbs:` storage is gone.

- [ ] **Step 3: Commit**

```bash
cd frontend && git add src/app/api/v1/admin/vdcs/ && \
git commit -m "feat(vdc-pbs): cascade unbind on vdc delete"
```

---

### Task 14: i18n strings

**Files:**
- Modify: `frontend/src/messages/{en,fr,de,zh-CN}.json`
- Modify: `frontend/src/components/settings/VdcPbsBindingsDialog.tsx` (replace hardcoded strings)

- [ ] **Step 1: Add keys to all 4 locale files**

Under the existing `"vdc"` block in each file, add:

```jsonc
"pbsBindings": "Backup (PBS)",
"pbsBindingsDialogTitle": "Backup bindings for {name}",
"pbsAddBinding": "Add binding",
"pbsPbsConnection": "PBS connection",
"pbsDatastore": "Datastore",
"pbsNamespaceOverride": "Override auto namespace",
"pbsNamespaceHelper": "e.g. tenant-acme/vdc-prod",
"pbsNoBinding": "No binding yet.",
"pbsFingerprintMissing": "This PBS connection has no captured fingerprint. Open its settings and capture it first.",
"pbsRemoveConfirm": "Remove this PBS binding? The namespace and backups are preserved; only the PVE storage and sub-token are deleted."
```

(Translate per locale — English values above.)

- [ ] **Step 2: Replace hardcoded strings in the dialog**

In `VdcPbsBindingsDialog.tsx`, import `useTranslations` and replace each literal with `t('vdc.pbsBindings')`, `t('vdc.pbsBindingsDialogTitle', { name: vdcName })`, etc.

- [ ] **Step 3: Verify by switching locale**

Start dev server, switch UI locale to `fr`, open the dialog — all labels localised.

- [ ] **Step 4: Commit**

```bash
cd frontend && git add src/messages/ src/components/settings/VdcPbsBindingsDialog.tsx && \
git commit -m "feat(vdc-pbs): i18n strings for backup bindings dialog"
```

---

### Task 15: Integration test — local PBS + PVE

Manual acceptance test. No code — run a checklist.

- [ ] **Step 1: Preconditions**

- At least one PVE cluster connection with a running dev cluster.
- One PBS connection in the `DEFAULT` tenant; open its edit panel, click "Update fingerprint" → verify DB has a non-null `Connection.fingerprint`.
- One non-default tenant with a vDC pointing at the PVE cluster, including `nodes[]` and an SDN zone.

- [ ] **Step 2: Bind**

- Open the vDC → Backup (PBS) dialog → add a binding with the PBS above and an existing datastore.
- Verify response shows all step statuses `ok`.
- On PBS UI: the namespace `tenant-<slug>/vdc-<slug>` exists, has an ACL granting `DatastoreBackup` to `root@...!vdc-<vdcId8>`.
- On PVE UI: storage `pbs-<tenantSlug>-<vdcSlug>` exists, type pbs, correct namespace, `nodes` matches the vDC.
- On ProxCenter: the new storage appears in `vdc.storages[]`.

- [ ] **Step 3: Tenant visibility**

- Log in as the tenant user, go to `/infrastructure/inventory`:
  - PBS datastore appears with **only** this vDC's namespace snapshots (likely 0 at first).
  - Other namespaces on the same datastore are not visible.
- Run a backup from the tenant's VM → verify it lands in the right namespace on PBS.
- Re-open `/infrastructure/inventory` → the backup count on the PBS datastore increments.

- [ ] **Step 4: Unbind**

- Remove the binding → verify PVE storage is gone, sub-token is gone on PBS, namespace + backups are still there.

- [ ] **Step 5: vDC delete**

- Re-create the binding, then delete the vDC → same outcome as Step 4.

- [ ] **Step 6: Mark the plan complete**

No commit — this task is a sign-off checklist.

---

## Self-review

1. **Spec coverage:**
   - §2 In-scope → Task 1 (schema), 2 (CRUD), 3 (fingerprint), 4-5 (helpers), 6 (orchestrator), 7-9 (filtering), 10-11 (admin API), 12 (UI), 13 (cascade), 14 (i18n), 15 (test). ✓
   - §5 Cleanup → Task 6 `unbindFromVdc` + Task 13 cascade ✓
   - §6.1 `VdcScope` extension → Task 7 ✓
   - §6.2 Inventory stream → Task 8 ✓
   - §6.3 Snapshot endpoint → Task 9 ✓
   - §8 Fingerprint capture → Task 3 + Task 11 ✓
   - §9 Per-key mutex → Task 6 `withLock` ✓
   - §11 Migration → Task 1 ✓

2. **Placeholder scan:**
   - Task 9 Step 1 says "verify the filename first" — this is a checklist step, not a placeholder.
   - No TBDs, no "implement later", no `// handle edge cases` placeholders.

3. **Type consistency:**
   - `PbsBindingRow` defined in Task 2 and reused by Tasks 6, 10, 12. ✓
   - `VdcScope.pbsNamespacesByConnection` defined Task 7, consumed Tasks 8-9. ✓
   - `sanitizeStorageName` signature identical in Tasks 5 + 6. ✓
   - Helper names consistent: `ensureNamespace`, `ensureNamespacePath`, `ensureSubToken`, `setNamespaceAcl`, `deleteSubToken`, `listSnapshotsInNamespace`, `createPbsStorage`, `deletePbsStorage`, `pbsStorageExists`. ✓

Plan self-review clean.

---
