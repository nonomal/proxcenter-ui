'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'

import { Box, Typography, MenuItem, Select, FormControl, InputLabel, Alert, Stack, Divider } from '@mui/material'

import MyVdcOverview from '@/components/mydc/MyVdcOverview'
import VnetList from '@/components/mydc/VnetList'

export default function MyVdcPage() {
  const t = useTranslations()
  const [vdcs, setVdcs] = useState<any[]>([])
  const [selectedVdcId, setSelectedVdcId] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch('/api/v1/vdcs')
        const json = await res.json()
        const list = Array.isArray(json.data) ? json.data : []
        setVdcs(list)
        if (list.length > 0) setSelectedVdcId(list[0].id)
      } catch (e: any) {
        setError(e?.message || String(e))
      } finally {
        setLoading(false)
      }
    })()
  }, [])

  const selectedVdc = vdcs.find((v) => v.id === selectedVdcId)

  if (loading) return <Box p={3}>{t('common.loading')}</Box>
  if (error) return <Box p={3}><Alert severity="error">{error}</Alert></Box>
  if (vdcs.length === 0) {
    return (
      <Box p={3}>
        <Typography variant="h5" gutterBottom>{t('myVdc.title')}</Typography>
        <Alert severity="info">{t('myVdc.noVdcs')}</Alert>
      </Box>
    )
  }

  return (
    <Box p={3}>
      <Stack direction="row" alignItems="center" spacing={2} mb={2}>
        <Typography variant="h5">{t('myVdc.title')}</Typography>
        {vdcs.length > 1 && (
          <FormControl size="small" sx={{ minWidth: 240 }}>
            <InputLabel>{t('myVdc.selectVdc')}</InputLabel>
            <Select
              value={selectedVdcId}
              label={t('myVdc.selectVdc')}
              onChange={(e) => setSelectedVdcId(e.target.value)}
            >
              {vdcs.map((v) => (
                <MenuItem key={v.id} value={v.id}>{v.name}</MenuItem>
              ))}
            </Select>
          </FormControl>
        )}
      </Stack>

      {selectedVdc && (
        <>
          <MyVdcOverview vdc={selectedVdc} />
          <Divider sx={{ my: 3 }} />
          <VnetList vdcId={selectedVdc.id} quota={selectedVdc.quota} />
        </>
      )}
    </Box>
  )
}
