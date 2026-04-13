'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'

import { Dialog, DialogContent, DialogActions, Button, TextField, FormControlLabel, Switch, Alert, Stack } from '@mui/material'

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
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async () => {
    setSaving(true); setError(null)
    try {
      const res = await fetch(
        `/api/v1/vdcs/${encodeURIComponent(vdcId)}/vnets/${encodeURIComponent(vnet.pveName)}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ description, firewall }),
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
      <AppDialogTitle onClose={onClose}>{vnet.pveName}</AppDialogTitle>
      <DialogContent>
        <Stack spacing={2} mt={1}>
          <TextField label={t('myVdc.vnetDescription')} value={description} onChange={(e) => setDescription(e.target.value)} fullWidth multiline rows={2} />
          <FormControlLabel control={<Switch checked={firewall} onChange={(e) => setFirewall(e.target.checked)} />} label={t('myVdc.vnetFirewallToggle')} />
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
