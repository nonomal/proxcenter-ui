'use client'

import { useCallback, useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'

import { Chip, IconButton, Paper, Stack, Tooltip, Typography } from '@mui/material'
import { DataGrid, type GridColDef } from '@mui/x-data-grid'

import VnetCreateDialog from './VnetCreateDialog'
import VnetEditDialog from './VnetEditDialog'
import VnetDeleteDialog from './VnetDeleteDialog'

interface Props {
  vdcId: string
  quota: { maxVnets?: number | null } | null
}

export default function VnetList({ vdcId, quota }: Props) {
  const t = useTranslations()
  const [rows, setRows] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [createOpen, setCreateOpen] = useState(false)
  const [editVnet, setEditVnet] = useState<any | null>(null)
  const [deleteVnet, setDeleteVnet] = useState<any | null>(null)

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`/api/v1/vdcs/${encodeURIComponent(vdcId)}/vnets`)
      const json = await res.json()
      setRows(Array.isArray(json.data) ? json.data : [])
    } finally {
      setLoading(false)
    }
  }, [vdcId])

  useEffect(() => { void reload() }, [reload])

  const quotaReached = quota?.maxVnets != null && rows.length >= quota.maxVnets

  const columns: GridColDef[] = [
    {
      field: 'pveName',
      headerName: t('myVdc.vnetName'),
      flex: 1,
      renderCell: (p) => <Typography variant="body2">{p.value}</Typography>,
    },
    { field: 'description', headerName: t('myVdc.vnetDescription'), flex: 2 },
    { field: 'vxlanTag', headerName: 'VNI', width: 100, align: 'center', headerAlign: 'center' },
    {
      field: 'firewall',
      headerName: t('myVdc.vnetFirewall'),
      width: 120,
      align: 'center',
      headerAlign: 'center',
      renderCell: (p) => <Chip size="small" label={p.value ? t('myVdc.fwOn') : t('myVdc.fwOff')} color={p.value ? 'success' : 'default'} />,
    },
    {
      field: 'actions',
      headerName: '',
      width: 120,
      sortable: false,
      align: 'center',
      headerAlign: 'center',
      renderCell: (p) => (
        <Stack direction="row" spacing={0.5} justifyContent="center">
          <IconButton size="small" onClick={() => setEditVnet(p.row)}><i className="ri-pencil-line" /></IconButton>
          <IconButton size="small" color="error" onClick={() => setDeleteVnet(p.row)}><i className="ri-delete-bin-line" /></IconButton>
        </Stack>
      ),
    },
  ]

  return (
    <Paper sx={{ p: 2 }} variant="outlined">
      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1.5 }}>
        <i className="ri-git-branch-line" />
        <Typography variant="subtitle1" sx={{ fontWeight: 600, flex: 1 }}>
          {t('myVdc.vnetsTitle')}
        </Typography>
        <Tooltip title={t('myVdc.createVnet')}>
          <span>
            <IconButton
              size="small"
              color="primary"
              disabled={quotaReached}
              onClick={() => setCreateOpen(true)}
            >
              <i className="ri-add-line" />
            </IconButton>
          </span>
        </Tooltip>
      </Stack>

      <DataGrid
        rows={rows}
        columns={columns}
        getRowId={(r) => r.id}
        loading={loading}
        disableRowSelectionOnClick
        autoHeight
        density="compact"
        rowHeight={38}
        columnHeaderHeight={40}
        pageSizeOptions={[5, 10, 25]}
        initialState={{ pagination: { paginationModel: { pageSize: 5 } } }}
        sx={{
          '& .MuiDataGrid-cell': {
            display: 'flex',
            alignItems: 'center',
            fontSize: '0.8125rem',
          },
          '& .MuiDataGrid-columnHeaderTitle': {
            fontSize: '0.75rem',
            fontWeight: 600,
          },
        }}
      />

      <VnetCreateDialog open={createOpen} vdcId={vdcId} onClose={() => setCreateOpen(false)} onCreated={() => { setCreateOpen(false); void reload() }} />
      {editVnet && <VnetEditDialog vnet={editVnet} vdcId={vdcId} onClose={() => setEditVnet(null)} onSaved={() => { setEditVnet(null); void reload() }} />}
      {deleteVnet && <VnetDeleteDialog vnet={deleteVnet} vdcId={vdcId} onClose={() => setDeleteVnet(null)} onDeleted={() => { setDeleteVnet(null); void reload() }} />}
    </Paper>
  )
}
