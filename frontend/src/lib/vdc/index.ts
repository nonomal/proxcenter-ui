// src/lib/vdc/index.ts
// vDC CRUD library with PVE pool integration

import { randomUUID } from 'crypto'

import { getDb } from '@/lib/db/sqlite'
import { pveFetch } from '@/lib/proxmox/client'
import { getConnectionById } from '@/lib/connections/getConnection'
import { prisma } from '@/lib/db/prisma'

import { generateZoneName, createZone, deleteZone, deleteVnetPve, applySdn } from './sdn'

import type {
  Vdc,
  VdcWithDetails,
  VdcQuota,
  VdcUsage,
  CreateVdcInput,
  UpdateVdcInput,
} from './types'

// Re-export all types
export type { Vdc, VdcWithDetails, VdcQuota, VdcUsage, CreateVdcInput, UpdateVdcInput } from './types'

// ---------------------------------------------------------------------------
// Row mapping helpers
// ---------------------------------------------------------------------------

function rowToVdc(row: any): Vdc {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    connectionId: row.connection_id,
    name: row.name,
    slug: row.slug,
    description: row.description ?? null,
    pvePoolName: row.pve_pool_name,
    sdnZoneName: row.sdn_zone_name ?? null,
    enabled: !!row.enabled,
    createdBy: row.created_by ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function rowToQuota(row: any): VdcQuota | null {
  if (!row) return null
  return {
    maxVcpus: row.max_vcpus ?? null,
    maxRamMb: row.max_ram_mb ?? null,
    maxStorageMb: row.max_storage_mb ?? null,
    maxVms: row.max_vms ?? null,
    maxSnapshots: row.max_snapshots ?? null,
    maxBackups: row.max_backups ?? null,
    maxVnets: row.max_vnets ?? null,
  }
}

function rowToUsage(row: any): VdcUsage | null {
  if (!row) return null
  return {
    usedVcpus: row.used_vcpus ?? 0,
    usedRamMb: row.used_ram_mb ?? 0,
    usedStorageMb: row.used_storage_mb ?? 0,
    usedVms: row.used_vms ?? 0,
    usedSnapshots: row.used_snapshots ?? 0,
    usedBackups: row.used_backups ?? 0,
    lastSyncedAt: row.last_synced_at ?? null,
  }
}

function generatePoolName(tenantSlug: string, vdcSlug: string): string {
  return `vdc-${tenantSlug}-${vdcSlug}`
}

/** Resolve the real owner tenantId of a connection (it may differ from the vDC's tenantId) */
async function getConnectionOwnerTenantId(connectionId: string): Promise<string> {
  const conn = await prisma.connection.findUnique({ where: { id: connectionId }, select: { tenantId: true } })
  if (!conn) throw new Error(`Connection not found: ${connectionId}`)
  return conn.tenantId
}

// ---------------------------------------------------------------------------
// listVdcs
// ---------------------------------------------------------------------------

export function listVdcs(tenantId?: string): VdcWithDetails[] {
  const db = getDb()

  const baseQuery = `
    SELECT v.*, t.name AS tenant_name
    FROM vdcs v
    LEFT JOIN tenants t ON t.id = v.tenant_id
  `
  const rows = tenantId
    ? db.prepare(`${baseQuery} WHERE v.tenant_id = ? ORDER BY v.name`).all(tenantId)
    : db.prepare(`${baseQuery} ORDER BY v.name`).all()

  const stmtNodes = db.prepare('SELECT node_name FROM vdc_nodes WHERE vdc_id = ?')
  const stmtStorages = db.prepare('SELECT storage_id FROM vdc_storages WHERE vdc_id = ?')
  const stmtQuota = db.prepare('SELECT * FROM vdc_quotas WHERE vdc_id = ?')
  const stmtUsage = db.prepare('SELECT * FROM vdc_usage_cache WHERE vdc_id = ?')
  const stmtShared = db.prepare('SELECT id, vdc_id, bridge, label, created_at FROM vdc_shared_bridges WHERE vdc_id = ? ORDER BY bridge')
  const stmtVnets = db.prepare(`
    SELECT v.id, v.vdc_id, v.pve_name, v.display_name, v.description, v.vxlan_tag, v.firewall, v.created_by, v.created_at,
           s.id AS subnet_id, s.cidr, s.gateway, s.dns_servers, s.ipam_enabled, s.created_at AS subnet_created_at
    FROM vdc_vnets v
    LEFT JOIN vdc_subnets s ON s.vnet_id = v.id
    WHERE v.vdc_id = ?
    ORDER BY v.pve_name
  `)
  const stmtPbs = db.prepare(
    `SELECT b.id, b.vdc_id, b.pbs_connection_id, b.datastore, b.namespace, b.mode, b.created_at,
            c.name AS pbs_name
     FROM vdc_pbs_namespaces b
     LEFT JOIN Connection c ON c.id = b.pbs_connection_id
     WHERE b.vdc_id = ?
     ORDER BY c.name, b.datastore, b.namespace`
  )

  return (rows as any[]).map((row) => {
    const vdc = rowToVdc(row)
    const nodes = (stmtNodes.all(vdc.id) as any[]).map((r) => r.node_name)
    const storages = (stmtStorages.all(vdc.id) as any[]).map((r) => r.storage_id)
    const quota = rowToQuota(stmtQuota.get(vdc.id))
    const usage = rowToUsage(stmtUsage.get(vdc.id))
    const sharedBridges = (stmtShared.all(vdc.id) as any[]).map((r) => ({
      id: r.id,
      vdcId: r.vdc_id,
      bridge: r.bridge,
      label: r.label ?? null,
      createdAt: r.created_at,
    }))
    const vnets = (stmtVnets.all(vdc.id) as any[]).map((r) => ({
      id: r.id,
      vdcId: r.vdc_id,
      pveName: r.pve_name,
      displayName: r.display_name ?? r.pve_name,
      description: r.description ?? null,
      vxlanTag: r.vxlan_tag,
      firewall: !!r.firewall,
      subnet: {
        id: r.subnet_id,
        vnetId: r.id,
        cidr: r.cidr,
        gateway: r.gateway,
        dnsServers: r.dns_servers ? String(r.dns_servers).split(',').map((s: string) => s.trim()).filter(Boolean) : [],
        ipamEnabled: !!r.ipam_enabled,
        createdAt: r.subnet_created_at,
      },
      createdBy: r.created_by ?? null,
      createdAt: r.created_at,
    }))
    const pbsBindings = (stmtPbs.all(vdc.id) as any[]).map((r) => ({
      id: r.id,
      vdcId: r.vdc_id,
      pbsConnectionId: r.pbs_connection_id,
      pbsConnectionName: r.pbs_name ?? r.pbs_connection_id,
      datastore: r.datastore,
      namespace: r.namespace,
      mode: (r.mode ?? 'auto') as 'auto' | 'manual',
      createdAt: r.created_at,
    }))

    return {
      ...vdc,
      tenantName: row.tenant_name ?? undefined,
      nodes,
      storages,
      quota,
      usage,
      sharedBridges,
      vnets,
      pbsBindings,
    } as VdcWithDetails
  })
}

// ---------------------------------------------------------------------------
// getVdcById
// ---------------------------------------------------------------------------

export function getVdcById(id: string): VdcWithDetails | null {
  const db = getDb()

  const row = db.prepare(`
    SELECT v.*, t.name AS tenant_name
    FROM vdcs v
    LEFT JOIN tenants t ON t.id = v.tenant_id
    WHERE v.id = ?
  `).get(id) as any

  if (!row) return null

  const vdc = rowToVdc(row)
  const nodes = (db.prepare('SELECT node_name FROM vdc_nodes WHERE vdc_id = ?').all(id) as any[]).map((r) => r.node_name)
  const storages = (db.prepare('SELECT storage_id FROM vdc_storages WHERE vdc_id = ?').all(id) as any[]).map((r) => r.storage_id)
  const quota = rowToQuota(db.prepare('SELECT * FROM vdc_quotas WHERE vdc_id = ?').get(id))
  const usage = rowToUsage(db.prepare('SELECT * FROM vdc_usage_cache WHERE vdc_id = ?').get(id))
  const sharedBridges = (db.prepare('SELECT id, vdc_id, bridge, label, created_at FROM vdc_shared_bridges WHERE vdc_id = ? ORDER BY bridge').all(id) as any[]).map((r) => ({
    id: r.id,
    vdcId: r.vdc_id,
    bridge: r.bridge,
    label: r.label ?? null,
    createdAt: r.created_at,
  }))
  const vnets = (db.prepare(`
    SELECT v.id, v.vdc_id, v.pve_name, v.display_name, v.description, v.vxlan_tag, v.firewall, v.created_by, v.created_at,
           s.id AS subnet_id, s.cidr, s.gateway, s.dns_servers, s.ipam_enabled, s.created_at AS subnet_created_at
    FROM vdc_vnets v
    LEFT JOIN vdc_subnets s ON s.vnet_id = v.id
    WHERE v.vdc_id = ?
    ORDER BY v.pve_name
  `).all(id) as any[]).map((r) => ({
    id: r.id,
    vdcId: r.vdc_id,
    pveName: r.pve_name,
    displayName: r.display_name ?? r.pve_name,
    description: r.description ?? null,
    vxlanTag: r.vxlan_tag,
    firewall: !!r.firewall,
    subnet: {
      id: r.subnet_id,
      vnetId: r.id,
      cidr: r.cidr,
      gateway: r.gateway,
      dnsServers: r.dns_servers ? String(r.dns_servers).split(',').map((s: string) => s.trim()).filter(Boolean) : [],
      ipamEnabled: !!r.ipam_enabled,
      createdAt: r.subnet_created_at,
    },
    createdBy: r.created_by ?? null,
    createdAt: r.created_at,
  }))
  const pbsBindings = (db.prepare(
    `SELECT b.id, b.vdc_id, b.pbs_connection_id, b.datastore, b.namespace, b.mode, b.created_at,
            c.name AS pbs_name
     FROM vdc_pbs_namespaces b
     LEFT JOIN Connection c ON c.id = b.pbs_connection_id
     WHERE b.vdc_id = ?
     ORDER BY c.name, b.datastore, b.namespace`
  ).all(id) as any[]).map((r) => ({
    id: r.id,
    vdcId: r.vdc_id,
    pbsConnectionId: r.pbs_connection_id,
    pbsConnectionName: r.pbs_name ?? r.pbs_connection_id,
    datastore: r.datastore,
    namespace: r.namespace,
    mode: (r.mode ?? 'auto') as 'auto' | 'manual',
    createdAt: r.created_at,
  }))

  return {
    ...vdc,
    tenantName: row.tenant_name ?? undefined,
    nodes,
    storages,
    quota,
    usage,
    sharedBridges,
    vnets,
    pbsBindings,
  }
}

// ---------------------------------------------------------------------------
// createVdc
// ---------------------------------------------------------------------------

export async function createVdc(input: CreateVdcInput, createdBy: string | null): Promise<VdcWithDetails> {
  const db = getDb()

  // 1. Resolve tenant slug
  const tenantRow = db.prepare('SELECT slug FROM tenants WHERE id = ?').get(input.tenantId) as any
  if (!tenantRow) {
    throw new Error(`Tenant not found: ${input.tenantId}`)
  }
  const tenantSlug = tenantRow.slug as string

  // 2. Check slug uniqueness within tenant + connection
  const existing = db.prepare(
    'SELECT id FROM vdcs WHERE tenant_id = ? AND connection_id = ? AND slug = ?'
  ).get(input.tenantId, input.connectionId, input.slug) as any
  if (existing) {
    throw new Error(`A vDC with slug "${input.slug}" already exists for this tenant/connection`)
  }

  // 3. Allocate vDC id (needed for zone generation)
  const id = randomUUID()
  const now = new Date().toISOString()

  // 4. Create PVE pool (existing behavior)
  const poolName = generatePoolName(tenantSlug, input.slug)
  const connOwnerTenantId = await getConnectionOwnerTenantId(input.connectionId)
  const conn = await getConnectionById(input.connectionId, connOwnerTenantId)

  try {
    await pveFetch(conn, '/pools', {
      method: 'POST',
      body: new URLSearchParams({
        poolid: poolName,
        comment: `ProxCenter vDC: ${input.name}`,
      }),
    })
  } catch (err: any) {
    const msg = err?.message || ''
    if (!msg.includes('already exists')) {
      throw new Error(`Failed to create PVE pool "${poolName}": ${msg}`)
    }
    console.warn(`[vdc] PVE pool "${poolName}" already exists, proceeding`)
  }

  // 5. Create SDN zone on PVE
  const sdnZoneName = generateZoneName(input.connectionId, { id, slug: input.slug })
  try {
    await createZone(conn, sdnZoneName)
  } catch (err: any) {
    try {
      await pveFetch(conn, `/pools/${encodeURIComponent(poolName)}`, { method: 'DELETE' })
    } catch {}
    throw new Error(`Failed to create SDN zone: ${err?.message}`)
  }

  // 6. DB transaction
  const insertVdc = db.prepare(`
    INSERT INTO vdcs (id, tenant_id, connection_id, name, slug, description, pve_pool_name, sdn_zone_name, enabled, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
  `)
  const insertNode = db.prepare('INSERT INTO vdc_nodes (id, vdc_id, node_name) VALUES (?, ?, ?)')
  const insertStorage = db.prepare('INSERT INTO vdc_storages (id, vdc_id, storage_id) VALUES (?, ?, ?)')
  const insertQuota = db.prepare(`
    INSERT INTO vdc_quotas (id, vdc_id, max_vcpus, max_ram_mb, max_storage_mb, max_vms, max_snapshots, max_backups, max_vnets, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const insertUsage = db.prepare(`
    INSERT INTO vdc_usage_cache (id, vdc_id, used_vcpus, used_ram_mb, used_storage_mb, used_vms, used_snapshots, used_backups, last_synced_at)
    VALUES (?, ?, 0, 0, 0, 0, 0, 0, NULL)
  `)

  const runTransaction = db.transaction(() => {
    insertVdc.run(
      id, input.tenantId, input.connectionId, input.name, input.slug,
      input.description ?? null, poolName, sdnZoneName, createdBy, now, now
    )

    for (const nodeName of input.nodes) {
      insertNode.run(randomUUID(), id, nodeName)
    }

    for (const storageId of input.storages) {
      insertStorage.run(randomUUID(), id, storageId)
    }

    if (input.quota) {
      insertQuota.run(
        randomUUID(), id,
        input.quota.maxVcpus ?? null,
        input.quota.maxRamMb ?? null,
        input.quota.maxStorageMb ?? null,
        input.quota.maxVms ?? null,
        input.quota.maxSnapshots ?? null,
        input.quota.maxBackups ?? null,
        input.quota.maxVnets ?? null,
        now
      )
    }

    const insertShared = db.prepare(
      'INSERT INTO vdc_shared_bridges (id, vdc_id, bridge, label, created_at) VALUES (?, ?, ?, ?, ?)'
    )
    for (const sb of input.sharedBridges ?? []) {
      insertShared.run(randomUUID(), id, sb.bridge, sb.label ?? null, now)
    }

    insertUsage.run(randomUUID(), id)
  })

  try {
    runTransaction()
  } catch (err: any) {
    // DB transaction failed - rollback PVE resources to avoid orphans
    try { await deleteZone(conn, sdnZoneName) } catch {}
    try {
      await pveFetch(conn, `/pools/${encodeURIComponent(poolName)}`, { method: 'DELETE' })
    } catch {}
    throw err
  }

  try {
    await applySdn(conn)
  } catch (err: any) {
    // Do not roll back - config is written to /etc/pve/sdn/*.cfg; admin can retry apply.
    console.warn(`[vdc] applySdn failed after creating zone "${sdnZoneName}": ${err?.message}`)
  }

  return getVdcById(id)!
}

// ---------------------------------------------------------------------------
// updateVdc
// ---------------------------------------------------------------------------

export async function updateVdc(id: string, input: UpdateVdcInput): Promise<VdcWithDetails> {
  const db = getDb()

  // Verify vDC exists
  const existing = db.prepare('SELECT id FROM vdcs WHERE id = ?').get(id) as any
  if (!existing) {
    throw new Error(`vDC not found: ${id}`)
  }

  const now = new Date().toISOString()

  const updateVdcStmt = db.prepare(`
    UPDATE vdcs SET
      name = COALESCE(?, name),
      description = COALESCE(?, description),
      enabled = COALESCE(?, enabled),
      updated_at = ?
    WHERE id = ?
  `)

  const deleteNodes = db.prepare('DELETE FROM vdc_nodes WHERE vdc_id = ?')
  const insertNode = db.prepare('INSERT INTO vdc_nodes (id, vdc_id, node_name) VALUES (?, ?, ?)')
  const deleteStorages = db.prepare('DELETE FROM vdc_storages WHERE vdc_id = ?')
  const insertStorage = db.prepare('INSERT INTO vdc_storages (id, vdc_id, storage_id) VALUES (?, ?, ?)')

  // Upsert quota: try UPDATE first, INSERT if no row exists
  const upsertQuota = db.prepare(`
    INSERT INTO vdc_quotas (id, vdc_id, max_vcpus, max_ram_mb, max_storage_mb, max_vms, max_snapshots, max_backups, max_vnets, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(vdc_id) DO UPDATE SET
      max_vcpus = excluded.max_vcpus,
      max_ram_mb = excluded.max_ram_mb,
      max_storage_mb = excluded.max_storage_mb,
      max_vms = excluded.max_vms,
      max_snapshots = excluded.max_snapshots,
      max_backups = excluded.max_backups,
      max_vnets = excluded.max_vnets,
      updated_at = excluded.updated_at
  `)

  const runTransaction = db.transaction(() => {
    updateVdcStmt.run(
      input.name ?? null,
      input.description ?? null,
      input.enabled !== undefined ? (input.enabled ? 1 : 0) : null,
      now,
      id
    )

    if (input.nodes) {
      deleteNodes.run(id)
      for (const nodeName of input.nodes) {
        insertNode.run(randomUUID(), id, nodeName)
      }
    }

    if (input.storages) {
      deleteStorages.run(id)
      for (const storageId of input.storages) {
        insertStorage.run(randomUUID(), id, storageId)
      }
    }

    if (input.sharedBridges) {
      db.prepare('DELETE FROM vdc_shared_bridges WHERE vdc_id = ?').run(id)
      const insertShared = db.prepare(
        'INSERT INTO vdc_shared_bridges (id, vdc_id, bridge, label, created_at) VALUES (?, ?, ?, ?, ?)'
      )
      for (const sb of input.sharedBridges) {
        insertShared.run(randomUUID(), id, sb.bridge, sb.label ?? null, now)
      }
    }

    if (input.quota) {
      upsertQuota.run(
        randomUUID(), id,
        input.quota.maxVcpus ?? null,
        input.quota.maxRamMb ?? null,
        input.quota.maxStorageMb ?? null,
        input.quota.maxVms ?? null,
        input.quota.maxSnapshots ?? null,
        input.quota.maxBackups ?? null,
        input.quota.maxVnets ?? null,
        now
      )
    }
  })

  runTransaction()

  return getVdcById(id)!
}

// ---------------------------------------------------------------------------
// deleteVdc
// ---------------------------------------------------------------------------

export async function deleteVdc(id: string): Promise<void> {
  const db = getDb()

  // 1. Load vDC from DB
  const row = db.prepare('SELECT * FROM vdcs WHERE id = ?').get(id) as any
  if (!row) {
    throw new Error(`vDC not found: ${id}`)
  }
  const vdc = rowToVdc(row)

  // 2. Check PVE pool for VMs
  const connOwnerTenantId = await getConnectionOwnerTenantId(vdc.connectionId)
  const conn = await getConnectionById(vdc.connectionId, connOwnerTenantId)

  try {
    const poolData = await pveFetch<{ members?: any[] }>(conn, `/pools/${encodeURIComponent(vdc.pvePoolName)}`)
    const members = poolData?.members || []
    let vmMembers = members.filter(
      (m: any) => m.type === 'qemu' || m.type === 'lxc'
    )

    // Same ghost-filter as refreshVdcUsage: cross-reference with
    // /cluster/resources so deletion isn't blocked by stale pool refs
    // pointing to VMs that no longer exist. Same auto-cleanup attempt
    // — leftover ghosts wouldn't survive the pool deletion below
    // anyway, but cleaning them now logs a clearer trail.
    if (vmMembers.length > 0) {
      try {
        const liveResources = await pveFetch<any[]>(conn, '/cluster/resources?type=vm')
        const validIds = new Set(
          (liveResources || [])
            .filter((r: any) => r?.vmid != null)
            .map((r: any) => `${r.type}/${r.vmid}`),
        )
        const ghosts = vmMembers.filter(m => !validIds.has(`${m.type}/${m.vmid}`))
        vmMembers = vmMembers.filter(m => validIds.has(`${m.type}/${m.vmid}`))
        for (const g of ghosts) {
          try {
            await pveFetch(conn, `/pools/${encodeURIComponent(vdc.pvePoolName)}`, {
              method: 'PUT',
              body: new URLSearchParams({ delete: '1', vms: String(g.vmid) }),
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            } as any)
          } catch (err: any) {
            console.warn(`[vdc-delete] failed to clean ghost ${g.type}/${g.vmid}: ${err?.message}`)
          }
        }
      } catch (err: any) {
        console.warn(`[vdc-delete] /cluster/resources lookup failed: ${err?.message}`)
      }
    }

    if (vmMembers.length > 0) {
      throw new Error(
        `Cannot delete vDC "${vdc.name}": PVE pool "${vdc.pvePoolName}" still contains ${vmMembers.length} VM(s)/container(s). Remove them first.`
      )
    }
  } catch (err: any) {
    // If the pool doesn't exist on PVE side, that's fine - proceed with DB cleanup
    const msg = err?.message || ''
    if (msg.includes('Cannot delete vDC')) {
      throw err // re-throw our own check error
    }
    // Pool not found or unreachable - log and continue
    console.warn(`[vdc] Could not check PVE pool "${vdc.pvePoolName}": ${msg}`)
  }

  // 3. Delete all VNets in the vDC zone (best effort).
  //    Cascade order matters on PVE: subnet → vnet → zone. Skipping the
  //    subnet leaves PVE with "vnet has subnets" → vnet delete fails →
  //    zone delete fails because the vnet is still attached. Each helper
  //    is idempotent (404 / "does not exist" tolerated) so external drift
  //    doesn't block the rest of the cascade.
  if (vdc.sdnZoneName) {
    const vnetRows = db.prepare(`
      SELECT v.id AS vnet_id, v.pve_name
      FROM vdc_vnets v
      WHERE v.vdc_id = ?
    `).all(id) as Array<{ vnet_id: string; pve_name: string }>

    // No PVE-side subnet to drop anymore — subnets only live in our DB and
    // are removed by the vdc_vnets ON DELETE CASCADE / vdc_subnets cascade.

    for (const v of vnetRows) {
      try {
        await deleteVnetPve(conn, v.pve_name)
      } catch (err: any) {
        console.warn(`[vdc] Failed to delete VNet "${v.pve_name}": ${err?.message}`)
      }
    }

    // Delete the SDN zone
    try {
      await deleteZone(conn, vdc.sdnZoneName)
    } catch (err: any) {
      console.warn(`[vdc] Failed to delete SDN zone "${vdc.sdnZoneName}": ${err?.message}`)
    }
  }

  // 4. Delete PVE pool (best effort)
  try {
    await pveFetch(conn, `/pools/${encodeURIComponent(vdc.pvePoolName)}`, { method: 'DELETE' })
  } catch (err: any) {
    console.warn(`[vdc] Failed to delete PVE pool "${vdc.pvePoolName}" (best effort): ${err?.message}`)
  }

  // 5. Apply SDN changes if zone was removed
  if (vdc.sdnZoneName) {
    try {
      await applySdn(conn)
    } catch (err: any) {
      console.warn(`[vdc] applySdn failed after deleting zone "${vdc.sdnZoneName}": ${err?.message}`)
    }
  }

  // 6. Delete from DB (CASCADE handles child tables)
  db.prepare('DELETE FROM vdcs WHERE id = ?').run(id)
}

// ---------------------------------------------------------------------------
// refreshVdcUsage
// ---------------------------------------------------------------------------

export async function refreshVdcUsage(vdcId: string): Promise<VdcUsage> {
  const db = getDb()

  // 1. Load vDC
  const row = db.prepare('SELECT * FROM vdcs WHERE id = ?').get(vdcId) as any
  if (!row) {
    throw new Error(`vDC not found: ${vdcId}`)
  }
  const vdc = rowToVdc(row)

  // 2. Get connection (use the connection's owner tenantId, not the vDC's tenantId)
  const connOwnerTenantId = await getConnectionOwnerTenantId(vdc.connectionId)
  const conn = await getConnectionById(vdc.connectionId, connOwnerTenantId)

  // 3. Fetch pool members
  let members: any[] = []
  try {
    const poolData = await pveFetch<{ members?: any[] }>(conn, `/pools/${encodeURIComponent(vdc.pvePoolName)}`)
    members = poolData?.members || []
  } catch (err: any) {
    console.warn(`[vdc] Failed to fetch pool members for "${vdc.pvePoolName}": ${err?.message}`)
  }

  // 4. Filter for qemu/lxc members, then drop ghosts. PVE pools can hold
  //    references to vmids that no longer exist (VM deleted but the pool
  //    membership wasn't cleaned up — happens when /cluster/resources
  //    races with the delete, or when a tool deleted the VM directly via
  //    qm/pct without going through ProxCenter). Counting them blocks the
  //    vDC delete forever; cross-reference with /cluster/resources and
  //    auto-clean the orphans from the pool.
  let vmMembers = members.filter(
    (m: any) => m.type === 'qemu' || m.type === 'lxc'
  )

  if (vmMembers.length > 0) {
    try {
      const liveResources = await pveFetch<any[]>(conn, '/cluster/resources?type=vm')
      const validIds = new Set(
        (liveResources || [])
          .filter((r: any) => r?.vmid != null)
          .map((r: any) => `${r.type}/${r.vmid}`),
      )
      const ghosts = vmMembers.filter(m => !validIds.has(`${m.type}/${m.vmid}`))
      vmMembers = vmMembers.filter(m => validIds.has(`${m.type}/${m.vmid}`))

      // Best-effort cleanup of ghost references on the PVE pool. PVE
      // accepts PUT /pools/<poolname> with `delete=1` + `vms=<id>` to
      // remove a member. We do them sequentially to avoid PVE locking
      // issues on the same pool config.
      for (const g of ghosts) {
        try {
          await pveFetch(conn, `/pools/${encodeURIComponent(vdc.pvePoolName)}`, {
            method: 'PUT',
            body: new URLSearchParams({ delete: '1', vms: String(g.vmid) }),
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          } as any)
          console.info(`[vdc] cleaned ghost ${g.type}/${g.vmid} from pool "${vdc.pvePoolName}"`)
        } catch (err: any) {
          console.warn(`[vdc] failed to clean ghost ${g.type}/${g.vmid} from pool "${vdc.pvePoolName}": ${err?.message}`)
        }
      }
    } catch (err: any) {
      console.warn(`[vdc] /cluster/resources lookup failed; counting all pool members: ${err?.message}`)
    }
  }

  // 5. Sum resources
  let usedVcpus = 0
  let usedRamMb = 0
  let usedStorageMb = 0
  let usedVms = vmMembers.length
  let usedSnapshots = 0
  let usedBackups = 0

  for (const vm of vmMembers) {
    usedVcpus += vm.maxcpu || 0
    usedRamMb += Math.round((vm.maxmem || 0) / 1048576)
    usedStorageMb += Math.round((vm.maxdisk || 0) / 1048576)
  }

  // 6. Count snapshots per VM (non-"current" entries)
  for (const vm of vmMembers) {
    try {
      const snapshots = await pveFetch<any[]>(
        conn,
        `/nodes/${encodeURIComponent(vm.node)}/${vm.type}/${vm.vmid}/snapshot`
      )
      if (Array.isArray(snapshots)) {
        usedSnapshots += snapshots.filter((s: any) => s.name !== 'current').length
      }
    } catch {
      // Snapshot fetch failed for this VM - skip
    }
  }

  // 7. Upsert into vdc_usage_cache
  const now = new Date().toISOString()

  db.prepare(`
    INSERT INTO vdc_usage_cache (id, vdc_id, used_vcpus, used_ram_mb, used_storage_mb, used_vms, used_snapshots, used_backups, last_synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(vdc_id) DO UPDATE SET
      used_vcpus = excluded.used_vcpus,
      used_ram_mb = excluded.used_ram_mb,
      used_storage_mb = excluded.used_storage_mb,
      used_vms = excluded.used_vms,
      used_snapshots = excluded.used_snapshots,
      used_backups = excluded.used_backups,
      last_synced_at = excluded.last_synced_at
  `).run(randomUUID(), vdcId, usedVcpus, usedRamMb, usedStorageMb, usedVms, usedSnapshots, usedBackups, now)

  return {
    usedVcpus,
    usedRamMb,
    usedStorageMb,
    usedVms,
    usedSnapshots,
    usedBackups,
    lastSyncedAt: now,
  }
}
