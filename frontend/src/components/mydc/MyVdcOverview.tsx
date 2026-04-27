'use client'

import { useMemo } from 'react'
import { useTranslations } from 'next-intl'

import { Box, Paper, Typography } from '@mui/material'
import { alpha, useTheme } from '@mui/material/styles'

import QuotaDonut from './QuotaDonut'
import UplinksCard from './UplinksCard'
import MyStoragesCard from './MyStoragesCard'
import MyVmsCard from './MyVmsCard'
import VnetList from './VnetList'
import MyBackupsCard from './MyBackupsCard'
import MyGreenCard from './MyGreenCard'
import MyDatacentersMapCard from './MyDatacentersMapCard'

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
  const theme = useTheme()
  const accent = theme.palette.primary.main
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
  const pbsBindings = useMemo<any[]>(
    () => (Array.isArray(vdc.pbsBindings) ? vdc.pbsBindings : []),
    [vdc.pbsBindings],
  )

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {/* Block 1: Quota donuts — glassmorphism with subtle highlight */}
      <Paper
        variant="outlined"
        sx={{
          p: 2,
          position: 'relative',
          overflow: 'hidden',
          background: `linear-gradient(135deg, ${alpha(accent, 0.08)} 0%, ${alpha(theme.palette.background.paper, 0.98)} 50%, ${alpha(accent, 0.03)} 100%)`,
          borderColor: alpha(accent, 0.3),
          backdropFilter: 'blur(8px)',
          transition: 'border-color 0.2s, box-shadow 0.2s',
          '&:hover': {
            borderColor: alpha(accent, 0.5),
            boxShadow: `0 8px 32px ${alpha(accent, 0.15)}`,
          },
        }}
      >
        {/* Top-right highlight blob — the "reflet" */}
        <Box
          aria-hidden
          sx={{
            position: 'absolute',
            top: -50,
            right: -50,
            width: 200,
            height: 200,
            borderRadius: '50%',
            background: `radial-gradient(circle, ${alpha(accent, 0.12)} 0%, transparent 70%)`,
            pointerEvents: 'none',
          }}
        />
        <Box sx={{ position: 'relative' }}>
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
        </Box>
      </Paper>

      {/* Geographic map of datacentres hosting the vDC's resources. */}
      <MyDatacentersMapCard vdcId={vdc.id} />

      {/* Blocks 2-5 in a 2-column grid. Nodes are deliberately abstracted
          away from the tenant view (cloud-style) — the provider manages the
          underlying hosts via /infrastructure/inventory. */}
      <Box
        sx={{
          display: 'grid',
          gap: 2,
          gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' },
        }}
      >
        <MyVmsCard connectionIds={connectionIds} />
        <VnetList vdcId={vdc.id} quota={{ maxVnets: quota.maxVnets ?? null }} />
        <MyStoragesCard connectionIds={connectionIds} allowedStorages={allowedStorages} />
        <UplinksCard vdcId={vdc.id} />
      </Box>

      {/* Backups card — full width below the grid. PBS namespaces and
          retention timelines need horizontal real estate the half-width
          column was clipping. */}
      <MyBackupsCard pbsBindings={pbsBindings} />

      {/* Green-IT card at the bottom — full width so the 3 sub-papers have
          room without clipping. */}
      <MyGreenCard vdcId={vdc.id} />
    </Box>
  )
}
