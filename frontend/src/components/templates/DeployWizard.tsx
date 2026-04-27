'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControl,
  FormControlLabel,
  InputLabel,
  ListSubheader,
  MenuItem,
  Select,
  Stack,
  Step,
  StepLabel,
  Stepper,
  Switch,
  TextField,
  Typography,
} from '@mui/material'

import type { CloudImage } from '@/lib/templates/cloudImages'
import { supportsVmDisks } from '@/lib/proxmox/storage'
import DeploymentProgress from './DeploymentProgress'
import VendorLogo from './VendorLogo'
import { useTenant } from '@/contexts/TenantContext'
import VdcQuotaBanner from '@/components/inventory/VdcQuotaBanner'

interface DeployWizardProps {
  open: boolean
  onClose: () => void
  image: CloudImage | null
  prefillBlueprint?: any | null
}

const STEP_LABELS = [
  'templates.deploy.steps.image',
  'templates.deploy.steps.target',
  'templates.deploy.steps.hardware',
  'templates.deploy.steps.cloudInit',
  'templates.deploy.steps.review',
  'templates.deploy.steps.progress',
] as const

interface Connection {
  id: string
  name: string
  type: string
}

interface NodeInfo {
  node: string
  status: string
  cpu: number
  maxcpu: number
  mem: number
  maxmem: number
}

interface StorageInfo {
  storage: string
  content: string
  total: number
  used: number
  avail: number
  type: string
}

