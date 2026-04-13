import { NextResponse } from "next/server"

import { getDb } from "@/lib/db/sqlite"
import { getSessionPrisma, getCurrentTenantId } from "@/lib/tenant"

export const runtime = 'nodejs'

/**
 * GET /api/v1/app/status
 * Retourne l'état de l'application pour l'onboarding
 */
export async function GET() {
  try {
    const prisma = await getSessionPrisma()
    const db = getDb()
    const tenantId = await getCurrentTenantId()

    // Vérifier le nombre d'utilisateurs
    const userCount = db.prepare("SELECT COUNT(*) as count FROM users").get() as { count: number }

    // Vérifier le nombre de connexions Proxmox (direct or via vDC)
    const connectionCount = await prisma.connection.count()

    // For tenants with vDCs: they have connections indirectly via vDC assignments
    const vdcCount = db.prepare(
      "SELECT COUNT(*) as count FROM vdcs WHERE tenant_id = ? AND enabled = 1"
    ).get(tenantId) as { count: number }

    return NextResponse.json({
      setupRequired: userCount.count === 0,
      connectionsConfigured: connectionCount > 0 || vdcCount.count > 0,
      userCount: userCount.count,
      connectionCount: connectionCount + vdcCount.count,
    })
  } catch (error) {
    console.error("Error checking app status:", error)

    return NextResponse.json({
      setupRequired: true,
      connectionsConfigured: false,
      userCount: 0,
      connectionCount: 0,
    })
  }
}
