'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'

import { Box, Button, Chip, Paper, Stack, Typography } from '@mui/material'

interface Guest {
  vmid: number
  name: string
  type: 'qemu' | 'lxc'
  status: string
  node: string
  template?: boolean
  connId: string
}

interface Props {
  /** The vDC's connection IDs; the card subscribes to the inventory stream. */
  connectionIds: string[]
}

const statusIcon = (status: string, template?: boolean) => {
  if (template) return 'ri-file-copy-2-line'
  if (status === 'running') return 'ri-play-circle-fill'
  if (status === 'paused') return 'ri-pause-circle-fill'
  return 'ri-stop-circle-fill'
}

const statusColor = (status: string, template?: boolean): 'success' | 'warning' | 'default' => {
  if (template) return 'default'
  if (status === 'running') return 'success'
  if (status === 'paused') return 'warning'
  return 'default'
}

/**
 * VMs card: list of the tenant's guests (VMs and LXC) with status counters
 * and a top-5 quick view. Subscribes to /api/v1/inventory/stream which is
 * already tenant-scoped by vDC (nodes + pool).
 */
export default function MyVmsCard({ connectionIds }: Props) {
  const t = useTranslations()
  const router = useRouter()
  const [guests, setGuests] = useState<Guest[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    const accepted = new Set(connectionIds)
    const found: Guest[] = []
    const src = new EventSource('/api/v1/inventory/stream')

    const onCluster = (ev: MessageEvent) => {
      try {
        const cluster = JSON.parse(ev.data)
        if (!accepted.has(cluster.id)) return
        for (const n of cluster.nodes ?? []) {
          for (const g of n.guests ?? []) {
            found.push({
              vmid: g.vmid,
              name: g.name ?? String(g.vmid),
              type: g.type ?? 'qemu',
              status: g.status ?? 'unknown',
              node: n.node,
              template: !!g.template,
              connId: cluster.id,
            })
          }
        }
        setGuests([...found])
      } catch {}
    }

    const onDone = () => {
      setLoading(false)
      src.close()
    }

    src.addEventListener('cluster', onCluster)
    src.addEventListener('done', onDone)
    src.addEventListener('error', () => {
      setLoading(false)
      src.close()
    })

    return () => {
      src.removeEventListener('cluster', onCluster)
      src.removeEventListener('done', onDone)
      src.close()
    }
  }, [connectionIds])

  const counts = useMemo(() => {
    const c = { running: 0, stopped: 0, paused: 0, template: 0 }
    for (const g of guests) {
      if (g.template) c.template++
      else if (g.status === 'running') c.running++
      else if (g.status === 'paused') c.paused++
      else c.stopped++
    }
    return c
  }, [guests])

  const top = useMemo(() => {
    const sorted = [...guests].sort((a, b) => {
      const ar = a.status === 'running' ? 0 : 1
      const br = b.status === 'running' ? 0 : 1
      if (ar !== br) return ar - br
      return a.name.localeCompare(b.name)
    })
    return sorted.slice(0, 5)
  }, [guests])

  const goInventory = (g?: Guest) => {
    if (g) router.push(`/infrastructure/inventory?select=vm:${g.connId}:${g.node}:${g.type}:${g.vmid}`)
    else router.push('/infrastructure/inventory')
  }

  return (
    <Paper sx={{ p: 2 }} variant="outlined">
      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1.5 }}>
        <i className="ri-computer-line" />
        <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>{t('myVdc.cockpit.myVmsTitle')}</Typography>
        <Chip label={guests.length} size="small" sx={{ height: 20 }} />
      </Stack>

      {!loading && guests.length === 0 ? (
        <Stack alignItems="center" spacing={1} sx={{ py: 2 }}>
          <Typography variant="body2" color="text.secondary">{t('myVdc.cockpit.noVms')}</Typography>
          <Button size="small" variant="outlined" onClick={() => goInventory()} startIcon={<i className="ri-add-line" />}>
            {t('myVdc.cockpit.createVm')}
          </Button>
        </Stack>
      ) : (
        <>
          <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap sx={{ mb: 1.5 }}>
            <Chip size="small" color="success" icon={<i className="ri-play-circle-fill" />} label={`${counts.running} ${t('myVdc.cockpit.vmStatus.running')}`} />
            <Chip size="small" icon={<i className="ri-stop-circle-line" />} label={`${counts.stopped} ${t('myVdc.cockpit.vmStatus.stopped')}`} />
            {counts.paused > 0 && <Chip size="small" color="warning" icon={<i className="ri-pause-circle-fill" />} label={`${counts.paused} ${t('myVdc.cockpit.vmStatus.paused')}`} />}
            {counts.template > 0 && <Chip size="small" icon={<i className="ri-file-copy-2-line" />} label={`${counts.template} ${t('myVdc.cockpit.vmStatus.template')}`} />}
          </Stack>

          <Stack spacing={0.5}>
            {top.map(g => (
              <Box
                key={`${g.connId}:${g.vmid}`}
                onClick={() => goInventory(g)}
                sx={{
                  display: 'flex', alignItems: 'center', gap: 1,
                  px: 1, py: 0.5, borderRadius: 1,
                  cursor: 'pointer',
                  '&:hover': { bgcolor: 'action.hover' },
                }}
              >
                <Box component="i" className={statusIcon(g.status, g.template)} sx={{ fontSize: 14, color: `${statusColor(g.status, g.template)}.main` }} />
                <Typography variant="body2" sx={{ fontFamily: 'monospace', flex: 1 }}>{g.name}</Typography>
                <Chip label={g.node} size="small" sx={{ height: 18, fontSize: 10 }} variant="outlined" />
              </Box>
            ))}
          </Stack>

          {guests.length > 5 && (
            <Button size="small" onClick={() => goInventory()} sx={{ mt: 1 }}>
              {t('myVdc.cockpit.viewAllVms', { count: guests.length })}
            </Button>
          )}
        </>
      )}
    </Paper>
  )
}
