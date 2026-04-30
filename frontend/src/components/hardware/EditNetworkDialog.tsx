'use client'

import React, { useState, useEffect } from 'react'
import { useTranslations } from 'next-intl'

import {
  Dialog,
  DialogContent,
  DialogActions,
  Button,
  TextField,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  FormControlLabel,
  Checkbox,
  Box,
  Typography,
  Stack,
  Alert,
  CircularProgress,
  Divider,
  Tooltip,
} from '@mui/material'

import AppDialogTitle from '@/components/ui/AppDialogTitle'

// ==================== EDIT NETWORK DIALOG ====================
type EditNetworkDialogProps = {
  open: boolean
  onClose: () => void
  onSave: (config: any) => Promise<void>
  onDelete: () => Promise<void>
  connId: string
  node: string
  network: {
    id: string
    model: string
    bridge: string
    mac?: string
    vlan?: number
    firewall?: boolean
    linkDown?: boolean
    rate?: number
    mtu?: number
    queues?: number
  } | null
}

export function EditNetworkDialog({ open, onClose, onSave, onDelete, connId, node, network }: EditNetworkDialogProps) {
  const t = useTranslations()
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showAdvanced, setShowAdvanced] = useState(false)

  // Bridges disponibles
  // {iface,label,kind}: iface is the actual PVE bridge name (hashed for tenant
  // VNets); label is the user-friendly display name; kind tells us whether
  // this is a SDN VNet, a shared bridge, or a raw physical bridge — used to
  // gate the per-NIC VLAN tag field which PVE rejects on VXLAN VNets.
  const [bridges, setBridges] = useState<Array<{ iface: string; label: string; kind: 'vnet' | 'shared' | 'bridge' }>>([])

  // Network config
  const [bridge, setBridge] = useState('vmbr0')
  const [model, setModel] = useState('virtio')
  const [vlanTag, setVlanTag] = useState('')
  const [macAddress, setMacAddress] = useState('')
  const [firewall, setFirewall] = useState(true)
  const [disconnect, setDisconnect] = useState(false)
  const [rateLimit, setRateLimit] = useState('')
  const [mtu, setMtu] = useState('')
  const [multiqueue, setMultiqueue] = useState('')

  // Charger les bridges et initialiser les valeurs
  useEffect(() => {
    if (!open || !connId || !node) return

    const loadBridges = async () => {
      try {
        const res = await fetch(
          `/api/v1/connections/${encodeURIComponent(connId)}/network-choices?node=${encodeURIComponent(node)}`
        )
        if (res.ok) {
          const json = await res.json()
          const choices = Array.isArray(json.data) ? json.data : []
          const bridgeList = choices.map((c: any) => ({
            iface: c.name,
            label: c.kind === 'vnet'
              ? (c.displayName ?? c.name)
              : c.kind === 'shared'
                ? (c.label ?? c.name)
                : c.name,
            kind: (c.kind === 'vnet' || c.kind === 'shared' ? c.kind : 'bridge') as 'vnet' | 'shared' | 'bridge',
          }))

          const fallback = [
            { iface: 'vmbr0', label: 'vmbr0', kind: 'bridge' as const },
            { iface: 'vmbr1', label: 'vmbr1', kind: 'bridge' as const },
          ]
          setBridges(bridgeList.length > 0 ? bridgeList : fallback)
        } else {
          setBridges([
            { iface: 'vmbr0', label: 'vmbr0', kind: 'bridge' },
            { iface: 'vmbr1', label: 'vmbr1', kind: 'bridge' },
          ])
        }
      } catch (e) {
        setBridges([
          { iface: 'vmbr0', label: 'vmbr0', kind: 'bridge' },
          { iface: 'vmbr1', label: 'vmbr1', kind: 'bridge' },
        ])
      }
    }

    loadBridges()
  }, [open, connId, node])

  // Initialiser les valeurs depuis le network
  useEffect(() => {
    if (open && network) {
      setBridge(network.bridge || 'vmbr0')
      setModel(network.model || 'virtio')
      setVlanTag(network.vlan ? String(network.vlan) : '')
      setMacAddress(network.mac || '')
      // PVE convention: missing `firewall=` parameter = firewall OFF.
      // Our parser leaves network.firewall as undefined when the key isn't
      // present in the config, so map undefined to false to match PVE,
      // instead of the previous `!== false` which mapped undefined to true
      // and silently flipped the firewall on when the user clicked Save.
      setFirewall(network.firewall === true)
      setDisconnect(network.linkDown || false)
      setRateLimit(network.rate ? String(network.rate) : '')
      setMtu(network.mtu ? String(network.mtu) : '')
      setMultiqueue(network.queues ? String(network.queues) : '')
    }
  }, [open, network])

  const handleSave = async () => {
    if (!network) return

    setSaving(true)
    setError(null)

    try {
      // SDN VXLAN VNets reject per-NIC VLAN tags — drop the tag client-side
      // even if the field somehow holds a stale value from a prior bridge
      // selection, so the user doesn't hit a 400 from PVE.
      const selectedBridge = bridges.find(b => b.iface === bridge)
      const isSdnVnet = selectedBridge?.kind === 'vnet'

      let netConfig = `${model},bridge=${bridge}`

      if (macAddress) netConfig += `,macaddr=${macAddress}`
      if (!isSdnVnet && vlanTag) netConfig += `,tag=${vlanTag}`
      if (firewall) netConfig += ',firewall=1'
      if (disconnect) netConfig += ',link_down=1'
      if (rateLimit) netConfig += `,rate=${rateLimit}`
      if (mtu) netConfig += `,mtu=${mtu}`
      if (multiqueue) netConfig += `,queues=${multiqueue}`

      await onSave({ [network.id]: netConfig })
      onClose()
    } catch (e: any) {
      setError(e.message || t('errors.updateError'))
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!network) return
    if (!confirm(t('hardware.confirmDeleteNetwork', { id: network.id }))) return

    setDeleting(true)
    setError(null)

    try {
      await onDelete()
      onClose()
    } catch (e: any) {
      setError(e.message || t('errors.deleteError'))
    } finally {
      setDeleting(false)
    }
  }

  if (!network) return null

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <AppDialogTitle onClose={onClose} icon={<i className="ri-router-line" style={{ fontSize: 24 }} />}>
        {t('common.edit')}: {network.id}
      </AppDialogTitle>

      <DialogContent>
        {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

        <Stack spacing={2} sx={{ mt: 1 }}>
          {/* Bridge & Model */}
          <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 2 }}>
            <FormControl fullWidth size="small">
              <InputLabel>Bridge</InputLabel>
              <Select value={bridge} onChange={(e) => setBridge(e.target.value)} label="Bridge">
                {bridges.map((b) => (
                  <MenuItem key={b.iface} value={b.iface}>
                    {b.label}
                    {b.label !== b.iface && (
                      <span style={{ opacity: 0.45, marginLeft: 8, fontSize: '0.75em' }}>{b.iface}</span>
                    )}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            <FormControl fullWidth size="small">
              <InputLabel>Model</InputLabel>
              <Select value={model} onChange={(e) => setModel(e.target.value)} label="Model">
                <MenuItem value="e1000">Intel E1000</MenuItem>
                <MenuItem value="e1000e">Intel E1000E</MenuItem>
                <MenuItem value="virtio">VirtIO (paravirtualized)</MenuItem>
                <MenuItem value="rtl8139">Realtek RTL8139</MenuItem>
                <MenuItem value="vmxnet3">VMware vmxnet3</MenuItem>
              </Select>
            </FormControl>
          </Box>

          {/* VLAN & MAC */}
          {(() => {
            const selectedBridge = bridges.find(b => b.iface === bridge)
            const isSdnVnet = selectedBridge?.kind === 'vnet'
            // PVE rejects per-NIC VLAN tags on VXLAN SDN VNets unless the
            // VNet has VLAN aware enabled (which is mutually exclusive with
            // an attached subnet, so almost never the case in our flow).
            // Surface this constraint inline instead of letting the user hit
            // a 400 from PVE.
            const tagField = (
              <TextField
                size="small"
                label="VLAN Tag"
                placeholder={isSdnVnet ? '— SDN VNet, tag ignored' : 'no VLAN'}
                value={isSdnVnet ? '' : vlanTag}
                onChange={(e) => setVlanTag(e.target.value)}
                type="number"
                disabled={isSdnVnet}
                helperText={isSdnVnet ? 'Use a separate VNet to segment traffic' : undefined}
              />
            )
            return (
              <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 2 }}>
                {isSdnVnet ? (
                  <Tooltip
                    arrow
                    placement="top"
                    title="VLAN tagging on a NIC isn't supported on VXLAN SDN VNets — each VNet is already its own isolated L2 domain (VNI). To split traffic, create a second VNet instead of tagging a NIC here."
                  >
                    <span>{tagField}</span>
                  </Tooltip>
                ) : (
                  tagField
                )}
                <TextField
                  size="small"
                  label="MAC address"
                  value={macAddress}
                  onChange={(e) => setMacAddress(e.target.value)}
                />
              </Box>
            )
          })()}

          {/* Checkboxes */}
          <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1 }}>
            <FormControlLabel
              control={<Checkbox checked={firewall} onChange={(e) => setFirewall(e.target.checked)} size="small" />}
              label="Firewall"
            />
            <FormControlLabel
              control={<Checkbox checked={disconnect} onChange={(e) => setDisconnect(e.target.checked)} size="small" />}
              label="Disconnect"
            />
          </Box>

          {/* Advanced */}
          <FormControlLabel
            control={<Checkbox checked={showAdvanced} onChange={(e) => setShowAdvanced(e.target.checked)} size="small" />}
            label="Advanced"
          />

          {showAdvanced && (
            <>
              <Divider />
              <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 2 }}>
                <TextField
                  size="small"
                  label="Rate limit (MB/s)"
                  value={rateLimit}
                  onChange={(e) => setRateLimit(e.target.value)}
                  type="number"
                />
                <TextField
                  size="small"
                  label="MTU"
                  placeholder="1500"
                  value={mtu}
                  onChange={(e) => setMtu(e.target.value)}
                  type="number"
                />
              </Box>
              <TextField
                size="small"
                label="Multiqueue"
                value={multiqueue}
                onChange={(e) => setMultiqueue(e.target.value)}
                type="number"
                fullWidth
              />
            </>
          )}
        </Stack>
      </DialogContent>

      <DialogActions sx={{ px: 3, pb: 2, justifyContent: 'space-between' }}>
        <Button
          color="error"
          onClick={handleDelete}
          disabled={saving || deleting}
          startIcon={deleting ? <CircularProgress size={16} /> : <i className="ri-delete-bin-line" />}
        >
          {t('common.delete')}
        </Button>
        <Box>
          <Button onClick={onClose} disabled={saving || deleting} sx={{ mr: 1 }}>{t('common.cancel')}</Button>
          <Button variant="contained" onClick={handleSave} disabled={saving || deleting}>
            {saving ? <CircularProgress size={20} /> : t('common.save')}
          </Button>
        </Box>
      </DialogActions>
    </Dialog>
  )
}
