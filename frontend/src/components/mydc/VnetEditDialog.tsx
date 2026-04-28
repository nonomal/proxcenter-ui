'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'

import {
  Dialog, DialogContent, DialogActions, Button, TextField, FormControlLabel, Switch,
  Alert, Stack, Tooltip, Box, Typography,
  Accordion, AccordionSummary, AccordionDetails,
} from '@mui/material'

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
  const [isolatePorts, setIsolatePorts] = useState(!!vnet.isolatePorts)
  const [vlanAware, setVlanAware] = useState(!!vnet.vlanAware)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async () => {
    setSaving(true); setError(null)
    try {
      // URL segment is the user-facing display name (vDC-scoped). Falls back to
      // pveName for any caller that hasn't been migrated to the new field yet.
      const segment = vnet.displayName ?? vnet.pveName
      const res = await fetch(
        `/api/v1/vdcs/${encodeURIComponent(vdcId)}/vnets/${encodeURIComponent(segment)}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ description, firewall, isolatePorts, vlanAware }),
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
      <AppDialogTitle onClose={onClose}>{vnet.displayName ?? vnet.pveName}</AppDialogTitle>
      <DialogContent>
        <Stack spacing={2} mt={1}>
          <TextField label={t('myVdc.vnetDescription')} value={description} onChange={(e) => setDescription(e.target.value)} fullWidth multiline rows={2} />
          <FormControlLabel control={<Switch checked={firewall} onChange={(e) => setFirewall(e.target.checked)} />} label={t('myVdc.vnetFirewallToggle')} />

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
        <Button variant="contained" onClick={handleSubmit} disabled={saving}>{t('common.save')}</Button>
      </DialogActions>
    </Dialog>
  )
}
