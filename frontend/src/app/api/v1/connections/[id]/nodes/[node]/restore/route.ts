import { NextResponse, after } from "next/server"

import { pveFetch } from "@/lib/proxmox/client"
import { getConnectionById } from "@/lib/connections/getConnection"
import { checkPermission, buildNodeResourceId, PERMISSIONS } from "@/lib/rbac"
import { syncIpamForVmConfig } from "@/lib/vdc/ipamSync"
import { releaseAllocationsForVm } from "@/lib/vdc/ipam"
import { waitForTask } from "@/lib/proxmox/tasks"
import { prisma } from "@/lib/db/prisma"
import { getCurrentTenantId, DEFAULT_TENANT_ID } from "@/lib/tenant"

export const runtime = "nodejs"

// POST /api/v1/connections/{id}/nodes/{node}/restore
// Restore a VM or CT from a backup (vzdump/PBS)
export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string; node: string }> }
) {
  try {
    const { id, node } = await ctx.params

    const resourceId = buildNodeResourceId(id, node)
    const denied = await checkPermission(PERMISSIONS.VM_BACKUP, "node", resourceId)
    if (denied) return denied

    const body = await req.json()
    const {
      vmid,
      archive: archiveDirect,
      storage,
      type = 'qemu',
      bwlimit,
      unique,
      start,
      live,
      name,
      memory,
      cores,
      sockets,
      pbsBackup,
      force,
    } = body

    if (!vmid) {
      return NextResponse.json({ error: "VMID is required" }, { status: 400 })
    }

    const conn = await getConnectionById(id)

    // Resolve the PVE-side volid the way qmrestore expects it. Two paths:
    //
    // 1. The caller already knows the volid (e.g. /storage/.../content
    //    listings on a PVE-configured PBS storage produce them directly).
    //    Pass it as `archive` and we use it as-is.
    //
    // 2. The caller only has PBS-side coordinates (this is what
    //    /api/v1/guests/{vmid}/backups returns, since it queries PBS
    //    directly without going through PVE). Pass them as
    //    `pbsBackup: { pbsId, datastore, namespace, backupPath }` and we
    //    look up the PVE storage that targets this (datastore, namespace)
    //    pair, then compose `<storageName>:<backupPath>`.
    let archive: string | null = typeof archiveDirect === 'string' && archiveDirect ? archiveDirect : null
    if (!archive && pbsBackup && typeof pbsBackup === 'object') {
      const { pbsId, datastore, namespace, backupPath } = pbsBackup as {
        pbsId?: string; datastore?: string; namespace?: string; backupPath?: string
      }
      if (!pbsId || !datastore || !backupPath) {
        return NextResponse.json({ error: "pbsBackup requires pbsId, datastore, and backupPath" }, { status: 400 })
      }
      // Look up the PBS connection to know which `server` PVE storages
      // need to advertise. We compare lower-cased hostnames so an IP vs
      // FQDN mismatch (e.g. `pbs.lab` vs `10.0.0.5`) doesn't break the
      // join — both sides are normalised the same way.
      const pbsConn = await prisma.connection.findUnique({
        where: { id: pbsId },
        select: { baseUrl: true },
      })
      if (!pbsConn?.baseUrl) {
        return NextResponse.json({ error: "PBS connection not found" }, { status: 404 })
      }
      const pbsHost = (() => {
        try { return new URL(pbsConn.baseUrl).hostname.toLowerCase() } catch { return '' }
      })()

      // List PVE storages on the target node and pick the one whose pbs-
      // type config points at the same server + datastore (and namespace).
      const nodeStorages = await pveFetch<any[]>(
        conn,
        `/nodes/${encodeURIComponent(node)}/storage?content=backup`
      ).catch(() => [])

      // For each candidate, GET /storage/{name} to read its `server` /
      // `datastore` / `namespace` fields. The /nodes/X/storage listing
      // doesn't return them, only the names + types.
      const wantedNs = (namespace || '').trim()
      let matchedStorage: string | null = null
      for (const s of (nodeStorages || [])) {
        if ((s.type || '').toLowerCase() !== 'pbs') continue
        const storageName: string = String(s.storage || '')
        if (!storageName) continue
        try {
          const cfg = await pveFetch<any>(conn, `/storage/${encodeURIComponent(storageName)}`)
          const cfgServer = String(cfg?.server || '').toLowerCase()
          const cfgDatastore = String(cfg?.datastore || '')
          const cfgNamespace = String(cfg?.namespace || '').trim()
          const sameHost = !!cfgServer && (cfgServer === pbsHost || cfgServer === pbsConn.baseUrl.toLowerCase())
          const sameDs = cfgDatastore === datastore
          const sameNs = cfgNamespace === wantedNs
          if (sameHost && sameDs && sameNs) {
            matchedStorage = storageName
            break
          }
        } catch { /* continue probing other candidates */ }
      }
      if (!matchedStorage) {
        return NextResponse.json({
          error: `No PVE storage on node "${node}" maps to PBS datastore "${datastore}"${wantedNs ? ` (ns: ${wantedNs})` : ''}. Configure one before restoring.`,
        }, { status: 409 })
      }
      // backupPath comes from /guests/{vmid}/backups already shaped as
      // `backup/<type>/<id>/<isoTime>` — drop into the volid form.
      archive = `${matchedStorage}:${backupPath}`
    }

    if (!archive) {
      return NextResponse.json({ error: "archive (or pbsBackup) is required" }, { status: 400 })
    }

    // PVE's PBSPlugin volname regex requires the timestamp to end strictly in
    // `Z`, no fractions: `\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$`. Any caller
    // that built the path from a raw `Date.toISOString()` (which always emits
    // `.NNNZ`) without stripping the millis would 500 here. Strip defensively
    // so any upstream miss doesn't surface as "unable to parse PBS volume name".
    archive = archive.replace(/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.\d{1,6}Z$/, '$1Z')

    // PVE has no /qmrestore or /vzrestore REST endpoint — those are CLI
    // commands. The actual restore lives behind POST /nodes/{node}/qemu
    // (with `archive=...`) and POST /nodes/{node}/lxc (with
    // `ostemplate=...,restore=1`). The original implementation pointed
    // at the CLI names and 501'd unconditionally.
    const isLxc = type === 'lxc'
    const endpoint = isLxc ? 'lxc' : 'qemu'

    const params: Record<string, string> = {
      vmid: String(vmid),
    }

    if (isLxc) {
      // For containers, the backup volid goes on `ostemplate` and we
      // must opt in to restore mode explicitly — otherwise PVE treats
      // the call as a fresh CT create and complains about missing args.
      params.ostemplate = archive
      params.restore = '1'
    } else {
      params.archive = archive
    }

    if (storage) params.storage = storage
    if (bwlimit) params.bwlimit = String(bwlimit)
    if (unique) params.unique = '1'
    if (start) params.start = '1'
    if (live && !isLxc) params['live-restore'] = '1'
    // `force=1` lets PVE overwrite an existing VMID — required when the
    // tenant chooses "Restore on top of source VM". Without it PVE
    // refuses with "VM/CT <id> already exists".
    if (force) params.force = '1'

    // Override settings
    if (name) params.name = name
    if (memory) params.memory = String(memory)
    if (cores) params.cores = String(cores)
    if (sockets) params.sockets = String(sockets)

    const result = await pveFetch<string>(
      conn,
      `/nodes/${encodeURIComponent(node)}/${endpoint}`,
      {
        method: 'POST',
        body: new URLSearchParams(params).toString(),
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      }
    )

    // ── Post-restore IPAM sync (qemu only) ──
    // qmrestore reinjects the saved netN/ipconfigN. For VMs that were
    // tracked by our IPAM before the backup, the same (subnet, mac)
    // tuple should produce the same IP — allocateIp is idempotent on
    // MAC, so a re-allocate with hint=ip just succeeds. For restores
    // into a fresh vmid with `unique=1`, PVE regenerates the MAC and
    // the helper allocates a fresh IP for it.
    //
    // Caveat: restoring without `unique=1` into a vmid that doesn't
    // collide with the source's still-running VM is rare but can
    // produce duplicate (subnet, mac) allocations across vmids — the
    // upcoming Restore UI will default unique=1 in that case. For
    // now, the sync runs best-effort and any collision surfaces in
    // the server logs.
    // Resolve the tenant's vDC pool eagerly (cookies are gone after the
    // response is sent and `after()` runs). qmrestore/vzrestore land VMs
    // outside any pool — without this placement the restored VM is invisible
    // in the tenant's vDC scope (vDC membership is keyed on PVE pool).
    let targetPool: string | null = null
    try {
      const tenantId = await getCurrentTenantId()
      if (tenantId !== DEFAULT_TENANT_ID) {
        const row = await prisma.vdc.findFirst({
          where: {
            tenantId,
            connectionId: id,
            enabled: true,
            nodes: { some: { nodeName: node } },
          },
          select: { pvePoolName: true },
        })
        targetPool = row?.pvePoolName ?? null
      }
    } catch (err: any) {
      console.error(`[restore-pool] failed to resolve target pool: ${err?.message ?? err}`)
    }

    if (result) {
      const upid = String(result)
      const numericVmid = Number(vmid)
      after(async () => {
        try {
          await waitForTask(conn, node, upid)
        } catch (err: any) {
          console.error(`[restore] waitForTask failed for vmid=${vmid}: ${err?.message ?? err}`)
          return
        }

        // Pool placement (tenant vDC scope only — provider doesn't auto-pool).
        // Applies to both qemu and lxc since both are scoped via PVE pools.
        if (targetPool) {
          try {
            await pveFetch(
              conn,
              `/pools/${encodeURIComponent(targetPool)}`,
              {
                method: 'PUT',
                body: new URLSearchParams({ vms: String(numericVmid) }).toString(),
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              } as any
            )
          } catch (err: any) {
            console.error(`[restore-pool] failed to add vmid=${numericVmid} to pool ${targetPool}: ${err?.message ?? err}`)
          }
        }

        // IPAM sync — qemu only (lxc network config is shaped differently
        // and isn't tracked by syncIpamForVmConfig today).
        if (isLxc) return

        try {
          const restoredConfig = await pveFetch<any>(
            conn,
            `/nodes/${encodeURIComponent(node)}/qemu/${encodeURIComponent(String(numericVmid))}/config`
          )

          const sync = await syncIpamForVmConfig({
            before: null,
            after: restoredConfig,
            conn,
            connectionId: id,
            vmid: numericVmid,
            hostname: typeof name === 'string' ? name : (restoredConfig?.name ?? null),
          })

          // Push back any ipconfigN corrections (auto-pick / hint conflict
          // resolution) so the restored VM boots with the IPAM-allocated
          // IP rather than whatever the backup had baked in.
          if (Object.keys(sync.bodyOverrides).length > 0) {
            const patch = new URLSearchParams()
            for (const [k, v] of Object.entries(sync.bodyOverrides)) patch.set(k, v)
            try {
              await pveFetch<any>(
                conn,
                `/nodes/${encodeURIComponent(node)}/qemu/${encodeURIComponent(String(numericVmid))}/config`,
                {
                  method: 'PUT',
                  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                  body: patch.toString(),
                }
              )
            } catch (err: any) {
              console.error(`[restore-ipam-sync] PVE PUT config failed for vmid=${numericVmid}: ${err?.message ?? err}`)
              try { sync.rollback() } catch { /* tolerate */ }
              try { await releaseAllocationsForVm(id, numericVmid) } catch { /* tolerate */ }
            }
          }
        } catch (err: any) {
          console.error(`[restore-ipam-sync] post-restore IPAM sync failed for vmid=${vmid}: ${err?.message ?? err}`)
          // Best-effort cleanup so a failed sync doesn't leak partial
          // allocations. The restored VM stays — data loss > drift.
          try { releaseAllocationsForVm(id, numericVmid) } catch { /* tolerate */ }
        }
      })
    }

    const { audit } = await import("@/lib/audit")
    await audit({
      action: "restore",
      category: "backups",
      resourceType: "vm",
      resourceId: String(vmid),
      details: { node, connectionId: id, archive, storage, type },
    })

    return NextResponse.json({
      success: true,
      data: result,
      message: `Restore of ${isLxc ? 'CT' : 'VM'} ${vmid} started`,
    })
  } catch (e: any) {
    console.error('Error restoring backup:', e)
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 })
  }
}
