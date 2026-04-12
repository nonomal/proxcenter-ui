import { NextResponse } from "next/server"

import { pveFetch } from "@/lib/proxmox/client"
import { getConnectionById } from "@/lib/connections/getConnection"
import { prisma } from "@/lib/db/prisma"
import { checkPermission, PERMISSIONS } from "@/lib/rbac"

export const runtime = "nodejs"

type RouteContext = { params: Promise<{ id: string }> | { id: string } }

export async function GET(_req: Request, ctx: RouteContext) {
  try {
    const params = await Promise.resolve(ctx.params)
    const id = (params as any)?.id

    if (!id) return NextResponse.json({ error: "Missing connection ID" }, { status: 400 })

    const denied = await checkPermission(PERMISSIONS.ADMIN_SETTINGS)
    if (denied) return denied

    // Admin endpoint: resolve connection's tenantId to bypass session tenant filter
    const connMeta = await prisma.connection.findUnique({ where: { id }, select: { tenantId: true } })
    if (!connMeta) return NextResponse.json({ error: "Connection not found" }, { status: 404 })

    const conn = await getConnectionById(id, connMeta.tenantId)

    // Fetch nodes
    const nodesRaw = await pveFetch<any[]>(conn, "/nodes") || []
    const nodes = nodesRaw.map((n: any) => ({
      name: n.node,
      status: n.status,
      cpu: n.cpu,
      maxcpu: n.maxcpu,
      mem: n.mem,
      maxmem: n.maxmem,
    }))

    // Fetch storages: definition from /storage + per-node usage from /cluster/resources
    const storagesRaw = await pveFetch<any[]>(conn, "/storage") || []
    // Per-node usage: { "local": [{ node: "PVE-1", disk: X, maxdisk: Y }, ...], "ceph-pool": [{ node: "PVE-1", ... }] }
    const storageNodeUsage: Record<string, { node: string; disk: number; maxdisk: number }[]> = {}
    try {
      const resources = await pveFetch<any[]>(conn, "/cluster/resources?type=storage") || []
      for (const r of resources) {
        if (!r.storage) continue
        if (!storageNodeUsage[r.storage]) storageNodeUsage[r.storage] = []
        storageNodeUsage[r.storage].push({ node: r.node, disk: r.disk || 0, maxdisk: r.maxdisk || 0 })
      }
    } catch {}

    const storages = storagesRaw.map((s: any) => {
      const nodeEntries = storageNodeUsage[s.storage] || []
      // For shared storages: all nodes report the same usage, take first entry
      // For local storages: sum across nodes
      let disk = 0, maxdisk = 0
      if (s.shared) {
        disk = nodeEntries[0]?.disk || 0
        maxdisk = nodeEntries[0]?.maxdisk || 0
      } else {
        for (const ne of nodeEntries) { disk += ne.disk; maxdisk += ne.maxdisk }
      }

      return {
        id: s.storage,
        type: s.type,
        content: s.content,
        shared: !!s.shared,
        nodes: s.nodes || null,
        nodeDetails: !s.shared ? nodeEntries : null,
        disk,
        maxdisk,
      }
    })

    // Fetch existing PVE pools (to show what's taken)
    let pools: string[] = []
    try {
      const poolsRaw = await pveFetch<any[]>(conn, "/pools") || []
      pools = poolsRaw.map((p: any) => p.poolid)
    } catch {
      // Pools API may not be available
    }

    return NextResponse.json({ data: { nodes, storages, pools } })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 })
  }
}
