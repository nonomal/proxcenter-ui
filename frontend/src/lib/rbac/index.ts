// src/lib/rbac/index.ts
// RBAC helper functions for permission checking (Postgres / Prisma).
//
// All DB-touching helpers are async — they query Postgres via Prisma. The
// previous SQLite raw-SQL implementation was migrated in step 2.2 of the
// SQLite → Postgres sprint; cross-DB workarounds (PROTECTED_ROLE_ID_LIST_SQL,
// the SQLite-only isSuperAdminLocal in lib/tenant) were removed at the same
// time.

import { NextResponse } from "next/server"

import { getServerSession } from "next-auth"

import { prisma } from "@/lib/db/prisma"
import { authOptions } from "@/lib/auth/config"
import { resolveVmMeta } from "@/lib/cache/vmMetaCache"
import { DEFAULT_TENANT_ID } from "@/lib/tenant"


export interface PermissionCheck {
  userId: string
  permission: string
  resourceType?: "connection" | "node" | "vm" | "global" | "pbs"
  resourceId?: string
  resourceMeta?: { tags?: string[]; pool?: string }
  tenantId?: string
}

/**
 * Filter fragment matching grants whose expiry is either NULL or strictly
 * in the future. Equivalent to the SQLite `expires_at IS NULL OR expires_at > datetime('now')`.
 */
function activeGrantFilter() {
  return {
    OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
  }
}

/**
 * Check if a user has role_super_admin on ANY tenant.
 * role_super_admin is a global, cross-tenant privilege: a single assignment
 * (typically on the provider tenant) grants full access to all tenants.
 */
export async function isUserSuperAdmin(userId: string): Promise<boolean> {
  const row = await prisma.rbacUserRole.findFirst({
    where: { userId, roleId: "role_super_admin", ...activeGrantFilter() },
    select: { id: true },
  })
  return !!row
}

/**
 * Role IDs that must stay hidden from non-super-admin callers and may not be
 * assigned by anyone other than a super admin. Both grant wildcard permissions
 * (see seed in prisma/seed.ts); exposing either to a tenant admin lets them
 * escalate to full cluster access.
 */
export const PROTECTED_ROLE_IDS = ["role_super_admin", "role_provider_admin"] as const

/**
 * Check if a user holds any protected role (super_admin or provider_admin).
 * Use this (instead of isUserSuperAdmin) when deciding UI visibility of admin
 * accounts — a provider_admin has equivalent blast radius and deserves the
 * same hiding from tenant operators.
 */
export async function isUserProtected(userId: string): Promise<boolean> {
  const row = await prisma.rbacUserRole.findFirst({
    where: {
      userId,
      roleId: { in: [...PROTECTED_ROLE_IDS] },
      ...activeGrantFilter(),
    },
    select: { id: true },
  })
  return !!row
}

/**
 * Check if a user has a specific permission
 * @param check - The permission check parameters
 * @returns true if the user has the permission, false otherwise
 */
export async function hasPermission(check: PermissionCheck): Promise<boolean> {
  const { userId, permission, resourceType, resourceId, resourceMeta, tenantId } = check
  const tid = tenantId || DEFAULT_TENANT_ID

  // Super admins have full access across all tenants
  if (await isUserSuperAdmin(userId)) return true

  // Get all user's active roles for this tenant + the permissions each role grants
  const userRoles = await prisma.rbacUserRole.findMany({
    where: { userId, tenantId: tid, ...activeGrantFilter() },
    select: {
      scopeType: true,
      scopeTarget: true,
      role: {
        select: {
          permissions: {
            where: { permission: { name: permission } },
            select: { roleId: true },
          },
        },
      },
    },
  })

  for (const role of userRoles) {
    if (role.role.permissions.length === 0) continue
    if (scopeMatches(role.scopeType, role.scopeTarget, resourceType, resourceId, resourceMeta)) {
      return true
    }
  }

  // Check direct permissions (scoped by tenant)
  const directPerm = await prisma.rbacUserPermission.findMany({
    where: {
      userId,
      tenantId: tid,
      permission: { name: permission },
      ...activeGrantFilter(),
    },
    select: { scopeType: true, scopeTarget: true },
  })

  for (const perm of directPerm) {
    if (scopeMatches(perm.scopeType, perm.scopeTarget, resourceType, resourceId, resourceMeta)) {
      return true
    }
  }

  return false
}

/**
 * Get all effective permissions for a user
 */
