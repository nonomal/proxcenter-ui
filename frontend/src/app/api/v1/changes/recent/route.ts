import { NextResponse } from 'next/server'

import { orchestratorFetch } from '@/lib/orchestrator/client'
import { checkPermission, PERMISSIONS } from '@/lib/rbac'
import { getSessionPrisma } from '@/lib/tenant'

export const runtime = 'nodejs'

export async function GET(req: Request) {
  try {
    // connection.view baseline; results are filtered below by the tenant's
    // connection allowlist so cross-tenant change events never leak.
    const permError = await checkPermission(PERMISSIONS.CONNECTION_VIEW)
    if (permError) return permError

    const { searchParams } = new URL(req.url)
    const limit = Number.parseInt(searchParams.get('limit') || '10')

    // Get tenant's connection IDs for filtering
    const prisma = await getSessionPrisma()
    const tenantConnections = await prisma.connection.findMany({ select: { id: true } })
    const tenantConnectionIds = new Set(tenantConnections.map((c: any) => c.id))

    const data = await orchestratorFetch<any>(`/changes/recent?limit=100`)

    // Filter by tenant connections
    if (data?.data && Array.isArray(data.data)) {
      data.data = data.data
        .filter((c: any) => !c.connectionId || tenantConnectionIds.has(c.connectionId))
        .slice(0, limit)
    }

    return NextResponse.json(data)
  } catch (error: any) {
    if ((error as any)?.code !== 'ORCHESTRATOR_UNAVAILABLE') {
      console.error('Error fetching recent changes:', error)
    }

    return NextResponse.json(
      { error: error?.message || 'Server error' },
      { status: 500 }
    )
  }
}
