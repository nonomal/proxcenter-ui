import { NextResponse } from "next/server"

import { prisma as basePrisma } from "@/lib/db/prisma"
import { getSessionPrisma, getCurrentTenantId } from "@/lib/tenant"

export const runtime = 'nodejs'

/**
 * GET /api/v1/app/status
 * Retourne l'état de l'application pour l'onboarding
 */
export async function GET() {
  try {
    const prisma = await getSessionPrisma()
    const tenantId = await getCurrentTenantId()

    // Vérifier le nombre d'utilisateurs (cross-tenant: setup wizard fires
    // when ANY user exists, regardless of which tenant they belong to).
    const userCount = await basePrisma.user.count()

    // Vérifier le nombre de connexions Proxmox (direct or via vDC)
    const connectionCount = await prisma.connection.count()

    // For tenants with vDCs: they have connections indirectly via vDC assignments.
    const vdcCount = await basePrisma.vdc.count({ where: { tenantId, enabled: true } })

    return NextResponse.json({
      setupRequired: userCount === 0,
      connectionsConfigured: connectionCount > 0 || vdcCount > 0,
      userCount,
      connectionCount: connectionCount + vdcCount,
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
