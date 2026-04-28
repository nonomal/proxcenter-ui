'use client'

import { useState, useEffect, useCallback } from 'react'

import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Card,
  CardContent,
  Checkbox,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControlLabel,
  IconButton,
  LinearProgress,
  Stack,
  Switch,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material'

import { DataGrid, type GridColDef } from '@mui/x-data-grid'

import { useTranslations } from 'next-intl'

import VdcPbsBindingsSection from './VdcPbsBindingsSection'
import QuotaDonut from '@/components/mydc/QuotaDonut'
import { NodeIcon } from '@/app/(dashboard)/infrastructure/inventory/components/TreeIcons'

interface VdcFormState {
  name: string
  slug: string
  description: string
  tenantId: string
  connectionId: string
  nodes: string[]
  storages: string[]
  maxVcpus: string
  maxRamGb: string
  maxStorageGb: string
  maxVms: string
  maxSnapshots: string
  maxBackups: string
  maxVnets: string
  unlimitedVcpus: boolean
  unlimitedRam: boolean
  unlimitedStorage: boolean
  unlimitedVms: boolean
  unlimitedSnapshots: boolean
  unlimitedBackups: boolean
}

const emptyForm: VdcFormState = {
  name: '',
  slug: '',
  description: '',
  tenantId: '',
  connectionId: '',
  nodes: [],
  storages: [],
  maxVcpus: '',
  maxRamGb: '',
  maxStorageGb: '',
  maxVms: '',
  maxSnapshots: '',
  maxBackups: '',
  maxVnets: '',
  unlimitedVcpus: true,
  unlimitedRam: true,
  unlimitedStorage: true,
  unlimitedVms: true,
  unlimitedSnapshots: true,
  unlimitedBackups: true,
}

// Translates an ISO timestamp into a localized "3m ago" / "2h ago" / "5d ago"
// using the existing time.* keys, so we don't ship a new dependency.
function formatRelative(iso: string | null | undefined, t: (k: string, p?: any) => string): string {
  if (!iso) return ''
  const ts = Date.parse(iso)
  if (Number.isNaN(ts)) return ''
  const diff = Date.now() - ts
  if (diff < 60_000) return t('time.justNow')
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 60) return t('time.minutesAgo', { count: minutes })
  const hours = Math.floor(diff / 3_600_000)
  if (hours < 24) return t('time.hoursAgo', { count: hours })
  const days = Math.floor(diff / 86_400_000)
  return t('time.daysAgo', { count: days })
}

