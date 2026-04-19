# /my-vdc Cockpit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `/my-vdc` into the tenant cockpit — quota donuts + VMs + VNets + storages + uplinks in a 5-block grid — and redirect `/home` to it when the user has a vDC.

**Architecture:** Client-side detection of "vDC mode" via a new SWR hook. The menu's Dashboard entry swaps to Virtual Datacenter, `/home` redirects, and `MyVdcOverview` becomes a grid container composing four cards (existing `QuotaDonut` + `VnetList`, plus three new cards). All data comes from existing endpoints (`/api/v1/vdcs`, `/api/v1/inventory/stream`, `/api/v1/connections/[id]/storage`, `/api/v1/vdcs/[id]/shared-bridges`).

**Tech Stack:** Next.js 15, React 19, MUI, SWR, TypeScript, EventSource for inventory stream, next-intl.

**Spec:** `docs/superpowers/specs/2026-04-17-my-vdc-cockpit-design.md`

---

## File map

- **Create**
  - `frontend/src/hooks/useMyVdcs.ts`
  - `frontend/src/components/mydc/UplinksCard.tsx`
  - `frontend/src/components/mydc/MyVmsCard.tsx`
  - `frontend/src/components/mydc/MyStoragesCard.tsx`
- **Modify**
  - `frontend/src/components/mydc/MyVdcOverview.tsx` (grid container)
  - `frontend/src/components/mydc/VnetList.tsx` (tighter size, compact row limit)
  - `frontend/src/@menu/menuData.js` (conditional Dashboard / Virtual Datacenter)
  - `frontend/src/components/GenerateMenu.jsx` (honor `requires.hasVdc`)
  - `frontend/src/app/(dashboard)/home/page.jsx` (redirect to `/my-vdc` when hasVdc)
  - `frontend/src/messages/{en,fr,de,zh-CN}.json` (cockpit.* keys)

---

## Task 1: `useMyVdcs` hook

**Files:**
- Create: `frontend/src/hooks/useMyVdcs.ts`

- [ ] **Step 1: Create the hook**

```typescript
'use client'

import useSWR from 'swr'

interface VdcUsage {
  usedVcpus: number
  usedRamMb: number
  usedStorageMb: number
  usedVms: number
  lastSyncedAt: string | null
}

interface VdcQuota {
  maxVcpus: number | null
  maxRamMb: number | null
  maxStorageMb: number | null
  maxVms: number | null
  maxVnets: number | null
}

export interface MyVdc {
  id: string
  slug: string
  name: string
  description: string | null
  connectionId: string
  enabled: boolean
  nodes: string[]
  storages: string[]
  quota: VdcQuota | null
  usage: VdcUsage | null
  vnets?: unknown[]
}

const fetcher = async (url: string): Promise<MyVdc[]> => {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Failed to fetch vDCs (${res.status})`)
  const json = await res.json()
  return Array.isArray(json?.data) ? json.data : []
}

/**
 * Fetches the current tenant's vDCs. Drives the "vDC mode" flag used by the
 * menu and by the /home redirect, plus feeds the /my-vdc cockpit.
 *
 * SWR caches for 30 s and revalidates on focus so a freshly-allocated vDC
 * surfaces within seconds without manual refresh.
 */
