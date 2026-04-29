import { NextResponse } from "next/server"

import { getCurrentTenantId } from "@/lib/tenant"
import { checkPermission } from "@/lib/rbac"
import { getDb } from "@/lib/db/sqlite"
import { updateVnetForTenant, deleteVnetForTenant } from "@/lib/vdc/vnets"

export const runtime = "nodejs"

// The dynamic segment is named [pveName] for historical reasons. Its actual
// value is the VNet's user-facing display_name (scoped to the vDC). We keep
// the folder name to avoid breaking existing redirects/bookmarks.
type RouteContext = { params: Promise<{ id: string; pveName: string }> | { id: string; pveName: string } }

// GET /api/v1/vdcs/{id}/vnets/{displayName}
export async function GET(_req: Request, ctx: RouteContext) {
  try {
    const params = await Promise.resolve(ctx.params)
    const vdcId = (params as any)?.id
    const displayName = (params as any)?.pveName
    if (!vdcId || !displayName) return NextResponse.json({ error: "Missing params" }, { status: 400 })

    const denied = await checkPermission("sdn.vnet.view")
    if (denied) return denied

    const tenantId = await getCurrentTenantId()
    const db = getDb()
    const row = db.prepare(`
      SELECT v.id, v.vdc_id, v.pve_name, v.display_name, v.description, v.vxlan_tag, v.firewall,
             v.created_by, v.created_at
      FROM vdc_vnets v
      JOIN vdcs d ON d.id = v.vdc_id
      WHERE v.vdc_id = ? AND v.display_name = ? AND d.tenant_id = ?
    `).get(vdcId, displayName, tenantId) as any

    if (!row) return NextResponse.json({ error: "VNet not found" }, { status: 404 })

    const subnetRow = db.prepare(`
      SELECT id, vnet_id, cidr, gateway, dns_servers, ipam_enabled, created_at
      FROM vdc_subnets WHERE vnet_id = ? LIMIT 1
    `).get(row.id) as any

    if (!subnetRow) {
      return NextResponse.json({ error: "VNet has no subnet — DB migration required" }, { status: 500 })
    }
    const subnet = {
      id: subnetRow.id,
      vnetId: subnetRow.vnet_id,
      cidr: subnetRow.cidr,
      gateway: subnetRow.gateway,
      dnsServers: subnetRow.dns_servers
        ? String(subnetRow.dns_servers).split(',').map((s: string) => s.trim()).filter(Boolean)
        : [],
      ipamEnabled: !!subnetRow.ipam_enabled,
      createdAt: subnetRow.created_at,
    }

    return NextResponse.json({
      data: {
        id: row.id,
        vdcId: row.vdc_id,
        pveName: row.pve_name,
        displayName: row.display_name ?? row.pve_name,
        description: row.description ?? null,
        vxlanTag: row.vxlan_tag,
        firewall: !!row.firewall,
        subnet,
        createdBy: row.created_by ?? null,
        createdAt: row.created_at,
      },
    })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 })
  }
}

// PUT /api/v1/vdcs/{id}/vnets/{displayName}
export async function PUT(req: Request, ctx: RouteContext) {
  try {
    const params = await Promise.resolve(ctx.params)
    const vdcId = (params as any)?.id
    const displayName = (params as any)?.pveName
    if (!vdcId || !displayName) return NextResponse.json({ error: "Missing params" }, { status: 400 })

    const denied = await checkPermission("sdn.vnet.edit")
    if (denied) return denied

    const body = await req.json().catch(() => ({}))
    const patch: {
      description?: string
      firewall?: boolean
      subnet?: {
        dnsServers?: string[]
      }
    } = {}
    if (typeof body?.description === "string") patch.description = body.description.trim()
    if (typeof body?.firewall === "boolean") patch.firewall = body.firewall
    if (body?.subnet && typeof body.subnet === "object") {
      const s: any = {}
      if (Array.isArray(body.subnet.dnsServers)) {
        s.dnsServers = body.subnet.dnsServers.map((x: any) => String(x).trim()).filter(Boolean)
      } else if (typeof body.subnet.dnsServers === "string") {
        s.dnsServers = body.subnet.dnsServers.split(",").map((x: string) => x.trim()).filter(Boolean)
      }
      if (Object.keys(s).length > 0) patch.subnet = s
    }

    const tenantId = await getCurrentTenantId()

    try {
      const vnet = await updateVnetForTenant(vdcId, tenantId, displayName, patch)
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

// DELETE /api/v1/vdcs/{id}/vnets/{displayName}
export async function DELETE(_req: Request, ctx: RouteContext) {
  try {
    const params = await Promise.resolve(ctx.params)
    const vdcId = (params as any)?.id
    const displayName = (params as any)?.pveName
    if (!vdcId || !displayName) return NextResponse.json({ error: "Missing params" }, { status: 400 })

    const denied = await checkPermission("sdn.vnet.delete")
    if (denied) return denied

    const tenantId = await getCurrentTenantId()

    try {
      const result = await deleteVnetForTenant(vdcId, tenantId, displayName)
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
