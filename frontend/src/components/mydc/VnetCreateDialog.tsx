'use client'

import { useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'

import {
  Dialog, DialogContent, DialogActions, Button, TextField, FormControlLabel, Switch,
  Alert, Stack, Typography, MenuItem, Tooltip, Box,
  Accordion, AccordionSummary, AccordionDetails,
} from '@mui/material'

import AppDialogTitle from '@/components/ui/AppDialogTitle'

interface VdcOption { id: string; name: string }

interface Props {
  open: boolean
  vdcs: VdcOption[]
  defaultVdcId?: string
  onClose: () => void
  onCreated: () => void
}

// User-facing display name — kept scoped to the vDC, free of PVE's 8-char +
// cluster-wide constraints (the backend hashes a unique 8-char pve_name from
// this). Keep in sync with VNET_DISPLAY_NAME_REGEX in lib/vdc/vnets.ts.
const NAME_REGEX = /^[a-z][a-z0-9-]{0,19}$/

export default function VnetCreateDialog({ open, vdcs, defaultVdcId, onClose, onCreated }: Props) {
  const t = useTranslations()
  const initialVdc = useMemo(() => {
    if (defaultVdcId && vdcs.some(v => v.id === defaultVdcId)) return defaultVdcId
    return vdcs[0]?.id ?? ''
  }, [vdcs, defaultVdcId])

  const [vdcId, setVdcId] = useState(initialVdc)
  const [displayName, setDisplayName] = useState('')
  const [description, setDescription] = useState('')
  const [firewall, setFirewall] = useState(true)
  const [isolatePorts, setIsolatePorts] = useState(false)
  const [vlanAware, setVlanAware] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open) setVdcId(initialVdc)
  }, [open, initialVdc])

  const nameValid = displayName === '' || NAME_REGEX.test(displayName)
  const canSubmit = !!vdcId && !!displayName && nameValid && !saving

  const handleSubmit = async () => {
    if (!vdcId) {
      setError(t('myVdc.vnetSelectVdc'))
      return
    }
    if (!NAME_REGEX.test(displayName)) {
      setError(t('myVdc.errorInvalidName'))
      return
    }
    setSaving(true); setError(null)
    try {
      const res = await fetch(`/api/v1/vdcs/${encodeURIComponent(vdcId)}/vnets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          displayName,
          description: description || undefined,
          firewall,
          isolatePorts,
          vlanAware,
        }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
      onCreated()
      setDisplayName(''); setDescription(''); setFirewall(true)
      setIsolatePorts(false); setVlanAware(false)
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
            select
            label={t('myVdc.vnetVdc')}
            value={vdcId}
            onChange={(e) => setVdcId(e.target.value)}
            disabled={vdcs.length <= 1 || saving}
            helperText={vdcs.length === 0 ? t('myVdc.vnetNoVdc') : undefined}
            fullWidth
          >
            {vdcs.map((v) => (
              <MenuItem key={v.id} value={v.id}>{v.name}</MenuItem>
            ))}
          </TextField>
          <TextField
            label={t('myVdc.vnetName')}
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            error={!nameValid}
            helperText={nameValid ? t('myVdc.vnetNameHint') : t('myVdc.errorInvalidName')}
            fullWidth
            autoFocus
            slotProps={{ htmlInput: { maxLength: 20, pattern: '^[a-z][a-z0-9-]{0,19}$' } }}
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

          <Accordion disableGutters elevation={0} sx={{ '&:before': { display: 'none' }, bgcolor: 'transparent' }}>
            <AccordionSummary
              expandIcon={<i className="ri-arrow-down-s-line" />}
              sx={{ px: 0, minHeight: 32, '& .MuiAccordionSummary-content': { my: 0 } }}
            >
              <Typography variant="body2" sx={{ fontWeight: 600 }}>{t('myVdc.vnetAdvanced')}</Typography>
            </AccordionSummary>
            <AccordionDetails sx={{ px: 0, pt: 0 }}>
              <Stack spacing={1}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                  <FormControlLabel
                    control={<Switch checked={isolatePorts} onChange={(e) => setIsolatePorts(e.target.checked)} />}
                    label={t('myVdc.vnetIsolatePortsToggle')}
                  />
                  <Tooltip title={t('myVdc.vnetIsolatePortsHelp')} arrow placement="right">
                    <i className="ri-information-line" style={{ fontSize: 16, opacity: 0.55, cursor: 'help' }} />
                  </Tooltip>
                </Box>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                  <FormControlLabel
                    control={<Switch checked={vlanAware} onChange={(e) => setVlanAware(e.target.checked)} />}
                    label={t('myVdc.vnetVlanAwareToggle')}
                  />
                  <Tooltip title={t('myVdc.vnetVlanAwareHelp')} arrow placement="right">
                    <i className="ri-information-line" style={{ fontSize: 16, opacity: 0.55, cursor: 'help' }} />
                  </Tooltip>
                </Box>
              </Stack>
            </AccordionDetails>
          </Accordion>

          {error && <Alert severity="error">{error}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={saving}>{t('common.cancel')}</Button>
        <Button variant="contained" onClick={handleSubmit} disabled={!canSubmit}>{t('common.create')}</Button>
      </DialogActions>
    </Dialog>
  )
}
