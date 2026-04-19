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
  mode: 'auto' | 'manual'
  pbsTokenId: string | null
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
  const [form, setForm] = useState({
    mode: 'auto' as 'auto' | 'manual',
    pbsConnectionId: '', datastore: '', namespace: '', overrideNs: false,
    pveStorageName: '',
  })
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
      const body: any = { mode: form.mode, pbsConnectionId: form.pbsConnectionId, datastore: form.datastore }
      if (form.mode === 'manual') {
        if (!form.namespace) { setError('Namespace is required in manual mode'); setSubmitting(false); return }
        body.namespace = form.namespace
        if (form.pveStorageName) body.pveStorageName = form.pveStorageName
      } else if (form.overrideNs && form.namespace) {
        body.namespace = form.namespace
      }
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

  const eligibleAuto = pbsConnections.filter(c => c.fingerprint)
  const noFingerprint = form.mode === 'auto' && pbsConnections.length > 0 && eligibleAuto.length === 0
  const eligible = form.mode === 'auto' ? eligibleAuto : pbsConnections

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>Backup (PBS) — {vdcName}</DialogTitle>
      <DialogContent>
        {noFingerprint && (
          <Alert severity="warning" sx={{ mb: 2 }}>
            None of the PBS connections have a captured fingerprint. Open the PBS connection settings and click &quot;Update fingerprint&quot; first.
          </Alert>
        )}
        {loading ? <Typography variant="caption">…</Typography> : (
          <Stack spacing={1}>
            {bindings.length === 0 && <Typography variant="caption" color="text.secondary">No binding yet.</Typography>}
            {bindings.map(b => (
              <Stack key={b.id} direction="row" alignItems="center" spacing={1} sx={{ border: '1px solid', borderColor: 'divider', p: 1, borderRadius: 1 }}>
                <Box sx={{ flex: 1 }}>
                  <Typography variant="body2">
                    <b>{b.datastore}</b> / {b.namespace}
                    {' '}<Box component="span" sx={{ fontSize: 10, fontWeight: 600, px: 0.5, borderRadius: 0.5, bgcolor: b.mode === 'manual' ? 'warning.light' : 'success.light', color: 'text.primary' }}>{b.mode}</Box>
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    PBS: {pbsConnections.find(c => c.id === b.pbsConnectionId)?.name ?? b.pbsConnectionId}
                    {b.pbsTokenId ? ` — token ${b.pbsTokenId}` : ''}
                  </Typography>
                </Box>
                <IconButton size="small" color="error" onClick={() => handleDelete(b.id)}><i className="ri-delete-bin-line" /></IconButton>
              </Stack>
            ))}
          </Stack>
        )}
        <Button sx={{ mt: 2 }} size="small" startIcon={<i className="ri-add-line" />} onClick={() => setAddOpen(v => !v)} disabled={pbsConnections.length === 0}>
          Add binding
        </Button>
        {addOpen && (
          <Box sx={{ mt: 2, p: 2, border: '1px dashed', borderColor: 'divider', borderRadius: 1 }}>
            <Stack spacing={2}>
              <FormControlLabel
                control={<Switch size="small" checked={form.mode === 'manual'} onChange={e => setForm(f => ({ ...f, mode: e.target.checked ? 'manual' : 'auto', pbsConnectionId: '', datastore: '' }))} />}
                label={form.mode === 'manual' ? 'Manual mode (admin already created namespace + PVE storage)' : 'Auto provision'}
              />
              <TextField select size="small" label="PBS connection" value={form.pbsConnectionId} onChange={e => setForm(f => ({ ...f, pbsConnectionId: e.target.value, datastore: '' }))}>
                {eligible.map(c => <MenuItem key={c.id} value={c.id}>{c.name}{!c.fingerprint ? ' (no fingerprint)' : ''}</MenuItem>)}
              </TextField>
              <TextField select size="small" label="Datastore" value={form.datastore} onChange={e => setForm(f => ({ ...f, datastore: e.target.value }))} disabled={!form.pbsConnectionId}>
                {datastores.map(d => <MenuItem key={d} value={d}>{d}</MenuItem>)}
              </TextField>
              {form.mode === 'auto' ? (
                <>
                  <FormControlLabel
                    control={<Switch size="small" checked={form.overrideNs} onChange={e => setForm(f => ({ ...f, overrideNs: e.target.checked }))} />}
                    label="Override auto namespace"
                  />
                  {form.overrideNs && (
                    <TextField size="small" label="Namespace" helperText="e.g. tenant-acme/vdc-prod" value={form.namespace} onChange={e => setForm(f => ({ ...f, namespace: e.target.value }))} />
                  )}
                </>
              ) : (
                <>
                  <TextField size="small" required label="Namespace" helperText="Must match the namespace you already created on PBS" value={form.namespace} onChange={e => setForm(f => ({ ...f, namespace: e.target.value }))} />
                  <TextField size="small" label="Existing PVE storage name (optional)" helperText="If you already configured a pbs: storage in PVE, name it here so the tenant sees it" value={form.pveStorageName} onChange={e => setForm(f => ({ ...f, pveStorageName: e.target.value }))} />
                </>
              )}
              {error && <Alert severity="error">{error}</Alert>}
              {stepReport && stepReport.mode === 'manual' && (
                <Alert severity="success">
                  Manual binding recorded. PVE storage: {stepReport.pveStorage}
                </Alert>
              )}
              {stepReport && stepReport.mode !== 'manual' && (
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
