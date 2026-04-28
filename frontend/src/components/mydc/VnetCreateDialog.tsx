'use client'

import { useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'

import {
  Dialog, DialogContent, DialogActions, Button, TextField, FormControlLabel, Switch,
  Alert, Stack, Typography, MenuItem, Tooltip, Box, Divider,
  Accordion, AccordionSummary, AccordionDetails,
} from '@mui/material'

import AppDialogTitle from '@/components/ui/AppDialogTitle'
import {
  parseCidr, gatewayValidForCidr, validateDhcpRange, usableHostCount, firstUsableAfterGateway,
} from '@/lib/vdc/network'

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
  // Subnet config — ON by default so the VNet is L3-ready out of the box.
  const [configureSubnet, setConfigureSubnet] = useState(true)
  const [cidr, setCidr] = useState('')
  const [gateway, setGateway] = useState('')
  const [dnsServers, setDnsServers] = useState('')        // comma-separated
  const [enableDhcp, setEnableDhcp] = useState(false)
  const [dhcpStart, setDhcpStart] = useState('')
  const [dhcpEnd, setDhcpEnd] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open) setVdcId(initialVdc)
  }, [open, initialVdc])

  // CIDR / gateway / DHCP live validation — drives helper text + Submit gate.
  const cidrInfo = useMemo(() => parseCidr(cidr), [cidr])
  const cidrValid = !!cidrInfo
  const gatewayValid = !cidr || !gateway || gatewayValidForCidr(gateway, cidr)
  const dhcpValidation = useMemo(() => {
    if (!enableDhcp || !cidr || !gateway || !dhcpStart || !dhcpEnd) return { ok: true as const }
    return validateDhcpRange(cidr, gateway, dhcpStart, dhcpEnd)
  }, [enableDhcp, cidr, gateway, dhcpStart, dhcpEnd])

  // Suggest gateway = first usable, DHCP start = gateway+1, end = last usable.
  // Fired only when the user just typed a fresh CIDR and hasn't touched the
  // dependent fields, so we don't fight their manual edits.
  useEffect(() => {
    if (!cidrInfo) return
    if (!gateway) {
      const firstUsable = firstUsableAfterGateway(cidr, '')
      if (firstUsable) setGateway(firstUsable)
    }
  }, [cidrInfo, cidr, gateway])

  const nameValid = displayName === '' || NAME_REGEX.test(displayName)
  const subnetValid = !configureSubnet || (
    cidrValid &&
    !!gateway && gatewayValid &&
    (!enableDhcp || (!!dhcpStart && !!dhcpEnd && dhcpValidation.ok))
  )
  const canSubmit = !!vdcId && !!displayName && nameValid && subnetValid && !saving

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
      const subnet = configureSubnet
        ? {
            cidr,
            gateway,
            dnsServers: dnsServers
              ? dnsServers.split(',').map(s => s.trim()).filter(Boolean)
              : undefined,
            dhcpRangeStart: enableDhcp ? dhcpStart : undefined,
            dhcpRangeEnd: enableDhcp ? dhcpEnd : undefined,
          }
        : undefined
      const res = await fetch(`/api/v1/vdcs/${encodeURIComponent(vdcId)}/vnets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          displayName,
          description: description || undefined,
          firewall,
          isolatePorts,
          vlanAware,
          subnet,
        }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
      onCreated()
      setDisplayName(''); setDescription(''); setFirewall(true)
      setIsolatePorts(false); setVlanAware(false)
      setConfigureSubnet(true); setCidr(''); setGateway(''); setDnsServers('')
      setEnableDhcp(false); setDhcpStart(''); setDhcpEnd('')
    } catch (e: any) {
      setError(e?.message || String(e))
    } finally {
      setSaving(false)
    }
  }

  // Maps a validateDhcpRange reason to an i18n key (UI surface, not DB).
  const dhcpErrorMessage = !dhcpValidation.ok ? (() => {
    switch (dhcpValidation.reason) {
      case 'invalid_start': return t('myVdc.subnetDhcpStartInvalid')
      case 'invalid_end': return t('myVdc.subnetDhcpEndInvalid')
      case 'reversed': return t('myVdc.subnetDhcpReversed')
      case 'gateway_in_range': return t('myVdc.subnetDhcpGatewayInRange')
      default: return ''
    }
  })() : ''

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

          <Divider />

          {/* Subnet / IPAM block — opt-out via the toggle for bridge-only
              VNets (no L3, no auto-IP for VMs). */}
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
            <FormControlLabel
              control={<Switch checked={configureSubnet} onChange={(e) => setConfigureSubnet(e.target.checked)} />}
              label={t('myVdc.subnetConfigureToggle')}
            />
            <Tooltip title={t('myVdc.subnetConfigureHelp')} arrow placement="right">
              <i className="ri-information-line" style={{ fontSize: 16, opacity: 0.55, cursor: 'help' }} />
            </Tooltip>
          </Box>

          {configureSubnet && (
            <Stack spacing={1.5} sx={{ pl: 1, borderLeft: '2px solid', borderColor: 'divider', ml: 0.5 }}>
              <Alert severity="info" icon={<i className="ri-information-line" />} sx={{ py: 0.5, fontSize: '0.8rem' }}>
                {t('myVdc.subnetIpamBanner')}
              </Alert>
              <TextField
                label={t('myVdc.subnetCidr')}
                value={cidr}
                onChange={(e) => setCidr(e.target.value.trim())}
                error={!!cidr && !cidrValid}
                helperText={
                  !cidr
                    ? t('myVdc.subnetCidrHint')
                    : !cidrValid
                      ? t('myVdc.subnetCidrInvalid')
                      : t('myVdc.subnetCidrUsable', { count: usableHostCount(cidr) })
                }
                fullWidth
                size="small"
                placeholder="10.42.0.0/24"
              />
              <TextField
                label={t('myVdc.subnetGateway')}
                value={gateway}
                onChange={(e) => setGateway(e.target.value.trim())}
                error={!!gateway && !gatewayValid}
                helperText={
                  !!gateway && !gatewayValid
                    ? t('myVdc.subnetGatewayInvalid')
                    : t('myVdc.subnetGatewayHint')
                }
                fullWidth
                size="small"
                placeholder="10.42.0.1"
                disabled={!cidrValid}
              />
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
                  control={<Switch checked={enableDhcp} onChange={(e) => setEnableDhcp(e.target.checked)} disabled={!cidrValid} />}
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
                    error={!!dhcpStart && !dhcpValidation.ok && (dhcpValidation.reason === 'invalid_start' || dhcpValidation.reason === 'reversed' || dhcpValidation.reason === 'gateway_in_range')}
                    fullWidth
                    size="small"
                  />
                  <TextField
                    label={t('myVdc.subnetDhcpEnd')}
                    value={dhcpEnd}
                    onChange={(e) => setDhcpEnd(e.target.value.trim())}
                    error={!!dhcpEnd && !dhcpValidation.ok && (dhcpValidation.reason === 'invalid_end' || dhcpValidation.reason === 'reversed' || dhcpValidation.reason === 'gateway_in_range')}
                    fullWidth
                    size="small"
                  />
                </Box>
              )}
              {enableDhcp && !!dhcpErrorMessage && (
                <Alert severity="error" sx={{ py: 0.5 }}>{dhcpErrorMessage}</Alert>
              )}
            </Stack>
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
        <Button variant="contained" onClick={handleSubmit} disabled={!canSubmit}>{t('common.create')}</Button>
      </DialogActions>
    </Dialog>
  )
}
