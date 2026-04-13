import { randomUUID } from "crypto"

import { NextResponse } from "next/server"

import { getDb } from "@/lib/db/sqlite"
import { checkPermission, PERMISSIONS } from "@/lib/rbac"
import { clearVdcScopeCache } from "@/lib/vdc/scope"

export const runtime = "nodejs"

type RouteContext = { params: Promise<{ id: string }> | { id: string } }

// GET /api/v1/admin/vdcs/{id}/shared-bridges
export async function GET(_req: Request, ctx: RouteContext) {
  try {
    const params = await Promise.resolve(ctx.params)
    const id = (params as any)?.id

    if (!id) return NextResponse.json({ error: "Missing vDC ID" }, { status: 400 })

    const denied = await checkPermission(PERMISSIONS.ADMIN_SETTINGS)
    if (denied) return denied

    const db = getDb()
    const rows = db
      .prepare(
        "SELECT id, vdc_id, bridge, label, created_at FROM vdc_shared_bridges WHERE vdc_id = ? ORDER BY bridge"
      )
      .all(id) as any[]

    const data = rows.map((r) => ({
      id: r.id,
      vdcId: r.vdc_id,
      bridge: r.bridge,
      label: r.label ?? null,
      createdAt: r.created_at,
    }))

    return NextResponse.json({ data })
  } catch (e: any) {
    console.error("[shared-bridges] GET error:", e)
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 })
  }
}

// PUT /api/v1/admin/vdcs/{id}/shared-bridges
// Body: { bridges: [{ bridge, label? }, ...] } - replaces the full set.
export async function PUT(req: Request, ctx: RouteContext) {
  try {
    const params = await Promise.resolve(ctx.params)
    const id = (params as any)?.id

    if (!id) return NextResponse.json({ error: "Missing vDC ID" }, { status: 400 })

    const denied = await checkPermission(PERMISSIONS.ADMIN_SETTINGS)
    if (denied) return denied

    const body = await req.json().catch(() => ({}))
    const incoming: Array<{ bridge?: unknown; label?: unknown }> = Array.isArray(body?.bridges)
      ? body.bridges
      : []

    const cleaned: Array<{ bridge: string; label: string | null }> = []
    for (const item of incoming) {
      if (typeof item?.bridge !== "string" || !item.bridge.trim()) continue
      cleaned.push({
        bridge: item.bridge.trim(),
        label: typeof item.label === "string" ? item.label.trim() : null,
      })
    }

    const seen = new Set<string>()
    const unique = cleaned.filter((c) => {
      if (seen.has(c.bridge)) return false
      seen.add(c.bridge)
      return true
    })

    const db = getDb()
    const vdc = db.prepare("SELECT tenant_id FROM vdcs WHERE id = ?").get(id) as any
    if (!vdc) return NextResponse.json({ error: "vDC not found" }, { status: 404 })

    const now = new Date().toISOString()
    const tx = db.transaction(() => {
      db.prepare("DELETE FROM vdc_shared_bridges WHERE vdc_id = ?").run(id)
      const insert = db.prepare(
        "INSERT INTO vdc_shared_bridges (id, vdc_id, bridge, label, created_at) VALUES (?, ?, ?, ?, ?)"
      )
      for (const sb of unique) {
        insert.run(randomUUID(), id, sb.bridge, sb.label, now)
      }
    })
    tx()

    clearVdcScopeCache(vdc.tenant_id)

    return NextResponse.json({ success: true, count: unique.length })
  } catch (e: any) {
    console.error("[shared-bridges] PUT error:", e)
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 })
  }
}
