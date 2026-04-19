import { NextResponse } from "next/server"

import { pveFetch } from "@/lib/proxmox/client"
import { getConnectionById } from "@/lib/connections/getConnection"
import { checkPermission, PERMISSIONS } from "@/lib/rbac"
import { getCurrentTenantId } from "@/lib/tenant"
import { resolveVdcForTenant, checkVdcQuota } from "@/lib/vdc/quota"
import { getAllowedBridgesForTenant, parseBridgeFromNet } from "@/lib/vdc/vnets"

export const runtime = "nodejs"

/**
 * Sum the total size (in MB) of NEW disk allocations in a PVE create payload.
 * Matches qemu disk keys (scsi0, virtio0, ide0, sata0, efidisk0, tpmstate0)
 * and lxc mount points (rootfs, mp0..mp9). Size format `storage:<number>` is
 * GB for new allocations; entries whose value is a volid (e.g.
 * `storage:vm-100-disk-0`) are existing attaches and are skipped. CDROM/media
 * entries are ignored.
 */
function sumNewDiskStorageMb(body: Record<string, any>): number {
  const diskKeyRe = /^(scsi|virtio|ide|sata|efidisk|tpmstate)\d+$|^rootfs$|^mp\d+$/
  const sizeRe = /^[^:]+:(\d+(?:\.\d+)?)$/
  let totalMb = 0
  for (const [key, raw] of Object.entries(body || {})) {
    if (!diskKeyRe.test(key)) continue
    if (typeof raw !== 'string') continue
    if (/\bmedia=cdrom\b/.test(raw)) continue
    const [head] = raw.split(',')
    const m = head.match(sizeRe)
    if (!m) continue
    const gb = parseFloat(m[1])
    if (Number.isFinite(gb) && gb > 0) totalMb += Math.round(gb * 1024)
  }
  return totalMb
}

// POST /api/v1/connections/{id}/guests/{type}/{node}
// Create a new VM (qemu) or LXC container
export async function POST(
  req: Request, 
  ctx: { params: Promise<{ id: string; type: string; node: string }> | { id: string; type: string; node: string } }
) {
  try {
    const params = await Promise.resolve(ctx.params)
    const { id, type, node } = params as { id: string; type: string; node: string }

    if (!id || !type || !node) {
      return NextResponse.json({ error: "Missing required parameters" }, { status: 400 })
    }

    if (type !== 'qemu' && type !== 'lxc') {
      return NextResponse.json({ error: "Type must be 'qemu' or 'lxc'" }, { status: 400 })
    }

    const denied = await checkPermission(PERMISSIONS.VM_CREATE, "connection", id)
    if (denied) return denied

    const conn = await getConnectionById(id)
    const body = await req.json()

    // Valider les champs requis
    if (!body.vmid) {
      return NextResponse.json({ error: "vmid is required" }, { status: 400 })
    }

    // vDC quota enforcement
    const tenantId = await getCurrentTenantId()
    try {
      const vdcInfo = resolveVdcForTenant(tenantId, id, node)

      if (vdcInfo) {
        // Estimate resources from body
        const vcpus = parseInt(body.cores || '1') * parseInt(body.sockets || '1')
        const ramMb = parseInt(body.memory || '512')
        const storageMb = sumNewDiskStorageMb(body)

        const quotaCheck = await checkVdcQuota(id, vdcInfo.poolName, vdcInfo.quota, {
          type: 'create',
          addVcpus: vcpus,
          addRamMb: ramMb,
          addStorageMb: storageMb,
          addVms: 1,
        })

        if (!quotaCheck.allowed) {
          return NextResponse.json({
            error: 'Quota exceeded',
            violations: quotaCheck.violations,
            currentUsage: quotaCheck.currentUsage,
          }, { status: 409 })
        }

        // Force pool assignment - inject into body before PVE call
        body.pool = vdcInfo.poolName
      }
    } catch (e: any) {
      if (e?.message === 'NODE_NOT_AUTHORIZED') {
        return NextResponse.json({ error: 'This node is not authorized for your vDC' }, { status: 403 })
      }
      throw e
    }

    // Phase 4b: Enforce bridge whitelist
    const allowedBridges = getAllowedBridgesForTenant(tenantId, id)
    if (allowedBridges !== null) {
      for (const key of Object.keys(body || {})) {
        if (!/^net\d+$/.test(key)) continue
        const bridge = parseBridgeFromNet(String(body[key] || ""))
        if (bridge && !allowedBridges.has(bridge)) {
          return NextResponse.json(
            { error: `Bridge "${bridge}" is not authorized for this vDC. Allowed: ${Array.from(allowedBridges).join(", ")}` },
            { status: 403 }
          )
        }
      }
    }

    // Construire l'URL Proxmox
    const endpoint = `/nodes/${encodeURIComponent(node)}/${type}`

    // Appeler l'API Proxmox pour créer la VM/LXC
    const result = await pveFetch<any>(conn, endpoint, {
      method: "POST",
      body: JSON.stringify(body),
      headers: {
        'Content-Type': 'application/json'
      }
    })

    return NextResponse.json({ 
      data: result,
      message: `${type === 'qemu' ? 'VM' : 'Container'} creation started`
    })
  } catch (e: any) {
    console.error('Error creating guest:', e)
    
return NextResponse.json({ error: e?.message || String(e) }, { status: 500 })
  }
}
