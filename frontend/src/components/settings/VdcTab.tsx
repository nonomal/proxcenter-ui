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
  Switch,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material'

import { DataGrid, type GridColDef } from '@mui/x-data-grid'

import { useTranslations } from 'next-intl'

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
  unlimitedVcpus: true,
  unlimitedRam: true,
  unlimitedStorage: true,
  unlimitedVms: true,
  unlimitedSnapshots: true,
  unlimitedBackups: true,
}

function formatBytes(bytes: number): string {
  return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB'
}

function quotaColor(percent: number): 'success' | 'warning' | 'error' {
  if (percent < 70) return 'success'
  if (percent < 90) return 'warning'
  return 'error'
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
        const res = await fetch(`/api/v1/admin/connections/${form.connectionId}/available-resources`)

        if (!res.ok) throw new Error(`HTTP ${res.status}`)

        const data = await res.json()

        if (!cancelled) {
          setAvailableResources(data.data || null)
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

  // ------- Handlers -------

  const handleCreate = () => {
    setEditingVdc(null)
    setForm(emptyForm)
    setAvailableResources(null)
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
      unlimitedVcpus: vdc.quota?.maxVcpus == null,
      unlimitedRam: vdc.quota?.maxRamMb == null,
      unlimitedStorage: vdc.quota?.maxStorageMb == null,
      unlimitedVms: vdc.quota?.maxVms == null,
      unlimitedSnapshots: vdc.quota?.maxSnapshots == null,
      unlimitedBackups: vdc.quota?.maxBackups == null,
    })
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

      // For unlimited fields, explicitly set null so the backend clears them
      if (form.unlimitedVcpus) quota.maxVcpus = null
      if (form.unlimitedRam) quota.maxRamMb = null
      if (form.unlimitedStorage) quota.maxStorageMb = null
      if (form.unlimitedVms) quota.maxVms = null
      if (form.unlimitedSnapshots) quota.maxSnapshots = null
      if (form.unlimitedBackups) quota.maxBackups = null

      if (editingVdc) {
        // PUT - update
        const body: any = {
          name: form.name,
          description: form.description || undefined,
          nodes: form.nodes,
          storages: form.storages,
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
          nodes: form.nodes,
          storages: form.storages,
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

  // ------- Quota gauge renderer -------

  const renderQuotaGauge = (used: number | undefined, max: number | null | undefined, unit?: string) => {
    if (max == null) {
      return (
        <Typography variant="body2" sx={{ opacity: 0.5, lineHeight: '52px' }}>
          {t('vdc.quotaUnlimited')}
        </Typography>
      )
    }

    const usedVal = used ?? 0
    const percent = max > 0 ? Math.min((usedVal / max) * 100, 100) : 0

    return (
      <Box sx={{ width: '100%', py: 0.5 }}>
        <LinearProgress
          variant="determinate"
          value={percent}
          color={quotaColor(percent)}
          sx={{ height: 6, borderRadius: 3 }}
        />
        <Typography variant="caption" color="text.secondary">
          {usedVal}{unit ? ` ${unit}` : ''} / {max}{unit ? ` ${unit}` : ''}
        </Typography>
      </Box>
    )
  }

  // ------- DataGrid columns -------

  const columns: GridColDef[] = [
    {
      field: 'name',
      headerName: t('common.name'),
      flex: 1,
      minWidth: 150,
    },
    {
      field: 'tenantName',
      headerName: t('vdc.tenant'),
      width: 150,
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
      width: 100,
      renderCell: (params) => (
        <Chip
          label={Array.isArray(params.value) ? params.value.length : 0}
          size="small"
          variant="outlined"
        />
      ),
    },
    {
      field: 'quotaCpu',
      headerName: t('vdc.vcpus'),
      width: 150,
      sortable: false,
      renderCell: (params) => renderQuotaGauge(
        params.row.usage?.usedVcpus,
        params.row.quota?.maxVcpus,
      ),
    },
    {
      field: 'quotaRam',
      headerName: t('vdc.ram'),
      width: 150,
      sortable: false,
      renderCell: (params) => {
        const usedGb = params.row.usage?.usedRamMb != null ? Math.round(params.row.usage.usedRamMb / 1024) : undefined
        const maxGb = params.row.quota?.maxRamMb != null ? Math.round(params.row.quota.maxRamMb / 1024) : null

        return renderQuotaGauge(usedGb, maxGb, 'GB')
      },
    },
    {
      field: 'quotaVms',
      headerName: t('vdc.vms'),
      width: 120,
      sortable: false,
      renderCell: (params) => renderQuotaGauge(
        params.row.usage?.usedVms,
        params.row.quota?.maxVms,
      ),
    },
    {
      field: 'enabled',
      headerName: t('common.status'),
      width: 100,
      renderCell: (params) => (
        <Chip
          label={params.value ? t('common.active') : t('common.disabled')}
          size="small"
          color={params.value ? 'success' : 'default'}
        />
      ),
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
              onClick={() => setDeleteVdc(params.row)}
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

  // ------- Pool name preview -------

  const poolNamePreview = form.tenantId && form.slug
    ? `vdc-${getTenantSlug(form.tenantId)}-${form.slug}`
    : null

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
              disableRowSelectionOnClick
              pageSizeOptions={[10, 25]}
              initialState={{ pagination: { paginationModel: { pageSize: 10 } } }}
              sx={{
                '& .MuiDataGrid-cell': { display: 'flex', alignItems: 'center' },
              }}
            />
          )}
        </CardContent>
      </Card>

      {/* Create / Edit Dialog */}
      <Dialog open={dialogOpen} onClose={() => setDialogOpen(false)} maxWidth="md" fullWidth>
        <DialogTitle>{editingVdc ? t('vdc.edit') : t('vdc.create')}</DialogTitle>
        <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: '20px !important' }}>
          {/* Name */}
          <TextField
            label={t('vdc.name')}
            value={form.name}
            onChange={(e) => {
              const name = e.target.value

              setForm((f) => ({
                ...f,
                name,
                ...(editingVdc ? {} : { slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') }),
              }))
            }}
            fullWidth
            required
          />

          {/* Slug */}
          <Tooltip
            title={t('vdc.slugHelp')}
            open={!!form.slug && !/^[a-z0-9-]*$/.test(form.slug)}
            arrow
            placement="top"
          >
            <TextField
              label={t('vdc.slug')}
              value={form.slug}
              onChange={(e) => {
                const raw = e.target.value
                const sanitized = raw.toLowerCase().replace(/[^a-z0-9-]/g, '')
                setForm((f) => ({ ...f, slug: sanitized }))
              }}
              fullWidth
              required
              disabled={!!editingVdc}
            />
          </Tooltip>

          {/* Description */}
          <TextField
            label={t('vdc.description')}
            value={form.description}
            onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
            fullWidth
            multiline
            rows={2}
          />

          {/* Tenant */}
          <Autocomplete
            options={tenants}
            getOptionLabel={(o) => o.name || o.slug || o.id}
            value={tenants.find((t) => t.id === form.tenantId) || null}
            onChange={(_, v) => setForm((f) => ({ ...f, tenantId: v?.id || '' }))}
            disabled={!!editingVdc}
            renderInput={(params) => (
              <TextField {...params} label={t('vdc.tenant')} placeholder={t('vdc.selectTenant')} required />
            )}
          />

          {/* Connection / Cluster */}
          <Autocomplete
            options={connections}
            getOptionLabel={(o) => o.name || o.id}
            value={connections.find((c) => c.id === form.connectionId) || null}
            onChange={(_, v) => {
              setForm((f) => ({ ...f, connectionId: v?.id || '', nodes: [], storages: [] }))
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
                  {/* PVE Pool preview */}
                  {poolNamePreview && (
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                      <Typography variant="body2" color="text.secondary">
                        {t('vdc.pvePoolName')}:
                      </Typography>
                      <Chip
                        label={poolNamePreview}
                        size="small"
                        sx={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.75rem' }}
                      />
                    </Box>
                  )}

                  <Divider />

                  {/* Nodes */}
                  <Typography variant="subtitle2" sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <i className="ri-server-line" />
                    {t('vdc.nodes')}
                    {form.nodes.length > 0 && (
                      <Chip label={t('vdc.nodesSelected', { count: form.nodes.length })} size="small" variant="outlined" />
                    )}
                  </Typography>

                  {(availableResources.nodes || []).map((node: any) => {
                    const cpuPercent = node.maxcpu > 0 ? Math.round((node.cpu || 0) * 100) : 0
                    const ramPercent = node.maxmem > 0 ? Math.round(((node.mem || 0) / node.maxmem) * 100) : 0
                    const isOnline = node.status === 'online'

                    return (
                      <Box
                        key={node.name}
                        sx={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 1.5,
                          py: 0.75,
                          px: 1,
                          borderRadius: 1,
                          '&:hover': { bgcolor: 'action.hover' },
                        }}
                      >
                        <Checkbox
                          checked={form.nodes.includes(node.name)}
                          onChange={(e) => {
                            setForm((f) => ({
                              ...f,
                              nodes: e.target.checked
                                ? [...f.nodes, node.name]
                                : f.nodes.filter((n) => n !== node.name),
                            }))
                          }}
                          size="small"
                        />

                        {/* Proxmox icon with status dot */}
                        <Box sx={{ position: 'relative', width: 22, height: 22, flexShrink: 0 }}>
                          <img src="/images/proxmox-logo.svg" alt="" width={22} height={22} style={{ opacity: isOnline ? 0.9 : 0.4 }} />
                          <Box sx={{
                            position: 'absolute', bottom: -2, right: -2,
                            width: 10, height: 10, borderRadius: '50%',
                            bgcolor: isOnline ? 'success.main' : 'text.disabled',
                            border: '2px solid', borderColor: 'background.paper',
                          }} />
                        </Box>

                        <Typography variant="body2" sx={{ fontWeight: 500, minWidth: 120 }}>{node.name}</Typography>

                        {/* CPU progress */}
                        <Box sx={{ flex: 1, minWidth: 80 }}>
                          <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 0.25 }}>
                            <Typography variant="caption" color="text.secondary">CPU</Typography>
                            <Typography variant="caption" color="text.secondary">{cpuPercent}%</Typography>
                          </Box>
                          <LinearProgress
                            variant="determinate"
                            value={cpuPercent}
                            color={quotaColor(cpuPercent)}
                            sx={{ height: 6, borderRadius: 3 }}
                          />
                        </Box>

                        {/* RAM progress */}
                        <Box sx={{ flex: 1, minWidth: 80 }}>
                          <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 0.25 }}>
                            <Typography variant="caption" color="text.secondary">RAM</Typography>
                            <Typography variant="caption" color="text.secondary">
                              {formatBytes(node.mem || 0)} / {formatBytes(node.maxmem || 0)}
                            </Typography>
                          </Box>
                          <LinearProgress
                            variant="determinate"
                            value={ramPercent}
                            color={quotaColor(ramPercent)}
                            sx={{ height: 6, borderRadius: 3 }}
                          />
                        </Box>
                      </Box>
                    )
                  })}

                  <Divider />

                  {/* Storages */}
                  <Typography variant="subtitle2" sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <i className="ri-hard-drive-3-line" />
                    {t('vdc.storages')}
                    {form.storages.length > 0 && (
                      <Chip label={t('vdc.storagesSelected', { count: form.storages.length })} size="small" variant="outlined" />
                    )}
                  </Typography>

                  {(availableResources.storages || []).map((storage: any) => {
                    const usagePercent = storage.maxdisk > 0 ? Math.round((storage.disk / storage.maxdisk) * 100) : 0

                    return (
                      <Box
                        key={storage.id}
                        sx={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 1.5,
                          py: 0.75,
                          px: 1,
                          borderRadius: 1,
                          '&:hover': { bgcolor: 'action.hover' },
                        }}
                      >
                        <Checkbox
                          checked={form.storages.includes(storage.id)}
                          onChange={(e) => {
                            setForm((f) => ({
                              ...f,
                              storages: e.target.checked
                                ? [...f.storages, storage.id]
                                : f.storages.filter((s) => s !== storage.id),
                            }))
                          }}
                          size="small"
                        />

                        <i className="ri-hard-drive-2-fill" style={{ fontSize: 18, opacity: 0.7 }} />

                        {/* Left zone: name + badges (fixed width) */}
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, width: 220, flexShrink: 0 }}>
                          <Typography variant="body2" sx={{ fontWeight: 500 }} noWrap>{storage.id}</Typography>
                          <Chip label={storage.type} size="small" variant="outlined" sx={{ height: 20, fontSize: '0.65rem' }} />
                          {storage.shared && (
                            <Chip label={t('vdc.shared')} size="small" color="info" sx={{ height: 20, fontSize: '0.65rem' }} />
                          )}
                        </Box>

                        {/* Right zone: progress bar (fills remaining space) */}
                        {storage.maxdisk > 0 ? (
                          <Box sx={{ flex: 1, minWidth: 80 }}>
                            <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 0.25 }}>
                              <Typography variant="caption" color="text.secondary">
                                {formatBytes(storage.disk || 0)} / {formatBytes(storage.maxdisk || 0)}
                              </Typography>
                              <Typography variant="caption" color="text.secondary">{usagePercent}%</Typography>
                            </Box>
                            <LinearProgress
                              variant="determinate"
                              value={usagePercent}
                              color={quotaColor(usagePercent)}
                              sx={{ height: 6, borderRadius: 3 }}
                            />
                          </Box>
                        ) : (
                          <Box sx={{ flex: 1 }} />
                        )}
                      </Box>
                    )
                  })}
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
              !form.name ||
              !form.slug ||
              !form.tenantId ||
              !form.connectionId ||
              form.nodes.length === 0 ||
              form.storages.length === 0
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
