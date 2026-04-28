import { NextResponse } from "next/server"
import { getServerSession } from "next-auth"

import { authOptions } from "@/lib/auth/config"
import { getCurrentTenantId } from "@/lib/tenant"
import { checkPermission } from "@/lib/rbac"
import { listVnetsForTenant, createVnetForTenant } from "@/lib/vdc/vnets"

export const runtime = "nodejs"

type RouteContext = { params: Promise<{ id: string }> | { id: string } }

// GET /api/v1/vdcs/{id}/vnets
export async function GET(_req: Request, ctx: RouteContext) {
  try {
    const params = await Promise.resolve(ctx.params)
    const vdcId = (params as any)?.id
    if (!vdcId) return NextResponse.json({ error: "Missing vDC ID" }, { status: 400 })

    const denied = await checkPermission("sdn.vnet.view")
    if (denied) return denied

    const vnets = listVnetsForTenant(vdcId)
    return NextResponse.json({ data: vnets })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 })
  }
}

// POST /api/v1/vdcs/{id}/vnets
export async function POST(req: Request, ctx: RouteContext) {
  try {
    const params = await Promise.resolve(ctx.params)
    const vdcId = (params as any)?.id
    if (!vdcId) return NextResponse.json({ error: "Missing vDC ID" }, { status: 400 })

    const denied = await checkPermission("sdn.vnet.create")
    if (denied) return denied

    const body = await req.json().catch(() => ({}))
    // Accept `displayName` (current), fall back to legacy `pveName` field
    // posted by older clients/dialogs that haven't been redeployed yet.
    const displayName = typeof body?.displayName === "string"
      ? body.displayName.trim()
      : typeof body?.pveName === "string"
        ? body.pveName.trim()
        : ""
    const description = typeof body?.description === "string" ? body.description.trim() : undefined
    const firewall = body?.firewall !== false
    const isolatePorts = body?.isolatePorts === true
    const vlanAware = body?.vlanAware === true

    if (!displayName) return NextResponse.json({ error: "displayName required" }, { status: 400 })

    const session = await getServerSession(authOptions)
    const createdBy = session?.user?.id ?? null
    const tenantId = await getCurrentTenantId()

    try {
      const vnet = await createVnetForTenant({ vdcId, tenantId, displayName, description, firewall, isolatePorts, vlanAware, createdBy })
      return NextResponse.json({ data: vnet }, { status: 201 })
    } catch (err: any) {
      const msg = err?.message || String(err)
      if (msg.includes("Quota exceeded")) return NextResponse.json({ error: msg }, { status: 409 })
      if (msg.includes("already exists")) return NextResponse.json({ error: msg }, { status: 409 })
      if (msg.includes("Invalid VNet name")) return NextResponse.json({ error: msg }, { status: 400 })
      if (msg.includes("vDC not found")) return NextResponse.json({ error: msg }, { status: 404 })
      throw err
    }
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 })
  }
}
