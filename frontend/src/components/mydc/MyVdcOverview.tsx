'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'

import { Box, Typography, Stack, Chip, LinearProgress, Paper } from '@mui/material'

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

  const qRow = (label: string, used: number, max: number | null | undefined) => {
    const pct = max ? Math.round((used / max) * 100) : 0
    return (
      <Stack direction="row" alignItems="center" spacing={2} key={label}>
        <Typography variant="body2" sx={{ minWidth: 120 }}>{label}</Typography>
        <Box sx={{ flex: 1 }}>
          {max ? (
            <LinearProgress variant="determinate" value={Math.min(pct, 100)} color={pct >= 90 ? 'error' : pct >= 70 ? 'warning' : 'primary'} />
          ) : (
            <Typography variant="caption">{t('vdc.quotaUnlimited')}</Typography>
          )}
        </Box>
        <Typography variant="body2" sx={{ minWidth: 100 }}>
          {used}{max ? ` / ${max}` : ''}
        </Typography>
      </Stack>
    )
  }

  return (
    <Paper sx={{ p: 2 }}>
      <Typography variant="h6" gutterBottom>{vdc.name}</Typography>

      <Stack direction="row" spacing={3} mb={2} flexWrap="wrap">
        <Box><Typography variant="caption" color="text.secondary">{t('myVdc.nodes')}</Typography><Typography>{(vdc.nodes || []).join(', ')}</Typography></Box>
        <Box><Typography variant="caption" color="text.secondary">{t('myVdc.storages')}</Typography><Typography>{(vdc.storages || []).join(', ')}</Typography></Box>
      </Stack>

      <Typography variant="subtitle2" sx={{ mt: 2 }}>{t('myVdc.quotas')}</Typography>
      <Stack spacing={1} mt={1}>
        {qRow(t('vdc.maxVcpus'), usage.usedVcpus || 0, quota.maxVcpus)}
        {qRow(t('vdc.maxRam'), Math.round((usage.usedRamMb || 0) / 1024), quota.maxRamMb ? Math.round(quota.maxRamMb / 1024) : null)}
        {qRow(t('vdc.maxVms'), usage.usedVms || 0, quota.maxVms)}
        {qRow(t('vdc.maxVnets'), (vdc.vnets || []).length, quota.maxVnets)}
      </Stack>

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