export function useMyVdcs() {
  const { data, error, isLoading, mutate } = useSWR<MyVdc[]>(
    '/api/v1/vdcs',
    fetcher,
    {
      refreshInterval: 30_000,
      revalidateOnFocus: true,
      dedupingInterval: 5_000,
    }
  )

  const vdcs = data ?? []
  return {
    vdcs,
    hasVdc: vdcs.length > 0,
    loading: isLoading,
    error,
    mutate,
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `cd frontend && ./node_modules/.bin/tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/hooks/useMyVdcs.ts
git commit -m "feat(mydc): useMyVdcs SWR hook for vDC-mode detection"
```

---

## Task 2: Menu routing — `requires.hasVdc` gate

**Files:**
- Modify: `frontend/src/@menu/menuData.js`
- Modify: `frontend/src/components/GenerateMenu.jsx`

### Step 1: Split Dashboard into two conditional entries

- [ ] Open `frontend/src/@menu/menuData.js`. Locate the first entry:

```javascript
  {
    label: t('navigation.dashboard'),
    icon: 'ri-dashboard-line',
    href: '/home',
    // Accessible à tous les utilisateurs authentifiés
  },
```

Replace it with the two siblings below (keep the rest of the file unchanged):

```javascript
  {
    label: t('navigation.dashboard'),
    icon: 'ri-dashboard-line',
    href: '/home',
    requires: { hasVdc: false }, // provider / tenant-without-vdc landing
  },
  {
    label: t('navigation.myVdc'),
    icon: 'ri-cloud-line',
    href: '/my-vdc',
    permissions: ['sdn.vnet.view'],
    requires: { hasVdc: true }, // tenant cockpit
  },
```

Also remove the **existing** `/my-vdc` entry inside the `infrastructure` section further down (around line 24-29 of the current file). It's replaced by the top-level sibling above.

### Step 2: Wire `requires` into the menu filter

- [ ] Open `frontend/src/components/GenerateMenu.jsx`. At the top of each component that uses `useRBAC`, add the hook import and call:

```jsx
import { useMyVdcs } from '@/hooks/useMyVdcs'
```

Inside both `VerticalMenu` and `HorizontalMenu` functions (both already present in this file, see lines around 19 and 132), just after the existing `const { hasAnyPermission, loading } = useRBAC()`:

```jsx
const { hasVdc, loading: vdcLoading } = useMyVdcs()
```

Then augment the existing `canView` function:

```jsx
const canView = (item) => {
  if (loading || vdcLoading) return true // Afficher pendant le chargement
  if (item.requires?.hasVdc === true && !hasVdc) return false
  if (item.requires?.hasVdc === false && hasVdc) return false
  if (!item.permissions || item.permissions.length === 0) return true

  return hasAnyPermission(item.permissions)
}
```

(Apply to both `canView` definitions — one per sub-component.)

- [ ] **Step 3: Typecheck**

Run: `cd frontend && ./node_modules/.bin/tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Manual check**

Start the dev server (if not already) and:

1. Log in as a tenant with a vDC → menu shows **Virtual Datacenter**, no Dashboard.
2. Log in as super admin on `default` → menu shows **Dashboard**, no Virtual Datacenter.
3. Log in as a tenant without a vDC → menu shows **Dashboard**.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/@menu/menuData.js frontend/src/components/GenerateMenu.jsx
git commit -m "feat(mydc): conditional Dashboard vs Virtual Datacenter menu via requires.hasVdc"
```

---

## Task 3: `/home` redirect when hasVdc

**Files:**
- Modify: `frontend/src/app/(dashboard)/home/page.jsx`

- [ ] **Step 1: Add redirect effect**

Open the file and locate the top of the `HomePage` component (around line 28). Add this hook right after the existing hooks (below `useTranslations` / `usePageTitle` declarations, before any `useEffect` that sets page info):

```jsx
import { useRouter } from 'next/navigation'
import { useMyVdcs } from '@/hooks/useMyVdcs'
```

(Place imports near the other imports at the top of the file.)

Inside the component, add:

```jsx
  const router = useRouter()
  const { hasVdc, loading: vdcLoading } = useMyVdcs()

  useEffect(() => {
    if (!vdcLoading && hasVdc) {
      router.replace('/my-vdc')
    }
  }, [vdcLoading, hasVdc, router])
```

Then gate the widget grid render behind the loading check (find the return statement) to avoid flashing the widget grid before the redirect fires:

```jsx
  if (vdcLoading || hasVdc) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '60vh' }}>
        <CircularProgress />
      </Box>
    )
  }
```

If `CircularProgress` is not imported, add it to the existing `@mui/material` import line.

- [ ] **Step 2: Typecheck**

Run: `cd frontend && ./node_modules/.bin/tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Manual check**

1. Tenant with vDC → opens `/home` → gets redirected to `/my-vdc` (brief spinner, no widget flash).
2. Super admin or tenant without vDC → stays on `/home` with the widget grid.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/app/\(dashboard\)/home/page.jsx
git commit -m "feat(mydc): redirect /home to /my-vdc when tenant has a vDC"
```

---

## Task 4: `UplinksCard` — extract from MyVdcOverview

**Files:**
- Create: `frontend/src/components/mydc/UplinksCard.tsx`

- [ ] **Step 1: Create the component**

```tsx
'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'

import { Box, Chip, Paper, Typography } from '@mui/material'

interface SharedBridge {
  bridge: string
  label: string | null
}

interface Props {
  vdcId: string
}

/**
 * Uplinks card: provider-authorised shared bridges for this vDC. Read-only
 * for the tenant — the provider controls the list via the admin panel.
 */
export default function UplinksCard({ vdcId }: Props) {
  const t = useTranslations()
  const [bridges, setBridges] = useState<SharedBridge[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(false)
    ;(async () => {
      try {
        const res = await fetch(`/api/v1/vdcs/${encodeURIComponent(vdcId)}/shared-bridges`)
        if (!res.ok) throw new Error(String(res.status))
        const json = await res.json()
        if (!cancelled) setBridges(Array.isArray(json?.data) ? json.data : [])
      } catch {
        if (!cancelled) setError(true)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [vdcId])

  return (
    <Paper sx={{ p: 2 }} variant="outlined">
      <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 1.5, display: 'flex', alignItems: 'center', gap: 1 }}>
        <i className="ri-arrow-up-down-line" />
        {t('myVdc.cockpit.uplinksTitle')}
      </Typography>
      {loading ? (
        <Typography variant="caption" color="text.secondary">…</Typography>
      ) : error ? (
        <Typography variant="caption" color="error">{t('myVdc.cockpit.loadError')}</Typography>
      ) : bridges.length === 0 ? (
        <Typography variant="caption" color="text.secondary">{t('myVdc.noUplinks')}</Typography>
      ) : (
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75 }}>
          {bridges.map(b => (
            <Chip
              key={b.bridge}
              label={b.label ? `${b.bridge} — ${b.label}` : b.bridge}
              size="small"
              sx={{ fontFamily: 'monospace' }}
            />
          ))}
        </Box>
      )}
    </Paper>
  )
}
```

- [ ] **Step 2: Typecheck**

Run: `cd frontend && ./node_modules/.bin/tsc --noEmit`
Expected: no errors (will still be unused, but valid).

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/mydc/UplinksCard.tsx
git commit -m "feat(mydc): UplinksCard extracted from MyVdcOverview"
```

---

## Task 5: `MyStoragesCard`

**Files:**
- Create: `frontend/src/components/mydc/MyStoragesCard.tsx`

- [ ] **Step 1: Create the component**

```tsx
'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'

import { Box, Chip, LinearProgress, Paper, Stack, Typography } from '@mui/material'

interface StorageRow {
  id: string
  storage: string
  node?: string
  type: string
  usedFormatted: string
  totalFormatted: string
  usedPct: number
  content?: string[]
}

interface Props {
  /** The vDC's connection IDs; the card fetches the storage list for each. */
  connectionIds: string[]
  /** Storage names allowed by the vDC (subset filter). */
  allowedStorages: string[]
}

const storageIcon = (type: string) => {
  if (type === 'nfs' || type === 'cifs') return 'ri-folder-shared-fill'
  if (type === 'zfspool' || type === 'zfs') return 'ri-stack-fill'
  if (type === 'lvm' || type === 'lvmthin') return 'ri-hard-drive-2-fill'
  if (type === 'dir') return 'ri-folder-fill'
  return 'ri-hard-drive-fill'
}

const barColor = (pct: number): 'primary' | 'warning' | 'error' =>
  pct >= 90 ? 'error' : pct >= 70 ? 'warning' : 'primary'

/**
 * Storage card: usage bars for each storage assigned to the tenant's vDC.
 * Data source: /api/v1/connections/[id]/storage which is already tenant-scoped
 * (non-shared storages only, filtered to vDC allowlist).
 */
export default function MyStoragesCard({ connectionIds, allowedStorages }: Props) {
  const t = useTranslations()
  const [rows, setRows] = useState<StorageRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  useEffect(() => {
    if (connectionIds.length === 0) {
      setRows([])
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(false)
    const allow = new Set(allowedStorages)
    ;(async () => {
      try {
        const all: StorageRow[] = []
        for (const connId of connectionIds) {
          const res = await fetch(`/api/v1/connections/${encodeURIComponent(connId)}/storage`)
          if (!res.ok) continue
          const json = await res.json()
          const arr: StorageRow[] = Array.isArray(json?.data) ? json.data : []
          for (const r of arr) {
            if (allow.size === 0 || allow.has(r.storage)) all.push(r)
          }
        }
        if (!cancelled) setRows(all)
      } catch {
        if (!cancelled) setError(true)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [connectionIds, allowedStorages])

  return (
    <Paper sx={{ p: 2 }} variant="outlined">
      <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 1.5, display: 'flex', alignItems: 'center', gap: 1 }}>
        <i className="ri-hard-drive-2-line" />
        {t('myVdc.cockpit.storagesTitle')}
      </Typography>
      {loading ? (
        <Typography variant="caption" color="text.secondary">…</Typography>
      ) : error ? (
        <Typography variant="caption" color="error">{t('myVdc.cockpit.loadError')}</Typography>
      ) : rows.length === 0 ? (
        <Typography variant="caption" color="text.secondary">{t('myVdc.cockpit.noStorages')}</Typography>
      ) : (
        <Stack spacing={1.5}>
          {rows.map(r => (
            <Box key={r.id}>
              <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 0.5 }}>
                <Box component="i" className={storageIcon(r.type)} sx={{ fontSize: 16, opacity: 0.7 }} />
                <Typography variant="body2" sx={{ fontFamily: 'monospace', fontWeight: 500 }}>{r.storage}</Typography>
                <Chip label={r.type} size="small" sx={{ height: 18, fontSize: 10 }} />
                {r.node && <Typography variant="caption" color="text.secondary">— {r.node}</Typography>}
                <Box sx={{ flex: 1 }} />
                <Typography variant="caption" color="text.secondary">
                  {r.usedFormatted} / {r.totalFormatted} ({r.usedPct}%)
                </Typography>
              </Stack>
              <LinearProgress
                variant="determinate"
                value={Math.min(100, r.usedPct)}
                color={barColor(r.usedPct)}
                sx={{ height: 4, borderRadius: 2 }}
              />
            </Box>
          ))}
        </Stack>
      )}
    </Paper>
  )
}
```

- [ ] **Step 2: Typecheck**

Run: `cd frontend && ./node_modules/.bin/tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/mydc/MyStoragesCard.tsx
git commit -m "feat(mydc): MyStoragesCard with usage bars per vDC storage"
```

---

## Task 6: `MyVmsCard` — inventory stream subscriber

**Files:**
- Create: `frontend/src/components/mydc/MyVmsCard.tsx`

- [ ] **Step 1: Create the component**

```tsx
'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'

import { Box, Button, Chip, Paper, Stack, Typography } from '@mui/material'

interface Guest {
  vmid: number
  name: string
  type: 'qemu' | 'lxc'
  status: string
  node: string
  template?: boolean
  connId: string
}

interface Props {
  /** The vDC's connection IDs; the card subscribes to the inventory stream. */
  connectionIds: string[]
}

const statusIcon = (status: string, template?: boolean) => {
  if (template) return 'ri-file-copy-2-line'
  if (status === 'running') return 'ri-play-circle-fill'
  if (status === 'paused') return 'ri-pause-circle-fill'
  return 'ri-stop-circle-fill'
}

const statusColor = (status: string, template?: boolean): 'success' | 'warning' | 'default' => {
  if (template) return 'default'
  if (status === 'running') return 'success'
  if (status === 'paused') return 'warning'
  return 'default'
}

/**
 * VMs card: list of the tenant's guests (VMs and LXC) with status counters
 * and a top-5 quick view. Subscribes to /api/v1/inventory/stream which is
 * already tenant-scoped by vDC (nodes + pool).
 */
export default function MyVmsCard({ connectionIds }: Props) {
  const t = useTranslations()
  const router = useRouter()
  const [guests, setGuests] = useState<Guest[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    const accepted = new Set(connectionIds)
    const found: Guest[] = []
    const src = new EventSource('/api/v1/inventory/stream')

    const onCluster = (ev: MessageEvent) => {
      try {
        const cluster = JSON.parse(ev.data)
        if (!accepted.has(cluster.id)) return
        for (const n of cluster.nodes ?? []) {
          for (const g of n.guests ?? []) {
            found.push({
              vmid: g.vmid,
              name: g.name ?? String(g.vmid),
              type: g.type ?? 'qemu',
              status: g.status ?? 'unknown',
              node: n.node,
              template: !!g.template,
              connId: cluster.id,
            })
          }
        }
        setGuests([...found])
      } catch {}
    }

    const onDone = () => {
      setLoading(false)
      src.close()
    }

    src.addEventListener('cluster', onCluster)
    src.addEventListener('done', onDone)
    src.addEventListener('error', () => {
      setLoading(false)
      src.close()
    })

    return () => {
      src.removeEventListener('cluster', onCluster)
      src.removeEventListener('done', onDone)
      src.close()
    }
  }, [connectionIds])

  const counts = useMemo(() => {
    const c = { running: 0, stopped: 0, paused: 0, template: 0 }
    for (const g of guests) {
      if (g.template) c.template++
      else if (g.status === 'running') c.running++
      else if (g.status === 'paused') c.paused++
      else c.stopped++
    }
    return c
  }, [guests])

  const top = useMemo(() => {
    const sorted = [...guests].sort((a, b) => {
      const ar = a.status === 'running' ? 0 : 1
      const br = b.status === 'running' ? 0 : 1
      if (ar !== br) return ar - br
      return a.name.localeCompare(b.name)
    })
    return sorted.slice(0, 5)
  }, [guests])

  const goInventory = (g?: Guest) => {
    if (g) router.push(`/infrastructure/inventory?select=vm:${g.connId}:${g.node}:${g.type}:${g.vmid}`)
    else router.push('/infrastructure/inventory')
  }

  return (
    <Paper sx={{ p: 2 }} variant="outlined">
      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1.5 }}>
        <i className="ri-computer-line" />
        <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>{t('myVdc.cockpit.myVmsTitle')}</Typography>
        <Chip label={guests.length} size="small" sx={{ height: 20 }} />
      </Stack>

      {!loading && guests.length === 0 ? (
        <Stack alignItems="center" spacing={1} sx={{ py: 2 }}>
          <Typography variant="body2" color="text.secondary">{t('myVdc.cockpit.noVms')}</Typography>
          <Button size="small" variant="outlined" onClick={() => goInventory()} startIcon={<i className="ri-add-line" />}>
            {t('myVdc.cockpit.createVm')}
          </Button>
        </Stack>
      ) : (
        <>
          <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap sx={{ mb: 1.5 }}>
            <Chip size="small" color="success" icon={<i className="ri-play-circle-fill" />} label={`${counts.running} ${t('myVdc.cockpit.vmStatus.running')}`} />
            <Chip size="small" icon={<i className="ri-stop-circle-line" />} label={`${counts.stopped} ${t('myVdc.cockpit.vmStatus.stopped')}`} />
            {counts.paused > 0 && <Chip size="small" color="warning" icon={<i className="ri-pause-circle-fill" />} label={`${counts.paused} ${t('myVdc.cockpit.vmStatus.paused')}`} />}
            {counts.template > 0 && <Chip size="small" icon={<i className="ri-file-copy-2-line" />} label={`${counts.template} ${t('myVdc.cockpit.vmStatus.template')}`} />}
          </Stack>

          <Stack spacing={0.5}>
            {top.map(g => (
              <Box
                key={`${g.connId}:${g.vmid}`}
                onClick={() => goInventory(g)}
                sx={{
                  display: 'flex', alignItems: 'center', gap: 1,
                  px: 1, py: 0.5, borderRadius: 1,
                  cursor: 'pointer',
                  '&:hover': { bgcolor: 'action.hover' },
                }}
              >
                <Box component="i" className={statusIcon(g.status, g.template)} sx={{ fontSize: 14, color: `${statusColor(g.status, g.template)}.main` }} />
                <Typography variant="body2" sx={{ fontFamily: 'monospace', flex: 1 }}>{g.name}</Typography>
                <Chip label={g.node} size="small" sx={{ height: 18, fontSize: 10 }} variant="outlined" />
              </Box>
            ))}
          </Stack>

          {guests.length > 5 && (
            <Button size="small" onClick={() => goInventory()} sx={{ mt: 1 }}>
              {t('myVdc.cockpit.viewAllVms', { count: guests.length })}
            </Button>
          )}
        </>
      )}
    </Paper>
  )
}
```

- [ ] **Step 2: Typecheck**

Run: `cd frontend && ./node_modules/.bin/tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/mydc/MyVmsCard.tsx
git commit -m "feat(mydc): MyVmsCard — status counters + top 5 via inventory stream"
```

---

## Task 7: Refactor `MyVdcOverview` into grid container

**Files:**
- Modify: `frontend/src/components/mydc/MyVdcOverview.tsx`

- [ ] **Step 1: Replace the entire file**

Overwrite the file's contents with:

```tsx
'use client'

