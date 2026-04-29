import { NextResponse, after } from "next/server"

import { pveFetch } from "@/lib/proxmox/client"
import { getConnectionById } from "@/lib/connections/getConnection"
import { checkPermission, buildNodeResourceId, PERMISSIONS } from "@/lib/rbac"
import { syncIpamForVmConfig } from "@/lib/vdc/ipamSync"
import { releaseAllocationsForVm } from "@/lib/vdc/ipam"
import { waitForTask } from "@/lib/proxmox/tasks"

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
      archive,
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
    } = body

    if (!vmid) {
      return NextResponse.json({ error: "VMID is required" }, { status: 400 })
    }
    if (!archive) {
      return NextResponse.json({ error: "Archive volume ID is required" }, { status: 400 })
    }

    const conn = await getConnectionById(id)

    const isLxc = type === 'lxc'
    const endpoint = isLxc ? 'vzrestore' : 'qmrestore'

    const params: Record<string, string> = {
      vmid: String(vmid),
      archive: archive,
    }

    if (storage) params.storage = storage
    if (bwlimit) params.bwlimit = String(bwlimit)
    if (unique) params.unique = '1'
    if (start) params.start = '1'
    if (live && !isLxc) params['live-restore'] = '1'

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
    if (!isLxc && result) {
      const upid = String(result)
      const numericVmid = Number(vmid)
      after(async () => {
        try {
          await waitForTask(conn, node, upid)
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
              try { releaseAllocationsForVm(id, numericVmid) } catch { /* tolerate */ }
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
