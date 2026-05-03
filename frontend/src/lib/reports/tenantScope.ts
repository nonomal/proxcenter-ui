// src/lib/reports/tenantScope.ts
// Report-type restrictions and scope payload builder for vDC tenants.
//
// vDC tenants must only see and generate a curated subset of the report
// catalog (Alerts, Inventory). The provider tenant retains access to every
// type. Both /types listing and POST/PUT validation flow through here to
// keep the rule in one place.
//
// buildScopePayloadFromVdc translates a VdcScope (nodes/storages/pools per
// connection) into the node_filter / vmid_filter / storage_filter envelope
// the Go orchestrator expects in GenerateReportRequest. VMIDs are resolved
// by querying PVE /cluster/resources and filtering by the tenant's pools.

import { NextResponse } from 'next/server'

import { DEFAULT_TENANT_ID, getCurrentTenantId } from '@/lib/tenant'
import { getVdcScope, type VdcScope } from '@/lib/vdc/scope'
import { getConnectionById } from '@/lib/connections/getConnection'
import { pveFetch } from '@/lib/proxmox/client'

export const VDC_ALLOWED_REPORT_TYPES: ReadonlySet<string> = new Set([
  'alerts',
  'inventory',
])

/** True when the current session belongs to a non-provider (vDC) tenant. */
export async function isVdcTenant(): Promise<boolean> {
  const tenantId = await getCurrentTenantId()
  return tenantId !== DEFAULT_TENANT_ID
}

/**
 * Validate a report type against the current tenant's allow-list.
 * Returns a 403 NextResponse when the tenant is a vDC tenant and the type
 * is outside VDC_ALLOWED_REPORT_TYPES, or null when the request is allowed.
 * A missing/empty type is treated as allowed (the orchestrator will reject it).
 */
export async function assertReportTypeAllowed(type: string | undefined | null): Promise<NextResponse | null> {
  if (!type) return null
  if (!(await isVdcTenant())) return null
  if (VDC_ALLOWED_REPORT_TYPES.has(type)) return null
  return NextResponse.json(
    { error: `Report type '${type}' is not available for this tenant` },
    { status: 403 }
  )
}

/** Filter a list of {type} records down to the vDC allow-list (when applicable). */
export async function filterReportTypesForTenant<T extends { type: string }>(types: T[]): Promise<T[]> {
  if (!(await isVdcTenant())) return types
  return types.filter(t => VDC_ALLOWED_REPORT_TYPES.has(t.type))
}

export interface ScopePayload {
  node_filter: Record<string, string[]>
  vmid_filter: Record<string, number[]>
  storage_filter: Record<string, string[]>
}

/**
 * Build the scope payload sent to the Go orchestrator in GenerateReportRequest
 * for the current tenant. Returns null for the provider tenant (no scoping)
 * or when no vDC is configured.
 *
 * VMIDs are computed from PVE /cluster/resources by intersecting each VM's
 * `pool` membership with the tenant's allowed pools. We query each connection
 * once; failures are logged and skipped so a single dead PVE doesn't block
 * report generation across the rest of the scope.
 */
export async function buildScopePayloadForCurrentTenant(): Promise<ScopePayload | null> {
  const tenantId = await getCurrentTenantId()
  const scope = getVdcScope(tenantId)
  if (!scope) return null
  return buildScopePayloadFromVdc(scope, tenantId)
}

async function buildScopePayloadFromVdc(scope: VdcScope, tenantId: string): Promise<ScopePayload> {
  const node_filter: Record<string, string[]> = {}
  const vmid_filter: Record<string, number[]> = {}
  const storage_filter: Record<string, string[]> = {}

  for (const connId of scope.connectionIds) {
    const nodes = scope.nodesByConnection.get(connId)
    if (nodes && nodes.size > 0) node_filter[connId] = Array.from(nodes)

    const storages = scope.storagesByConnection.get(connId)
    if (storages && storages.size > 0) storage_filter[connId] = Array.from(storages)

    const pools = scope.poolsByConnection.get(connId)
    if (pools && pools.size > 0) {
      try {
        const conn = await getConnectionById(connId, tenantId)
        const resources = await pveFetch<any[]>(conn, '/cluster/resources?type=vm')
        if (Array.isArray(resources)) {
          const ids: number[] = []
          for (const r of resources) {
            const vmid = Number(r?.vmid)
            if (!Number.isFinite(vmid)) continue
            if (typeof r?.pool === 'string' && pools.has(r.pool)) {
              ids.push(vmid)
            }
          }
          if (ids.length > 0) vmid_filter[connId] = ids
          else vmid_filter[connId] = [-1] // sentinel: pool exists but is empty → block all VMs
        }
      } catch (err: any) {
        console.warn(`[reports/scope] /cluster/resources lookup failed for ${connId}: ${err?.message || err}`)
      }
    }
  }

  return { node_filter, vmid_filter, storage_filter }
}
