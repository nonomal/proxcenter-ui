import { NextResponse } from "next/server"

import { pveFetch } from "@/lib/proxmox/client"
import { getConnectionById } from "@/lib/connections/getConnection"
import { checkPermission, buildVmResourceId, PERMISSIONS } from "@/lib/rbac"
import { cloneVmSchema } from "@/lib/schemas"
import { invalidateInventoryCache } from "@/lib/cache/inventoryCache"
import { getCurrentTenantId } from "@/lib/tenant"
import { resolveVdcForTenant, checkVdcQuota } from "@/lib/vdc/quota"

export const runtime = "nodejs"

// POST /api/v1/connections/{id}/guests/{type}/{node}/{vmid}/clone
// Clone a VM or template
export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string; type: string; node: string; vmid: string }> | { id: string; type: string; node: string; vmid: string } }
) {
  try {
    const params = await Promise.resolve(ctx.params)
    const { id, type, node, vmid } = params as { id: string; type: string; node: string; vmid: string }

    if (!id || !type || !node || !vmid) {
      return NextResponse.json({ error: "Missing required parameters" }, { status: 400 })
    }

    if (type !== 'qemu' && type !== 'lxc') {
      return NextResponse.json({ error: "Type must be 'qemu' or 'lxc'" }, { status: 400 })
    }

    // RBAC: Check vm.clone permission
    const resourceId = buildVmResourceId(id, node, type, vmid)
    const denied = await checkPermission(PERMISSIONS.VM_CLONE, "vm", resourceId)

    if (denied) return denied

    const conn = await getConnectionById(id)
    const rawBody = await req.json()

    const parseResult = cloneVmSchema.safeParse(rawBody)

    if (!parseResult.success) {
      return NextResponse.json(
        { error: "Invalid input", details: parseResult.error.flatten() },
        { status: 400 }
      )
    }

    const body = parseResult.data

    // vDC quota enforcement
    const tenantId = await getCurrentTenantId()
    let vdcPoolName: string | null = null
    try {
      const vdcInfo = resolveVdcForTenant(tenantId, id, node)

      if (vdcInfo) {
        // Fetch source VM config to estimate resources for the clone
        const vmConfig = await pveFetch<any>(
          conn,
          `/nodes/${encodeURIComponent(node)}/${type}/${encodeURIComponent(vmid)}/config`
        )
        const vcpus = (vmConfig?.cores || 1) * (vmConfig?.sockets || 1)
        const ramMb = vmConfig?.memory || 512

        const quotaCheck = await checkVdcQuota(id, vdcInfo.poolName, vdcInfo.quota, {
          type: 'clone',
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

        // Remember pool name for formData injection below
        vdcPoolName = vdcInfo.poolName
      }
    } catch (e: any) {
      if (e?.message === 'NODE_NOT_AUTHORIZED') {
        return NextResponse.json({ error: 'This node is not authorized for your vDC' }, { status: 403 })
      }
      throw e
    }

    // Construire l'URL Proxmox pour le clone
    const endpoint = `/nodes/${encodeURIComponent(node)}/${type}/${encodeURIComponent(vmid)}/clone`

    // Convertir le body en format URL-encoded (Proxmox attend ce format)
    const formData = new URLSearchParams()

    for (const [key, value] of Object.entries(body)) {
      if (value !== undefined && value !== null && value !== '') {
        formData.append(key, String(value))
      }
    }

    // Force pool assignment if tenant has a vDC
    if (vdcPoolName) {
      formData.set('pool', vdcPoolName)
    }

    // Appeler l'API Proxmox pour cloner la VM
    const result = await pveFetch<any>(conn, endpoint, {
      method: "POST",
      body: formData.toString(),
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    })

    invalidateInventoryCache()

    // Audit
    const { audit } = await import("@/lib/audit")

    await audit({
      action: "clone",
      category: type === 'lxc' ? 'containers' : 'vms',
      resourceType: type,
      resourceId: vmid,
      details: { node, connectionId: id, newVmId: body.newid, newName: body.name },
    })

    return NextResponse.json({
      data: result,
      message: `Clone operation started`
    })
  } catch (e: any) {
    console.error('Error cloning VM:', e)

return NextResponse.json({ error: e?.message || String(e) }, { status: 500 })
  }
}
