// src/app/api/v1/orchestrator/reports/types/route.ts
import { NextResponse } from 'next/server'

import { orchestratorFetch } from '@/lib/orchestrator'
import { checkPermission, PERMISSIONS } from '@/lib/rbac'
import { getCurrentTenantId, DEFAULT_TENANT_ID } from '@/lib/tenant'

export const runtime = 'nodejs'

const VDC_ALLOWED_REPORT_TYPES = new Set(['alerts', 'utilization', 'inventory'])

// GET /api/v1/orchestrator/reports/types - Get available report types
export async function GET() {
  try {
    console.warn('[REPORTS-TYPES] Handler called')
    const denied = await checkPermission(PERMISSIONS.REPORTS_VIEW)
    console.warn('[REPORTS-TYPES] checkPermission result:', denied ? 'DENIED' : 'OK')
    if (denied) return denied

    const data = await orchestratorFetch('/reports/types')

    const tenantId = await getCurrentTenantId()
    if (tenantId !== DEFAULT_TENANT_ID && Array.isArray(data)) {
      return NextResponse.json(data.filter((t: any) => VDC_ALLOWED_REPORT_TYPES.has(t.type)))
    }

    return NextResponse.json(data)
  } catch (error: any) {
    if ((error as any)?.code !== 'ORCHESTRATOR_UNAVAILABLE') {
      console.error('Failed to get report types:', error)
    }
    return NextResponse.json(
      { error: error.message || 'Failed to get report types' },
      { status: 500 }
    )
  }
}
