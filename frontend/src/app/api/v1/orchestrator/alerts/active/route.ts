import { NextResponse } from 'next/server'

import { alertsApi } from '@/lib/orchestrator/client'
import { demoResponse } from '@/lib/demo/demo-api'
import { getCurrentTenantId, getTenantConnectionIds } from '@/lib/tenant'
import { getVdcScope } from '@/lib/vdc/scope'
import { checkPermission, PERMISSIONS } from '@/lib/rbac'
import { isAlertVisibleToTenant } from '@/lib/alerts/visibility'
import { getVdcVmidsByConnection } from '@/lib/alerts/vdcVmids'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/v1/orchestrator/alerts/active
 * Récupère uniquement les alertes actives, filtrées par tenant
 */
export async function GET(req: Request) {
  const demo = demoResponse(req)
  if (demo) return demo

  try {
    const denied = await checkPermission(PERMISSIONS.ALERTS_VIEW)
    if (denied) return denied

    const { searchParams } = new URL(req.url)
    const connectionId = searchParams.get('connection_id') || undefined

    const tenantConnectionIds = await getTenantConnectionIds()
    const tenantId = await getCurrentTenantId()
    const vdcScope = getVdcScope(tenantId)
    const vdcVmids = vdcScope ? await getVdcVmidsByConnection(tenantId) : undefined
    const response = await alertsApi.getActiveAlerts(connectionId)

    const resData = response.data as any
    const alerts = Array.isArray(resData) ? resData : (resData?.data || [])
    const visibilityCtx = { tenantId, tenantConnectionIds, vdcScope, vdcVmids }
    const filtered = Array.isArray(alerts)
      ? alerts.filter((a: any) => isAlertVisibleToTenant(a, visibilityCtx))
      : alerts

    return NextResponse.json(filtered)
  } catch (error: any) {
    if ((error as any)?.code !== 'ORCHESTRATOR_UNAVAILABLE') {
      console.error('[orchestrator/alerts/active] GET error:', error)
    }

    if (error.message?.includes('ECONNREFUSED') || error.message?.includes('timeout')) {
      return NextResponse.json([])
    }

    return NextResponse.json(
      { error: error?.message || 'Failed to fetch active alerts' },
      { status: 500 }
    )
  }
}
