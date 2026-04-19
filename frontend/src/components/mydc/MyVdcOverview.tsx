'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'

import { Box, Typography, Stack, Chip, Paper } from '@mui/material'

import QuotaDonut from './QuotaDonut'

interface Props {
  vdc: any
}

export default function MyVdcOverview({ vdc }: Props) {
  const t = useTranslations()
  const [sharedBridges, setSharedBridges] = useState<Array<{ bridge: string; label: string | null }>>([])

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch(`/api/v1/vdcs/${encodeURIComponent(vdc.id)}/shared-bridges`)
        const json = await res.json()
        setSharedBridges(Array.isArray(json.data) ? json.data : [])
      } catch {}
    })()
  }, [vdc.id])

  const usage = vdc.usage || {}
  const quota = vdc.quota || {}
  const unlimitedLabel = t('vdc.quotaUnlimited')
  const formatMbAsGb = (mb: number) => `${(mb / 1024).toFixed(1)} GB`

  return (
    <Paper sx={{ p: 2 }}>
      <Typography variant="h6" gutterBottom>{vdc.name}</Typography>

      <Stack direction="row" spacing={3} mb={2} flexWrap="wrap">
        <Box><Typography variant="caption" color="text.secondary">{t('myVdc.nodes')}</Typography><Typography>{(vdc.nodes || []).join(', ')}</Typography></Box>
        <Box><Typography variant="caption" color="text.secondary">{t('myVdc.storages')}</Typography><Typography>{(vdc.storages || []).join(', ')}</Typography></Box>
      </Stack>

      <Typography variant="subtitle2" sx={{ mt: 2 }}>{t('myVdc.quotas')}</Typography>
      <Box
        sx={{
          mt: 2,
          display: 'grid',
          gap: 2,
          gridTemplateColumns: {
            xs: 'repeat(2, 1fr)',
            sm: 'repeat(4, 1fr)',
          },
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

      <Typography variant="subtitle2" sx={{ mt: 2 }}>{t('myVdc.uplinks')}</Typography>
      <Stack direction="row" spacing={1} flexWrap="wrap" mt={1}>
        {sharedBridges.length === 0 ? (
          <Typography variant="caption" color="text.secondary">{t('myVdc.noUplinks')}</Typography>
        ) : (
          sharedBridges.map((sb) => (
            <Chip
              key={sb.bridge}
              label={sb.label ? `${sb.bridge} — ${sb.label}` : sb.bridge}
              size="small"
              sx={{ fontFamily: 'monospace' }}
            />
          ))
        )}
      </Stack>
    </Paper>
  )
}
