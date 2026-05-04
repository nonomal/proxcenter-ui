import { NextResponse } from 'next/server'
import { getSetting } from '@/lib/db/settings'
import { getCurrentTenantId } from '@/lib/tenant'

export const dynamic = 'force-dynamic'

const DEFAULT_BRANDING = {
  enabled: false,
  appName: 'ProxCenter',
  logoUrl: '',
  faviconUrl: '',
  loginLogoUrl: '',
  primaryColor: '',
  browserTitle: '',
  poweredByVisible: true,
}

export async function GET() {
  try {
    // Try to get tenant from session, fallback to 'default' for unauthenticated requests (login page)
    let tenantId = 'default'
    try { tenantId = await getCurrentTenantId() } catch {}
    const stored = await getSetting<any>('branding', tenantId)
    const settings = { ...DEFAULT_BRANDING, ...(stored ?? {}) }

    // If white label is not enabled, return defaults
    if (!settings.enabled) {
      return NextResponse.json(DEFAULT_BRANDING)
    }

    // Migrate old static paths to API serving paths
    const fixUrl = (url: string) =>
      url ? url.replace(/^\/uploads\/branding\//, '/api/v1/settings/branding/uploads/') : url

    return NextResponse.json({
      enabled: true,
      appName: settings.appName,
      logoUrl: fixUrl(settings.logoUrl),
      faviconUrl: fixUrl(settings.faviconUrl),
      loginLogoUrl: fixUrl(settings.loginLogoUrl),
      primaryColor: settings.primaryColor,
      browserTitle: settings.browserTitle,
      poweredByVisible: settings.poweredByVisible,
      showGithubStars: settings.showGithubStars,
      showWhatsNew: settings.showWhatsNew,
      showAbout: settings.showAbout,
      showSubscription: settings.showSubscription,
    })
  } catch {
    return NextResponse.json(DEFAULT_BRANDING)
  }
}