export default function DeployWizard({ open, onClose, image, prefillBlueprint }: DeployWizardProps) {
  const t = useTranslations()
  // Tenants get cloud-style abstraction in step "Target": no connection /
  // node / storage / VMID picker. They only enter a name. Selections are
  // resolved in the background (first allowed connection, least-loaded
  // node, first shared storage, /cluster/nextid).
  const { currentTenant, loading: tenantLoading } = useTenant()
  const hideInfra = !tenantLoading && !!currentTenant && currentTenant.id !== 'default'
  const [activeStep, setActiveStep] = useState(0)
  const [deploying, setDeploying] = useState(false)
  const [deploymentId, setDeploymentId] = useState<string | null>(null)
  const [deployError, setDeployError] = useState<string | null>(null)

  // Target step
  const [connections, setConnections] = useState<Connection[]>([])
  const [connectionId, setConnectionId] = useState('')
  const [nodes, setNodes] = useState<NodeInfo[]>([])
  const [node, setNode] = useState('')
  const [storages, setStorages] = useState<StorageInfo[]>([])
  const [storage, setStorage] = useState('')
  const [vmid, setVmid] = useState<number>(100)
  const [vmName, setVmName] = useState('')

  // Hardware step
  const [cores, setCores] = useState(2)
  const [sockets, setSockets] = useState(1)
  const [memory, setMemory] = useState(2048)
  const [diskSize, setDiskSize] = useState('20G')
  const [scsihw, setScsihw] = useState('virtio-scsi-single')
  const [networkModel, setNetworkModel] = useState('virtio')
  const [networkBridge, setNetworkBridge] = useState('vmbr0')
  const [vlanTag, setVlanTag] = useState<number | ''>('')
  const [cpu, setCpu] = useState('host')

  // vDC quota (tenant only — provider has no vDC scope so banner stays hidden)
  const [vdcQuota, setVdcQuota] = useState<{ maxVcpus: number | null; maxRamMb: number | null; maxStorageMb: number | null; maxVms: number | null } | null>(null)
  const [vdcUsage, setVdcUsage] = useState<{ usedVcpus: number; usedRamMb: number; usedStorageMb: number; usedVms: number } | null>(null)
  const [quotaBlocked, setQuotaBlocked] = useState(false)

  // Bridges + VNets for the network picker. Mirrors the shape used by
  // CreateVmDialog so we hit the same `/network-choices` endpoint.
  // type values: 'vnet' (tenant SDN), 'shared' (provider uplink), or a
  // PVE bridge type (e.g. 'bridge', 'OVSBridge').
  const [bridges, setBridges] = useState<Array<{ iface: string; type: string; label?: string | null; vdc?: string | null }>>([])
  const [agent, setAgent] = useState(true)

  // Cloud-init step
  const [ciuser, setCiuser] = useState('')
  const [cipassword, setCipassword] = useState('')
  const [sshKeys, setSshKeys] = useState('')
  const [ipconfig0, setIpconfig0] = useState('ip=dhcp')
  const [nameserver, setNameserver] = useState('')
  const [searchdomain, setSearchdomain] = useState('')

  // Save as blueprint
  const [saveAsBlueprint, setSaveAsBlueprint] = useState(false)
  const [blueprintName, setBlueprintName] = useState('')

  // Reset state on open
  useEffect(() => {
    if (!open) return
    setActiveStep(0)
    setDeploying(false)
    setDeploymentId(null)
    setDeployError(null)

    if (image) {
      setCores(image.recommendedCores)
      setMemory(image.recommendedMemory)
      setDiskSize(image.defaultDiskSize)
      setVmName('')
    }

    // Prefill from blueprint
    if (prefillBlueprint) {
      try {
        const hw = typeof prefillBlueprint.hardware === 'string'
          ? JSON.parse(prefillBlueprint.hardware)
          : prefillBlueprint.hardware
        setCores(hw.cores || 2)
        setSockets(hw.sockets || 1)
        setMemory(hw.memory || 2048)
        setDiskSize(hw.diskSize || '20G')
        setScsihw(hw.scsihw || 'virtio-scsi-single')
        setNetworkModel(hw.networkModel || 'virtio')
        setNetworkBridge(hw.networkBridge || 'vmbr0')
        setVlanTag(hw.vlanTag || '')
        setCpu(hw.cpu || 'host')
        setAgent(hw.agent !== false)
      } catch { /* ignore */ }

      try {
        const ci = prefillBlueprint.cloudInit
          ? (typeof prefillBlueprint.cloudInit === 'string'
            ? JSON.parse(prefillBlueprint.cloudInit)
            : prefillBlueprint.cloudInit)
          : null
        if (ci) {
          setCiuser(ci.ciuser || '')
          setCipassword(ci.cipassword || '')
          setSshKeys(ci.sshKeys || '')
          setIpconfig0(ci.ipconfig0 || 'ip=dhcp')
          setNameserver(ci.nameserver || '')
          setSearchdomain(ci.searchdomain || '')
        }
      } catch { /* ignore */ }

      // Prefill target from retry
      if (prefillBlueprint._retryFrom) {
        const rf = prefillBlueprint._retryFrom
        if (rf.connectionId) setConnectionId(rf.connectionId)
        if (rf.node) setNode(rf.node)
        if (rf.storage) setStorage(rf.storage)
        if (rf.vmName) setVmName(rf.vmName)
      }
    }
  }, [open, image, prefillBlueprint])

  // Fetch connections
  useEffect(() => {
    if (!open) return
    fetch('/api/v1/connections?type=pve')
      .then(r => r.json())
      .then(res => {
        const conns = res.data || []
        setConnections(conns)
        // Tenant: auto-pick the first connection from their vDC scope so
        // step Target requires no input. Provider keeps manual selection
        // unless there's a single option.
        if (conns.length === 1 || (hideInfra && conns.length > 0)) {
          setConnectionId(conns[0].id)
        }
      })
      .catch(() => {})
  }, [open, hideInfra])

  // Fetch nodes when connection changes
  useEffect(() => {
    if (!connectionId) { setNodes([]); setNode(''); return }
    fetch(`/api/v1/connections/${encodeURIComponent(connectionId)}/nodes`)
      .then(r => r.json())
      .then(res => {
        const nodeList = (res.data || []).filter((n: any) => n.status === 'online')
        setNodes(nodeList)
        if (nodeList.length === 1) {
          setNode(nodeList[0].node)
        } else if (hideInfra && nodeList.length > 0) {
          // Pick least-loaded online node (cpu + 1.5*ram, RAM weighted higher).
          const scored = nodeList.map((n: any) => {
            const cpuPct = n.maxcpu ? (n.cpu || 0) * 100 : 0
            const memPct = n.maxmem ? ((n.mem || 0) / n.maxmem) * 100 : 0
            return { n, score: cpuPct + 1.5 * memPct }
          })
          scored.sort((a: any, b: any) => a.score - b.score)
          setNode(scored[0].n.node)
        }
      })
      .catch(() => setNodes([]))
  }, [connectionId, hideInfra])

  // Fetch storages + next VMID when node changes
  useEffect(() => {
    if (!connectionId || !node) { setStorages([]); return }

    // Fetch file-based storages (content types are auto-enabled by the deploy route)
    fetch(`/api/v1/connections/${encodeURIComponent(connectionId)}/nodes/${encodeURIComponent(node)}/storages`)
      .then(r => r.json())
      .then(res => {
        // Filter on BOTH type AND content. supportsVmDisks() only checks the
        // backing technology (dir, NFS, RBD, …); we still need the storage
        // to be configured for `images` (or `rootdir`) — otherwise PVE
        // rejects the VM creation with "storage X does not support vm images".
        const stList = (res.data || []).filter((s: any) =>
          supportsVmDisks(s.type)
          && s.enabled !== 0
          && (s.content?.includes('images') || s.content?.includes('rootdir')),
        )
        setStorages(stList)
        // Tenant: prefer a shared storage (cluster-wide, no node leak), then
        // fall back to the first available. Provider keeps the existing
        // first-match logic.
        if (stList.length > 0) {
          if (hideInfra) {
            const shared = stList.find((s: any) => s.shared)
            setStorage((shared || stList[0]).storage)
          } else {
            setStorage(stList[0].storage)
          }
        } else {
          setStorage('')
        }
      })
      .catch(() => setStorages([]))

    // Try to get next available VMID
    fetch(`/api/v1/connections/${encodeURIComponent(connectionId)}/cluster/nextid`)
      .then(r => r.json())
      .then(res => {
        if (res.data) setVmid(Number(res.data) || 100)
      })
      .catch(() => {})

    // Network bridges + tenant vDC VNets — populates the bridge picker on
    // the Hardware step. Mirrors the call made by CreateVmDialog so we
    // honour the same vDC whitelist server-side: tenants get their VNets
    // and shared bridges, providers get the full PVE bridge list.
    fetch(`/api/v1/connections/${encodeURIComponent(connectionId)}/network-choices?node=${encodeURIComponent(node)}`)
      .then(r => r.json())
      .then(res => {
        const choices = Array.isArray(res?.data) ? res.data : []
        const list = choices.map((c: any) => ({
          iface: c.name,
          type: c.kind === 'vnet' ? 'vnet' : c.kind === 'shared' ? 'shared' : (c.type || 'bridge'),
          label: c.label ?? null,
          vdc: c.vdc ?? null,
        }))
        setBridges(list)
        if (list.length > 0 && !list.some(b => b.iface === networkBridge)) {
          setNetworkBridge(list[0].iface)
        }
      })
      .catch(() => setBridges([]))
  }, [connectionId, node, hideInfra])

  // Fetch the tenant's vDC quota+usage for the live quota banner on the
  // Hardware step. The /api/v1/vdcs route already returns null for the
  // provider tenant (no vDC), so the banner only shows up for tenants.
  useEffect(() => {
    if (!open || !connectionId) {
      setVdcQuota(null); setVdcUsage(null)
      return
    }
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch('/api/v1/vdcs')
        if (!res.ok) { if (!cancelled) { setVdcQuota(null); setVdcUsage(null) } ; return }
        const json = await res.json()
        const vdcs: any[] = Array.isArray(json?.data) ? json.data : []
        const match = vdcs.find(v => v.connectionId === connectionId || v.connection_id === connectionId)
        if (cancelled) return
        if (match?.quota) {
          setVdcQuota({
            maxVcpus: match.quota.maxVcpus ?? null,
            maxRamMb: match.quota.maxRamMb ?? null,
            maxStorageMb: match.quota.maxStorageMb ?? null,
            maxVms: match.quota.maxVms ?? null,
          })
          setVdcUsage({
            usedVcpus: match.usage?.usedVcpus ?? 0,
            usedRamMb: match.usage?.usedRamMb ?? 0,
            usedStorageMb: match.usage?.usedStorageMb ?? 0,
            usedVms: match.usage?.usedVms ?? 0,
          })
        } else {
          setVdcQuota(null); setVdcUsage(null)
        }
      } catch {
        if (!cancelled) { setVdcQuota(null); setVdcUsage(null) }
      }
    })()
    return () => { cancelled = true }
  }, [open, connectionId])

  const handleNext = useCallback(() => {
    setActiveStep(s => Math.min(s + 1, STEP_LABELS.length - 1))
  }, [])

  const handleBack = useCallback(() => {
    setActiveStep(s => Math.max(s - 1, 0))
  }, [])

  const handleDeploy = useCallback(async () => {
    if (!image) return
    setDeploying(true)
    setDeployError(null)
    setActiveStep(5) // Progress step

    try {
      const body = {
        connectionId,
        node,
        storage,
        vmid,
        vmName: vmName || undefined,
        imageSlug: image.slug,
        blueprintId: prefillBlueprint?.id || undefined,
        hardware: {
          cores,
          sockets,
          memory,
          diskSize,
          scsihw,
          networkModel,
          networkBridge,
          vlanTag: vlanTag || null,
          ostype: image.ostype,
          agent,
          cpu,
        },
        cloudInit: {
          ciuser: ciuser || undefined,
          cipassword: cipassword || undefined,
          sshKeys: sshKeys || undefined,
          ipconfig0,
          nameserver: nameserver || undefined,
          searchdomain: searchdomain || undefined,
        },
        saveAsBlueprint,
        blueprintName: saveAsBlueprint ? blueprintName : undefined,
      }

      const res = await fetch('/api/v1/templates/deploy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })

      const text = await res.text()
      let data: any
      try {
        data = JSON.parse(text)
      } catch {
        console.warn('[DeployWizard] Non-JSON response from /api/v1/templates/deploy →', text.slice(0, 200))
        setDeployError('Server returned an invalid response')
        setDeploying(false)
        return
      }
      if (data.error) {
        // Validation / permission errors from the sync part
        setDeployError(data.error)
        setDeploying(false)
        return
      }
      if (data.data?.deploymentId) {
        setDeploymentId(data.data.deploymentId)
      }
    } catch (err: any) {
      setDeployError(err.message || 'Deploy failed')
      setDeploying(false)
    }
  }, [
    image, connectionId, node, storage, vmid, vmName, cores, sockets, memory,
    diskSize, scsihw, networkModel, networkBridge, vlanTag, cpu, agent,
    ciuser, cipassword, sshKeys, ipconfig0, nameserver, searchdomain,
    saveAsBlueprint, blueprintName, prefillBlueprint,
  ])

  const handleDeployComplete = useCallback((status: 'completed' | 'failed', error?: string) => {
    setDeploying(false)
    if (status === 'failed' && error) setDeployError(error)
  }, [])

  const canProceed = useMemo(() => {
    switch (activeStep) {
      case 0: return !!image
      case 1: return !!connectionId && !!node && !!storage && vmid >= 100
      // Hardware step: also block while the vDC quota would be exceeded.
      case 2: return cores >= 1 && memory >= 128 && !!diskSize && !quotaBlocked
      case 3: return true
      case 4: return !quotaBlocked
      default: return false
    }
  }, [activeStep, image, connectionId, node, storage, vmid, cores, memory, diskSize, quotaBlocked])

  // ─── Step renderers ────────────────────────────────────────────────

  const renderImageStep = () => {
    if (!image) return null
    return (
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          <Box
            sx={{
              width: 56, height: 56, borderRadius: 2,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            <VendorLogo vendor={image.vendor} size={48} />
          </Box>
          <Box>
            <Typography variant="h6">{image.name}</Typography>
            <Typography variant="body2" sx={{ opacity: 0.6 }}>
              {image.arch} &middot; {image.format} &middot; {image.ostype}
            </Typography>
          </Box>
        </Box>
        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
          {image.tags.map(tag => (
            <Chip key={tag} label={tag} size="small" />
          ))}
        </Box>
        <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 2 }}>
          <Box>
            <Typography variant="caption" sx={{ opacity: 0.6 }}>{t('templates.catalog.recommendedSpecs')}</Typography>
            <Typography variant="body2">
              {image.recommendedCores} {t('templates.catalog.cores')} / {image.recommendedMemory >= 1024 ? `${image.recommendedMemory / 1024} GB` : `${image.recommendedMemory} MB`} RAM / {image.defaultDiskSize} {t('templates.deploy.hardware.disk')}
            </Typography>
          </Box>
          <Box>
            <Typography variant="caption" sx={{ opacity: 0.6 }}>{t('templates.catalog.minimumSpecs')}</Typography>
            <Typography variant="body2">
              {image.minCores} {t('templates.catalog.cores')} / {image.minMemory >= 1024 ? `${image.minMemory / 1024} GB` : `${image.minMemory} MB`} RAM
            </Typography>
          </Box>
        </Box>
      </Box>
    )
  }

  const renderTargetStep = () => {
    // Tenant-facing simplified target: VM name only, the rest auto-resolved.
    if (hideInfra) {
      return (
        <Stack spacing={2}>
          <TextField
            size="small"
            fullWidth
            label={t('templates.deploy.target.vmName')}
            value={vmName}
            onChange={e => setVmName(e.target.value)}
            placeholder={image ? `${image.slug}-${vmid}` : ''}
            autoFocus
          />
        </Stack>
      )
    }

    return (
    <Stack spacing={2}>
      <FormControl size="small" fullWidth required>
        <InputLabel>{t('templates.deploy.target.connection')}</InputLabel>
        <Select
          value={connectionId}
          onChange={e => { setConnectionId(e.target.value); setNode(''); setStorage('') }}
          label={t('templates.deploy.target.connection')}
        >
          {connections.map(c => (
            <MenuItem key={c.id} value={c.id}>{c.name}</MenuItem>
          ))}
        </Select>
      </FormControl>

      <FormControl size="small" fullWidth required disabled={!connectionId}>
        <InputLabel>{t('templates.deploy.target.node')}</InputLabel>
        <Select
          value={node}
          onChange={e => { setNode(e.target.value); setStorage('') }}
          label={t('templates.deploy.target.node')}
        >
          {nodes.map(n => (
            <MenuItem key={n.node} value={n.node}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, width: '100%' }}>
                <Typography variant="body2">{n.node}</Typography>
                <Typography variant="caption" sx={{ opacity: 0.5, ml: 'auto' }}>
                  CPU: {(n.cpu * 100).toFixed(0)}% &middot; RAM: {((n.mem / n.maxmem) * 100).toFixed(0)}%
                </Typography>
              </Box>
            </MenuItem>
          ))}
        </Select>
      </FormControl>

      <FormControl size="small" fullWidth required disabled={!node}>
        <InputLabel>{t('templates.deploy.target.storage')}</InputLabel>
        <Select
          value={storage}
          onChange={e => setStorage(e.target.value)}
          label={t('templates.deploy.target.storage')}
        >
          {storages.map(s => (
            <MenuItem key={s.storage} value={s.storage}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, width: '100%' }}>
                <Typography variant="body2">{s.storage}</Typography>
                <Typography variant="caption" sx={{ opacity: 0.5, ml: 'auto' }}>
                  {s.type} &middot; {((s.avail || 0) / 1073741824).toFixed(1)} GB {t('templates.deploy.target.available')}
                </Typography>
              </Box>
            </MenuItem>
          ))}
        </Select>
      </FormControl>

      {node && storages.length === 0 && (
        <Alert severity="warning" variant="outlined">
          {t('templates.deploy.target.noFileStorage')}
        </Alert>
      )}

      <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 2 }}>
        <TextField
          size="small"
          label={t('templates.deploy.target.vmid')}
          type="number"
          value={vmid}
          onChange={e => setVmid(Number.parseInt(e.target.value) || 100)}
          required
          slotProps={{ htmlInput: { min: 100 } }}
        />
        <TextField
          size="small"
          label={t('templates.deploy.target.vmName')}
          value={vmName}
          onChange={e => setVmName(e.target.value)}
          placeholder={image ? `${image.slug}-${vmid}` : ''}
        />
      </Box>
    </Stack>
    )
  }

  // Convert "20G" → MB for the quota banner. Falls back to 0 on parse error.
  const parseDiskSizeMb = (s: string): number => {
    const m = /^(\d+)\s*([GTM]?)$/i.exec(String(s).trim())
    if (!m) return 0
    const n = Number.parseInt(m[1], 10)
    const unit = m[2].toUpperCase()
    if (unit === 'T') return n * 1024 * 1024
    if (unit === 'M') return n
    return n * 1024
  }

  const renderHardwareStep = () => (
    <Box>
      {vdcQuota && vdcUsage && (
        <VdcQuotaBanner
          quota={vdcQuota}
          usage={vdcUsage}
          requested={{
            vcpus: cores * sockets,
            ramMb: memory,
            storageMb: parseDiskSizeMb(diskSize),
            vms: 1,
          }}
          onStateChange={({ blocked }) => {
            if (blocked !== quotaBlocked) setQuotaBlocked(blocked)
          }}
        />
      )}
      <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 2 }}>
      {/* Cores + Memory only — sockets / SCSI controller / CPU type are
          implementation details that the deploy wizard hides for clarity.
          Defaults stay sensible (1 socket, virtio-scsi-single, host CPU)
          and the provider can still tweak them via the bare-metal
          CreateVmDialog if a specific need arises. */}
      <TextField
        size="small"
        label={t('templates.deploy.hardware.cores')}
        type="number"
        value={cores}
        onChange={e => setCores(Number.parseInt(e.target.value) || 1)}
        slotProps={{ htmlInput: { min: 1, max: 128 } }}
      />
      <TextField
        size="small"
        label={t('templates.deploy.hardware.memory')}
        type="number"
        value={memory}
        onChange={e => setMemory(Number.parseInt(e.target.value) || 512)}
        helperText="MB"
        slotProps={{ htmlInput: { min: 128, step: 256 } }}
      />
      <TextField
        size="small"
        label={t('templates.deploy.hardware.diskSize')}
        value={diskSize}
        onChange={e => setDiskSize(e.target.value)}
      />
      <FormControl size="small">
        <InputLabel>{t('templates.deploy.hardware.bridge')}</InputLabel>
        <Select
          value={bridges.some(b => b.iface === networkBridge) ? networkBridge : (bridges[0]?.iface || networkBridge)}
          onChange={e => setNetworkBridge(String(e.target.value))}
          label={t('templates.deploy.hardware.bridge')}
        >
          {bridges.length === 0 && (
            <MenuItem value={networkBridge}>{networkBridge}</MenuItem>
          )}
          {/* VNets first — these are the tenant's SDN networks (per vDC).
              Provider-managed shared bridges next, raw PVE bridges last. */}
          {bridges.filter(b => b.type === 'vnet').length > 0 && (
            <ListSubheader sx={{ lineHeight: '28px', fontSize: 11, fontWeight: 700, opacity: 0.7, textTransform: 'uppercase' }}>
              {t('templates.deploy.hardware.bridgeGroupVnets')}
            </ListSubheader>
          )}
          {bridges.filter(b => b.type === 'vnet').map(b => (
            <MenuItem key={b.iface} value={b.iface} sx={{ pl: 3 }}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, width: '100%' }}>
                <Box component="i" className="ri-shield-keyhole-line" sx={{ fontSize: 14, color: 'primary.main' }} />
                <Typography variant="body2">{b.iface}</Typography>
                {b.vdc && (
                  <Typography variant="caption" sx={{ opacity: 0.55, ml: 'auto' }}>
                    {b.vdc}
                  </Typography>
                )}
              </Box>
            </MenuItem>
          ))}
          {bridges.filter(b => b.type === 'shared').length > 0 && (
            <ListSubheader sx={{ lineHeight: '28px', fontSize: 11, fontWeight: 700, opacity: 0.7, textTransform: 'uppercase' }}>
              {t('templates.deploy.hardware.bridgeGroupShared')}
            </ListSubheader>
          )}
          {bridges.filter(b => b.type === 'shared').map(b => (
            <MenuItem key={b.iface} value={b.iface} sx={{ pl: 3 }}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, width: '100%' }}>
                <Box component="i" className="ri-share-line" sx={{ fontSize: 14, opacity: 0.7 }} />
                <Typography variant="body2">{b.iface}</Typography>
                {b.label && (
                  <Typography variant="caption" sx={{ opacity: 0.55, ml: 'auto' }}>
                    {b.label}
                  </Typography>
                )}
              </Box>
            </MenuItem>
          ))}
          {bridges.filter(b => b.type !== 'vnet' && b.type !== 'shared').length > 0 && (
            <ListSubheader sx={{ lineHeight: '28px', fontSize: 11, fontWeight: 700, opacity: 0.7, textTransform: 'uppercase' }}>
              {t('templates.deploy.hardware.bridgeGroupBridges')}
            </ListSubheader>
          )}
          {bridges.filter(b => b.type !== 'vnet' && b.type !== 'shared').map(b => (
            <MenuItem key={b.iface} value={b.iface} sx={{ pl: 3 }}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, width: '100%' }}>
                <Box component="i" className="ri-bridge-line" sx={{ fontSize: 14, opacity: 0.7 }} />
                <Typography variant="body2">{b.iface}</Typography>
              </Box>
            </MenuItem>
          ))}
        </Select>
      </FormControl>
      <TextField
        size="small"
        label={t('templates.deploy.hardware.vlan')}
        type="number"
        value={vlanTag}
        onChange={e => setVlanTag(e.target.value ? Number.parseInt(e.target.value) : '')}
        placeholder={t('templates.deploy.hardware.vlanPlaceholder')}
        slotProps={{ htmlInput: { min: 1, max: 4094 } }}
        // VNets carry their own intrinsic tag — disable the manual override
        // when a VNet is selected to prevent confusion / conflicts.
        disabled={bridges.find(b => b.iface === networkBridge)?.type === 'vnet'}
      />
      <FormControlLabel
        control={<Switch checked={agent} onChange={(_, v) => setAgent(v)} size="small" />}
        label={t('templates.deploy.hardware.qemuAgent')}
        sx={{ gridColumn: 'span 2' }}
      />
      </Box>
    </Box>
  )

  const renderCloudInitStep = () => (
    <Stack spacing={2}>
      <TextField
        size="small"
        label={t('templates.deploy.cloudInit.user')}
        value={ciuser}
        onChange={e => setCiuser(e.target.value)}
        placeholder="ubuntu"
        fullWidth
      />
      <TextField
        size="small"
        label={t('templates.deploy.cloudInit.password')}
        value={cipassword}
        onChange={e => setCipassword(e.target.value)}
        type="password"
        fullWidth
        placeholder={t('templates.deploy.cloudInit.passwordPlaceholder')}
      />
      <TextField
        size="small"
        label={t('templates.deploy.cloudInit.sshKeys')}
        value={sshKeys}
        onChange={e => setSshKeys(e.target.value)}
        multiline
        rows={3}
        fullWidth
        placeholder="ssh-ed25519 AAAA... user@host"
      />
      <TextField
        size="small"
        label={t('templates.deploy.cloudInit.ipConfig')}
        value={ipconfig0}
        onChange={e => setIpconfig0(e.target.value)}
        fullWidth
        helperText={t('templates.deploy.cloudInit.ipConfigHelp')}
      />
      <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 2 }}>
        <TextField
          size="small"
          label={t('templates.deploy.cloudInit.nameserver')}
          value={nameserver}
          onChange={e => setNameserver(e.target.value)}
          placeholder="1.1.1.1"
        />
        <TextField
          size="small"
          label={t('templates.deploy.cloudInit.searchdomain')}
          value={searchdomain}
          onChange={e => setSearchdomain(e.target.value)}
          placeholder="local.lan"
        />
      </Box>
    </Stack>
  )

  const renderReviewStep = () => {
    if (!image) return null

    const selectedConn = connections.find(c => c.id === connectionId)

    return (
      <Stack spacing={2}>
        {/* Image */}
        <Box>
          <Typography variant="overline" sx={{ opacity: 0.6 }}>{t('templates.deploy.steps.image')}</Typography>
          <Typography variant="body2">{image.name}</Typography>
        </Box>
        <Divider />

        {/* Target */}
        <Box>
          <Typography variant="overline" sx={{ opacity: 0.6 }}>{t('templates.deploy.steps.target')}</Typography>
          <Typography variant="body2">
            {selectedConn?.name} &rarr; {node} &rarr; {storage}
          </Typography>
          <Typography variant="body2">
            VMID: {vmid} {vmName && `(${vmName})`}
          </Typography>
        </Box>
        <Divider />

        {/* Hardware */}
        <Box>
          <Typography variant="overline" sx={{ opacity: 0.6 }}>{t('templates.deploy.steps.hardware')}</Typography>
          <Typography variant="body2">
            {cores}C &times; {sockets}S / {memory >= 1024 ? `${memory / 1024} GB` : `${memory} MB`} RAM / {diskSize} / {networkBridge}{vlanTag ? ` (VLAN ${vlanTag})` : ''}
          </Typography>
        </Box>
        <Divider />

        {/* Cloud-Init */}
        <Box>
          <Typography variant="overline" sx={{ opacity: 0.6 }}>{t('templates.deploy.steps.cloudInit')}</Typography>
          <Typography variant="body2">
            {ciuser ? `${t('templates.deploy.cloudInit.user')}: ${ciuser}` : t('templates.deploy.cloudInit.noUser')}
            {cipassword ? ` · ${t('templates.deploy.cloudInit.password')}: ••••••` : ''}
            {' · '}{ipconfig0}
          </Typography>
          {sshKeys && (
            <Typography variant="caption" sx={{ opacity: 0.6 }}>
              {sshKeys.split('\n').filter(Boolean).length} SSH key(s)
            </Typography>
          )}
        </Box>
        <Divider />

        {/* Save as blueprint option */}
        <FormControlLabel
          control={<Switch checked={saveAsBlueprint} onChange={(_, v) => setSaveAsBlueprint(v)} size="small" />}
          label={t('templates.deploy.review.saveBlueprint')}
        />
        {saveAsBlueprint && (
          <TextField
            size="small"
            label={t('templates.deploy.review.blueprintName')}
            value={blueprintName}
            onChange={e => setBlueprintName(e.target.value)}
            fullWidth
            placeholder={image.name}
          />
        )}
      </Stack>
    )
  }

  const renderProgressStep = () => {
    if (deploymentId) {
      return <DeploymentProgress deploymentId={deploymentId} onComplete={handleDeployComplete} />
    }

    if (deployError) {
      return (
        <Alert severity="error" sx={{ mt: 2 }}>
          {deployError}
        </Alert>
      )
    }

    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
        <CircularProgress />
      </Box>
    )
  }

  const stepContent = useMemo(() => {
    switch (activeStep) {
      case 0: return renderImageStep()
      case 1: return renderTargetStep()
      case 2: return renderHardwareStep()
      case 3: return renderCloudInitStep()
      case 4: return renderReviewStep()
      case 5: return renderProgressStep()
      default: return null
    }
  }, [
    activeStep, image, connections, connectionId, nodes, node, storages, storage,
    vmid, vmName, cores, sockets, memory, diskSize, scsihw, networkModel,
    networkBridge, vlanTag, cpu, agent, ciuser, cipassword, sshKeys, ipconfig0, nameserver,
    searchdomain, saveAsBlueprint, blueprintName, deploymentId, deployError, deploying, t,
  ])

  const isProgressStep = activeStep === 5

  return (
    <Dialog open={open} onClose={isProgressStep && deploying ? undefined : onClose} maxWidth="md" fullWidth>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <i className="ri-rocket-2-line" style={{ fontSize: 22 }} />
        {t('templates.deploy.title')}
      </DialogTitle>

      <DialogContent>
        <Stepper activeStep={activeStep} sx={{ mb: 3 }} alternativeLabel>
          {STEP_LABELS.map(label => (
            <Step key={label}>
              <StepLabel>{t(label as any)}</StepLabel>
            </Step>
          ))}
        </Stepper>

        <Box sx={{ minHeight: 300 }}>
          {stepContent}
        </Box>
      </DialogContent>

      {!isProgressStep && (
        <DialogActions>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Box sx={{ flex: 1 }} />
          {activeStep > 0 && (
            <Button onClick={handleBack}>{t('common.back')}</Button>
          )}
          {activeStep < 4 ? (
            <Button variant="contained" onClick={handleNext} disabled={!canProceed}>
              {t('common.next')}
            </Button>
          ) : (
            <Button
              variant="contained"
              color="success"
              onClick={handleDeploy}
              disabled={deploying}
              startIcon={deploying ? <CircularProgress size={18} /> : <i className="ri-rocket-2-line" style={{ fontSize: 16 }} />}
            >
              {t('templates.deploy.review.deployNow')}
            </Button>
          )}
        </DialogActions>
      )}

      {isProgressStep && !deploying && (
        <DialogActions>
          <Button variant="contained" onClick={onClose}>
            {deployError ? t('common.close') : t('common.done')}
          </Button>
        </DialogActions>
      )}
    </Dialog>
  )
}
