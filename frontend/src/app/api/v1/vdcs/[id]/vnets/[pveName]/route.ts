import { NextResponse } from "next/server"

import { getCurrentTenantId } from "@/lib/tenant"
import { checkPermission } from "@/lib/rbac"
import { getDb } from "@/lib/db/sqlite"
import { updateVnetForTenant, deleteVnetForTenant } from "@/lib/vdc/vnets"

export const runtime = "nodejs"

type RouteContext = { params: Promise<{ id: string; pveName: string }> | { id: string; pveName: string } }

// GET /api/v1/vdcs/{id}/vnets/{pveName}
export async function GET(_req: Request, ctx: RouteContext) {
  try {
    const params = await Promise.resolve(ctx.params)
    const vdcId = (params as any)?.id
    const pveName = (params as any)?.pveName
    if (!vdcId || !pveName) return NextResponse.json({ error: "Missing params" }, { status: 400 })

    const denied = await checkPermission("sdn.vnet.view")
    if (denied) return denied

    const tenantId = await getCurrentTenantId()
    const db = getDb()
    const row = db.prepare(`
      SELECT v.id, v.vdc_id, v.pve_name, v.description, v.vxlan_tag, v.firewall, v.created_by, v.created_at
      FROM vdc_vnets v
      JOIN vdcs d ON d.id = v.vdc_id
      WHERE v.vdc_id = ? AND v.pve_name = ? AND d.tenant_id = ?
    `).get(vdcId, pveName, tenantId) as any

    if (!row) return NextResponse.json({ error: "VNet not found" }, { status: 404 })

    return NextResponse.json({
      data: {
        id: row.id,
        vdcId: row.vdc_id,
        pveName: row.pve_name,
        description: row.description ?? null,
        vxlanTag: row.vxlan_tag,
        firewall: !!row.firewall,
        createdBy: row.created_by ?? null,
        createdAt: row.created_at,
      },
    })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 })
  }
}

// PUT /api/v1/vdcs/{id}/vnets/{pveName}
export async function PUT(req: Request, ctx: RouteContext) {
  try {
    const params = await Promise.resolve(ctx.params)
    const vdcId = (params as any)?.id
    const pveName = (params as any)?.pveName
    if (!vdcId || !pveName) return NextResponse.json({ error: "Missing params" }, { status: 400 })

    const denied = await checkPermission("sdn.vnet.edit")
    if (denied) return denied

    const body = await req.json().catch(() => ({}))
    const patch: { description?: string; firewall?: boolean } = {}
    if (typeof body?.description === "string") patch.description = body.description.trim()
    if (typeof body?.firewall === "boolean") patch.firewall = body.firewall

    const tenantId = await getCurrentTenantId()

    try {
      const vnet = await updateVnetForTenant(vdcId, tenantId, pveName, patch)
      return NextResponse.json({ data: vnet })
    } catch (err: any) {
      const msg = err?.message || String(err)
      if (msg.includes("vDC not found") || (msg.includes("VNet") && msg.includes("not found"))) {
        return NextResponse.json({ error: msg }, { status: 404 })
      }
      throw err
    }
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 })
  }
}

// DELETE /api/v1/vdcs/{id}/vnets/{pveName}
export async function DELETE(_req: Request, ctx: RouteContext) {
  try {
    const params = await Promise.resolve(ctx.params)
    const vdcId = (params as any)?.id
    const pveName = (params as any)?.pveName
    if (!vdcId || !pveName) return NextResponse.json({ error: "Missing params" }, { status: 400 })

    const denied = await checkPermission("sdn.vnet.delete")
    if (denied) return denied

    const tenantId = await getCurrentTenantId()

    try {
      const result = await deleteVnetForTenant(vdcId, tenantId, pveName)
      if (result.deleted === false) {
        const count = result.attachmentCount
        return NextResponse.json(
          { error: `VNet in use by ${count} NIC(s)`, attachmentCount: count },
          { status: 409 }
        )
      }
      return NextResponse.json({ success: true })
    } catch (err: any) {
      const msg = err?.message || String(err)
      if (msg.includes("vDC not found") || (msg.includes("VNet") && msg.includes("not found"))) {
        return NextResponse.json({ error: msg }, { status: 404 })
      }
      throw err
    }
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 })
  }
}
