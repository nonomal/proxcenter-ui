import { NextResponse } from "next/server"

import { pveFetch } from "@/lib/proxmox/client"
import { getConnectionById } from "@/lib/connections/getConnection"
import { checkPermission, PERMISSIONS } from "@/lib/rbac"
import { guardTenantStorageWrite } from "@/lib/vdc/scope"

export const runtime = "nodejs"

// DELETE /api/v1/connections/{id}/nodes/{node}/storage/{storage}/content/{volid}
// Delete a volume from Proxmox storage
export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string; node: string; storage: string; volid: string }> }
) {
  try {
    const { id, node, storage, volid } = await ctx.params

    const denied = await checkPermission(PERMISSIONS.CONNECTION_VIEW, "connection", id)
    if (denied) return denied

    const storageBlock = await guardTenantStorageWrite(id, storage)
    if (storageBlock) return storageBlock

    const conn = await getConnectionById(id)

    // The volid is URL-encoded; Proxmox expects the full volid (storage:path)
    const decodedVolid = decodeURIComponent(volid)

    await pveFetch<any>(
      conn,
      `/nodes/${encodeURIComponent(node)}/storage/${encodeURIComponent(storage)}/content/${encodeURIComponent(decodedVolid)}`,
      { method: "DELETE" }
    )

    const { audit } = await import("@/lib/audit")
    await audit({
      action: "delete" as any,
      category: "storage",
      resourceType: "storage",
      resourceId: storage,
      details: { node, connectionId: id, volid: decodedVolid },
    })

    return NextResponse.json({ success: true })
  } catch (e: any) {
    console.error("Error deleting storage content:", e)
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 })
  }
}
