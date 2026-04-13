'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'

import { Dialog, DialogContent, DialogActions, Button, TextField, FormControlLabel, Switch, Alert, Stack, Typography } from '@mui/material'

import AppDialogTitle from '@/components/ui/AppDialogTitle'

interface Props {
  open: boolean
  vdcId: string
  onClose: () => void
  onCreated: () => void
}

const NAME_REGEX = /^[a-z][a-z0-9]{0,14}$/

export default function VnetCreateDialog({ open, vdcId, onClose, onCreated }: Props) {
  const t = useTranslations()
  const [pveName, setPveName] = useState('')
  const [description, setDescription] = useState('')
  const [firewall, setFirewall] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const nameValid = pveName === '' || NAME_REGEX.test(pveName)

  const handleSubmit = async () => {
    if (!NAME_REGEX.test(pveName)) {
      setError(t('myVdc.errorInvalidName'))
      return
    }
    setSaving(true); setError(null)
    try {
      const res = await fetch(`/api/v1/vdcs/${encodeURIComponent(vdcId)}/vnets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pveName, description: description || undefined, firewall }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
      onCreated()
      setPveName(''); setDescription(''); setFirewall(true)
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
            label={t('myVdc.vnetName')}
            value={pveName}
            onChange={(e) => setPveName(e.target.value)}
            error={!nameValid}
            helperText={nameValid ? t('myVdc.vnetNameHint') : t('myVdc.errorInvalidName')}
            fullWidth
            autoFocus
            slotProps={{ htmlInput: { maxLength: 15, pattern: '^[a-z][a-z0-9]{0,14}$' } }}
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
          {error && <Alert severity="error">{error}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={saving}>{t('common.cancel')}</Button>
        <Button variant="contained" onClick={handleSubmit} disabled={!pveName || !nameValid || saving}>{t('common.create')}</Button>
      </DialogActions>
    </Dialog>
  )
}
