# Multi-DC Green-IT Configuration — Design (Phase A)

**Date:** 2026-04-26
**Branch:** feature/msp-iaas
**Status:** Proposed

## 1. Goal

Today the green-IT computation (`/api/v1/resources/overview`, `/api/v1/vdcs/[id]/green`) treats the whole infrastructure as a single homogeneous datacentre with one PUE, one electricity price, one CO₂ factor and one server-spec template. Most MSP setups span multiple physical sites with different PUE / power contracts / grid mixes, and may have heterogeneous hardware between clusters. The single-config model produces incorrect numbers as soon as a second DC is involved.

Phase A introduces a hierarchy of configuration — global default → cluster-level override → node-level override — anchored on user-managed datacentres. Server-model catalogues (Dell R750, HPE DL380, …) are out of scope: server specs stay as raw fields (TDP/core, W/GB RAM, overhead) at each level, with optional override.

## 2. Scope

### In

- New `datacenters` table with PUE / electricity_price / currency / co2_factor / location.
- New `connection_green_config` table — per-cluster (or standalone) DC assignment + optional server-spec overrides.
- New `node_green_config` table — per-node DC override + optional server-spec overrides.
- Restructured `/settings?tab=green` UI: 3 stacked sections (Datacenters · Server defaults · Connections).
- Refactored green-IT calculation: per-VM resolution of `(connectionId, nodeName) → { datacenter, tdp, ramW, overhead }`, applying the most specific level available (node ?? cluster ?? global).
- Migration: at first boot after deploy, auto-create a "Default" DC from the existing `settings.green` row so existing installs see no discontinuity.
- Provider-only — `/settings?tab=green` stays `providerOnly`.

### Out (Phase B, separate spec)

- Tenant-scoped `/infrastructure/resources` (filter VMs/nodes/storages by `vdcScope`). Tracked separately.
- Server-model catalogue (vendor presets, auto-detection from `/nodes/<n>/status`).
- Per-DC breakdown in the UI (per-DC tile or chart). Aggregate sum stays the primary number.
- External hypervisor connections (VMware, Hyper-V, XCP-NG, Nutanix). Out of scope per user direction.

## 3. Data model

### 3.1 `datacenters`

```sql
CREATE TABLE datacenters (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  name TEXT NOT NULL,
  location_label TEXT,
  country TEXT,
  latitude REAL,
  longitude REAL,
  pue REAL NOT NULL DEFAULT 1.4,
  electricity_price REAL NOT NULL DEFAULT 0.18,
  currency TEXT NOT NULL DEFAULT 'EUR',
  co2_factor REAL NOT NULL DEFAULT 0.052,
  co2_country_preset TEXT,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX idx_datacenters_default
  ON datacenters (tenant_id) WHERE is_default = 1;
```

`tenant_id` defaults to `'default'` and is provider-only in this iteration; we keep the column to avoid a schema migration when / if tenants ever get their own DC catalogue.

### 3.2 `connection_green_config`

```sql
CREATE TABLE connection_green_config (
  connection_id TEXT PRIMARY KEY,
  datacenter_id TEXT,
  tdp_per_core_w REAL,
  watts_per_gb_ram REAL,
  overhead_per_node_w REAL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (connection_id) REFERENCES Connection(id) ON DELETE CASCADE,
  FOREIGN KEY (datacenter_id) REFERENCES datacenters(id) ON DELETE SET NULL
);
```

Every spec field is nullable — null means "inherit from global".

### 3.3 `node_green_config`

```sql
CREATE TABLE node_green_config (
  connection_id TEXT NOT NULL,
  node_name TEXT NOT NULL,
  datacenter_id TEXT,
  tdp_per_core_w REAL,
  watts_per_gb_ram REAL,
  overhead_per_node_w REAL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (connection_id, node_name),
  FOREIGN KEY (connection_id) REFERENCES Connection(id) ON DELETE CASCADE,
  FOREIGN KEY (datacenter_id) REFERENCES datacenters(id) ON DELETE SET NULL
);
```

Same nullable convention — null means "inherit from cluster", which itself can mean "inherit from global".

## 4. Resolution

A new helper in `frontend/src/lib/green/resolve.ts`:

```ts
type ResolvedGreenConfig = {
  datacenter: { id: string | null; name: string; pue: number;
                electricityPrice: number; currency: string; co2Factor: number }
  tdpPerCore: number
  wattsPerGbRam: number
  overheadPerNode: number
}

export function resolveGreenConfigForNode(
  connectionId: string,
  nodeName: string,
): ResolvedGreenConfig
```

