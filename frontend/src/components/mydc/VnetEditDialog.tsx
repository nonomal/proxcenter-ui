'use client'

import { useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'

import {
  Dialog, DialogContent, DialogActions, Button, TextField, FormControlLabel, Switch,
  Alert, Stack, Tooltip, Box, Typography, Divider,
  Accordion, AccordionSummary, AccordionDetails,
} from '@mui/material'

import AppDialogTitle from '@/components/ui/AppDialogTitle'
import { validateDhcpRange } from '@/lib/vdc/network'

interface Props {
  vnet: any
  vdcId: string
  onClose: () => void
  onSaved: () => void
}

export default function VnetEditDialog({ vnet, vdcId, onClose, onSaved }: Props) {
  const t = useTranslations()
  const subnet = vnet.subnet ?? null

  const [description, setDescription] = useState(vnet.description ?? '')
  const [firewall, setFirewall] = useState(!!vnet.firewall)
  const [isolatePorts, setIsolatePorts] = useState(!!vnet.isolatePorts)
  const [vlanAware, setVlanAware] = useState(!!vnet.vlanAware)
  const [dnsServers, setDnsServers] = useState<string>(
    Array.isArray(subnet?.dnsServers) ? subnet.dnsServers.join(', ') : '',
  )
  const [enableDhcp, setEnableDhcp] = useState<boolean>(!!subnet?.dhcpRangeStart && !!subnet?.dhcpRangeEnd)
  const [dhcpStart, setDhcpStart] = useState<string>(subnet?.dhcpRangeStart ?? '')
  const [dhcpEnd, setDhcpEnd] = useState<string>(subnet?.dhcpRangeEnd ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const dhcpValidation = useMemo(() => {
    if (!subnet || !enableDhcp || !dhcpStart || !dhcpEnd) return { ok: true as const }
    return validateDhcpRange(subnet.cidr, subnet.gateway, dhcpStart, dhcpEnd)
  }, [subnet, enableDhcp, dhcpStart, dhcpEnd])

  const dhcpErrorMessage = !dhcpValidation.ok ? (() => {
    switch (dhcpValidation.reason) {
      case 'invalid_start': return t('myVdc.subnetDhcpStartInvalid')
      case 'invalid_end': return t('myVdc.subnetDhcpEndInvalid')
      case 'reversed': return t('myVdc.subnetDhcpReversed')
      case 'gateway_in_range': return t('myVdc.subnetDhcpGatewayInRange')
      default: return ''
    }
  })() : ''

  const subnetEditable = !!subnet
  const canSubmit = !saving && (!enableDhcp || !subnetEditable || (dhcpStart && dhcpEnd && dhcpValidation.ok))

  const handleSubmit = async () => {
    setSaving(true); setError(null)
    try {
      const segment = vnet.displayName ?? vnet.pveName
      const subnetPatch = subnetEditable
        ? {
            dnsServers: dnsServers
              .split(',')
              .map(s => s.trim())
              .filter(Boolean),
            dhcpRangeStart: enableDhcp ? dhcpStart : null,
            dhcpRangeEnd: enableDhcp ? dhcpEnd : null,
          }
        : undefined
      const res = await fetch(
        `/api/v1/vdcs/${encodeURIComponent(vdcId)}/vnets/${encodeURIComponent(segment)}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ description, firewall, isolatePorts, vlanAware, subnet: subnetPatch }),
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

          {subnetEditable && (
            <>
              <Divider />
              <Typography variant="body2" sx={{ fontWeight: 600 }}>{t('myVdc.subnetColumn')}</Typography>
              <Alert severity="info" icon={<i className="ri-information-line" />} sx={{ py: 0.5, fontSize: '0.8rem' }}>
                {t('myVdc.subnetIpamBanner')}
              </Alert>
              {/* CIDR + gateway are immutable post-creation (changing them
                  invalidates IPAM allocations). Render as read-only for context. */}
              <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1 }}>
                <TextField
                  label={t('myVdc.subnetCidr')}
                  value={subnet.cidr}
                  fullWidth
                  size="small"
                  InputProps={{ readOnly: true }}
                  helperText={t('myVdc.subnetReadOnly')}
                />
                <TextField
                  label={t('myVdc.subnetGateway')}
                  value={subnet.gateway}
                  fullWidth
                  size="small"
                  InputProps={{ readOnly: true }}
                />
              </Box>
              <TextField
                label={t('myVdc.subnetDns')}
                value={dnsServers}
                onChange={(e) => setDnsServers(e.target.value)}
                helperText={t('myVdc.subnetDnsHint')}
                fullWidth
                size="small"
                placeholder="1.1.1.1, 9.9.9.9"
              />
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                <FormControlLabel
                  control={<Switch checked={enableDhcp} onChange={(e) => setEnableDhcp(e.target.checked)} />}
                  label={t('myVdc.subnetEnableDhcp')}
                />
                <Tooltip title={t('myVdc.subnetEnableDhcpHelp')} arrow placement="right">
                  <i className="ri-information-line" style={{ fontSize: 16, opacity: 0.55, cursor: 'help' }} />
                </Tooltip>
              </Box>
              {enableDhcp && (
                <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1 }}>
                  <TextField
                    label={t('myVdc.subnetDhcpStart')}
                    value={dhcpStart}
                    onChange={(e) => setDhcpStart(e.target.value.trim())}
                    fullWidth
                    size="small"
                  />
                  <TextField
                    label={t('myVdc.subnetDhcpEnd')}
                    value={dhcpEnd}
                    onChange={(e) => setDhcpEnd(e.target.value.trim())}
                    fullWidth
                    size="small"
                  />
                </Box>
              )}
              {enableDhcp && !!dhcpErrorMessage && (
                <Alert severity="error" sx={{ py: 0.5 }}>{dhcpErrorMessage}</Alert>
              )}
            </>
          )}

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
        <Button variant="contained" onClick={handleSubmit} disabled={!canSubmit}>{t('common.save')}</Button>
      </DialogActions>
    </Dialog>
  )
}
