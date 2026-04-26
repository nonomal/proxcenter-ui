'use client'

import { useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'

import {
  Box, Chip, Paper, Stack, Table, TableBody, TableCell, TableContainer,
  TableHead, TablePagination, TableRow, Typography, useTheme,
} from '@mui/material'
import { Area, AreaChart, Tooltip as RTooltip } from 'recharts'

import { widgetColors } from '@/components/dashboard/widgets/themeColors'

import SparklineCell from './SparklineCell'

interface PbsBinding {
  id: string
  pbsConnectionId: string
  pbsConnectionName: string
  datastore: string
  namespace: string
  mode: 'auto' | 'manual'
}

interface BackupStats {
  total: number
  lastBackupAt: number | null
  vmCount: number
  ctCount: number
  hostCount: number
  series: SeriesPoint[]
}

interface SeriesPoint {
  t: number
  count: number
}

interface Props {
  /** PBS bindings of the vDC; one row per (PBS, datastore, namespace) tuple. */
  pbsBindings: PbsBinding[]
}

const REFRESH_MS = 5 * 60_000
const ROWS_PER_PAGE = 10
const TREND_DAYS = 14

function bindingKey(b: PbsBinding) {
  return `${b.pbsConnectionId}|${b.datastore}|${b.namespace}`
}

function formatRelative(ts: number | null): string {
  if (!ts) return '—'
  const diffMs = Date.now() - ts * 1000
  if (diffMs < 0) return '—'
  const days = Math.floor(diffMs / 86_400_000)
  if (days >= 1) return `${days}d ago`
  const hours = Math.floor(diffMs / 3_600_000)
  if (hours >= 1) return `${hours}h ago`
  const minutes = Math.floor(diffMs / 60_000)
  if (minutes >= 1) return `${minutes}m ago`
  return 'just now'
}

function freshnessColor(ts: number | null, theme: any): string {
  if (!ts) return theme.palette.text.disabled
  const diffMs = Date.now() - ts * 1000
  const days = diffMs / 86_400_000
  if (days >= 7) return theme.palette.error.main
  if (days >= 2) return theme.palette.warning.main
  return theme.palette.success.main
}

function buildSeries(timestamps: number[]): SeriesPoint[] {
  const buckets = new Map<number, number>()
  const dayMs = 86_400_000
  const now = Date.now()
  // Initialise the last TREND_DAYS days with 0 so the sparkline always renders
  // a stable horizon even when backups landed only on a single day.
  for (let i = TREND_DAYS - 1; i >= 0; i--) {
    const dayStart = Math.floor((now - i * dayMs) / dayMs) * dayMs
    buckets.set(dayStart, 0)
  }
  for (const ts of timestamps) {
    const ms = ts * 1000
    if (now - ms > TREND_DAYS * dayMs) continue
    const dayStart = Math.floor(ms / dayMs) * dayMs
    if (buckets.has(dayStart)) buckets.set(dayStart, (buckets.get(dayStart) || 0) + 1)
  }
  return Array.from(buckets.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([t, count]) => ({ t, count }))
}

function BackupTrendTooltip({ active, payload, isDark }: { active?: boolean; payload?: any[]; isDark: boolean }) {
  if (!active || !payload?.length) return null
  const point = payload[0]?.payload as SeriesPoint | undefined
  if (!point) return null
  const c = widgetColors(isDark)
  const date = new Date(point.t).toLocaleDateString()
  return (
    <div style={{ background: c.tooltipBg, border: `1px solid ${c.tooltipBorder}`, borderRadius: 6, overflow: 'hidden', fontSize: 10, minWidth: 110, color: c.tooltipText }}>
      <div style={{ background: '#0ea5e9', color: '#fff', padding: '2px 8px', fontWeight: 700, fontSize: 9, display: 'flex', alignItems: 'center', gap: 4 }}>
        <i className="ri-archive-line" style={{ fontSize: 10 }} /> Backups
        <span style={{ fontWeight: 400, opacity: 0.8, marginLeft: 'auto' }}>{date}</span>
      </div>
      <div style={{ padding: '4px 8px' }}>
        <span style={{ color: '#0ea5e9', fontWeight: 700 }}>{point.count}</span> snapshot{point.count === 1 ? '' : 's'}
      </div>
    </div>
  )
}

/**
 * PBS card for /my-vdc: one row per (PBS connection, datastore, namespace)
 * binding the vDC owns. Fetches backup totals + last-snapshot timestamp from
 * /api/v1/pbs/[id]/backups (already namespace-scoped server-side for the
 * tenant).
 */
export default function MyBackupsCard({ pbsBindings }: Props) {
  const t = useTranslations()
  const theme = useTheme()
  const isDark = theme.palette.mode === 'dark'
  const [stats, setStats] = useState<Record<string, BackupStats>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [page, setPage] = useState(0)

  useEffect(() => {
    if (pbsBindings.length === 0) {
      setStats({})
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(false)

    const fetchStats = async () => {
      try {
        const entries = await Promise.all(
          pbsBindings.map(async (b) => {
            const url = `/api/v1/pbs/${encodeURIComponent(b.pbsConnectionId)}/backups`
              + `?datastore=${encodeURIComponent(b.datastore)}`
              + `&namespace=${encodeURIComponent(b.namespace)}`
              + `&pageSize=5000`
            const res = await fetch(url, { cache: 'no-store' })
            if (!res.ok) return [bindingKey(b), { total: 0, lastBackupAt: null, vmCount: 0, ctCount: 0, hostCount: 0, series: buildSeries([]) } as BackupStats] as const
            const json = await res.json()
            const all: any[] = Array.isArray(json?.data) ? json.data : []
            let lastTs = 0
            let vm = 0, ct = 0, host = 0
            const timestamps: number[] = []
            for (const bk of all) {
              const ts = Number(bk.backupTime || 0)
              if (ts > lastTs) lastTs = ts
              if (ts) timestamps.push(ts)
              if (bk.backupType === 'vm') vm++
              else if (bk.backupType === 'ct') ct++
              else if (bk.backupType === 'host') host++
            }
            const stats: BackupStats = {
              total: all.length,
              lastBackupAt: lastTs || null,
              vmCount: vm,
              ctCount: ct,
              hostCount: host,
              series: buildSeries(timestamps),
            }
            return [bindingKey(b), stats] as const
          }),
        )
        if (cancelled) return
        const next: Record<string, BackupStats> = {}
        for (const [k, v] of entries) next[k] = v
        setStats(next)
      } catch {
        if (!cancelled) setError(true)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void fetchStats()
    const interval = setInterval(() => { void fetchStats() }, REFRESH_MS)
    return () => { cancelled = true; clearInterval(interval) }
  }, [pbsBindings])

  const sorted = useMemo(
    () => [...pbsBindings].sort((a, b) =>
      a.pbsConnectionName.localeCompare(b.pbsConnectionName)
      || a.datastore.localeCompare(b.datastore)
      || a.namespace.localeCompare(b.namespace),
    ),
    [pbsBindings],
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

  const renderSpark = (series: SeriesPoint[] | undefined) => {
    const hasData = !!(series && series.length > 1 && series.some(p => p.count > 0))
    return (
      <SparklineCell
        hasData={hasData}
        fallback={
          <Box sx={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: 0.3 }}>
            <Typography sx={{ fontSize: 9 }}>…</Typography>
          </Box>
        }
      >
        {(width) => (
          <AreaChart width={width} height={24} data={series} margin={{ top: 1, right: 1, left: 1, bottom: 1 }}>
            <RTooltip
              content={<BackupTrendTooltip isDark={isDark} />}
              wrapperStyle={{ backgroundColor: 'transparent', zIndex: 1500, pointerEvents: 'none' }}
              cursor={{ stroke: '#0ea5e9', strokeWidth: 1, strokeDasharray: '3 3' }}
              allowEscapeViewBox={{ x: true, y: true }}
            />
            <Area
              type="monotone"
              dataKey="count"
              stroke="#0ea5e9"
              fill="#0ea5e9"
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
        <i className="ri-archive-line" />
        <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
          {t('myVdc.cockpit.backupsTitle')}
        </Typography>
      </Stack>

      {loading ? (
        <Typography variant="caption" color="text.secondary">…</Typography>
      ) : error ? (
        <Typography variant="caption" color="error">{t('myVdc.cockpit.loadError')}</Typography>
      ) : sorted.length === 0 ? (
        <Typography variant="caption" color="text.secondary">{t('myVdc.cockpit.noBackups')}</Typography>
      ) : (
        <TableContainer sx={{ overflow: 'visible' }}>
          <Table size="small" sx={{ '& .MuiTableCell-root': { overflow: 'visible' } }}>
            <TableHead>
              <TableRow>
                <TableCell sx={{ fontWeight: 700, fontSize: 11, py: 0.75, bgcolor: headerBg, borderBottom: cellBorder }}>
                  {t('common.name')}
                </TableCell>
                <TableCell sx={{ fontWeight: 700, fontSize: 11, py: 0.75, bgcolor: headerBg, borderBottom: cellBorder }}>
                  {t('myVdc.cockpit.backupsCount')}
                </TableCell>
                <TableCell sx={{ fontWeight: 700, fontSize: 11, py: 0.75, bgcolor: headerBg, borderBottom: cellBorder }}>
                  {t('myVdc.cockpit.backupsLast')}
                </TableCell>
                <TableCell sx={{ fontWeight: 700, fontSize: 11, py: 0.75, bgcolor: headerBg, borderBottom: cellBorder }}>
                  Trend
                </TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {pageRows.map((b) => {
                const k = bindingKey(b)
                const s = stats[k]
                const total = s?.total ?? 0
                const last = s?.lastBackupAt ?? null
                return (
                  <TableRow key={b.id} hover>
                    <TableCell sx={{ py: 0.5, borderBottom: cellBorder }}>
                      <Stack direction="row" alignItems="center" spacing={1} flexWrap="wrap">
                        <Box component="i" className="ri-hard-drive-2-fill" sx={{ fontSize: 16, opacity: 0.7 }} />
                        <Typography variant="body2" sx={{ fontWeight: 500 }}>{b.pbsConnectionName}</Typography>
                        <Chip label={b.datastore} size="small" sx={{ height: 18, fontSize: 10 }} />
                        <Typography variant="caption" color="text.secondary">/ {b.namespace || '<root>'}</Typography>
                      </Stack>
                    </TableCell>
                    <TableCell sx={{ py: 0.5, borderBottom: cellBorder, whiteSpace: 'nowrap' }}>
                      <Stack direction="row" spacing={0.75} alignItems="center">
                        <Typography variant="body2" sx={{ fontWeight: 600 }}>{total}</Typography>
                        {s && (s.vmCount + s.ctCount + s.hostCount > 0) && (
                          <Typography variant="caption" color="text.secondary">
                            ({[s.vmCount && `${s.vmCount} VM`, s.ctCount && `${s.ctCount} CT`, s.hostCount && `${s.hostCount} host`].filter(Boolean).join(', ')})
                          </Typography>
                        )}
                      </Stack>
                    </TableCell>
                    <TableCell sx={{ py: 0.5, borderBottom: cellBorder, whiteSpace: 'nowrap' }}>
                      <Typography variant="caption" sx={{ color: freshnessColor(last, theme), fontWeight: 600 }}>
                        {formatRelative(last)}
                      </Typography>
                    </TableCell>
                    <TableCell sx={{ py: 0.5, borderBottom: cellBorder }}>
                      {renderSpark(s?.series)}
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