import { useTranslations } from 'next-intl'

import { Box, Paper, Typography } from '@mui/material'

import QuotaDonut from './QuotaDonut'
import UplinksCard from './UplinksCard'
import MyStoragesCard from './MyStoragesCard'
import MyVmsCard from './MyVmsCard'
import VnetList from './VnetList'

interface Props {
  vdc: any
}

/**
 * Tenant cockpit for a single vDC: quota donuts across the top, then a
 * 2-column grid (1 column on mobile) with VMs / VNets / Storages / Uplinks.
 * All data-fetching lives in the children; this file composes.
 */
export default function MyVdcOverview({ vdc }: Props) {
  const t = useTranslations()
  const usage = vdc.usage || {}
  const quota = vdc.quota || {}
  const unlimitedLabel = t('vdc.quotaUnlimited')
  const formatMbAsGb = (mb: number) => `${(mb / 1024).toFixed(1)} GB`

  const connectionIds: string[] = vdc.connectionId ? [vdc.connectionId] : []
  const allowedStorages: string[] = Array.isArray(vdc.storages) ? vdc.storages : []

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {/* Header */}
      <Box>
        <Typography variant="h6">{vdc.name}</Typography>
        {vdc.description && (
          <Typography variant="caption" color="text.secondary">{vdc.description}</Typography>
        )}
      </Box>

      {/* Block 1: Quota donuts */}
      <Paper sx={{ p: 2 }} variant="outlined">
        <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 1.5, display: 'flex', alignItems: 'center', gap: 1 }}>
          <i className="ri-gauge-line" />
          {t('myVdc.quotas')}
        </Typography>
        <Box
          sx={{
            display: 'grid',
            gap: 2,
            gridTemplateColumns: { xs: 'repeat(2, 1fr)', sm: 'repeat(4, 1fr)' },
            justifyItems: 'center',
          }}
        >
          <QuotaDonut icon="ri-cpu-line" label={t('vdc.maxVcpus')} used={usage.usedVcpus || 0} max={quota.maxVcpus} unlimitedLabel={unlimitedLabel} />
          <QuotaDonut
            icon="ri-ram-2-line"
            label={t('vdc.maxRam')}
            used={usage.usedRamMb || 0}
            max={quota.maxRamMb ?? null}
            formatValue={formatMbAsGb}
            unlimitedLabel={unlimitedLabel}
          />
          <QuotaDonut icon="ri-computer-line" label={t('vdc.maxVms')} used={usage.usedVms || 0} max={quota.maxVms} unlimitedLabel={unlimitedLabel} />
          <QuotaDonut icon="ri-git-branch-line" label={t('vdc.maxVnets')} used={(vdc.vnets || []).length} max={quota.maxVnets} unlimitedLabel={unlimitedLabel} />
        </Box>
      </Paper>

      {/* Blocks 2-5 in a 2x2 grid */}
      <Box
        sx={{
          display: 'grid',
          gap: 2,
          gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' },
        }}
      >
        <MyVmsCard connectionIds={connectionIds} />
        <Paper sx={{ p: 2 }} variant="outlined">
          <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 1.5, display: 'flex', alignItems: 'center', gap: 1 }}>
            <i className="ri-git-branch-line" />
            {t('myVdc.vnetsTitle')}
          </Typography>
          <VnetList vdcId={vdc.id} quota={{ maxVnets: quota.maxVnets ?? null }} />
        </Paper>
        <MyStoragesCard connectionIds={connectionIds} allowedStorages={allowedStorages} />
        <UplinksCard vdcId={vdc.id} />
      </Box>
    </Box>
  )
}
```

- [ ] **Step 2: Tighten `VnetList` row cap**

Open `frontend/src/components/mydc/VnetList.tsx`. The existing DataGrid has `autoHeight` + `pageSizeOptions=[10,25,50]`. Change `pageSizeOptions` to `[5, 10, 25]` and set `initialState={{ pagination: { paginationModel: { pageSize: 5 } } }}` so the compact card shows 5 rows by default:

```tsx
      <DataGrid
        rows={rows}
        columns={columns}
        getRowId={(r) => r.id}
        loading={loading}
        disableRowSelectionOnClick
        autoHeight
        density="compact"
        rowHeight={38}
        columnHeaderHeight={40}
        pageSizeOptions={[5, 10, 25]}
        initialState={{ pagination: { paginationModel: { pageSize: 5 } } }}
        sx={{
          '& .MuiDataGrid-cell': {
            display: 'flex',
            alignItems: 'center',
            fontSize: '0.8125rem',
          },
          '& .MuiDataGrid-columnHeaderTitle': {
            fontSize: '0.75rem',
            fontWeight: 600,
          },
        }}
      />
