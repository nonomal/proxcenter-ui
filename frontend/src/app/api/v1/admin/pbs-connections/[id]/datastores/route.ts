import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'

import { authOptions } from '@/lib/auth/config'
import { isUserSuperAdmin } from '@/lib/rbac'
import { getPbsConnectionById } from '@/lib/connections/getConnection'
import { pbsFetch } from '@/lib/proxmox/pbs-client'

export const runtime = 'nodejs'

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const s = await getServerSession(authOptions)
  if (!s?.user?.id || !isUserSuperAdmin(s.user.id)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  const { id } = await ctx.params
  try {
    const conn = await getPbsConnectionById(id)
    const datastores = await pbsFetch<Array<{ store?: string; name?: string }>>(conn, '/admin/datastore')
    const names = (datastores || []).map(d => d.store || d.name).filter((n): n is string => !!n)
    return NextResponse.json({ data: names })
  } catch (e: any) {
    console.error(`[pbs-datastores] failed for ${id}:`, e?.message || e)
    return NextResponse.json({ error: e?.message || String(e) }, { status: 502 })
  }
}