export async function getEffectivePermissions(
  userId: string,
  resourceType?: string,
  resourceId?: string,
  tenantId?: string,
): Promise<string[]> {
  const tid = tenantId || DEFAULT_TENANT_ID
  const permissions = new Set<string>()

  // Super admins get all defined permissions across any tenant
  if (await isUserSuperAdmin(userId)) {
    const allPerms = await prisma.rbacPermission.findMany({ select: { name: true } })
    return allPerms.map(p => p.name)
  }

  // Get permissions from roles (scoped by tenant)
  const userRoles = await prisma.rbacUserRole.findMany({
    where: { userId, tenantId: tid, ...activeGrantFilter() },
    select: {
      scopeType: true,
      scopeTarget: true,
      role: {
        select: {
          permissions: { select: { permission: { select: { name: true } } } },
        },
      },
    },
  })

  for (const ur of userRoles) {
    if (scopeMatches(ur.scopeType, ur.scopeTarget, resourceType, resourceId)) {
      for (const rp of ur.role.permissions) {
        permissions.add(rp.permission.name)
      }
    }
  }

  // Get direct permissions (scoped by tenant)
  const directPerms = await prisma.rbacUserPermission.findMany({
    where: { userId, tenantId: tid, ...activeGrantFilter() },
    select: {
      scopeType: true,
      scopeTarget: true,
      permission: { select: { name: true } },
    },
  })

  for (const perm of directPerms) {
    if (scopeMatches(perm.scopeType, perm.scopeTarget, resourceType, resourceId)) {
      permissions.add(perm.permission.name)
    }
  }

  return Array.from(permissions)
}

/**
 * Check if multiple permissions are granted
 */
export async function hasAllPermissions(
  userId: string,
  permissions: string[],
  resourceType?: string,
  resourceId?: string,
  tenantId?: string,
): Promise<boolean> {
  for (const perm of permissions) {
    if (!(await hasPermission({ userId, permission: perm, resourceType: resourceType as any, resourceId, tenantId }))) {
      return false
    }
  }
  return true
}

/**
 * Check if at least one permission is granted
 */
export async function hasAnyPermission(
  userId: string,
  permissions: string[],
  resourceType?: string,
  resourceId?: string,
  tenantId?: string,
): Promise<boolean> {
  for (const perm of permissions) {
    if (await hasPermission({ userId, permission: perm, resourceType: resourceType as any, resourceId, tenantId })) {
      return true
    }
  }
  return false
}

/**
 * Get all resources a user can access with a specific permission
 */
export async function getAccessibleResources(
  userId: string,
  permission: string,
  tenantId?: string,
): Promise<{ scope_type: string; scope_target: string | null }[]> {
  const tid = tenantId || DEFAULT_TENANT_ID
  const resources: { scope_type: string; scope_target: string | null }[] = []

  // Super admins implicitly have global scope for every permission
  if (await isUserSuperAdmin(userId)) {
    return [{ scope_type: "global", scope_target: null }]
  }

  // Get from roles (scoped by tenant)
  const fromRoles = await prisma.rbacUserRole.findMany({
    where: {
      userId,
      tenantId: tid,
      role: { permissions: { some: { permission: { name: permission } } } },
      ...activeGrantFilter(),
    },
    select: { scopeType: true, scopeTarget: true },
    distinct: ["scopeType", "scopeTarget"],
  })

  for (const r of fromRoles) {
    resources.push({ scope_type: r.scopeType, scope_target: r.scopeTarget })
  }

  // Get direct permissions (scoped by tenant)
  const direct = await prisma.rbacUserPermission.findMany({
    where: {
      userId,
      tenantId: tid,
      permission: { name: permission },
      ...activeGrantFilter(),
    },
    select: { scopeType: true, scopeTarget: true },
  })

  for (const r of direct) {
    resources.push({ scope_type: r.scopeType, scope_target: r.scopeTarget })
  }

  return resources
}

// Helper function to check if a scope matches
function scopeMatches(
  scopeType: string,
  scopeTarget: string | null,
  resourceType?: string,
  resourceId?: string,
  resourceMeta?: { tags?: string[]; pool?: string }
): boolean {
  // Global scope matches everything
  if (scopeType === "global") {
    return true
  }

  // If no resource filter, include all scoped permissions
  if (!resourceType || !resourceId) {
    return true
  }

  switch (scopeType) {
    case "connection":
      // Connection scope matches if resourceId starts with the connection ID
      return resourceId.startsWith(scopeTarget || "")

    case "node":
      // Node scope matches if the resource is on this node
      // scopeTarget format: "connectionId:nodeName"
      // resourceId format for VM: "connectionId:nodeName:type:vmid"
      // resourceId format for node: "connectionId:nodeName"
      if (scopeTarget) {
        // Check if resourceId starts with the node scope target
        // This handles both node resources and VM resources on that node
        return resourceId.startsWith(scopeTarget + ":") || resourceId === scopeTarget
      }


return false

    case "vm":
      // VM scope matches exactly
      return resourceId === scopeTarget

    case "tag":
      if (!resourceMeta?.tags || !scopeTarget) return false
      return resourceMeta.tags.includes(scopeTarget)

    case "pool":
      if (!resourceMeta?.pool || !scopeTarget) return false
      return resourceMeta.pool === scopeTarget

    default:
      return false
  }
}