Resolution order, field by field:
1. `node_green_config(connectionId, nodeName).<field>`
2. `connection_green_config(connectionId).<field>`
3. Global defaults (existing `settings.green` row for `tenant_id='default'`, falling back to constants in code).

Datacenter row resolution:
- `node.datacenter_id` if non-null
- else `connection.datacenter_id` if non-null
- else `datacenters WHERE is_default=1` for the provider tenant
- else first datacenter row, else a virtual "global default" assembled from `settings.green` fields.

Caches: 30-second in-memory map keyed by `(connectionId, nodeName)`. Invalidated on any PUT to the green endpoints.

## 5. API

All endpoints provider-only — guarded with `requireSuperAdmin` (existing helper in `/api/v1/admin/...`).

### 5.1 Datacenters CRUD

- `GET /api/v1/admin/datacenters` → `{ data: Datacenter[] }`
- `POST /api/v1/admin/datacenters` body `{ name, locationLabel?, country?, latitude?, longitude?, pue, electricityPrice, currency, co2Factor, co2CountryPreset?, isDefault? }` → `{ data: Datacenter }`
- `GET /api/v1/admin/datacenters/[id]` → `{ data: Datacenter }`
- `PUT /api/v1/admin/datacenters/[id]` → `{ data: Datacenter }`
- `DELETE /api/v1/admin/datacenters/[id]` → 204
  - 409 if any `connection_green_config.datacenter_id` or `node_green_config.datacenter_id` references it. Force the user to reassign first.
  - Refuse to delete the row marked `is_default=1` unless another row is being promoted in the same transaction.

### 5.2 Connection green config

- `GET /api/v1/admin/connections/[id]/green-config` →
  ```json
  {
    "data": {
      "cluster": { "datacenterId": "...", "tdpPerCoreW": 9, … } | null,
      "nodes": [{ "nodeName": "pve1", "datacenterId": "...", … }]
    }
  }
  ```
- `PUT /api/v1/admin/connections/[id]/green-config` body identical to `cluster` field; upsert, returns the full payload above.
- `PUT /api/v1/admin/connections/[id]/nodes/[node]/green-config` upsert per-node row; same body shape minus connectionId.
- `DELETE /api/v1/admin/connections/[id]/nodes/[node]/green-config` clears the per-node override.

The `nodes` array on GET is built from the union of `node_green_config` rows + the live PVE node list (so the UI can show every node with placeholders even if the operator never saved anything).

## 6. UI changes — `/settings?tab=green`

Component restructuring (`frontend/src/components/settings/GreenTab.jsx` → splits into 3 sub-components on the same page).

### 6.1 Datacenters section (NEW, top)

`frontend/src/components/settings/green/DatacentersSection.tsx` + `DatacenterDialog.tsx`.

Table columns: Name · Location · PUE · Price (currency) · CO₂ kg/kWh · Default · Actions.
Row actions: Edit · Delete · Promote to default.
"Add datacenter" → dialog with full form, including a country dropdown that prefills CO₂ factor from a small static map (FR / DE / US / UK / EU avg / world avg / custom).

### 6.2 Server defaults section (existing, light refactor)

The existing tab content (PUE, electricity, CO₂ factor, server specs sliders) keeps its current shape but moves into `ServerDefaultsSection.tsx`. PUE / electricity / CO₂ inputs at this level become the "global fallback for any DC field that wasn't set" — the inline help text is updated to say so. They're written under `tenant_id='default'` key `'green'` as today.

### 6.3 Connections section (NEW, bottom)

`frontend/src/components/settings/green/ConnectionsGreenSection.tsx`.

Lists all `Connection` rows of `type='pve'`. Each row is a `<Accordion>`:

- Header: cluster name + small icon + count of nodes.
- Body:
  - Top sub-section "Cluster-level" — 4 inputs: DC dropdown (with "Inherit (Default)" option), TDP/core, RAM W/GB, overhead. All optional; placeholder text shows the current resolved value.
  - "Apply DC to all nodes" button — sets every node's `datacenter_id` to whatever the cluster has (saves cluster, wipes node-level DC overrides, refetches).
  - Sub-section "Per-node overrides" — small table, one row per node. Same 4 fields, all optional. Placeholder = "Inherit from cluster".

Skeleton state when fetching node list. Save button per cluster (debounced auto-save not worth the complexity for an admin tool).

## 7. Calculation refactor

### 7.1 `/api/v1/vdcs/[id]/green`

Currently: load provider settings once, sum per-VM with one PUE / one CO₂ factor.

