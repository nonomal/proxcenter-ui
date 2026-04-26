'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'

import { Box, Chip, Paper, Typography } from '@mui/material'

interface SharedBridge {
  bridge: string
  label: string | null
}

interface Props {
  vdcId: string
}

/**
 * Uplinks card: provider-authorised shared bridges for this vDC. Read-only
 * for the tenant — the provider controls the list via the admin panel.
 */
export default function UplinksCard({ vdcId }: Props) {
  const t = useTranslations()
  const [bridges, setBridges] = useState<SharedBridge[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(false)
    ;(async () => {
      try {
        const res = await fetch(`/api/v1/vdcs/${encodeURIComponent(vdcId)}/shared-bridges`)
        if (!res.ok) throw new Error(String(res.status))
        const json = await res.json()
        if (!cancelled) setBridges(Array.isArray(json?.data) ? json.data : [])
      } catch {
        if (!cancelled) setError(true)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [vdcId])

  return (
    <Paper sx={{ p: 2 }} variant="outlined">
      <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 1.5, display: 'flex', alignItems: 'center', gap: 1 }}>
        <i className="ri-arrow-up-down-line" />
        {t('myVdc.cockpit.uplinksTitle')}
      </Typography>
      {loading ? (
        <Typography variant="caption" color="text.secondary">…</Typography>
      ) : error ? (
        <Typography variant="caption" color="error">{t('myVdc.cockpit.loadError')}</Typography>
      ) : bridges.length === 0 ? (
        <Typography variant="caption" color="text.secondary">{t('myVdc.noUplinks')}</Typography>
      ) : (
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75 }}>
          {bridges.map(b => (
            <Chip
              key={b.bridge}
              label={b.label ? `${b.bridge} — ${b.label}` : b.bridge}
              size="small"
            />
          ))}
        </Box>
      )}
    </Paper>
  )
}