// Export permission constants
export const PERMISSIONS = {
  // VM
  VM_VIEW: "vm.view",
  VM_CONSOLE: "vm.console",
  VM_START: "vm.start",
  VM_STOP: "vm.stop",
  VM_RESTART: "vm.restart",
  VM_SUSPEND: "vm.suspend",
  VM_SNAPSHOT: "vm.snapshot",
  VM_BACKUP: "vm.backup",
  VM_CLONE: "vm.clone",
  VM_MIGRATE: "vm.migrate",
  VM_CONFIG: "vm.config",
  VM_DELETE: "vm.delete",
  VM_CREATE: "vm.create",

  // Storage
  STORAGE_VIEW: "storage.view",
  STORAGE_CONTENT: "storage.content",
  STORAGE_UPLOAD: "storage.upload",
  STORAGE_DELETE: "storage.delete",

  // Node
  NODE_VIEW: "node.view",
  NODE_CONSOLE: "node.console",
  NODE_SERVICES: "node.services",
  NODE_NETWORK: "node.network",
  NODE_MANAGE: "node.manage",

  // Connection
  CONNECTION_VIEW: "connection.view",
  CONNECTION_MANAGE: "connection.manage",

  // Backup
  BACKUP_VIEW: "backup.view",
  BACKUP_RESTORE: "backup.restore",
  BACKUP_DELETE: "backup.delete",

  // Backup Jobs (scheduled backups)
  BACKUP_JOB_VIEW: "backup.job.view",
  BACKUP_JOB_CREATE: "backup.job.create",
  BACKUP_JOB_EDIT: "backup.job.edit",
  BACKUP_JOB_DELETE: "backup.job.delete",
  BACKUP_JOB_RUN: "backup.job.run",

  // Automation (DRS, etc.)
  AUTOMATION_VIEW: "automation.view",
  AUTOMATION_MANAGE: "automation.manage",
  AUTOMATION_EXECUTE: "automation.execute",

  // Operations
  EVENTS_VIEW: "events.view",
  ALERTS_VIEW: "alerts.view",
  ALERTS_MANAGE: "alerts.manage",
  TASKS_VIEW: "tasks.view",
  REPORTS_VIEW: "reports.view",

  // Storage Admin
  STORAGE_ADMIN: "storage.admin",

  // Admin
  ADMIN_USERS: "admin.users",
  ADMIN_RBAC: "admin.rbac",
  ADMIN_SETTINGS: "admin.settings",
  ADMIN_AUDIT: "admin.audit",
  ADMIN_COMPLIANCE: "admin.compliance",
  ADMIN_TENANTS: "admin.tenants",
} as const

export type Permission = typeof PERMISSIONS[keyof typeof PERMISSIONS]

// ============================================================================
// API Route Helper Functions
// ============================================================================

/**
 * Build a VM resource ID from connection, node, type and vmid
 * Format: "connId:node:type:vmid"
 */
export function buildVmResourceId(connId: string, node: string, type: string, vmid: string): string {
  return `${connId}:${node}:${type}:${vmid}`
}

/**
 * Build a node resource ID from connection and node name
 * Format: "connId:nodeName"
 */
export function buildNodeResourceId(connId: string, nodeName: string): string {
  return `${connId}:${nodeName}`
}

/**
 * Get the current user's RBAC context from the session
 * Returns null if not authenticated
 */
export async function getRBACContext(): Promise<{ userId: string; isAdmin: boolean; tenantId: string } | null> {
  const session = await getServerSession(authOptions)

  if (!session?.user?.id) {
    return null
  }

  const tenantId = (session as any)?.user?.tenantId || DEFAULT_TENANT_ID

  return {
    userId: session.user.id,
    isAdmin: await isUserSuperAdmin(session.user.id),
    tenantId
  }
}

/**
 * Check if a user has any tag or pool scoped assignments (roles or direct permissions).
 * Used to decide whether to attempt the second pass in checkPermission().
 */
