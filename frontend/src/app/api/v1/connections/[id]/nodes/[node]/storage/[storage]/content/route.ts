import { NextResponse } from "next/server"

import { pveFetch } from "@/lib/proxmox/client"
import { getConnectionById } from "@/lib/connections/getConnection"
import { checkPermission, PERMISSIONS } from "@/lib/rbac"
import { getCurrentTenantId } from "@/lib/tenant"
import { getVdcScope } from "@/lib/vdc/scope"

export const runtime = "nodejs"

// GET /api/v1/connections/{id}/nodes/{node}/storage/{storage}/content?content=iso
export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string; node: string; storage: string }> }
) {
  try {
    const { id, node, storage } = await ctx.params

    const denied = await checkPermission(PERMISSIONS.VM_VIEW, "connection", id)
    if (denied) return denied

    // Tenants may browse content (mainly ISOs for the VM create picker) ONLY
    // on storages assigned to their vDC — super admins are unrestricted
    // (getVdcScope returns null for them). Stops cross-tenant enumeration on
    // shared storages the tenant never attached.
    const tenantId = await getCurrentTenantId()
    const scope = getVdcScope(tenantId)
    if (scope) {
      const allowed = scope.storagesByConnection.get(id)
      if (!allowed || !allowed.has(storage)) {
        return NextResponse.json({ error: "Storage not accessible" }, { status: 403 })
      }
    }

    const conn = await getConnectionById(id)

    const url = new URL(req.url)
    const contentType = url.searchParams.get("content") || ""

    const query = contentType ? `?content=${encodeURIComponent(contentType)}` : ""
    const data = await pveFetch<any[]>(
      conn,
      `/nodes/${encodeURIComponent(node)}/storage/${encodeURIComponent(storage)}/content${query}`
    )

    return NextResponse.json({ data: data || [] })
  } catch (e: any) {
    console.error("Error fetching storage content:", String(e?.message || e).replace(/[\r\n]/g, ''))
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 })
  }
}
