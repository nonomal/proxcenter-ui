import { NextResponse } from 'next/server'

import { orchestratorFetch } from '@/lib/orchestrator/client'
import { checkPermission, PERMISSIONS } from '@/lib/rbac'
import { getTenantConnectionIds } from '@/lib/tenant'

export const runtime = 'nodejs'

export async function GET(req: Request) {
  try {
    // connection.view baseline; results are filtered below by the tenant's
    // connection allowlist so cross-tenant change events never leak.
    const permError = await checkPermission(PERMISSIONS.CONNECTION_VIEW)
    if (permError) return permError

    const { searchParams } = new URL(req.url)
    const limit = Number.parseInt(searchParams.get('limit') || '10')

    // Reachable connections = directly owned ∪ vDC-bound. Going through
    // the helper instead of an inline prisma.connection.findMany so MSP
    // tenants (who own no connections directly, only vDC bindings) get
    // their changes feed populated.
    const tenantConnectionIds = await getTenantConnectionIds()

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