export async function hasTagOrPoolScopes(userId: string, tenantId?: string): Promise<boolean> {
  const tid = tenantId || DEFAULT_TENANT_ID
  const roleHit = await prisma.rbacUserRole.findFirst({
    where: {
      userId,
      tenantId: tid,
      scopeType: { in: ["tag", "pool"] },
      ...activeGrantFilter(),
    },
    select: { id: true },
  })
  if (roleHit) return true

  const permHit = await prisma.rbacUserPermission.findFirst({
    where: {
      userId,
      tenantId: tid,
      scopeType: { in: ["tag", "pool"] },
      ...activeGrantFilter(),
    },
    select: { id: true },
  })
  return !!permHit
}

/**
 * Check if the current user has a specific permission
 * Returns a 401/403 NextResponse if denied, or null if allowed
 *
 * Uses a two-pass approach:
 *   Pass 1: standard scopes (global, connection, node, vm)
 *   Pass 2: if VM resource + user has tag/pool scopes → resolve meta and retry
 */
export async function checkPermission(
  permission: string,
  resourceType?: "connection" | "node" | "vm" | "global" | "pbs",
  resourceId?: string
): Promise<NextResponse | null> {
  const session = await getServerSession(authOptions)

  if (!session?.user?.id) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 })
  }

  const userId = session.user.id
  const tenantId = (session as any)?.user?.tenantId || DEFAULT_TENANT_ID

  // Pass 1: standard scopes (global, connection, node, vm)
  if (await hasPermission({ userId, permission, resourceType, resourceId, tenantId })) {
    return null
  }

  // Pass 2: if VM resource + user has tag/pool scopes → resolve meta and retry
  if (resourceType === "vm" && resourceId && (await hasTagOrPoolScopes(userId, tenantId))) {
    const meta = resolveVmMeta(resourceId, tenantId)
    if (
      meta &&
      (await hasPermission({ userId, permission, resourceType, resourceId, resourceMeta: meta, tenantId }))
    ) {
      return null
    }
  }

  return NextResponse.json(
    { error: `Permission denied: ${permission}` },
    { status: 403 }
  )
}

/**
 * Check admin-only permission (for admin routes)
 * Returns a 401/403 NextResponse if denied, or null if allowed
 */
export async function requireAdmin(): Promise<NextResponse | null> {
  return checkPermission(PERMISSIONS.ADMIN_SETTINGS)
}

/**
 * Filter a list of VMs based on user permissions
 * Each VM should have: connId, node, type, vmid (or id in format "connId:type:node:vmid")
 */
export async function filterVmsByPermission<T extends { id?: string; connId?: string; node?: string; type?: string; vmid?: string }>(
  userId: string,
  vms: T[],
  permission: string = PERMISSIONS.VM_VIEW,
  tenantId?: string,
): Promise<T[]> {
  // Get accessible resources for this permission
  const resources = await getAccessibleResources(userId, permission, tenantId)

  // Check for global access
  if (resources.some(r => r.scope_type === "global")) {
    return vms
  }

  const result: T[] = []
  for (const vm of vms) {
    // Build resource ID from VM
    let resourceId: string

    if (vm.id && vm.id.includes(":")) {
      // Format: "connId:type:node:vmid"
      const parts = vm.id.split(":")

      resourceId = `${parts[0]}:${parts[2]}:${parts[1]}:${parts[3]}`
    } else if (vm.connId && vm.node && vm.type && vm.vmid) {
      resourceId = buildVmResourceId(vm.connId, vm.node, vm.type, vm.vmid)
    } else {
      continue
    }

    // Extract tags/pool from VM object for tag/pool scope matching
    const vmAny = vm as any
    const tags = Array.isArray(vmAny.tags)
      ? vmAny.tags
      : typeof vmAny.tags === "string"
        ? vmAny.tags
            .split(/[;,]/)
            .map((t: string) => t.trim())
            .filter(Boolean)
        : []

    if (
      await hasPermission({
        userId,
        permission,
        resourceType: "vm",
        resourceId,
        resourceMeta: { tags, pool: vmAny.pool || undefined },
        tenantId,
      })
    ) {
      result.push(vm)
    }
  }
  return result
}

/**
 * Filter a list of nodes based on user permissions
 */
export async function filterNodesByPermission<T extends { connId: string; node: string }>(
  userId: string,
  nodes: T[],
  permission: string = PERMISSIONS.NODE_VIEW,
  tenantId?: string,
): Promise<T[]> {
  // Get accessible resources
  const resources = await getAccessibleResources(userId, permission, tenantId)

  if (resources.some(r => r.scope_type === "global")) {
    return nodes
  }

  const result: T[] = []
  for (const node of nodes) {
    const resourceId = buildNodeResourceId(node.connId, node.node)

    if (
      await hasPermission({
        userId,
        permission,
        resourceType: "node",
        resourceId,
        tenantId,
      })
    ) {
      result.push(node)
    }
  }
  return result
}
