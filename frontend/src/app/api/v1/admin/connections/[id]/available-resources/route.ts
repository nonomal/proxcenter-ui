import { NextResponse } from "next/server"

import { pveFetch } from "@/lib/proxmox/client"
import { getConnectionById } from "@/lib/connections/getConnection"
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

    const conn = await getConnectionById(id)

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

    // Fetch storages (cluster-wide)
    const storagesRaw = await pveFetch<any[]>(conn, "/storage") || []
    const storages = storagesRaw.map((s: any) => ({
      id: s.storage,
      type: s.type,
      content: s.content,
      shared: !!s.shared,
      nodes: s.nodes || null,
    }))

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
