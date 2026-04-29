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

    // connection.view is enough to populate the VM-create network picker:
    // the endpoint only returns names a tenant is already authorised to
    // attach to (their vDC VNets + shared bridges). node.network would gate
    // real network-management operations, not this read-only helper.
    const resourceId = buildNodeResourceId(connId, node)
    const denied = await checkPermission(PERMISSIONS.CONNECTION_VIEW, "node", resourceId)
    if (denied) return denied

    const tenantId = await getCurrentTenantId()
    const scope = getVdcScope(tenantId)
    const db = getDb()

    const connMeta = await prisma.connection.findUnique({ where: { id: connId }, select: { tenantId: true } })
    if (!connMeta) return NextResponse.json({ error: "Connection not found" }, { status: 404 })
    const pveConn = await getConnectionById(connId, connMeta.tenantId)

    // Subnet info per VNet pve_name. The DeployWizard's CloudInit step
    // uses this to pre-fill IP/gateway/DNS fields for the selected VNet
    // (so the user gets an "Auto-allocated from <CIDR>" hint and a fixed
    // gateway, both driven by IPAM rather than typed by hand).
    type SubnetInfo = { cidr: string; gateway: string; dnsServers: string[]; subnetId: string }
    const subnetByPveName = new Map<string, SubnetInfo>()
    {
      const subnetRows = db.prepare(`
        SELECT v.pve_name, s.id AS subnet_id, s.cidr, s.gateway, s.dns_servers
        FROM vdc_vnets v
        JOIN vdcs       d ON d.id = v.vdc_id
        JOIN vdc_subnets s ON s.vnet_id = v.id
        WHERE d.connection_id = ? AND d.enabled = 1 AND s.ipam_enabled = 1
      `).all(connId) as Array<{ pve_name: string; subnet_id: string; cidr: string; gateway: string; dns_servers: string | null }>
      for (const r of subnetRows) {
        subnetByPveName.set(r.pve_name, {
          subnetId: r.subnet_id,
          cidr: r.cidr,
          gateway: r.gateway,
          dnsServers: r.dns_servers ? r.dns_servers.split(',').map(s => s.trim()).filter(Boolean) : [],
        })
      }
    }

    type Choice =
      | { kind: "vnet"; name: string; displayName: string; vdc: string; vdcId: string | null; zone: string; subnet: SubnetInfo | null }
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
          // PVE returns alias when set (we set it to display_name on create);
          // fall back to the bare ID for legacy/externally-managed VNets.
          choices.push({
            kind: "vnet",
            name: v.vnet,
            displayName: v.alias ?? v.vnet,
            vdc: "*",
            // Super-admin (no scope filter) sees PVE VNets directly —
            // the matching ProxCenter vDC isn't always 1-to-1, so we
            // leave vdcId null. Endpoints that need a specific vDC
            // shouldn't be reachable via this path anyway.
            vdcId: null,
            zone: v.zone,
            subnet: subnetByPveName.get(v.vnet) ?? null,
          })
        }
      } catch {}
    } else {
      // Tenant with vDC(s) on this connection
      const allowedVnets = scope.vnetsByConnection.get(connId) ?? new Set<string>()
      const allowedShared = scope.sharedBridgesByConnection.get(connId) ?? new Set<string>()

      // VNets with vdc slug + zone. `name` stays the pve_name (= what PVE
      // expects in the NIC bridge field) but we expose displayName separately
      // so the picker can render the user-friendly label.
      const vnetRows = db.prepare(`
        SELECT v.pve_name, v.display_name, d.id AS vdc_id, d.slug AS vdc_slug, d.sdn_zone_name
        FROM vdc_vnets v
        JOIN vdcs d ON d.id = v.vdc_id
        WHERE d.tenant_id = ? AND d.connection_id = ?
      `).all(tenantId, connId) as any[]
      for (const v of vnetRows) {
        if (allowedVnets.has(v.pve_name)) {
          choices.push({
            kind: "vnet",
            name: v.pve_name,
            displayName: v.display_name ?? v.pve_name,
            vdc: v.vdc_slug,
            // Routes that hit /api/v1/vdcs/{id}/... need the UUID, not
            // the slug. Surface it explicitly so the deploy wizard
            // (and any future caller) doesn't have to do a second
            // lookup to translate slug → id.
            vdcId: v.vdc_id,
            zone: v.sdn_zone_name,
            subnet: subnetByPveName.get(v.pve_name) ?? null,
          })
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
