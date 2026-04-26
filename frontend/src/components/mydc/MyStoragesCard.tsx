'use client'

import { useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'

import {
  Box, Chip, Paper, Stack, Table, TableBody, TableCell, TableContainer,
  TableHead, TablePagination, TableRow, Typography, useTheme,
} from '@mui/material'
import { Area, AreaChart, Tooltip as RTooltip } from 'recharts'

import { widgetColors } from '@/components/dashboard/widgets/themeColors'
import { formatTime } from '@/components/dashboard/widgets/timeRangeUtils'

import SparklineCell from './SparklineCell'

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

interface SeriesPoint {
  t: number
  pct: number
  used: number
  total: number
}

interface Props {
  /** The vDC's connection IDs; the card fetches the storage list for each. */
  connectionIds: string[]
  /** Storage names allowed by the vDC (subset filter). */
  allowedStorages: string[]
}

const RRD_REFRESH_MS = 5 * 60_000
const ROWS_PER_PAGE = 10

const storageIcon = (type: string) => {
  if (type === 'nfs' || type === 'cifs') return 'ri-folder-shared-fill'
  if (type === 'zfspool' || type === 'zfs') return 'ri-stack-fill'
  if (type === 'lvm' || type === 'lvmthin') return 'ri-hard-drive-2-fill'
  if (type === 'dir') return 'ri-folder-fill'
  return 'ri-hard-drive-fill'
}

const pctColor = (pct: number, theme: any) =>
  pct >= 90 ? theme.palette.error.main
    : pct >= 70 ? theme.palette.warning.main
    : theme.palette.success.main

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

function buildSeries(raw: any[]): SeriesPoint[] {
  const out: SeriesPoint[] = []
  for (const p of raw || []) {
    const t = p.time ?? p.t ?? p.timestamp
    if (!t) continue
    const used = Number(p.used ?? 0)
    const total = Number(p.total ?? 0)
    const pct = total > 0 ? Math.round((used / total) * 100) : 0
    out.push({ t, pct, used, total })
  }
  return out.sort((a, b) => a.t - b.t)
}

function StorageUsageTooltip({ active, payload, isDark }: { active?: boolean; payload?: any[]; isDark: boolean }) {
  if (!active || !payload?.length) return null
  const point = payload[0]?.payload as SeriesPoint | undefined
  if (!point) return null
  const time = formatTime(payload)
  const c = widgetColors(isDark)
  return (
    <div style={{ background: c.tooltipBg, border: `1px solid ${c.tooltipBorder}`, borderRadius: 6, overflow: 'hidden', fontSize: 10, minWidth: 120, color: c.tooltipText }}>
      <div style={{ background: '#0ea5e9', color: '#fff', padding: '2px 8px', fontWeight: 700, fontSize: 9, display: 'flex', alignItems: 'center', gap: 4 }}>
        <i className="ri-hard-drive-2-line" style={{ fontSize: 10 }} /> Usage
        {time && <span style={{ fontWeight: 400, opacity: 0.8, marginLeft: 'auto' }}>{time}</span>}
      </div>
      <div style={{ padding: '4px 8px', display: 'flex', flexDirection: 'column', gap: 1 }}>
        <div><span style={{ color: '#0ea5e9', fontWeight: 700 }}>Used</span> {point.pct}%</div>
        <div style={{ opacity: 0.8 }}>{formatBytes(point.used)} / {formatBytes(point.total)}</div>
      </div>
    </div>
  )
}

/**
 * Storage card: table with one row per storage, sparkline of usage %.
 * Data source: /api/v1/connections/[id]/storage for list + /rrd per storage
 * for history. Only vDC-assigned storages are displayed.
 */
export default function MyStoragesCard({ connectionIds, allowedStorages }: Props) {
  const t = useTranslations()
  const theme = useTheme()
  const isDark = theme.palette.mode === 'dark'
  const [rows, setRows] = useState<StorageRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [trends, setTrends] = useState<Record<string, SeriesPoint[]>>({})
  const [page, setPage] = useState(0)

  const rowKey = (r: StorageRow, connId: string) => `${connId}:${r.node ?? ''}:${r.storage}`

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
        const all: Array<StorageRow & { connId: string }> = []
        for (const connId of connectionIds) {
          const res = await fetch(`/api/v1/connections/${encodeURIComponent(connId)}/storage`)
          if (!res.ok) continue
          const json = await res.json()
          const arr: StorageRow[] = Array.isArray(json?.data) ? json.data : []
          for (const r of arr) {
            if (allow.size === 0 || allow.has(r.storage)) all.push({ ...r, connId })
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

  useEffect(() => {
    if (rows.length === 0) return
    const controller = new AbortController()
    let cancelled = false

    const fetchRrd = async () => {
      const results = await Promise.all(
        rows.filter(r => r.node).map(async (r) => {
          try {
            const connId = (r as any).connId as string
            const path = `/nodes/${r.node}/storage/${r.storage}`
            const url = `/api/v1/connections/${encodeURIComponent(connId)}/rrd?path=${encodeURIComponent(path)}&timeframe=month`
            const res = await fetch(url, { cache: 'no-store', signal: controller.signal })
            if (!res.ok) return null
            const json = await res.json()
            let raw: any[] = []
            if (Array.isArray(json)) raw = json
            else if (Array.isArray(json?.data)) raw = json.data
            else if (json?.data && typeof json.data === 'object') raw = Object.values(json.data)
            return { key: rowKey(r, connId), series: buildSeries(raw) }
          } catch {
            return null
          }
        }),
      )
      if (cancelled) return
      const next: Record<string, SeriesPoint[]> = {}
      for (const r of results) if (r && r.series.length > 0) next[r.key] = r.series
      setTrends(next)
    }

    void fetchRrd()
    const interval = setInterval(() => { void fetchRrd() }, RRD_REFRESH_MS)

    return () => { cancelled = true; controller.abort(); clearInterval(interval) }
  }, [rows])

  const sorted = useMemo(
    () => [...rows].sort((a, b) => a.storage.localeCompare(b.storage) || (a.node ?? '').localeCompare(b.node ?? '')),
    [rows],
  )

  const pageRows = useMemo(
    () => sorted.slice(page * ROWS_PER_PAGE, page * ROWS_PER_PAGE + ROWS_PER_PAGE),
    [sorted, page],
  )

  useEffect(() => {
    const maxPage = Math.max(0, Math.ceil(sorted.length / ROWS_PER_PAGE) - 1)
    if (page > maxPage) setPage(maxPage)
  }, [sorted.length, page])

  const headerBg = isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.04)'
  const cellBorder = `1px solid ${isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)'}`

  const renderSpark = (series: SeriesPoint[] | undefined, pct: number) => {
    const hasData = series && series.length > 1
    const color = pctColor(pct, theme)
    return (
      <SparklineCell
        hasData={!!hasData}
        fallback={
          <Box sx={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: 0.3 }}>
            <Typography sx={{ fontSize: 9 }}>…</Typography>
          </Box>
        }
      >
        {(width) => (
          <AreaChart width={width} height={24} data={series} margin={{ top: 1, right: 1, left: 1, bottom: 1 }}>
            <RTooltip
              content={<StorageUsageTooltip isDark={isDark} />}
              wrapperStyle={{ backgroundColor: 'transparent', zIndex: 1500, pointerEvents: 'none' }}
              cursor={{ stroke: color, strokeWidth: 1, strokeDasharray: '3 3' }}
              allowEscapeViewBox={{ x: true, y: true }}
            />
            <Area
              type="monotone"
              dataKey="pct"
              stroke={color}
              fill={color}
              fillOpacity={0.35}
              strokeWidth={1.1}
              dot={false}
              isAnimationActive={false}
            />
          </AreaChart>
        )}
      </SparklineCell>
    )
  }

  return (
    <Paper sx={{ p: 2 }} variant="outlined">
      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1.5 }}>
        <i className="ri-hard-drive-2-line" />
        <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
          {t('myVdc.cockpit.storagesTitle')}
        </Typography>
      </Stack>

      {loading ? (
        <Typography variant="caption" color="text.secondary">…</Typography>
      ) : error ? (
        <Typography variant="caption" color="error">{t('myVdc.cockpit.loadError')}</Typography>
      ) : sorted.length === 0 ? (
        <Typography variant="caption" color="text.secondary">{t('myVdc.cockpit.noStorages')}</Typography>
      ) : (
        <TableContainer sx={{ overflow: 'visible' }}>
          <Table size="small" sx={{ '& .MuiTableCell-root': { overflow: 'visible' } }}>
            <TableHead>
              <TableRow>
                <TableCell sx={{ fontWeight: 700, fontSize: 11, py: 0.75, bgcolor: headerBg, borderBottom: cellBorder }}>
                  {t('common.name')}
                </TableCell>
                <TableCell sx={{ fontWeight: 700, fontSize: 11, py: 0.75, bgcolor: headerBg, borderBottom: cellBorder }}>
                  Usage
                </TableCell>
                <TableCell sx={{ fontWeight: 700, fontSize: 11, py: 0.75, bgcolor: headerBg, borderBottom: cellBorder }}>
                  Trend
                </TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {pageRows.map(r => {
                const connId = (r as any).connId as string
                const series = trends[rowKey(r, connId)]
                return (
                  <TableRow key={rowKey(r, connId)} hover>
                    <TableCell sx={{ py: 0.5, borderBottom: cellBorder }}>
                      <Stack direction="row" alignItems="center" spacing={1} flexWrap="wrap">
                        <Box component="i" className={storageIcon(r.type)} sx={{ fontSize: 16, opacity: 0.7 }} />
                        <Typography variant="body2" sx={{ fontWeight: 500 }}>{r.storage}</Typography>
                        <Chip label={r.type} size="small" sx={{ height: 18, fontSize: 10 }} />
                        {r.node && <Typography variant="caption" color="text.secondary">— {r.node}</Typography>}
                      </Stack>
                    </TableCell>
                    <TableCell sx={{ py: 0.5, borderBottom: cellBorder, whiteSpace: 'nowrap' }}>
                      <Typography variant="caption" color="text.secondary">
                        {r.usedFormatted} / {r.totalFormatted}
                        {' '}
                        <Box component="span" sx={{ color: pctColor(r.usedPct, theme), fontWeight: 600 }}>
                          ({r.usedPct}%)
                        </Box>
                      </Typography>
                    </TableCell>
                    <TableCell sx={{ py: 0.5, borderBottom: cellBorder }}>
                      {renderSpark(series, r.usedPct)}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
          {sorted.length > ROWS_PER_PAGE && (
            <TablePagination
              component="div"
              count={sorted.length}
              page={page}
              onPageChange={(_, p) => setPage(p)}
              rowsPerPage={ROWS_PER_PAGE}
              rowsPerPageOptions={[ROWS_PER_PAGE]}
              sx={{ '& .MuiTablePagination-toolbar': { minHeight: 40 } }}
            />
          )}
        </TableContainer>
      )}
    </Paper>
  )
}
