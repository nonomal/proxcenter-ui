import { useMemo } from 'react'

import { useRBAC } from '@/contexts/RBACContext'
import { useTenant } from '@/contexts/TenantContext'

/** Scope types that reveal infrastructure topology (cluster/node names) */
const INFRA_SCOPES = new Set(['global', 'connection', 'node'])

export type WidgetVisibility = {
  hasInfraScope: boolean
  loading: boolean
}

/**
 * Derives which widgets a user is allowed to see based on their RBAC roles
 * and the active tenant. Mirrors `useRBACScopeProfile` semantics:
 *
 * - Admin or infra-scoped (global/connection/node) on the provider tenant
 *   → full access (sees every widget).
 * - Tag/VM/pool scope only, or any non-provider tenant
 *   → infrastructure widgets are hidden (Ceph, PBS, nodes/clusters tables,
 *   DRS, etc.). VM-centric widgets remain visible.
 */
export function useWidgetVisibility(): WidgetVisibility {
  const { roles, isAdmin, loading } = useRBAC()
  const { currentTenant, loading: tenantLoading } = useTenant()

  return useMemo(() => {
    if (loading || tenantLoading) {
      return { hasInfraScope: true, loading: true }
    }

    // Non-provider tenants get the cloud-style abstraction: nodes / clusters
    // are an implementation detail, never surfaced regardless of RBAC scope.
    const isProviderTenant = !currentTenant || currentTenant.id === 'default'

    if (!isProviderTenant) {
      return { hasInfraScope: false, loading: false }
    }

    if (isAdmin) return { hasInfraScope: true, loading: false }

    const scopeTypes = new Set<string>(
      (roles || []).map((r: any) => r.scope_type).filter(Boolean),
    )
    const hasInfra = [...scopeTypes].some(s => INFRA_SCOPES.has(s))

    return { hasInfraScope: hasInfra, loading: false }
  }, [roles, isAdmin, loading, currentTenant, tenantLoading])
}
