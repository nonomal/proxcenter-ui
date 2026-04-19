# /my-vdc Cockpit — Design Spec

**Status:** Draft
**Date:** 2026-04-17
**Author:** ProxCenter MSP team

## Context

Today `/my-vdc` is a minimal tenant page: quota donuts, plaintext lists of
nodes/storages/uplinks, and a VNet CRUD table. `/home` (the default landing)
shows `WidgetGrid`, whose widgets are all provider-level — a tenant opens the
app and sees nothing useful.

The goal is to turn `/my-vdc` into the tenant's cockpit: a synthetic inventory
of everything they have, readable at a glance, with drill-down to existing
detail pages. `/home` is redirected to `/my-vdc` for tenants that own at least
one vDC; super admins on the provider tenant keep their customisable widget
dashboard unchanged.

## Success criteria

- A tenant with a vDC opens the app and immediately sees quotas, their VMs,
  their VNets, their storages, and their uplinks on a single page.
- Each inventory block offers a drill-down to the existing detailed view
  (inventory tree, VNet edit dialog).
- The routing change is scoped: super admins on `default` see no change;
  tenants without a vDC (not yet allocated) keep seeing `/home`.
- No new backend endpoint needed — existing APIs are sufficient.
- Four-language i18n (en/fr/de/zh-CN) from the start.

## Non-goals

- Custom widget layout per tenant (drag/drop, pinning). If needed later the
  current `WidgetGrid` can be recycled — out of scope for v1.
- Historical trends / sparklines (time series). Capacity planning is another
  job; may follow later.
- Alerts / health scoring. Out of scope.
- Cost estimation. Out of scope.
- vDC creation/editing — still a provider admin operation, unchanged.

## Routing & menu changes

### Rule

A user is in **"vDC mode"** when `GET /api/v1/vdcs` returns at least one vDC.
In that mode, the landing page and the top menu entry change from Dashboard to
Virtual Datacenter. Anyone not in vDC mode (super admin on `default`, tenant
without a vDC) sees the current behaviour.

### Implementation

- New SWR hook `useMyVdcs()` in `src/hooks/useMyVdcs.ts`:
  - Calls `/api/v1/vdcs` (already tenant-scoped)
  - 30 s refresh interval, revalidate on focus
  - Returns `{ vdcs, loading, error, hasVdc: vdcs.length > 0 }`
- `src/@menu/menuData.js`:
  - Split the current Dashboard item into two siblings:
    `{ href: '/home', requires: { noVdc: true } }` and
    `{ href: '/my-vdc', requires: { hasVdc: true } }`.
  - The `requires` field is a new key consumed by `GenerateMenu.jsx`.
- `src/components/GenerateMenu.jsx`:
  - Reads `useMyVdcs().hasVdc`.
  - Skips items whose `requires.hasVdc` mismatches the user's state.
  - Existing `permissions` + `requiredFeature` gates are untouched.
- `src/app/(dashboard)/home/page.jsx`:
  - `useEffect`: if `!loading && hasVdc`, `router.replace('/my-vdc')`.
  - A brief loading state shows a `CircularProgress` during the initial fetch
    to avoid a flash of empty widget grid before redirect.

During the SWR's first load (no cache), both menu entries would be skipped
because `loading === true`. To avoid a flicker, the menu falls back to the
cached Dashboard entry while loading (nothing breaks — user can still
navigate). Once loaded, the item swaps.

## `/my-vdc` layout

Five blocks in a responsive CSS grid (`md+` 2-column, `sm` 1-column):

```
┌─────────────────────────────────────────────────────────────┐
│  Block 1: Quota donuts (full width)                         │
├─────────────────────────────┬───────────────────────────────┤
│  Block 2: My VMs            │  Block 3: My VNets            │
├─────────────────────────────┼───────────────────────────────┤
│  Block 4: Storages          │  Block 5: Uplinks             │
└─────────────────────────────┴───────────────────────────────┘
```

The existing vDC selector (when a tenant has multiple vDCs) stays above the
grid and updates all blocks on change.

### Block 1 — Quota donuts (kept, already in place)

No change. Reuses `QuotaDonut` with projected=current (no `requested` prop).

### Block 2 — My VMs (new)

Compact card in `src/components/mydc/MyVmsCard.tsx`.

Data source: existing `/api/v1/inventory/stream` (already vDC-scoped, sends
cluster + node + guest events). Hook subscribes to the stream on mount,
disconnects on unmount. Falls back to an empty state if the stream completes
with no guests.

Card content:

- Header: "Mes VMs (N)"
- Status counters: `● 3 running   ■ 2 stopped   ⏸ 1 paused   📋 0 template`
  (icons with distinct colours, Chip layout, clickable → filters the list).
