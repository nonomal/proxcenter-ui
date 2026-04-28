'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import {
  Button,
  Card, CardContent,
  Chip,
  CircularProgress,
  IconButton,
  Stack,
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow,
  Tooltip,
  Typography,
  alpha,
  useTheme,
} from '@mui/material'

import VnetCreateDialog from '@/components/mydc/VnetCreateDialog'
import VnetEditDialog from '@/components/mydc/VnetEditDialog'
import VnetDeleteDialog from '@/components/mydc/VnetDeleteDialog'

interface Vdc { id: string; name: string; connectionId?: string }
interface VnetRow {
  id: string
  vdcId: string
  vdcName: string
  /** Tenant-facing name; what we render in the table and pass as URL segment. */
  displayName: string
  /** Hashed 8-char PVE ID; surfaced in a tooltip for provider debugging. */
  pveName: string
  description?: string | null
  vxlanTag?: number | null
  firewall?: boolean
}

interface Props {
  /** Inventory connections in scope; VNets from vDCs whose connectionId is
   *  outside this set are filtered out. Empty set = no filter. */
  connectionIds: string[]
}

export default function VnetsSection({ connectionIds }: Props) {
  const t = useTranslations()
  const theme = useTheme()
  const [vdcs, setVdcs] = useState<Vdc[]>([])
  const [rows, setRows] = useState<VnetRow[]>([])
  const [loading, setLoading] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [editVnet, setEditVnet] = useState<{ row: VnetRow } | null>(null)
  const [deleteVnet, setDeleteVnet] = useState<{ row: VnetRow } | null>(null)

  const connFilter = useMemo(() => new Set(connectionIds), [connectionIds])

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      const vdcsRes = await fetch('/api/v1/vdcs')
      const vdcsJson = await vdcsRes.json()
      const allVdcs: Vdc[] = Array.isArray(vdcsJson?.data) ? vdcsJson.data : []
      const visibleVdcs = connFilter.size === 0
        ? allVdcs
        : allVdcs.filter(v => !v.connectionId || connFilter.has(v.connectionId))
      setVdcs(visibleVdcs)

      const all: VnetRow[] = []
      await Promise.all(visibleVdcs.map(async (v) => {
        try {
          const r = await fetch(`/api/v1/vdcs/${encodeURIComponent(v.id)}/vnets`)
          if (!r.ok) return
          const j = await r.json()
          const list = Array.isArray(j?.data) ? j.data : []
          for (const vnet of list) {
            all.push({
              id: vnet.id,
              vdcId: v.id,
              vdcName: v.name,
              displayName: vnet.displayName ?? vnet.pveName,
              pveName: vnet.pveName,
              description: vnet.description,
              vxlanTag: vnet.vxlanTag,
              firewall: vnet.firewall,
            })
          }
        } catch { /* skip */ }
      }))
      all.sort((a, b) => a.vdcName.localeCompare(b.vdcName) || a.displayName.localeCompare(b.displayName))
      setRows(all)
    } finally {
      setLoading(false)
    }
  }, [connFilter])

  useEffect(() => { void reload() }, [reload])

  return (
    <>
      <Card variant="outlined" sx={{ mt: 3, borderRadius: 2, border: `1px solid ${alpha(theme.palette.divider, 0.8)}` }}>
        <CardContent sx={{ pb: '16px !important' }}>
          <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 2 }}>
            <i className="ri-git-branch-line" style={{ opacity: 0.6, fontSize: 16 }} />
            <Typography variant="subtitle2" fontWeight={700}>
              {t('myVdc.vnetsTitle')}
            </Typography>
            <Chip label={rows.length} size="small" sx={{ height: 20, fontSize: 11, ml: 0.5, bgcolor: alpha(theme.palette.primary.main, 0.1) }} />
            <Stack direction="row" sx={{ flex: 1 }} />
            <Tooltip title={vdcs.length === 0 ? t('myVdc.vnetNoVdc') : t('myVdc.createVnet')}>
              <span>
                <Button
                  size="small"
                  variant="outlined"
                  startIcon={<i className="ri-add-line" />}
                  disabled={vdcs.length === 0}
                  onClick={() => setCreateOpen(true)}
                >
                  {t('myVdc.createVnet')}
                </Button>
              </span>
            </Tooltip>
          </Stack>

          {loading ? (
            <Stack alignItems="center" sx={{ py: 4 }}>
              <CircularProgress size={20} />
            </Stack>
          ) : rows.length === 0 ? (
            <Stack alignItems="center" sx={{ py: 3, opacity: 0.55, gap: 0.5 }}>
              <i className="ri-git-branch-line" style={{ fontSize: 28 }} />
              <Typography variant="body2">{t('myVdc.vnetsEmpty')}</Typography>
            </Stack>
          ) : (
            <TableContainer>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell sx={{ fontWeight: 700, fontSize: 12, opacity: 0.65, py: 1 }}>{t('myVdc.vnetVdc')}</TableCell>
                    <TableCell sx={{ fontWeight: 700, fontSize: 12, opacity: 0.65, py: 1 }}>{t('myVdc.vnetName')}</TableCell>
                    <TableCell sx={{ fontWeight: 700, fontSize: 12, opacity: 0.65, py: 1 }}>{t('myVdc.vnetDescription')}</TableCell>
                    <TableCell align="center" sx={{ fontWeight: 700, fontSize: 12, opacity: 0.65, py: 1 }}>VNI</TableCell>
                    <TableCell align="center" sx={{ fontWeight: 700, fontSize: 12, opacity: 0.65, py: 1 }}>{t('myVdc.vnetFirewall')}</TableCell>
                    <TableCell align="right" sx={{ fontWeight: 700, fontSize: 12, opacity: 0.65, py: 1 }}></TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {rows.map((r) => (
                    <TableRow key={r.id} sx={{ '&:last-child td': { border: 0 }, '&:hover': { bgcolor: alpha(theme.palette.action.hover, 0.5) } }}>
                      <TableCell sx={{ py: 1, fontSize: 12 }}>
                        <Stack direction="row" alignItems="center" spacing={0.75}>
                          <i className="ri-cloud-line" style={{ fontSize: 13, opacity: 0.5 }} />
                          <span>{r.vdcName}</span>
                        </Stack>
                      </TableCell>
                      <TableCell sx={{ py: 1 }}>
                        <Tooltip title={`PVE ID: ${r.pveName}`} arrow placement="top">
                          <Typography variant="body2" fontWeight={600} sx={{ fontSize: 12 }}>{r.displayName}</Typography>
                        </Tooltip>
                      </TableCell>
                      <TableCell sx={{ py: 1, fontSize: 12, opacity: 0.75 }}>{r.description || '—'}</TableCell>
                      <TableCell align="center" sx={{ py: 1, fontFamily: 'JetBrains Mono, monospace', fontSize: 12, opacity: 0.8 }}>
                        {r.vxlanTag ?? '—'}
                      </TableCell>
                      <TableCell align="center" sx={{ py: 1 }}>
                        <Chip
                          size="small"
                          label={r.firewall ? t('myVdc.fwOn') : t('myVdc.fwOff')}
                          color={r.firewall ? 'success' : 'default'}
                          sx={{ height: 20, fontSize: 11 }}
                        />
                      </TableCell>
                      <TableCell align="right" sx={{ py: 0.5 }}>
                        <Stack direction="row" spacing={0.5} justifyContent="flex-end">
                          <IconButton size="small" onClick={() => setEditVnet({ row: r })}><i className="ri-pencil-line" /></IconButton>
                          <IconButton size="small" color="error" onClick={() => setDeleteVnet({ row: r })}><i className="ri-delete-bin-line" /></IconButton>
                        </Stack>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          )}
        </CardContent>
      </Card>

      <VnetCreateDialog
        open={createOpen}
        vdcs={vdcs.map(v => ({ id: v.id, name: v.name }))}
        onClose={() => setCreateOpen(false)}
        onCreated={() => { setCreateOpen(false); void reload() }}
      />
      {editVnet && (
        <VnetEditDialog
          vnet={editVnet.row}
          vdcId={editVnet.row.vdcId}
          onClose={() => setEditVnet(null)}
          onSaved={() => { setEditVnet(null); void reload() }}
        />
      )}
      {deleteVnet && (
        <VnetDeleteDialog
          vnet={deleteVnet.row}
          vdcId={deleteVnet.row.vdcId}
          onClose={() => setDeleteVnet(null)}
          onDeleted={() => { setDeleteVnet(null); void reload() }}
        />
      )}
    </>
  )
}
