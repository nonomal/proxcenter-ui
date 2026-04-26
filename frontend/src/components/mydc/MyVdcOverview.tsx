'use client'

import { useMemo } from 'react'
import { useTranslations } from 'next-intl'

import { Box, Paper, Typography } from '@mui/material'

import QuotaDonut from './QuotaDonut'
import UplinksCard from './UplinksCard'
import MyStoragesCard from './MyStoragesCard'
import MyVmsCard from './MyVmsCard'
import HostsCard from './HostsCard'
import VnetList from './VnetList'
import MyBackupsCard from './MyBackupsCard'
import MyGreenCard from './MyGreenCard'

interface Props {
  vdc: any
}

/**
 * Tenant cockpit for a single vDC: quota donuts across the top, then a
 * 2-column grid (1 column on mobile) with VMs / VNets / Storages / Uplinks.
 * All data-fetching lives in the children; this file composes.
 */
export default function MyVdcOverview({ vdc }: Props) {
  const t = useTranslations()
  const usage = vdc.usage || {}
  const quota = vdc.quota || {}
  const unlimitedLabel = t('vdc.quotaUnlimited')
  const formatMbAsGb = (mb: number) => `${(mb / 1024).toFixed(1)} GB`

  const connectionIds = useMemo<string[]>(
    () => (vdc.connectionId ? [vdc.connectionId] : []),
    [vdc.connectionId],
  )
  const allowedStorages = useMemo<string[]>(
    () => (Array.isArray(vdc.storages) ? vdc.storages : []),
    [vdc.storages],
  )
  const allowedNodes = useMemo<string[]>(
    () => (Array.isArray(vdc.nodes) ? vdc.nodes : []),
    [vdc.nodes],
  )
  const pbsBindings = useMemo<any[]>(
    () => (Array.isArray(vdc.pbsBindings) ? vdc.pbsBindings : []),
    [vdc.pbsBindings],
  )

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {/* Block 1: Quota donuts */}
      <Paper sx={{ p: 2 }} variant="outlined">
        <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 1.5, display: 'flex', alignItems: 'center', gap: 1 }}>
          <i className="ri-gauge-line" />
          {t('myVdc.quotas')}
        </Typography>
        <Box
          sx={{
            display: 'grid',
            gap: 2,
            gridTemplateColumns: { xs: 'repeat(2, 1fr)', sm: 'repeat(4, 1fr)' },
            justifyItems: 'center',
          }}
        >
          <QuotaDonut icon="ri-cpu-line" label={t('vdc.maxVcpus')} used={usage.usedVcpus || 0} max={quota.maxVcpus} unlimitedLabel={unlimitedLabel} />
          <QuotaDonut
            icon="ri-ram-2-line"
            label={t('vdc.maxRam')}
            used={usage.usedRamMb || 0}
            max={quota.maxRamMb ?? null}
            formatValue={formatMbAsGb}
            unlimitedLabel={unlimitedLabel}
          />
          <QuotaDonut icon="ri-computer-line" label={t('vdc.maxVms')} used={usage.usedVms || 0} max={quota.maxVms} unlimitedLabel={unlimitedLabel} />
          <QuotaDonut icon="ri-git-branch-line" label={t('vdc.maxVnets')} used={(vdc.vnets || []).length} max={quota.maxVnets} unlimitedLabel={unlimitedLabel} />
        </Box>
      </Paper>

      {/* Blocks 2-7 in a 2-column grid */}
      <Box
        sx={{
          display: 'grid',
          gap: 2,
          gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' },
        }}
      >
        <HostsCard connectionIds={connectionIds} allowedNodes={allowedNodes} />
        <MyVmsCard connectionIds={connectionIds} />
        <VnetList vdcId={vdc.id} quota={{ maxVnets: quota.maxVnets ?? null }} />
        <MyStoragesCard connectionIds={connectionIds} allowedStorages={allowedStorages} />
        <UplinksCard vdcId={vdc.id} />
        <MyBackupsCard pbsBindings={pbsBindings} />
      </Box>

      {/* Green-IT card at the bottom — full width so the 3 sub-papers have
          room without clipping. */}
      <MyGreenCard vdcId={vdc.id} />
    </Box>
  )
}
