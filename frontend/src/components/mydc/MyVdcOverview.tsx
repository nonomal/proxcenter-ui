'use client'

import { useMemo } from 'react'
import { useTranslations } from 'next-intl'

import { Box, Paper, Typography } from '@mui/material'

import QuotaDonut from './QuotaDonut'
import UplinksCard from './UplinksCard'
import MyStoragesCard from './MyStoragesCard'
import MyVmsCard from './MyVmsCard'
import VnetList from './VnetList'

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

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {/* Header */}
      <Box>
        <Typography variant="h6">{vdc.name}</Typography>
        {vdc.description && (
          <Typography variant="caption" color="text.secondary">{vdc.description}</Typography>
        )}
      </Box>

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

      {/* Blocks 2-5 in a 2x2 grid */}
      <Box
        sx={{
          display: 'grid',
          gap: 2,
          gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' },
        }}
      >
        <MyVmsCard connectionIds={connectionIds} />
        <Paper sx={{ p: 2 }} variant="outlined">
          <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 1.5, display: 'flex', alignItems: 'center', gap: 1 }}>
            <i className="ri-git-branch-line" />
            {t('myVdc.vnetsTitle')}
          </Typography>
          <VnetList vdcId={vdc.id} quota={{ maxVnets: quota.maxVnets ?? null }} />
        </Paper>
        <MyStoragesCard connectionIds={connectionIds} allowedStorages={allowedStorages} />
        <UplinksCard vdcId={vdc.id} />
      </Box>
    </Box>
  )
}
