'use client'

import { useCallback, useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'

import { Box, Button, Chip, Typography, Stack, IconButton } from '@mui/material'
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
    { field: 'pveName', headerName: t('myVdc.vnetName'), flex: 1, renderCell: (p) => <Typography fontFamily="monospace">{p.value}</Typography> },
    { field: 'description', headerName: t('myVdc.vnetDescription'), flex: 2 },
    { field: 'vxlanTag', headerName: 'VNI', width: 100 },
    {
      field: 'firewall',
      headerName: t('myVdc.vnetFirewall'),
      width: 120,
      renderCell: (p) => <Chip size="small" label={p.value ? t('myVdc.fwOn') : t('myVdc.fwOff')} color={p.value ? 'success' : 'default'} />,
    },
    {
      field: 'actions',
      headerName: '',
      width: 120,
      sortable: false,
      renderCell: (p) => (
        <Stack direction="row" spacing={1}>
          <IconButton size="small" onClick={() => setEditVnet(p.row)}><i className="ri-pencil-line" /></IconButton>
          <IconButton size="small" color="error" onClick={() => setDeleteVnet(p.row)}><i className="ri-delete-bin-line" /></IconButton>
        </Stack>
      ),
    },
  ]

  return (
    <Box>
      <Stack direction="row" justifyContent="space-between" alignItems="center" mb={2}>
        <Typography variant="h6">{t('myVdc.vnetsTitle')}</Typography>
        <Button
          variant="contained"
          startIcon={<i className="ri-add-line" />}
          disabled={quotaReached}
          onClick={() => setCreateOpen(true)}
        >
          {t('myVdc.createVnet')}
        </Button>
      </Stack>

      <DataGrid
        rows={rows}
        columns={columns}
        getRowId={(r) => r.id}
        loading={loading}
        disableRowSelectionOnClick
        autoHeight
        pageSizeOptions={[10, 25, 50]}
      />

      <VnetCreateDialog open={createOpen} vdcId={vdcId} onClose={() => setCreateOpen(false)} onCreated={() => { setCreateOpen(false); void reload() }} />
      {editVnet && <VnetEditDialog vnet={editVnet} vdcId={vdcId} onClose={() => setEditVnet(null)} onSaved={() => { setEditVnet(null); void reload() }} />}
      {deleteVnet && <VnetDeleteDialog vnet={deleteVnet} vdcId={vdcId} onClose={() => setDeleteVnet(null)} onDeleted={() => { setDeleteVnet(null); void reload() }} />}
    </Box>
  )
}