export default function VdcTab() {
  const t = useTranslations()

  // Data
  const [vdcs, setVdcs] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  // Dialog
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingVdc, setEditingVdc] = useState<any>(null)
  const [saving, setSaving] = useState(false)

  // Form
  const [form, setForm] = useState<VdcFormState>(emptyForm)

  // Available resources (loaded when connection selected)
  const [availableResources, setAvailableResources] = useState<any>(null)
  const [resourcesLoading, setResourcesLoading] = useState(false)

  // Dropdowns
  const [tenants, setTenants] = useState<any[]>([])
  const [connections, setConnections] = useState<any[]>([])

  // Delete confirmation
  const [deleteVdc, setDeleteVdc] = useState<any>(null)

  // Shared bridges (SDN)
  const [providerBridges, setProviderBridges] = useState<Array<{ iface: string; nodes: string[]; type: string }>>([])
  const [selectedSharedBridges, setSelectedSharedBridges] = useState<Map<string, string>>(new Map())

  // PBS bindings (inline in the edit dialog, below Nodes)
  const [pbsConnections, setPbsConnections] = useState<Array<{ id: string; name: string; fingerprint: string | null }>>([])

  // Node statuses keyed `${connectionId}|${nodeName}` -> 'online' | 'offline' | …
  // Populated once vDCs are loaded by hitting available-resources for each
  // distinct connection. Used to render the status pastille in the Nodes cell.
  const [nodeStatuses, setNodeStatuses] = useState<Record<string, string>>({})

  // Auto-clear success after 5s
  useEffect(() => {
    if (!success) return
    const timer = setTimeout(() => setSuccess(''), 5000)
    return () => clearTimeout(timer)
  }, [success])

  // ------- Data loading -------

  const fetchVdcs = useCallback(async () => {
    setLoading(true)

    try {
      const res = await fetch('/api/v1/admin/vdcs')

      if (!res.ok) throw new Error(`HTTP ${res.status}`)

      const data = await res.json()

      setVdcs(data.data || [])
    } catch {
      setError(t('vdc.failedLoad'))
    } finally {
      setLoading(false)
    }
  }, [t])

  const fetchDropdowns = useCallback(async () => {
    try {
      const [tenantsRes, connectionsRes] = await Promise.all([
        fetch('/api/v1/tenants'),
        fetch('/api/v1/admin/connections?type=pve'),
      ])

      const tenantsData = await tenantsRes.json()
      const connectionsData = await connectionsRes.json()

      setTenants(tenantsData.data || [])
      setConnections((connectionsData.data || []).filter((c: any) => c.type === 'pve'))
    } catch {
      // Non-critical, dropdowns just won't populate
    }
  }, [])

  useEffect(() => {
    fetchVdcs()
    fetchDropdowns()
  }, [fetchVdcs, fetchDropdowns])

  // After vDCs are loaded, resolve each distinct connection's node statuses
  // so the Nodes cell can display the online/offline pastille.
  useEffect(() => {
    if (vdcs.length === 0) return
    const connIds = Array.from(new Set(vdcs.map((v: any) => v.connectionId).filter(Boolean)))
    if (connIds.length === 0) return
    let cancelled = false

    void (async () => {
      const results = await Promise.all(connIds.map(async (cid) => {
        try {
          const r = await fetch(`/api/v1/admin/connections/${encodeURIComponent(cid)}/available-resources`)
          if (!r.ok) return null
          const j = await r.json()
          const ns = j?.data?.nodes ?? []
          return { cid, nodes: Array.isArray(ns) ? ns : [] }
        } catch {
          return null
        }
      }))
      if (cancelled) return
      const statuses: Record<string, string> = {}
      for (const r of results) {
        if (!r) continue
        for (const n of r.nodes as Array<{ name: string; status?: string }>) {
          if (n?.name) statuses[`${r.cid}|${n.name}`] = n.status || 'unknown'
        }
      }
      setNodeStatuses(statuses)
    })()

    return () => { cancelled = true }
  }, [vdcs])

  useEffect(() => {
    ;(async () => {
      const r = await fetch('/api/v1/admin/connections?type=pbs')
      if (r.ok) {
        const j = await r.json()
        setPbsConnections((j.data ?? []).map((c: any) => ({ id: c.id, name: c.name, fingerprint: c.fingerprint ?? null })))
      }
    })()
  }, [])

  // Fetch available resources when connectionId changes
  useEffect(() => {
    if (!form.connectionId) {
      setAvailableResources(null)
      return
    }

    let cancelled = false

    const fetchResources = async () => {
      setResourcesLoading(true)

      try {
        // Pass vdcId when editing so the route only hides PBS storages
        // bound to OTHER vDCs and keeps the current vDC's own visible.
        const url = editingVdc
          ? `/api/v1/admin/connections/${form.connectionId}/available-resources?vdcId=${encodeURIComponent(editingVdc.id)}`
          : `/api/v1/admin/connections/${form.connectionId}/available-resources`
        const res = await fetch(url)

        if (!res.ok) throw new Error(`HTTP ${res.status}`)

        const data = await res.json()

        if (!cancelled) {
          const resources = data.data || null
          setAvailableResources(resources)
          // Auto-embed all nodes + all storages of the cluster into the
          // form when creating. The granular pickers used to drive these
          // arrays via checkboxes; now the UI just shows the cluster's
          // contents informationally and we send everything to the API.
          // Edit mode keeps the existing values so the caller can still
          // tighten the scope manually if they ever need to.
          if (!editingVdc && resources) {
            setForm((f) => ({
              ...f,
              nodes: (resources.nodes || []).map((n: any) => n.name).filter(Boolean),
              storages: (resources.storages || []).map((s: any) => s.id).filter(Boolean),
            }))
          }
        }
      } catch {
        if (!cancelled) {
          setAvailableResources(null)
        }
      } finally {
        if (!cancelled) {
          setResourcesLoading(false)
        }
      }
    }

    fetchResources()

    return () => { cancelled = true }
  }, [form.connectionId, editingVdc?.id])

  // Fetch provider bridges when connectionId changes
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

  // ------- Helpers -------

  const getConnectionName = (connectionId: string) => {
    const conn = connections.find((c) => c.id === connectionId)
    return conn?.name || connectionId
  }

  const getTenantSlug = (tenantId: string) => {
    const tenant = tenants.find((t) => t.id === tenantId)
    return tenant?.slug || ''
  }

  // Slug derivation. The user no longer types the slug — it's a fully
  // computed value from (tenant, connection). Including the connection
  // distinguishes a tenant's vDCs across clusters and avoids the
  // (tenant_id, slug) UNIQUE conflict that would otherwise hit on the
  // second vDC. Falls back to the tenant slug only when the connection
  // hasn't been picked yet, so the form's "Save" disabled check stays
  // meaningful before all fields are filled.
  const sluggify = (s: string): string =>
    String(s || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')

  const computeVdcSlug = (tenant: any | null, connectionId: string): string => {
    if (!tenant) return ''
    const tSlug = sluggify(tenant.slug || tenant.name || tenant.id || '')
    const conn = connections.find((c) => c.id === connectionId)
    const cSlug = conn ? sluggify(conn.name || conn.id || '') : ''
    return cSlug ? `${tSlug}-${cSlug}` : tSlug
  }

  // ------- Handlers -------

  const handleCreate = () => {
    setEditingVdc(null)
    setForm(emptyForm)
    setAvailableResources(null)
    setSelectedSharedBridges(new Map())
    setDialogOpen(true)
  }

  const handleEdit = (vdc: any) => {
    setEditingVdc(vdc)
    setForm({
      name: vdc.name,
      slug: vdc.slug,
      description: vdc.description || '',
      tenantId: vdc.tenantId,
      connectionId: vdc.connectionId,
      nodes: vdc.nodes,
      storages: vdc.storages,
      maxVcpus: vdc.quota?.maxVcpus ? String(vdc.quota.maxVcpus) : '',
      maxRamGb: vdc.quota?.maxRamMb ? String(Math.round(vdc.quota.maxRamMb / 1024)) : '',
      maxStorageGb: vdc.quota?.maxStorageMb ? String(Math.round(vdc.quota.maxStorageMb / 1024)) : '',
      maxVms: vdc.quota?.maxVms ? String(vdc.quota.maxVms) : '',
      maxSnapshots: vdc.quota?.maxSnapshots ? String(vdc.quota.maxSnapshots) : '',
      maxBackups: vdc.quota?.maxBackups ? String(vdc.quota.maxBackups) : '',
      maxVnets: vdc.quota?.maxVnets ? String(vdc.quota.maxVnets) : '',
      unlimitedVcpus: vdc.quota?.maxVcpus == null,
      unlimitedRam: vdc.quota?.maxRamMb == null,
      unlimitedStorage: vdc.quota?.maxStorageMb == null,
      unlimitedVms: vdc.quota?.maxVms == null,
      unlimitedSnapshots: vdc.quota?.maxSnapshots == null,
      unlimitedBackups: vdc.quota?.maxBackups == null,
    })

    if (vdc.sharedBridges?.length) {
      const map = new Map<string, string>()
      for (const sb of vdc.sharedBridges) {
        map.set(sb.bridge, sb.label ?? '')
      }
      setSelectedSharedBridges(map)
    } else {
      setSelectedSharedBridges(new Map())
    }

    setDialogOpen(true)
  }

  const handleSave = async () => {
    setSaving(true)
    setError('')

    try {
      // Build quota object
      const quota: any = {}

      if (!form.unlimitedVcpus && form.maxVcpus) quota.maxVcpus = parseInt(form.maxVcpus)
      if (!form.unlimitedRam && form.maxRamGb) quota.maxRamMb = parseInt(form.maxRamGb) * 1024
      if (!form.unlimitedStorage && form.maxStorageGb) quota.maxStorageMb = parseInt(form.maxStorageGb) * 1024
      if (!form.unlimitedVms && form.maxVms) quota.maxVms = parseInt(form.maxVms)
      if (!form.unlimitedSnapshots && form.maxSnapshots) quota.maxSnapshots = parseInt(form.maxSnapshots)
      if (!form.unlimitedBackups && form.maxBackups) quota.maxBackups = parseInt(form.maxBackups)
      if (form.maxVnets) quota.maxVnets = parseInt(form.maxVnets)

      // For unlimited fields, explicitly set null so the backend clears them
      if (form.unlimitedVcpus) quota.maxVcpus = null
      if (form.unlimitedRam) quota.maxRamMb = null
      if (form.unlimitedStorage) quota.maxStorageMb = null
      if (form.unlimitedVms) quota.maxVms = null
      if (form.unlimitedSnapshots) quota.maxSnapshots = null
      if (form.unlimitedBackups) quota.maxBackups = null

      const sharedBridgesPayload = Array.from(selectedSharedBridges.entries()).map(([bridge, label]) => ({
        bridge,
        label: label.trim() || undefined,
      }))

      // Snapshot nodes/storages from the live resources at submit time.
      // form.nodes/form.storages get auto-filled by the resources fetch
      // useEffect, but a race (slow PVE, fetch retry, user clicking
      // Submit right after Connection select) can leave them empty —
      // backend then 400s on "nodes must be a non-empty array". Reading
      // straight from availableResources here closes that window.
      const liveNodes = (availableResources?.nodes || [])
        .map((n: any) => n.name)
        .filter(Boolean)
      const liveStorages = (availableResources?.storages || [])
        .map((s: any) => s.id)
        .filter(Boolean)
      const nodesPayload = (editingVdc ? form.nodes : (form.nodes.length > 0 ? form.nodes : liveNodes))
      const storagesPayload = (editingVdc ? form.storages : (form.storages.length > 0 ? form.storages : liveStorages))

      if (editingVdc) {
        // PUT - update
        const body: any = {
          name: form.name,
          description: form.description || undefined,
          nodes: nodesPayload,
          storages: storagesPayload,
          sharedBridges: sharedBridgesPayload,
          quota,
        }

        const res = await fetch(`/api/v1/admin/vdcs/${editingVdc.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })

        if (!res.ok) {
          const err = await res.json().catch(() => ({}))
          throw new Error(err.error || t('vdc.failedSave'))
        }
      } else {
        // POST - create
        const body = {
          tenantId: form.tenantId,
          connectionId: form.connectionId,
          name: form.name,
          slug: form.slug,
          description: form.description || undefined,
          nodes: nodesPayload,
          storages: storagesPayload,
          sharedBridges: sharedBridgesPayload,
          quota: Object.keys(quota).some((k) => quota[k] !== null) ? quota : undefined,
        }

        const res = await fetch('/api/v1/admin/vdcs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })

        if (!res.ok) {
          const err = await res.json().catch(() => ({}))
          throw new Error(err.error || t('vdc.failedSave'))
        }
      }

      setSuccess(editingVdc ? t('vdc.updated') : t('vdc.created'))
      setDialogOpen(false)
      fetchVdcs()
    } catch (e: any) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!deleteVdc) return

    try {
      const res = await fetch(`/api/v1/admin/vdcs/${deleteVdc.id}`, { method: 'DELETE' })

      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || t('vdc.failedDelete'))
      }

      setSuccess(t('vdc.deleted'))
      setDeleteVdc(null)
      fetchVdcs()
    } catch (e: any) {
      setError(e.message)
    }
  }

  // ------- Quota donut renderer (compact, in-cell) -------

  const renderQuotaDonut = (
    icon: string,
    used: number | undefined,
    max: number | null | undefined,
    unit?: string,
    lastSyncedAt?: string | null,
  ) => {
    const donut = (
      <QuotaDonut
        size={52}
        icon={icon}
        used={used ?? 0}
        max={max}
        unit={unit}
        unlimitedLabel={t('vdc.quotaUnlimited')}
      />
    )
    if (!lastSyncedAt) return donut
    const when = formatRelative(lastSyncedAt, t)
    if (!when) return donut
    return (
      <Tooltip title={t('time.synced', { time: when })} arrow>
        <Box sx={{ display: 'inline-flex' }}>{donut}</Box>
      </Tooltip>
    )
  }

  // ------- DataGrid columns -------

  const columns: GridColDef[] = [
    {
      field: 'name',
      headerName: t('common.name'),
      flex: 1,
      minWidth: 180,
      renderCell: (params) => {
        const enabled = params.row.enabled !== false
        const subtitle = params.row.description || params.row.slug || params.row.pvePoolName
        const created = formatRelative(params.row.createdAt, t)
        const tooltipTitle = created ? `${t('common.created')} ${created}` : ''

        return (
          <Tooltip title={tooltipTitle} arrow disableInteractive>
            <Box sx={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', overflow: 'hidden', width: '100%' }}>
              <Stack direction="row" alignItems="center" spacing={0.5}>
                <Typography variant="body2" noWrap sx={{ fontWeight: 500 }}>
                  {params.value}
                </Typography>
                {!enabled && (
                  <Tooltip title={t('common.disabled')} arrow>
                    <Box
                      component="i"
                      className="ri-pause-circle-fill"
                      sx={{ fontSize: 14, color: 'warning.main', flexShrink: 0 }}
                    />
                  </Tooltip>
                )}
              </Stack>
              {subtitle && (
                <Typography
                  variant="caption"
                  color="text.secondary"
                  noWrap
                  sx={{ fontSize: '0.7rem', lineHeight: 1.2, opacity: 0.7 }}
                >
                  {subtitle}
                </Typography>
              )}
            </Box>
          </Tooltip>
        )
      },
    },
    {
      field: 'tenantName',
      headerName: t('vdc.tenant'),
      width: 170,
      renderCell: (params) => (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, overflow: 'hidden' }}>
          <Box
            component="i"
            className="ri-building-line"
            sx={{ fontSize: 16, color: 'primary.main', flexShrink: 0 }}
          />
          <Typography variant="body2" noWrap>{params.value}</Typography>
        </Box>
      ),
    },
    {
      field: 'connectionId',
      headerName: t('vdc.connection'),
      width: 150,
      renderCell: (params) => getConnectionName(params.value),
    },
    {
      field: 'nodes',
      headerName: t('vdc.nodes'),
      minWidth: 200,
      flex: 1,
      renderCell: (params) => {
        const nodes: string[] = Array.isArray(params.value) ? params.value : []
        const connId: string = params.row.connectionId
        const MAX_VISIBLE = 3
        const visible = nodes.slice(0, MAX_VISIBLE)
        const hidden = nodes.slice(MAX_VISIBLE)

        return (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, overflow: 'hidden' }}>
            {visible.map((name) => {
              const status = nodeStatuses[`${connId}|${name}`]

              return (
                <Tooltip key={name} title={status ? `${name} (${status})` : name} arrow>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.25, flexShrink: 0 }}>
                    <NodeIcon status={status} size={16} />
                    <Typography variant="caption" noWrap>{name}</Typography>
                  </Box>
                </Tooltip>
              )
            })}
            {hidden.length > 0 && (
              <Tooltip
                arrow
                title={
                  <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.25 }}>
                    {hidden.map((name) => {
                      const status = nodeStatuses[`${connId}|${name}`]
                      return (
                        <Stack key={name} direction="row" alignItems="center" spacing={0.5}>
                          <NodeIcon status={status} size={14} />
                          <Typography variant="caption">{name}</Typography>
                        </Stack>
                      )
                    })}
                  </Box>
                }
              >
                <Chip
                  label={`+${hidden.length}`}
                  size="small"
                  sx={{ height: 20, fontSize: '0.7rem', flexShrink: 0, cursor: 'default' }}
                />
              </Tooltip>
            )}
          </Box>
        )
      },
    },
    {
      field: 'quotaCpu',
      headerName: t('vdc.vcpus'),
      width: 110,
      sortable: false,
      align: 'center',
      headerAlign: 'center',
      renderCell: (params) => renderQuotaDonut(
        'ri-cpu-line',
        params.row.usage?.usedVcpus,
        params.row.quota?.maxVcpus,
        undefined,
        params.row.usage?.lastSyncedAt,
      ),
    },
    {
      field: 'quotaRam',
      headerName: t('vdc.ram'),
      width: 120,
      sortable: false,
      align: 'center',
      headerAlign: 'center',
      renderCell: (params) => {
        const usedGb = params.row.usage?.usedRamMb != null ? Math.round(params.row.usage.usedRamMb / 1024) : undefined
        const maxGb = params.row.quota?.maxRamMb != null ? Math.round(params.row.quota.maxRamMb / 1024) : null

        return renderQuotaDonut('ri-ram-2-line', usedGb, maxGb, 'GB', params.row.usage?.lastSyncedAt)
      },
    },
    {
      field: 'quotaStorage',
      headerName: t('vdc.storage'),
      width: 120,
      sortable: false,
      align: 'center',
      headerAlign: 'center',
      renderCell: (params) => {
        const usedGb = params.row.usage?.usedStorageMb != null ? Math.round(params.row.usage.usedStorageMb / 1024) : undefined
        const maxGb = params.row.quota?.maxStorageMb != null ? Math.round(params.row.quota.maxStorageMb / 1024) : null

        return renderQuotaDonut('ri-hard-drive-2-line', usedGb, maxGb, 'GB', params.row.usage?.lastSyncedAt)
      },
    },
    {
      field: 'quotaVms',
      headerName: t('vdc.vms'),
      width: 110,
      sortable: false,
      align: 'center',
      headerAlign: 'center',
      renderCell: (params) => renderQuotaDonut(
        'ri-computer-line',
        params.row.usage?.usedVms,
        params.row.quota?.maxVms,
        undefined,
        params.row.usage?.lastSyncedAt,
      ),
    },
    {
      field: 'quotaVnets',
      headerName: t('sdn.subtab.vnets'),
      width: 110,
      sortable: false,
      align: 'center',
      headerAlign: 'center',
      renderCell: (params) => {
        const used = Array.isArray(params.row.vnets) ? params.row.vnets.length : 0
        return renderQuotaDonut('ri-git-branch-line', used, params.row.quota?.maxVnets)
      },
    },
    {
      field: 'pbsBindings',
      headerName: t('vdc.backups'),
      width: 110,
      sortable: false,
      align: 'center',
      headerAlign: 'center',
      renderCell: (params) => {
        const bindings: any[] = Array.isArray(params.row.pbsBindings) ? params.row.pbsBindings : []
        const count = bindings.length
        const tooltip = count === 0 ? t('myVdc.cockpit.noBackups') : (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.25 }}>
            {bindings.map((b) => (
              <Typography key={b.id} variant="caption" sx={{ whiteSpace: 'nowrap' }}>
                {b.pbsConnectionName} • {b.datastore}{b.namespace ? ` / ${b.namespace}` : ''}
              </Typography>
            ))}
          </Box>
        )

        return (
          <Tooltip arrow title={tooltip}>
            <Chip
              icon={<Box component="i" className="ri-database-2-line" sx={{ fontSize: 14, ml: '6px !important' }} />}
              label={count}
              size="small"
              color={count === 0 ? 'error' : 'default'}
              variant={count === 0 ? 'outlined' : 'filled'}
              sx={{ height: 24, cursor: 'default' }}
            />
          </Tooltip>
        )
      },
    },
    {
      field: 'actions',
      headerName: '',
      width: 100,
      sortable: false,
      renderCell: (params) => (
        <Box sx={{ display: 'flex', gap: 0.5 }}>
          <Tooltip title={t('common.edit')}>
            <IconButton size="small" onClick={() => handleEdit(params.row)}>
              <i className="ri-pencil-line" />
            </IconButton>
          </Tooltip>
          <Tooltip title={t('common.delete')}>
            <IconButton
              size="small"
              color="error"
              onClick={async () => {
                // Optimistically open the dialog with the current row so
                // the user gets immediate feedback, then refresh usage in
                // the background. Without this, the delete button stays
                // blocked on stale `usedVms` values when the user has
                // just torn down their VMs in PVE.
                setDeleteVdc(params.row)
                try {
                  const res = await fetch(
                    `/api/v1/admin/vdcs/${encodeURIComponent(params.row.id)}/usage?refresh=true`,
                    { cache: 'no-store' },
                  )
                  if (!res.ok) return
                  const json = await res.json()
                  const usage = json?.data?.usage
                  if (usage) {
                    setDeleteVdc((prev: any) => (prev?.id === params.row.id ? { ...prev, usage } : prev))
                  }
                } catch { /* ignore — keep stale usage, the server-side check will still refuse the delete if VMs remain */ }
              }}
            >
              <i className="ri-delete-bin-line" />
            </IconButton>
          </Tooltip>
        </Box>
      ),
    },
  ]

  // ------- Quota field row helper -------

  const renderQuotaField = (
    label: string,
    valueKey: keyof VdcFormState,
    unlimitedKey: keyof VdcFormState,
  ) => (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
      <Typography variant="body2" sx={{ minWidth: 130 }}>
        {label}
      </Typography>
      <FormControlLabel
        control={
          <Switch
            size="small"
            checked={form[unlimitedKey] as boolean}
            onChange={(e) => {
              const unlimited = e.target.checked
              setForm((f) => ({
                ...f,
                [unlimitedKey]: unlimited,
                ...(unlimited ? { [valueKey]: '' } : {}),
              }))
            }}
          />
        }
        label={
          <Typography variant="caption">{t('vdc.quotaUnlimited')}</Typography>
        }
        sx={{ minWidth: 120 }}
      />
      <TextField
        type="number"
        size="small"
        value={form[valueKey] as string}
        onChange={(e) => setForm((f) => ({ ...f, [valueKey]: e.target.value }))}
        disabled={form[unlimitedKey] as boolean}
        sx={{ width: 120 }}
        slotProps={{ htmlInput: { min: 0 } }}
      />
    </Box>
  )

  // ------- Render -------

  return (
    <Box>
      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>
          {error}
        </Alert>
      )}
      {success && (
        <Alert severity="success" sx={{ mb: 2 }} onClose={() => setSuccess('')}>
          {success}
        </Alert>
      )}

      <Card>
        <CardContent>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
            <Box>
              <Typography variant="h6">{t('vdc.title')}</Typography>
              <Typography variant="body2" color="text.secondary">
                {t('vdc.subtitle')}
              </Typography>
            </Box>
            <Button variant="contained" startIcon={<i className="ri-add-line" />} onClick={handleCreate}>
              {t('vdc.newVdc')}
            </Button>
          </Box>

          {loading ? (
            <LinearProgress />
          ) : vdcs.length === 0 ? (
            <Box sx={{ textAlign: 'center', py: 6 }}>
              <i className="ri-cloud-line" style={{ fontSize: 48, opacity: 0.3 }} />
              <Typography variant="h6" sx={{ mt: 2 }}>
                {t('vdc.noVdcs')}
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                {t('vdc.noVdcsDesc')}
              </Typography>
              <Button variant="contained" startIcon={<i className="ri-add-line" />} onClick={handleCreate}>
                {t('vdc.newVdc')}
              </Button>
            </Box>
          ) : (
            <DataGrid
              rows={vdcs}
              columns={columns}
              autoHeight
              rowHeight={68}
              disableRowSelectionOnClick
              pageSizeOptions={[10, 25]}
              initialState={{ pagination: { paginationModel: { pageSize: 10 } } }}
              getRowClassName={(p) => p.row.enabled === false ? 'vdc-row-disabled' : ''}
              sx={{
                '& .MuiDataGrid-cell': { display: 'flex', alignItems: 'center' },
                '& .vdc-row-disabled': { opacity: 0.55 },
              }}
            />
          )}
        </CardContent>
      </Card>

      {/* Create / Edit Dialog */}
      <Dialog open={dialogOpen} onClose={() => setDialogOpen(false)} maxWidth="md" fullWidth>
        <DialogTitle>{editingVdc ? t('vdc.edit') : t('vdc.create')}</DialogTitle>
        <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: '20px !important' }}>
          {/* Tenant — drives the vDC name and slug. Picking a tenant fills
              name (= tenant.name) and slug (= sluggified tenant + later
              the connection too). The slug field is no longer exposed —
              it's a derived identifier the user shouldn't tune. */}
          <Autocomplete
            options={tenants}
            getOptionLabel={(o) => o.name || o.slug || o.id}
            value={tenants.find((t) => t.id === form.tenantId) || null}
            onChange={(_, v) => {
              setForm((f) => {
                if (!v) return { ...f, tenantId: '' }
                if (editingVdc) return { ...f, tenantId: v.id }
                return {
                  ...f,
                  tenantId: v.id,
                  name: v.name || v.id,
                  slug: computeVdcSlug(v, f.connectionId),
                }
              })
            }}
            disabled={!!editingVdc}
            renderInput={(params) => (
              <TextField {...params} label={t('vdc.tenant')} placeholder={t('vdc.selectTenant')} required />
            )}
          />

          {/* Description */}
          <TextField
            label={t('vdc.description')}
            value={form.description}
            onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
            fullWidth
            multiline
            rows={2}
          />

          {/* Connection / Cluster */}
          <Autocomplete
            options={connections}
            getOptionLabel={(o) => o.name || o.id}
            value={connections.find((c) => c.id === form.connectionId) || null}
            onChange={(_, v) => {
              setForm((f) => {
                if (editingVdc) {
                  return { ...f, connectionId: v?.id || '', nodes: [], storages: [] }
                }
                // Re-derive slug now that the connection is known —
                // see computeVdcSlug for the format. Without this, a
                // tenant with two vDCs across clusters would hit the
                // (tenant_id, slug) UNIQUE on save.
                const tenant = tenants.find((tn) => tn.id === f.tenantId) || null
                return {
                  ...f,
                  connectionId: v?.id || '',
                  nodes: [],
                  storages: [],
                  slug: computeVdcSlug(tenant, v?.id || ''),
                }
              })
              setAvailableResources(null)
            }}
            disabled={!!editingVdc}
            renderInput={(params) => (
              <TextField {...params} label={t('vdc.connection')} placeholder={t('vdc.selectConnection')} required />
            )}
          />

          {/* Resources section (when connection selected) */}
          {form.connectionId && (
            <>
              {resourcesLoading ? (
                <Box sx={{ py: 2 }}>
                  <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                    {t('vdc.loadingResources')}
                  </Typography>
                  <LinearProgress />
                </Box>
              ) : availableResources ? (
                <>
                  {/* PBS bindings (only when editing an existing vDC).
                      The Pool / Nodes / Storages summary that used to live
                      here was dropped: a vDC now spans the entire cluster
                      so the per-node CPU/RAM bars and per-storage usage
                      bars added noise without informing any decision the
                      admin can still make in this modal. */}
                  {editingVdc && (
                    <>
                      <VdcPbsBindingsSection
                        vdcId={editingVdc.id}
                        tenantSlug={getTenantSlug(editingVdc.tenantId) || 'tenant'}
                        vdcSlug={editingVdc.slug || form.slug}
                        pbsConnections={pbsConnections}
                      />
                      <Divider />
                    </>
                  )}

                  {/* Shared Bridges */}

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
                </>
              ) : null}

              <Divider />

              {/* Quotas */}
              <Typography variant="subtitle2" sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                <i className="ri-bar-chart-box-line" />
                {t('vdc.quotas')}
              </Typography>

              {renderQuotaField(t('vdc.maxVcpus'), 'maxVcpus', 'unlimitedVcpus')}
              {renderQuotaField(t('vdc.maxRam'), 'maxRamGb', 'unlimitedRam')}
              {renderQuotaField(t('vdc.maxStorage'), 'maxStorageGb', 'unlimitedStorage')}
              {renderQuotaField(t('vdc.maxVms'), 'maxVms', 'unlimitedVms')}
              {renderQuotaField(t('vdc.maxSnapshots'), 'maxSnapshots', 'unlimitedSnapshots')}
              {renderQuotaField(t('vdc.maxBackups'), 'maxBackups', 'unlimitedBackups')}

              <TextField
                label={t('vdc.maxVnets')}
                type="number"
                value={form.maxVnets}
                onChange={(e) => setForm((f) => ({ ...f, maxVnets: e.target.value }))}
                helperText={t('vdc.maxVnetsHint')}
                slotProps={{ htmlInput: { min: 0 } }}
                size="small"
                fullWidth
              />
            </>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDialogOpen(false)}>{t('common.cancel')}</Button>
          <Button
            variant="contained"
            onClick={handleSave}
            disabled={
              saving ||
              !form.tenantId ||
              !form.connectionId ||
              // Hold the click until /available-resources has populated
              // form.nodes and form.storages — without this gate the user
              // could submit before the auto-fill ran and the backend
              // would 400 on "nodes must be a non-empty array".
              resourcesLoading
            }
          >
            {saving ? t('vdc.saving') : editingVdc ? t('common.update') : t('common.create')}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={!!deleteVdc} onClose={() => setDeleteVdc(null)}>
        <DialogTitle>{t('vdc.deleteConfirm', { name: deleteVdc?.name || '' })}</DialogTitle>
        <DialogContent>
          {deleteVdc?.usage?.usedVms > 0 ? (
            <Alert severity="error" sx={{ mt: 1 }}>
              {t('vdc.deleteBlocked')}
            </Alert>
          ) : (
            <Alert severity="warning" sx={{ mt: 1 }}>
              {t('vdc.deleteWarning', { pool: deleteVdc?.pvePoolName || '' })}
            </Alert>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteVdc(null)}>{t('common.cancel')}</Button>
          <Button
            variant="contained"
            color="error"
            onClick={handleDelete}
            disabled={deleteVdc?.usage?.usedVms > 0}
          >
            {t('common.delete')}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  )
}
