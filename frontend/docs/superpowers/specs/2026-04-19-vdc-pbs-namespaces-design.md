# vDC PBS Namespaces — Design (Phase 2: automatic provisioning)

**Date:** 2026-04-19
**Branch:** feature/msp-iaas
**Status:** Accepted

## 1. Goal

Automatically provision per-vDC backup isolation on Proxmox Backup Server (PBS). When a super admin attaches a PBS datastore + namespace to a vDC, ProxCenter creates the PBS namespace, mints a scoped PBS token, and injects a matching `pbs:` storage in every PVE cluster of the vDC. Tenants see only their own backups in `/infrastructure/inventory` and in every Backup tab (cluster / node / VM), without touching PBS or PVE directly.

Phase 1 ("assignment-only, manual PBS provisioning") is skipped — we go straight to full automation.

## 2. Scope

### In

- New super admin UI on the vDC edit dialog: tab "Backup (PBS)" to list / add / remove `(PBS connection, datastore, namespace)` bindings. **PBS is optional — a vDC with zero bindings is legal; tenants simply see no PBS section in their UI.**
- **n+1 PBS per vDC** — multiple bindings on different PBS connections and/or different datastores on the same PBS are allowed.
- Two modes per binding:
  - **Auto provision (default).** ProxCenter creates the PBS namespace, mints a sub-token, sets the ACL, and injects the PVE `pbs:` storage.
  - **Manual.** Admin has already created the namespace / token / PVE storage by hand. ProxCenter only records the mapping for UI filtering — no PBS/PVE API calls on create, no cleanup on delete beyond the DB row.
- Server-side orchestration on save **in auto mode**:
  - Create the PBS namespace (idempotent).
  - Mint a PBS sub-token with `DatastoreBackup` role scoped to that namespace.
  - Persist the secret in DB.
  - Create a `pbs:` storage entry on every PVE cluster referenced by the vDC, with `namespace` + `nodes=<vdc.nodes>` and the sub-token credentials.
  - Append the auto-created storage names to `vdc.storages[]` so the existing vDC scope filter (`lib/vdc/scope.ts`) exposes them to the tenant.
