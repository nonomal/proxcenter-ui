import { NextResponse } from 'next/server'
import { getCurrentTenantId } from '@/lib/tenant'
import { checkPermission, PERMISSIONS } from '@/lib/rbac'
import { listVdcs } from '@/lib/vdc'

export const runtime = 'nodejs'

// GET /api/v1/vdcs — list the current tenant's vDCs with quotas and usage
export async function GET() {
  try {
    const denied = await checkPermission(PERMISSIONS.VM_VIEW)
    if (denied) return denied

    const tenantId = await getCurrentTenantId()
    const vdcs = listVdcs(tenantId)

    return NextResponse.json({ data: vdcs })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 })
  }
}