```

Also the `<Stack direction="row" justifyContent="space-between">` header at the top of `VnetList` becomes redundant now that the parent Paper has its own header. Keep only the Create button + quota counter; delete the `<Typography variant="h6">` line:

```tsx
      <Stack direction="row" justifyContent="flex-end" alignItems="center" mb={2}>
        <Button
          variant="contained"
          startIcon={<i className="ri-add-line" />}
          disabled={quotaReached}
          onClick={() => setCreateOpen(true)}
        >
          {t('myVdc.createVnet')}
        </Button>
      </Stack>
```

- [ ] **Step 3: Typecheck**

Run: `cd frontend && ./node_modules/.bin/tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/mydc/MyVdcOverview.tsx frontend/src/components/mydc/VnetList.tsx
git commit -m "feat(mydc): MyVdcOverview grid container composing 5 cockpit blocks"
```

---

## Task 8: i18n — add `myVdc.cockpit.*` keys to 4 locales

**Files:**
- Modify: `frontend/src/messages/en.json`
- Modify: `frontend/src/messages/fr.json`
- Modify: `frontend/src/messages/de.json`
- Modify: `frontend/src/messages/zh-CN.json`

For each locale, find the closing `}` of the `myVdc` block (just before `deleteVnetHint` → `}`), and insert the new `cockpit` subtree as a sibling. The value of the existing `deleteVnetHint` key must gain a trailing comma.

### Step 1: en.json

- [ ] Open `frontend/src/messages/en.json`, locate the `myVdc` block (search for `"myVdc": {`), and replace the final `"deleteVnetHint": "..."` line with:

```json
    "deleteVnetHint": "The VNet must have no NIC attached. If VMs are still using it, the delete will be rejected.",
    "cockpit": {
      "myVmsTitle": "My VMs",
      "viewAllVms": "View all {count} VMs →",
      "createVm": "Create a VM",
      "noVms": "No VM yet.",
      "vmStatus": {
        "running": "running",
        "stopped": "stopped",
        "paused": "paused",
        "template": "templates"
      },
      "storagesTitle": "My storages",
      "storageUsage": "{used} / {total}",
      "noStorages": "No storage assigned to this vDC.",
      "uplinksTitle": "Provider uplinks",
      "loadError": "Load failed"
    }
```

### Step 2: fr.json

- [ ] Same operation on `frontend/src/messages/fr.json`:

```json
    "deleteVnetHint": "Le VNet ne doit plus avoir de NIC attachée. Si des VMs l'utilisent encore, la suppression sera rejetée.",
    "cockpit": {
      "myVmsTitle": "Mes VMs",
      "viewAllVms": "Voir toutes les {count} VMs →",
      "createVm": "Créer une VM",
      "noVms": "Aucune VM pour l'instant.",
      "vmStatus": {
        "running": "en cours",
        "stopped": "arrêtées",
        "paused": "suspendues",
        "template": "modèles"
      },
      "storagesTitle": "Mes stockages",
      "storageUsage": "{used} / {total}",
      "noStorages": "Aucun stockage assigné à ce vDC.",
      "uplinksTitle": "Uplinks provider",
      "loadError": "Échec du chargement"
    }
```

### Step 3: de.json

- [ ] Same operation on `frontend/src/messages/de.json`:

```json
    "deleteVnetHint": "Das VNet darf keine NIC angebunden haben. Wenn es noch von VMs verwendet wird, wird die Löschung abgelehnt.",
    "cockpit": {
      "myVmsTitle": "Meine VMs",
      "viewAllVms": "Alle {count} VMs anzeigen →",
      "createVm": "VM erstellen",
      "noVms": "Noch keine VM.",
      "vmStatus": {
        "running": "laufend",
        "stopped": "gestoppt",
        "paused": "pausiert",
        "template": "Vorlagen"
      },
      "storagesTitle": "Meine Speicher",
      "storageUsage": "{used} / {total}",
      "noStorages": "Diesem vDC ist kein Speicher zugewiesen.",
      "uplinksTitle": "Provider-Uplinks",
      "loadError": "Laden fehlgeschlagen"
    }
```

### Step 4: zh-CN.json

- [ ] Same operation on `frontend/src/messages/zh-CN.json`:

```json
    "deleteVnetHint": "VNet 不能连接任何 NIC。如果仍有 VM 使用它，删除将被拒绝。",
    "cockpit": {
      "myVmsTitle": "我的虚拟机",
      "viewAllVms": "查看全部 {count} 台虚拟机 →",
      "createVm": "创建虚拟机",
      "noVms": "暂无虚拟机。",
      "vmStatus": {
        "running": "运行中",
        "stopped": "已停止",
        "paused": "已暂停",
        "template": "模板"
      },
      "storagesTitle": "我的存储",
      "storageUsage": "{used} / {total}",
      "noStorages": "此 vDC 未分配存储。",
      "uplinksTitle": "提供商上行链路",
      "loadError": "加载失败"
    }
```

### Step 5: Validate JSON + typecheck

- [ ] Run:

```bash
for f in en fr de zh-CN; do
  python3 -c "import json; json.load(open('frontend/src/messages/$f.json')); print('$f OK')"
done
cd frontend && ./node_modules/.bin/tsc --noEmit
```

Expected: all JSONs OK, no TS errors.

### Step 6: Commit

- [ ] ```bash
git add frontend/src/messages/{en,fr,de,zh-CN}.json
git commit -m "i18n(mydc): cockpit block keys in 4 locales"
```

---

## Task 9: Manual acceptance test

- [ ] **Step 1: Run the dev server**

```bash
cd frontend && npm run dev
```

Wait for the server to be ready.

- [ ] **Step 2: Tenant-with-vDC scenario**

1. Log in as a tenant admin whose tenant has at least one vDC.
2. Verify the menu shows **Virtual Datacenter** (no Dashboard item).
3. Browsing to `/home` redirects to `/my-vdc`.
4. On `/my-vdc`, the page shows: a header with the vDC name, the quota donuts, then a 2×2 grid: My VMs / My VNets / My Storages / Uplinks.
5. If the tenant has VMs: counters match inventory counts, top 5 rows clickable, clicking a row navigates to `/infrastructure/inventory?select=vm:...`.
6. If the tenant has no VM: empty state + "Create a VM" button visible.
7. My Storages lists the vDC's non-shared storages with correct usage bars.
8. Uplinks lists the shared bridges or shows the "no uplinks" message.
9. VNet create/edit/delete inside the card still works, no regression.

- [ ] **Step 3: Tenant-without-vDC scenario**

1. Log in as a tenant admin whose tenant has no vDC.
2. Menu shows **Dashboard**.
3. `/home` stays on the widget grid (no redirect).
4. `/my-vdc` (if typed manually) behaves as before (existing empty-vdc handling).

- [ ] **Step 4: Super admin on `default`**

1. Log in as the super admin on the provider tenant.
2. Menu shows **Dashboard**, no Virtual Datacenter.
3. `/home` renders the widget grid unchanged.
4. Switching to a client tenant (e.g. `NEW-MSP`) flips the menu to Virtual Datacenter and `/home` redirects — same behaviour as a tenant admin.

- [ ] **Step 5: Commit (if any adjustments were needed)**

If Task 9 surfaced a fix, commit it with a descriptive message. Otherwise nothing to commit.

---

## Self-review notes

- **Spec coverage:** Routing/menu (Task 2 + 3), 5 blocks (Tasks 4-7), i18n (Task 8), manual test pass (Task 9). All spec success criteria covered.
- **No new endpoint:** confirmed, all data comes from existing APIs.
- **Types consistent:** `MyVdc.connectionId` (camelCase) matches the `listVdcs` return shape in `lib/vdc/index.ts:33`. `useMyVdcs.hasVdc` is consumed identically in `GenerateMenu` and `/home/page.jsx`. Card props (`connectionIds`, `allowedStorages`, `vdcId`) match what `MyVdcOverview` passes.
- **No placeholders:** every step shows actual code or exact commands with expected output.
- **Commits:** one per task, descriptive messages aligned with existing repo convention.
