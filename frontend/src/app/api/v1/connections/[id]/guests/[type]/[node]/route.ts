import { NextResponse } from "next/server"

import { pveFetch } from "@/lib/proxmox/client"
import { getConnectionById } from "@/lib/connections/getConnection"
import { checkPermission, PERMISSIONS } from "@/lib/rbac"
import { getCurrentTenantId } from "@/lib/tenant"
import { resolveVdcForTenant, checkVdcQuota } from "@/lib/vdc/quota"

export const runtime = "nodejs"

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

        const quotaCheck = await checkVdcQuota(id, vdcInfo.poolName, vdcInfo.quota, {
          type: 'create',
          addVcpus: vcpus,
          addRamMb: ramMb,
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
