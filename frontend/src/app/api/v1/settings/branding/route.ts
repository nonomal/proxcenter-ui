export const dynamic = "force-dynamic"
import { NextResponse } from 'next/server'
import { getSetting, setSetting } from '@/lib/db/settings'
import { checkPermission, PERMISSIONS } from '@/lib/rbac'
import { getCurrentTenantId } from '@/lib/tenant'


const DEFAULT_BRANDING = {
  enabled: false,        // white label master switch
  appName: 'ProxCenter',
  logoUrl: '',           // empty = use default SVG logo
  faviconUrl: '',        // empty = use default favicon
  loginLogoUrl: '',      // empty = use default
  primaryColor: '',      // empty = use theme default
  footerText: '',        // empty = use default "© {year} ProxCenter"
  browserTitle: '',      // empty = use default "PROXCENTER"
  poweredByVisible: true, // show "Powered by ProxCenter" in footer
}

export async function GET() {
  try {
    const denied = await checkPermission(PERMISSIONS.ADMIN_SETTINGS)
    if (denied) return denied

    const tenantId = await getCurrentTenantId()
    const stored = await getSetting<Partial<typeof DEFAULT_BRANDING>>('branding', tenantId)
    const settings = { ...DEFAULT_BRANDING, ...(stored ?? {}) }

    // Migrate old static paths to API serving paths
    const fixUrl = (url: string) =>
      url ? url.replace(/^\/uploads\/branding\//, '/api/v1/settings/branding/uploads/') : url
    settings.logoUrl = fixUrl(settings.logoUrl)
    settings.faviconUrl = fixUrl(settings.faviconUrl)
    settings.loginLogoUrl = fixUrl(settings.loginLogoUrl)

    return NextResponse.json(settings)
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}

export async function PUT(req: Request) {
  try {
    const denied = await checkPermission(PERMISSIONS.ADMIN_SETTINGS)
    if (denied) return denied

    const body = await req.json()
    const settings = { ...DEFAULT_BRANDING, ...body }

    const tenantId = await getCurrentTenantId()
    await setSetting('branding', tenantId, settings)

    return NextResponse.json({ success: true, ...settings })
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
