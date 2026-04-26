import { NextResponse } from "next/server"

import { checkPermission, PERMISSIONS } from "@/lib/rbac"
import { requireProviderTenant } from "@/lib/tenant"
import { getDb } from "@/lib/db/sqlite"

export const runtime = "nodejs"

/**
 * GET /api/v1/admin/green-assignments
 *
 * Returns the global map of which datacentre owns which cluster / node so
 * the assignment tree in the DC dialog can grey out rows already anchored
 * elsewhere. The frontend uses this in tandem with the per-DC GET to
 * compute "this DC vs another DC" UI states.
 *
 * Shape:
 *   {
 *     clusters: { [connectionId]: { datacenterId, datacenterName } },
 *     nodes:    { [connectionId+'|'+nodeName]: { datacenterId, datacenterName } },
 *   }
 *
 * Only direct assignments are reported (rows with non-NULL datacenter_id).
 * Inherited DCs (cluster -> nodes) must be derived client-side.
 */
export async function GET() {
  try {
    const providerGate = await requireProviderTenant()
    if (providerGate) return providerGate
    const denied = await checkPermission(PERMISSIONS.ADMIN_SETTINGS)
    if (denied) return denied

    const db = getDb()
    const clusterRows = db.prepare(
      `SELECT c.connection_id AS connection_id, c.datacenter_id AS datacenter_id, dc.name AS dc_name
       FROM connection_green_config c
       LEFT JOIN datacenters dc ON dc.id = c.datacenter_id
       WHERE c.datacenter_id IS NOT NULL`
    ).all() as Array<{ connection_id: string; datacenter_id: string; dc_name: string }>

    const nodeRows = db.prepare(
      `SELECT n.connection_id AS connection_id, n.node_name AS node_name,
              n.datacenter_id AS datacenter_id, dc.name AS dc_name
       FROM node_green_config n
       LEFT JOIN datacenters dc ON dc.id = n.datacenter_id
       WHERE n.datacenter_id IS NOT NULL`
    ).all() as Array<{ connection_id: string; node_name: string; datacenter_id: string; dc_name: string }>

    const clusters: Record<string, { datacenterId: string; datacenterName: string }> = {}
    for (const r of clusterRows) {
      clusters[r.connection_id] = { datacenterId: r.datacenter_id, datacenterName: r.dc_name }
    }
    const nodes: Record<string, { datacenterId: string; datacenterName: string }> = {}
    for (const r of nodeRows) {
      nodes[`${r.connection_id}|${r.node_name}`] = { datacenterId: r.datacenter_id, datacenterName: r.dc_name }
    }

    return NextResponse.json({ data: { clusters, nodes } })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 })
  }
}
