'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'

import { Box, Chip, LinearProgress, Paper, Stack, Typography } from '@mui/material'

interface StorageRow {
  id: string
  storage: string
  node?: string
  type: string
  usedFormatted: string
  totalFormatted: string
  usedPct: number
  content?: string[]
}

interface Props {
  /** The vDC's connection IDs; the card fetches the storage list for each. */
  connectionIds: string[]
  /** Storage names allowed by the vDC (subset filter). */
  allowedStorages: string[]
}

const storageIcon = (type: string) => {
  if (type === 'nfs' || type === 'cifs') return 'ri-folder-shared-fill'
  if (type === 'zfspool' || type === 'zfs') return 'ri-stack-fill'
  if (type === 'lvm' || type === 'lvmthin') return 'ri-hard-drive-2-fill'
  if (type === 'dir') return 'ri-folder-fill'
  return 'ri-hard-drive-fill'
}

const barColor = (pct: number): 'primary' | 'warning' | 'error' =>
  pct >= 90 ? 'error' : pct >= 70 ? 'warning' : 'primary'

/**
 * Storage card: usage bars for each storage assigned to the tenant's vDC.
 * Data source: /api/v1/connections/[id]/storage which is already tenant-scoped
 * (non-shared storages only, filtered to vDC allowlist).
 */
export default function MyStoragesCard({ connectionIds, allowedStorages }: Props) {
  const t = useTranslations()
  const [rows, setRows] = useState<StorageRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  useEffect(() => {
    if (connectionIds.length === 0) {
      setRows([])
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(false)
    const allow = new Set(allowedStorages)
    ;(async () => {
      try {
        const all: StorageRow[] = []
        for (const connId of connectionIds) {
          const res = await fetch(`/api/v1/connections/${encodeURIComponent(connId)}/storage`)
          if (!res.ok) continue
          const json = await res.json()
          const arr: StorageRow[] = Array.isArray(json?.data) ? json.data : []
          for (const r of arr) {
            if (allow.size === 0 || allow.has(r.storage)) all.push(r)
          }
        }
        if (!cancelled) setRows(all)
      } catch {
        if (!cancelled) setError(true)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [connectionIds, allowedStorages])

  return (
    <Paper sx={{ p: 2 }} variant="outlined">
      <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 1.5, display: 'flex', alignItems: 'center', gap: 1 }}>
        <i className="ri-hard-drive-2-line" />
        {t('myVdc.cockpit.storagesTitle')}
      </Typography>
      {loading ? (
        <Typography variant="caption" color="text.secondary">…</Typography>
      ) : error ? (
        <Typography variant="caption" color="error">{t('myVdc.cockpit.loadError')}</Typography>
      ) : rows.length === 0 ? (
        <Typography variant="caption" color="text.secondary">{t('myVdc.cockpit.noStorages')}</Typography>
      ) : (
        <Stack spacing={1.5}>
          {rows.map(r => (
            <Box key={r.id}>
              <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 0.5 }}>
                <Box component="i" className={storageIcon(r.type)} sx={{ fontSize: 16, opacity: 0.7 }} />
                <Typography variant="body2" sx={{ fontFamily: 'monospace', fontWeight: 500 }}>{r.storage}</Typography>
                <Chip label={r.type} size="small" sx={{ height: 18, fontSize: 10 }} />
                {r.node && <Typography variant="caption" color="text.secondary">— {r.node}</Typography>}
                <Box sx={{ flex: 1 }} />
                <Typography variant="caption" color="text.secondary">
                  {r.usedFormatted} / {r.totalFormatted} ({r.usedPct}%)
                </Typography>
              </Stack>
              <LinearProgress
                variant="determinate"
                value={Math.min(100, r.usedPct)}
                color={barColor(r.usedPct)}
                sx={{ height: 4, borderRadius: 2 }}
              />
            </Box>
          ))}
        </Stack>
      )}
    </Paper>
  )
}
