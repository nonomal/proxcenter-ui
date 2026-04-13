import { NextResponse } from "next/server"

import { getCurrentTenantId } from "@/lib/tenant"
import { checkPermission, PERMISSIONS, buildNodeResourceId } from "@/lib/rbac"
import { getDb } from "@/lib/db/sqlite"
import { getVdcScope } from "@/lib/vdc/scope"
import { pveFetch } from "@/lib/proxmox/client"
import { getConnectionById } from "@/lib/connections/getConnection"
import { prisma } from "@/lib/db/prisma"

export const runtime = "nodejs"

type RouteContext = { params: Promise<{ id: string }> | { id: string } }

// GET /api/v1/connections/{id}/network-choices?node=X
export async function GET(req: Request, ctx: RouteContext) {
  try {
    const params = await Promise.resolve(ctx.params)
    const connId = (params as any)?.id
    if (!connId) return NextResponse.json({ error: "Missing connection ID" }, { status: 400 })

    const url = new URL(req.url)
    const node = url.searchParams.get("node")
    if (!node) return NextResponse.json({ error: "Missing node query param" }, { status: 400 })

    const resourceId = buildNodeResourceId(connId, node)
    const denied = await checkPermission(PERMISSIONS.NODE_NETWORK, "node", resourceId)
    if (denied) return denied

    const tenantId = await getCurrentTenantId()
    const scope = getVdcScope(tenantId)
    const db = getDb()

    const connMeta = await prisma.connection.findUnique({ where: { id: connId }, select: { tenantId: true } })
    if (!connMeta) return NextResponse.json({ error: "Connection not found" }, { status: 404 })
    const pveConn = await getConnectionById(connId, connMeta.tenantId)

    type Choice =
      | { kind: "vnet"; name: string; vdc: string; zone: string }
      | { kind: "shared"; name: string; label: string | null }
      | { kind: "bridge"; name: string; type: string }

    const choices: Choice[] = []

    if (scope === null) {
      // Super admin or tenant without vDC - return all physical bridges + all VNets
      const ifaces = await pveFetch<any[]>(pveConn, `/nodes/${encodeURIComponent(node)}/network`)
      for (const ifc of ifaces || []) {
        if (ifc.type !== "bridge" && ifc.type !== "OVSBridge") continue
        choices.push({ kind: "bridge", name: ifc.iface, type: ifc.type })
      }
      try {
        const vnets = await pveFetch<any[]>(pveConn, "/cluster/sdn/vnets")
        for (const v of vnets || []) {
          choices.push({ kind: "vnet", name: v.vnet, vdc: "*", zone: v.zone })
        }
      } catch {}
    } else {
      // Tenant with vDC(s) on this connection
      const allowedVnets = scope.vnetsByConnection.get(connId) ?? new Set<string>()
      const allowedShared = scope.sharedBridgesByConnection.get(connId) ?? new Set<string>()

      // VNets with vdc slug + zone
      const vnetRows = db.prepare(`
        SELECT v.pve_name, d.slug AS vdc_slug, d.sdn_zone_name
        FROM vdc_vnets v
        JOIN vdcs d ON d.id = v.vdc_id
        WHERE d.tenant_id = ? AND d.connection_id = ?
      `).all(tenantId, connId) as any[]
      for (const v of vnetRows) {
        if (allowedVnets.has(v.pve_name)) {
          choices.push({ kind: "vnet", name: v.pve_name, vdc: v.vdc_slug, zone: v.sdn_zone_name })
        }
      }

      // Shared bridges with labels
      if (allowedShared.size > 0) {
        const sharedRows = db.prepare(`
          SELECT b.bridge, b.label
          FROM vdc_shared_bridges b
          JOIN vdcs d ON d.id = b.vdc_id
          WHERE d.tenant_id = ? AND d.connection_id = ?
        `).all(tenantId, connId) as any[]
        const labelMap = new Map<string, string | null>()
        for (const r of sharedRows) labelMap.set(r.bridge, r.label ?? null)
        for (const bridge of allowedShared) {
          choices.push({ kind: "shared", name: bridge, label: labelMap.get(bridge) ?? null })
        }
      }
    }

    return NextResponse.json({ data: choices })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 })
  }
}
