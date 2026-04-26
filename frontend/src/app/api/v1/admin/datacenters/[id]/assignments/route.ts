import { NextRequest, NextResponse } from "next/server"

import { checkPermission, PERMISSIONS } from "@/lib/rbac"
import { requireProviderTenant } from "@/lib/tenant"
import { getDatacenterById } from "@/lib/db/datacenters"
import { invalidateGreenResolution } from "@/lib/green/resolve"
import { getDb } from "@/lib/db/sqlite"

export const runtime = "nodejs"

type RouteContext = { params: Promise<{ id: string }> | { id: string } }

interface AssignmentPayload {
  /** Connection IDs whose entire cluster (and every node) should point to this DC. */
  clusters?: string[]
  /** Per-node assignments. Used when only a subset of a cluster's nodes are on this DC. */
  nodes?: Array<{ connectionId: string; nodeName: string }>
}

/**
 * GET — list every (connection, node) currently anchored on this datacentre.
 *
 * Returns clusters whose `connection_green_config.datacenter_id = id` and
 * nodes whose `node_green_config.datacenter_id = id`. The frontend tree
 * uses this to pre-check the right boxes when the dialog opens.
 */
export async function GET(_req: NextRequest, ctx: RouteContext) {
  try {
    const providerGate = await requireProviderTenant()
    if (providerGate) return providerGate
    const denied = await checkPermission(PERMISSIONS.ADMIN_SETTINGS)
    if (denied) return denied

    const params = await Promise.resolve(ctx.params)
    const id = (params as any)?.id
    const dc = getDatacenterById(id)
    if (!dc) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const db = getDb()
    const clusters = db
      .prepare(`SELECT connection_id FROM connection_green_config WHERE datacenter_id = ?`)
      .all(id) as Array<{ connection_id: string }>
    const nodes = db
      .prepare(`SELECT connection_id, node_name FROM node_green_config WHERE datacenter_id = ?`)
      .all(id) as Array<{ connection_id: string; node_name: string }>

    return NextResponse.json({
      data: {
        clusters: clusters.map(r => r.connection_id),
        nodes: nodes.map(r => ({ connectionId: r.connection_id, nodeName: r.node_name })),
      },
    })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 })
  }
}

/**
 * PUT — atomically replace this datacentre's assignments.
 *
 * Resources listed in `clusters` get their cluster-level `datacenter_id`
 * set to this DC; per-node DC overrides on those clusters are wiped (the
 * cluster pick wins). Resources listed in `nodes` get their per-node
 * `datacenter_id` set to this DC. Anything previously anchored on this DC
 * but absent from the payload has its `datacenter_id` cleared back to
 * NULL — meaning "inherit from the level above".
 */
export async function PUT(req: NextRequest, ctx: RouteContext) {
  try {
    const providerGate = await requireProviderTenant()
    if (providerGate) return providerGate
    const denied = await checkPermission(PERMISSIONS.ADMIN_SETTINGS)
    if (denied) return denied

    const params = await Promise.resolve(ctx.params)
    const id = (params as any)?.id
    const dc = getDatacenterById(id)
    if (!dc) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const body = await req.json().catch(() => ({})) as AssignmentPayload
    const targetClusters = new Set((body.clusters ?? []).filter(Boolean))
    const targetNodes = new Set(
      (body.nodes ?? []).filter(n => n?.connectionId && n?.nodeName).map(n => `${n.connectionId}|${n.nodeName}`),
    )

    const db = getDb()
    const now = new Date().toISOString()

    const tx = db.transaction(() => {
      // Cluster-level: align connection_green_config rows.
      const currentClusters = (db
        .prepare(`SELECT connection_id FROM connection_green_config WHERE datacenter_id = ?`)
        .all(id) as Array<{ connection_id: string }>).map(r => r.connection_id)

      // Detach clusters that left this DC.
      for (const cid of currentClusters) {
        if (!targetClusters.has(cid)) {
          db.prepare(`UPDATE connection_green_config SET datacenter_id = NULL, updated_at = ? WHERE connection_id = ?`)
            .run(now, cid)
        }
      }

      // Attach (upsert) clusters that should be on this DC + clear per-node DC overrides
      // so the cluster pick is the single source of truth.
      for (const cid of targetClusters) {
        db.prepare(
          `INSERT INTO connection_green_config (connection_id, datacenter_id, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(connection_id) DO UPDATE SET datacenter_id = excluded.datacenter_id, updated_at = excluded.updated_at`
        ).run(cid, id, now)
        db.prepare(`UPDATE node_green_config SET datacenter_id = NULL, updated_at = ? WHERE connection_id = ?`)
          .run(now, cid)
      }

      // Per-node: align node_green_config rows.
      const currentNodes = (db
        .prepare(`SELECT connection_id, node_name FROM node_green_config WHERE datacenter_id = ?`)
        .all(id) as Array<{ connection_id: string; node_name: string }>)
        .map(r => `${r.connection_id}|${r.node_name}`)

      for (const key of currentNodes) {
        if (!targetNodes.has(key)) {
          const [cid, nname] = key.split('|')
          db.prepare(`UPDATE node_green_config SET datacenter_id = NULL, updated_at = ? WHERE connection_id = ? AND node_name = ?`)
            .run(now, cid, nname)
        }
      }

      for (const key of targetNodes) {
        const [cid, nname] = key.split('|')
        // Skip nodes whose cluster is itself on this DC — covered by cluster-level row.
        if (targetClusters.has(cid)) continue
        db.prepare(
          `INSERT INTO node_green_config (connection_id, node_name, datacenter_id, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(connection_id, node_name) DO UPDATE SET datacenter_id = excluded.datacenter_id, updated_at = excluded.updated_at`
        ).run(cid, nname, id, now)
      }
    })
    tx()

    invalidateGreenResolution()
    return NextResponse.json({ success: true })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 })
  }
}