After: for each VM in the vDC pool, read `g.node` from PVE response, call `resolveGreenConfigForNode(vdc.connectionId, g.node)`, apply per-node specs and PUE. CO₂ / cost computed with per-node `co2Factor` / `electricityPrice` (still no cost in tenant response, that bit stands).

`computeGreenMetricsForVms` in `lib/green/compute.ts` is extended to accept either a single global config (current behaviour, kept for back-compat) or a per-VM config callback. Internally it sums per-VM and aggregates.

### 7.2 `/api/v1/resources/overview`

Same idea, broader scope. The route iterates over all (connection, node) pairs already, so the change is local: replace the single `loadGreenSettings()` call with `resolveGreenConfigForNode(connId, node)` per node, then apply the resolved spec to that node's VMs / utilisation.

Result shape unchanged — single aggregate across DCs. A future iteration can add a `byDatacenter: { id, name, power, co2 }[]` field for per-DC breakdown.

## 8. Migration

Triggered on the first call to any green endpoint (cheap idempotent check):

1. If `datacenters` table is empty (or no row with `is_default=1`):
   - Read `settings WHERE key='green' AND tenant_id='default'`, parse JSON.
   - Insert one `datacenters` row with `name='Default'`, `is_default=1`, fields populated from the parsed JSON (or hard-coded defaults if no row).
2. Existing connections / nodes don't get rows in `connection_green_config` / `node_green_config` — they inherit the Default DC implicitly through the resolution chain.

Schema creation lives in `frontend/src/lib/db/sqlite.ts` `runMigrations()` (existing pattern for vDC tables).

## 9. RBAC

Admin endpoints under `/api/v1/admin/` use the `requireSuperAdmin` helper — same pattern as `/api/v1/admin/vdcs/[id]/pbs-bindings`. UI gating on the tab is unchanged (`providerOnly: true`).

## 10. Test plan

Unit:
- `resolveGreenConfigForNode` returns expected values for cluster-only / node-only / both / neither configurations.
- Field-level inheritance (node sets DC, cluster sets TDP, neither sets RAM W/GB → RAM W/GB falls to global).

Integration (browser):
- Two DCs configured (PUE 1.2 vs 1.8) → power figure on `/resources` differs.
- Tenant on `/my-vdc` sees CO₂ change when their cluster's assigned DC's `co2_factor` changes.
- Promote DC #2 to default → unrelated nodes inherit new defaults.
- Delete DC #1 while a node references it → 409 Conflict.

## 11. Out of scope (explicit)

- Tenant-scoped `/infrastructure/resources` filtering (Phase B).
- Server-model presets / catalogue.
- Live auto-detection of node specs.
- Per-DC breakdown UI tiles.
- Cost / billing implications of per-DC pricing — only the existing energy-cost figure changes.
- External hypervisor connections.

## 12. Files to add / modify

Backend:
- `frontend/src/lib/db/sqlite.ts` — 3 new `CREATE TABLE` statements + migration backfill block.
- `frontend/src/lib/db/datacenters.ts` — CRUD helpers for `datacenters`.
- `frontend/src/lib/db/greenConfig.ts` — CRUD for `connection_green_config` + `node_green_config`.
- `frontend/src/lib/green/resolve.ts` — `resolveGreenConfigForNode`.
- `frontend/src/lib/green/compute.ts` — extend `computeGreenMetricsForVms` to accept a per-VM config callback.
- `frontend/src/app/api/v1/admin/datacenters/route.ts` (+ `[id]/route.ts`).
- `frontend/src/app/api/v1/admin/connections/[id]/green-config/route.ts`.
- `frontend/src/app/api/v1/admin/connections/[id]/nodes/[node]/green-config/route.ts`.
- `frontend/src/app/api/v1/resources/overview/route.ts` — replace single `loadGreenSettings` with per-node resolution.
- `frontend/src/app/api/v1/vdcs/[id]/green/route.ts` — replace `loadGreenSettingsForProvider` with per-VM resolution.

Frontend:
- `frontend/src/components/settings/GreenTab.jsx` — split into 3 sections.
- `frontend/src/components/settings/green/DatacentersSection.tsx` + `DatacenterDialog.tsx`.
- `frontend/src/components/settings/green/ServerDefaultsSection.tsx` (refactor of existing content).
- `frontend/src/components/settings/green/ConnectionsGreenSection.tsx` + `ConnectionGreenAccordion.tsx`.
- i18n keys for the new labels in `frontend/src/messages/{fr,en,de,zh-CN}.json` under `settings.green.*`.