- Server-side orchestration **in manual mode**:
  - Validate mandatory fields (PBS conn, datastore, namespace).
  - Optional: admin may provide an existing PVE storage name — if so, add it to `vdc.storages[]` and record it in `vdc_pbs_pve_storages` with a `managed=0` flag (so we don't delete it on cleanup).
  - Write the binding row with `mode='manual'`, nullable `pbs_token_id`/`pbs_token_secret`.
- Tenant-side filtering of PBS snapshots by namespace everywhere (inventory stream, cluster Backup tab, host Backup tab, VM Backup tab).
- Cleanup on binding removal / vDC delete: remove the PVE `pbs:` storage entries, revoke the PBS sub-token, **keep the namespace + its backups** (data retention by default).
- PBS fingerprint autocapture: `pbs_connections.fingerprint` column populated from TLS handshake at connection save time.

### Out (deferred)

- Native PVE ACLs on `/storage/<name>` — isolation relies on `vdc.storages[]` whitelist, which is already enforced by the app. PVE-native ACLs only matter if tenants gain direct PVE access; no plan for that.
- Migration of pre-existing backups written at the PBS root namespace before this feature lands — those remain invisible to tenants.
- Retention / prune policy per vDC.
- Encrypted backups (`encryption-key autogen`).
- Per-namespace quota beyond the PBS datastore level.
- Force-delete of a namespace with its backups (admin must do this by hand in PBS for now).

## 3. Architecture

### 3.1 Actors and trust boundaries

- **Root PBS connection** lives on the `DEFAULT` tenant, holds a token with `Datastore.Allocate` + `Permissions.Modify` + `Token.Modify` — ProxCenter's provisioning arm.
- **Sub-tokens** are per-binding (one token per `(vDC, pbs, datastore, namespace)` row). Named `<rootUser>@pbs!vdc-<vdcId8>` so they're trivially identifiable in PBS logs.
- **Tenants** never hold PBS credentials. All PBS reads go through ProxCenter, filtered by the vDC's namespace list.

### 3.2 Data model

Two new SQLite tables (SQLite because settings/RBAC live there; vDC data does too):

```sql
CREATE TABLE vdc_pbs_namespaces (
  id                 TEXT PRIMARY KEY,           -- uuid
  vdc_id             TEXT NOT NULL,
  pbs_connection_id  TEXT NOT NULL,
  datastore          TEXT NOT NULL,
  namespace          TEXT NOT NULL,              -- e.g. "tenant-acmecorp/vdc-prod-web"
  mode               TEXT NOT NULL DEFAULT 'auto',  -- 'auto' | 'manual'
  pbs_token_id       TEXT,                       -- NULL in manual mode
  pbs_token_secret   TEXT,                       -- NULL in manual mode
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (pbs_connection_id, datastore, namespace)
);

CREATE TABLE vdc_pbs_pve_storages (
  id                     TEXT PRIMARY KEY,       -- uuid
  vdc_pbs_namespace_id   TEXT NOT NULL REFERENCES vdc_pbs_namespaces(id) ON DELETE CASCADE,
  pve_connection_id      TEXT NOT NULL,
  pve_storage_name       TEXT NOT NULL,          -- e.g. "pbs-acmecorp-prod-web"
  managed                INTEGER NOT NULL DEFAULT 1,  -- 1 = ProxCenter created it and will delete on cleanup; 0 = pre-existing, don't touch
  created_at             TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (pve_connection_id, pve_storage_name)
);
```

`pbs_connections` schema gains:

```sql
ALTER TABLE pbs_connections ADD COLUMN fingerprint TEXT;
```

### 3.3 Naming conventions

- Tenant slug: `slugify(tenant.name)`, lowercased, `[a-z0-9-]{1,24}`, unique across tenants (add suffix `-2`, `-3` on collision).
- vDC slug: same rules, unique within a tenant.
- PBS namespace: `tenant-<tenantSlug>/vdc-<vdcSlug>` (hierarchical — enables revoking a tenant root by detaching the parent later if needed).
- PBS sub-token: `<rootUser>@<rootRealm>!vdc-<vdcId8>` where `vdcId8` is the first 8 chars of the vDC id.
- PVE storage id: `pbs-<tenantSlug>-<vdcSlug>` (must match `[a-z][a-z0-9\-_.]*`).

## 4. Provisioning flow

### 4.1 Auto mode

On `POST /api/v1/admin/vdcs/:id/pbs-bindings` with body `{ mode: 'auto', pbsConnectionId, datastore, namespace? }` (or `mode` omitted — defaults to auto):

1. Resolve the root PBS connection (`pbs_connections.fingerprint` must be set; reject with `412 fingerprint_missing` otherwise).
2. Compute the namespace path: if `namespace` in body is empty, default to `tenant-<slug>/vdc-<slug>` (hierarchical); otherwise use as-is (admin override — for migration/legacy cases).
3. **PBS: create parent then child namespace.** PBS namespaces are created one level at a time. First `POST /admin/datastore/{ds}/namespace` with `ns=tenant-<slug>` at the root (treat 409/"already exists" as success), then a second call with `ns=vdc-<slug>`, `parent=tenant-<slug>`. Both are idempotent via pre-check on `GET /admin/datastore/{ds}/namespace`.
4. **PBS: mint sub-token** `POST /access/users/{user}/token/{tokenId}` → capture `tokenid` + `value` (secret shown once).
5. **PBS: set ACL** `PUT /access/acl` with `path=/datastore/{ds}/{ns}`, `tokens=<tokenid>`, `roles=DatastoreBackup`, `propagate=1`.
6. **DB: insert** `vdc_pbs_namespaces` row.
7. For each PVE cluster id in `vdc.connectionIds`:
   a. `POST /storage` on that PVE cluster with `type=pbs`, `storage=pbs-<tenantSlug>-<vdcSlug>`, `server=<pbs.host>`, `datastore`, `namespace`, `username=<tokenid>`, `password=<secret>`, `fingerprint`, `content=backup`, `nodes=<vdc.nodes joined>`.
   b. **DB: insert** `vdc_pbs_pve_storages` row.
8. **Append** every created `pve_storage_name` to `vdc.storages[]` (the string JSON array on `vdcs.storages`).
9. Return the binding row plus per-step status (`{ namespace: 'ok', token: 'ok', acl: 'ok', pveStorages: [{connId, name, status}] }`).

**Idempotence:** every step checks "exists?" before creating (PBS `GET /admin/datastore/{ds}/namespace`, `GET /access/users/{u}/token/{id}`, PVE `GET /storage/{name}`). If the DB row already exists but a PVE cluster is missing its storage (e.g. vDC grew a new connection), re-calling the same endpoint reconciles — PVE storages for missing clusters are added, nothing else changes.

**Failure handling:** we do NOT rollback on partial failure. Return HTTP 207-style payload with per-step status. Admin can re-trigger — the idempotent steps skip themselves. Hard failure (e.g. PBS unreachable before step 3) returns 502 with no DB write.

### 4.2 Manual mode

On `POST /api/v1/admin/vdcs/:id/pbs-bindings` with body `{ mode: 'manual', pbsConnectionId, datastore, namespace, pveStorageName? }`:

1. Validate `pbsConnectionId` points at a PBS connection that exists (the fingerprint column is NOT required — ProxCenter doesn't need to talk to PBS in manual mode).
2. `namespace` is **required** (no auto default).
3. Insert `vdc_pbs_namespaces` row with `mode='manual'`, `pbs_token_id=NULL`, `pbs_token_secret=NULL`.
4. If `pveStorageName` is provided:
   - Insert `vdc_pbs_pve_storages` row with `managed=0`.
   - Append the name to `vdc.storages[]` so the tenant sees it in the storages allowlist.
5. Return the binding row with `steps = { mode: 'manual' }`.

Zero calls to PBS or PVE. Admin is fully responsible for ensuring the namespace, token/ACL, and PVE storage are correctly set up on their end.

## 5. Cleanup flow

On `DELETE /api/v1/admin/vdcs/:id/pbs-bindings/:bindingId`:

### 5.1 Auto-mode binding

1. For each `vdc_pbs_pve_storages` row tied to the binding where `managed=1`: `DELETE /storage/{name}` on the target PVE cluster (idempotent — ignore 404).
2. Remove the storage names from `vdc.storages[]`.
3. Revoke the PBS sub-token: `DELETE /access/users/{user}/token/{tokenId}`.
4. Delete the `vdc_pbs_namespaces` row (cascades to `vdc_pbs_pve_storages`).
5. **Leave the PBS namespace and its backups untouched.**

### 5.2 Manual-mode binding

1. For each `vdc_pbs_pve_storages` row tied to the binding where `managed=0`: **do not** delete the PVE storage — only remove it from `vdc.storages[]` and drop the DB row.
2. **Do not** call PBS (we don't own the token).
3. Delete the `vdc_pbs_namespaces` row.

### 5.3 vDC delete

On `DELETE /api/v1/admin/vdcs/:id`: iterate all bindings, invoke the appropriate cleanup per binding based on `mode`, then delete the vDC.

## 6. Tenant filtering

### 6.1 Helper

Extend `lib/vdc/scope.ts`:

```ts
interface VdcScope {
  // existing fields...
  pbsNamespaces: Map<string /* pbsConnectionId */, Array<{ datastore: string; namespace: string }>>
}
```

Populated from `vdc_pbs_namespaces` joined on `vdcs` where `tenant_id = <currentTenantId>`.

### 6.2 Inventory stream

`/api/v1/inventory/stream` (`route.ts`): when emitting `pbs` events for a tenant with a non-empty `vdcScope.pbsNamespaces`:

- Filter `pbsConnections` to those the tenant has bindings on.
- For each PBS, re-fetch snapshots **per-namespace** via `GET /admin/datastore/{ds}/snapshots?ns=<ns>&max-depth=0`. Replace the current `snapshots[]` with the union across the tenant's namespaces.
- Recompute `stats.totalBackups`, `stats.vmCount`, `stats.ctCount`, `stats.hostCount` from the filtered set.
- Datastores the tenant has no binding on are excluded entirely.

Keep the admin (non-vDC) path unchanged: it hits the datastore root (no `?ns=`), shows everything as today.

### 6.3 Cluster / node / VM Backup tabs

Each tab currently calls `GET /admin/datastore/{ds}/snapshots` (via `/api/v1/pbs/[id]/...`). Add a `ns` filter: when the caller is a tenant, the endpoint iterates the tenant's namespaces on that datastore and union-merges the results. Admin callers keep root-only behavior.

Touched routes (list, may grow during implementation):

- `GET /api/v1/pbs/[id]/datastores`
- `GET /api/v1/pbs/[id]/datastores/[store]/snapshots`
- `GET /api/v1/pbs/[id]/datastores/[store]/rrd`
- Any guest-level backup endpoint that proxies to PBS (to be enumerated during planning).

### 6.4 Backup job targets (client-side)

VM backup job create dialog already reads `vdc.storages[]` to populate the PVE storage dropdown. The auto-created `pbs-<tenantSlug>-<vdcSlug>` names will appear there automatically once step 8 of §4 runs.

## 7. Admin UI

### 7.1 Location

Inside the vDC edit dialog at `/settings` → Virtual Datacenters. Add a new tab "Backup (PBS)" alongside the existing "Storages" / "Nodes" / "Quotas" tabs.

### 7.2 Components

- `VdcPbsBindingsTab` (React) — table of current bindings with `{PBS name, datastore, namespace, mode, created}` + Remove button per row + "Add binding" button.
- `VdcPbsBindingDialog` — form:
  - **Mode toggle**: `Auto provision | Manual`. Default `Auto`.
  - Select PBS connection:
    - In Auto mode, only lists connections with a populated `fingerprint` (CTA "Configure fingerprint" if none).
    - In Manual mode, lists all PBS connections.
  - Select datastore (populated from `GET /api/v1/admin/pbs/[id]/datastores`).
  - Namespace:
    - Auto mode: read-only default `tenant-<slug>/vdc-<slug>` with an "Override" toggle revealing a text input.
    - Manual mode: required text input, no default.
  - PVE storage name (Manual mode only): optional text input for an existing storage to add to the tenant's allowlist.
  - Submit → POST. Auto mode renders per-step status (ok / skipped / failed); Manual mode shows a simple success chip.

### 7.3 Error surface

Failure during provisioning doesn't rollback — the modal stays open, shows the per-step status, admin can retry. The DB row exists as soon as step 6 succeeds; subsequent reruns only fix what's broken.

## 8. Fingerprint capture

At `POST/PATCH /api/v1/admin/pbs-connections`:

1. After validating credentials, open a TCP+TLS handshake to `pbs.host:pbs.port`.
2. Extract the SHA256 fingerprint of the leaf certificate (standard Node `tls.TLSSocket.getPeerCertificate()` with `fingerprint256`).
3. Store in `pbs_connections.fingerprint`. On failure (network / self-signed mismatch / etc.) return 400 with a field-level error; do NOT save the connection.

Existing connections get an "Update fingerprint" button in the admin PBS connection edit form — runs the same capture on demand.

## 9. Concurrency + idempotence

- Provisioning is serialised per binding via an **in-process mutex** keyed on `(vdcId, pbsConnectionId, datastore, namespace)`. SQLite doesn't offer advisory locks like PostgreSQL; a process-local `Map<key, Promise>` is sufficient since the app is single-node. If we ever horizontally scale this, we'll revisit (e.g. a `SELECT ... FOR UPDATE`-style pattern on a dedicated lock row).
- PBS namespace + token + ACL creations are idempotent (pre-check before create, treat "already exists" as success).
- PVE `POST /storage` treats existing storage as ok IF name + key config match; on mismatch, return 409 with guidance (admin must rename / remove by hand).

## 10. Security

- Sub-token secret stored in `vdc_pbs_namespaces.pbs_token_secret`. No encryption beyond what existing connection secrets use (to be confirmed — matches current pattern).
- Provisioning endpoint (`POST /api/v1/admin/vdcs/:id/pbs-bindings`) is super-admin only.
- Listing bindings for read is super-admin only too; tenants don't need to see the tuple (they only see the filtered PBS snapshots).
- All operations logged to `audit_log` with `action=vdc.pbs.bind` / `action=vdc.pbs.unbind`, resource = vdc id.

## 11. Migration

- SQLite migration script adds the two tables + the `fingerprint` column.
- Existing vDCs unaffected (no bindings until admin adds them).
- Existing PBS connections: `fingerprint` left NULL; admin must update via the new button before creating any binding on that PBS.

## 12. Testing strategy

- Unit: slug generation (collisions), namespace path builder, PVE storage name sanitizer, per-step idempotency checks (mocked PBS / PVE responses).
- Integration (local PBS + PVE): create binding end-to-end, verify namespace exists, token exists, PVE `pvesm status` lists the new storage with the right namespace, tenant inventory stream excludes other namespaces.
- Negative: PBS unreachable → no DB write; PBS OK but one PVE fails → DB row exists with partial `vdc_pbs_pve_storages`; re-POST reconciles.

## 13. Open implementation questions

- Exact audit log shape — follow existing `audit_log` conventions (to be checked during planning).
- Where to store the root PBS token — reuse `pbs_connections` `tokenId`/`tokenSecret` columns (confirm the existing schema during planning).

These aren't design decisions; they're "look at the existing code to follow the same pattern" items, resolved in the plan.