- Top 5 VMs below, sorted by most recent `lastSeen` or boot time. Each row:
  OS icon, name (monospace), status chip, `pveX` node chip.
- Footer: "Voir toutes les VMs ({count}) →" — links to
  `/infrastructure/inventory` (which is already filtered to vDC scope).
- Empty state: icon + message "Aucune VM" + button "Créer une VM" opening
  the existing `CreateVmDialog`.

### Block 3 — My VNets (existing, moved)

The current `VnetList.tsx` moves into this card. Changes:

- Compact size (max 5 rows visible; above that, "Voir tout (N) →" overflow).
- Header "Mes VNets" + the existing "Create VNet" button (+ quota counter).
- Edit/delete icons remain per row.
- Creation/edit/delete dialogs unchanged.

### Block 4 — Storages (new)

Card in `src/components/mydc/MyStoragesCard.tsx`.

Data source: `GET /api/v1/connections/[id]/storage` for each of the vDC's
connections (already tenant-scoped and vDC-filtered, already drops shared
pools in tenant context). Hook: SWR, 30 s refresh.

Card content:

- Header "Mes stockages"
- One row per storage:
  - Icon (dir/zfs/lvm), name (monospace), type chip
  - Horizontal progress bar (same colour scheme as donuts: blue/orange/red
    by threshold)
  - `32.0 GB / 100.0 GB` caption
- Empty state: "Aucun stockage". No create button (provider operation).

### Block 5 — Uplinks (existing, moved)

The chips from the current `MyVdcOverview` move into their own card header +
chip container. No logic change.

## Component tree

```
/my-vdc/page.tsx                (existing, chooses vdcs)
└── MyVdcOverview.tsx           (refactored: becomes grid container)
    ├── QuotaDonut × 4          (Block 1, existing)
    ├── MyVmsCard                (Block 2, NEW)
    ├── VnetList                 (Block 3, existing, moved)
    ├── MyStoragesCard           (Block 4, NEW)
    └── UplinksCard              (Block 5, NEW — extract from current Overview)
```

New files:

- `src/components/mydc/MyVmsCard.tsx`
- `src/components/mydc/MyStoragesCard.tsx`
- `src/components/mydc/UplinksCard.tsx`
- `src/hooks/useMyVdcs.ts`

Refactored: `src/components/mydc/MyVdcOverview.tsx` (container grid). `VnetList`
and `QuotaDonut` reused as-is.

## Data flow

1. Page mounts → fetches `/api/v1/vdcs` (cached via `useMyVdcs`).
2. User picks a vDC (or it's the only one). `selectedVdcId` propagates down.
3. Each card fetches what it needs from existing endpoints; no shared state
   besides `selectedVdcId`.
4. Mutations (VNet create/delete) use the existing APIs; cards revalidate via
   SWR `mutate()` or reconnect the inventory stream when relevant.

## Error handling

- Per-card isolation: if one card's fetch fails, the others still render.
  Failed card shows `<Alert severity="warning">Impossible de charger …</Alert>`
  with a retry button.
- Stream disconnect on `MyVmsCard`: automatic reconnect (existing hook
  pattern in `InventoryTree`).
- Redirect flow on `/home`: if `/api/v1/vdcs` fails during the initial fetch,
  stay on `/home` (safe default) and show the widget grid.

## i18n

New keys under `myVdc.*`:

- `cockpit.myVmsTitle`, `cockpit.viewAllVms`, `cockpit.vmStatus.running/stopped/paused/template`
- `cockpit.storageUsage`
- `cockpit.uplinksTitle`
- `cockpit.noVms`, `cockpit.noStorages`
- `cockpit.createVm`, `cockpit.loadError`

Added to all four locales (en/fr/de/zh-CN) at the time the code lands.

## Testing

- **Manual UI**:
  - Tenant with vDC (pve1+pve2 nodes, 1 local storage): menu shows "Virtual
    Datacenter", `/home` redirects, all five blocks render with correct data.
  - Tenant with 0 VM / 0 VNet: empty states render with correct CTAs.
  - Tenant without a vDC: `/home` stays, menu shows "Dashboard".
  - Super admin on `default`: no change.
- **Regression**:
  - VM create from the empty-state button still respects the quota pre-check.
  - VNet create/edit/delete still works from the compact card.
  - SWR revalidation after VNet create → new row appears without manual
    refresh (already works via `VnetList.reload`).

## Migration / rollout

- Additive feature, zero migration needed.
- No backend schema change.
- No breaking change for existing users: the redirect only kicks in when the
  user has a vDC (tenant scenario). Super admins on `default` keep their
  dashboard.

## Open questions

None blocking. Future iterations could add:

- Quota trends (sparklines)
- Per-tenant widget customisation on top of the cockpit
- Health / SLA score card

These are out of scope for v1.
