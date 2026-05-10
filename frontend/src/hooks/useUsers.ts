import { useSWRFetch } from './useSWRFetch'

export function useUsers() {
  return useSWRFetch('/api/v1/users', { revalidateOnFocus: true })
}

export function useRbacRoles(enabled: boolean) {
  return useSWRFetch(enabled ? '/api/v1/rbac/roles' : null, { revalidateOnFocus: true })
}

export function useRbacAssignments() {
  return useSWRFetch('/api/v1/rbac/assignments', { revalidateOnFocus: true })
}

export function useTenants(enabled: boolean) {
  // /api/v1/tenants is gated to the provider tenant by requireProviderTenant.
  // The caller passes `enabled` to short-circuit the fetch from non-default
  // sessions and from Community editions where multi-tenancy is hidden.
  return useSWRFetch(enabled ? '/api/v1/tenants' : null, { revalidateOnFocus: false })
}
