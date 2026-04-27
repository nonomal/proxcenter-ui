// src/lib/tenant/index.ts
// Multi-tenancy helpers

import { getServerSession } from "next-auth"
import { authOptions } from "@/lib/auth/config"
import { getDb } from "@/lib/db/sqlite"
import { prisma } from "@/lib/db/prisma"

export const DEFAULT_TENANT_ID = "default"

export interface Tenant {
  id: string
  slug: string
  name: string
  description: string | null
  enabled: boolean
  settings: Record<string, any> | null
  createdBy: string | null
  createdAt: string
  updatedAt: string
}

/**
 * Get current tenant ID from the session JWT.
 * Falls back to 'default' if not set (backwards-compatible).
 */
export async function getCurrentTenantId(): Promise<string> {
  const session = await getServerSession(authOptions)
  const tenantId = (session as any)?.user?.tenantId || DEFAULT_TENANT_ID

  // Verify tenant exists and is enabled
  const db = getDb()
  const tenant = db.prepare(
    "SELECT id, enabled FROM tenants WHERE id = ?"
  ).get(tenantId) as any

  if (!tenant) return DEFAULT_TENANT_ID
  if (!tenant.enabled) return DEFAULT_TENANT_ID

  // Verify the user actually belongs to this tenant (guards against stale JWTs)
  const userId = (session as any)?.user?.id
  if (userId && tenantId !== DEFAULT_TENANT_ID && !userHasAccessToTenant(userId, tenantId)) {
    return DEFAULT_TENANT_ID
  }

  return tenantId
}

/**
 * Get tenants accessible by a user.
 * Super admins see all enabled tenants; regular users see only those they are members of.
 */
export function getUserTenants(userId: string): Tenant[] {
  const db = getDb()
  if (isSuperAdminLocal(userId)) {
    return db.prepare(`
      SELECT t.id, t.slug, t.name, t.description, t.enabled, t.settings,
             t.created_by as createdBy, t.created_at as createdAt, t.updated_at as updatedAt
      FROM tenants t
      WHERE t.enabled = 1
      ORDER BY (t.id = 'default') DESC, t.name ASC
    `).all() as Tenant[]
  }
  return db.prepare(`
    SELECT t.id, t.slug, t.name, t.description, t.enabled, t.settings,
           t.created_by as createdBy, t.created_at as createdAt, t.updated_at as updatedAt
    FROM tenants t
    JOIN user_tenants ut ON ut.tenant_id = t.id
    WHERE ut.user_id = ? AND t.enabled = 1
    ORDER BY ut.is_default DESC, t.name ASC
  `).all(userId) as Tenant[]
}

/**
 * Get user's default tenant ID.
 */
export function getUserDefaultTenantId(userId: string): string {
  const db = getDb()
  const row = db.prepare(`
    SELECT tenant_id FROM user_tenants
    WHERE user_id = ? AND is_default = 1
    LIMIT 1
  `).get(userId) as any

  return row?.tenant_id || DEFAULT_TENANT_ID
}

/**
 * Check if a user holds role_super_admin on any tenant.
 * Super admins have cross-tenant access by design.
 * Inlined here (instead of importing from lib/rbac) to avoid a circular import.
 */
function isSuperAdminLocal(userId: string): boolean {
  const db = getDb()
  const row = db.prepare(`
    SELECT 1 FROM rbac_user_roles
    WHERE user_id = ? AND role_id = 'role_super_admin'
      AND (expires_at IS NULL OR expires_at > datetime('now'))
    LIMIT 1
  `).get(userId)
  return !!row
}

/**
 * Check if a user has access to a specific tenant.
 * Super admins always have access to every tenant.
 */
export function userHasAccessToTenant(userId: string, tenantId: string): boolean {
  if (isSuperAdminLocal(userId)) return true
  const db = getDb()
  const row = db.prepare(
    "SELECT 1 FROM user_tenants WHERE user_id = ? AND tenant_id = ?"
  ).get(userId, tenantId)
  return !!row
}

/**
 * Create a tenant-scoped Prisma client using $extends.
 * Automatically filters all queries by tenantId and sets tenantId on creates.
 */
export function getTenantPrisma(tenantId: string) {
  return prisma.$extends({
    query: {
      $allModels: {
        async findMany({ args, query }: any) {
          args.where = { ...args.where, tenantId }
          return query(args)
        },
        async findFirst({ args, query }: any) {
          args.where = { ...args.where, tenantId }
          return query(args)
        },
        async findUnique({ args, query }: any) {
          // findUnique uses unique fields, so we verify after fetch.
          // If a select clause is used that omits tenantId, we need to
          // temporarily include it for the tenant check, then strip it.
          const hadSelect = !!args.select
          const selectedTenantId = hadSelect && args.select.tenantId

          if (hadSelect && !selectedTenantId) {
            args.select = { ...args.select, tenantId: true }
          }

          const result = await query(args)

          if (result && (result as any).tenantId !== tenantId) return null

          // Strip tenantId from result if it wasn't originally selected
          if (result && hadSelect && !selectedTenantId) {
            delete (result as any).tenantId
          }

          return result
        },
        async create({ args, query }: any) {
          args.data = { ...args.data, tenantId }
          return query(args)
        },
        async createMany({ args, query }: any) {
          if (Array.isArray(args.data)) {
            args.data = args.data.map((d: any) => ({ ...d, tenantId }))
          } else {
            args.data = { ...args.data, tenantId }
          }
          return query(args)
        },
        async update({ model, args, query }: any) {
          // Verify ownership before updating via the base prisma client
          const modelKey = model.charAt(0).toLowerCase() + model.slice(1)
          const check = await (prisma as any)[modelKey].findUnique({
            where: args.where,
            select: { tenantId: true },
          })
          if (!check || check.tenantId !== tenantId) {
            throw new Error('Record not found')
          }
          return query(args)
        },
        async updateMany({ args, query }: any) {
          args.where = { ...args.where, tenantId }
          return query(args)
        },
        async delete({ model, args, query }: any) {
          // Verify ownership before deleting via the base prisma client
          const modelKey = model.charAt(0).toLowerCase() + model.slice(1)
          const check = await (prisma as any)[modelKey].findUnique({
            where: args.where,
            select: { tenantId: true },
          })
          if (!check || check.tenantId !== tenantId) {
            throw new Error('Record not found')
          }
          return query(args)
        },
        async deleteMany({ args, query }: any) {
          args.where = { ...args.where, tenantId }
          return query(args)
        },
        async upsert({ model, args, query }: any) {
          // Inject tenantId into create data and strip it from update to prevent tenant reassignment
          args.create = { ...args.create, tenantId }
          const { tenantId: _stripTenantId, ...safeUpdate } = args.update || {}
          args.update = safeUpdate
          // Check if record already exists and verify tenant ownership
          const modelKey = model.charAt(0).toLowerCase() + model.slice(1)
          const existing = await (prisma as any)[modelKey].findUnique({
            where: args.where,
            select: { tenantId: true },
          })
          if (existing && existing.tenantId !== tenantId) {
            throw new Error('Record not found')
          }
          return query(args)
        },
        async count({ args, query }: any) {
          args.where = { ...args.where, tenantId }
          return query(args)
        },
        async aggregate({ args, query }: any) {
          args.where = { ...args.where, tenantId }
          return query(args)
        },
        async groupBy({ args, query }: any) {
          args.where = { ...args.where, tenantId }
          return query(args)
        },
      },
    },
  })
}

/**
 * Get a tenant-scoped Prisma client from the current session.
 * Convenience wrapper for API routes.
 */
export async function getSessionPrisma() {
  const tenantId = await getCurrentTenantId()
  return getTenantPrisma(tenantId)
}

/**
 * Get the set of connection IDs reachable by the current tenant.
 *
 * Includes BOTH:
 *  - connections owned directly via the `Connection` table (legacy
 *    multi-tenancy or provider tenant)
 *  - PVE & PBS connection IDs referenced by the tenant's vDC bindings
 *    (MSP/IaaS mode, where the provider owns the connection but exposes
 *    a slice via vDC)
 *
 * Without the vDC union, tenants in MSP mode would get an empty set and
 * any orchestrator-proxy filter built on top of this helper would drop
 * every event (changes feed, replication plans, rolling updates, DRS
 * migration checks, …). Provider tenant returns all owned connections;
 * getVdcScope returns null for them so no extra union happens.
 */
export async function getTenantConnectionIds(): Promise<Set<string>> {
  const tenantPrisma = await getSessionPrisma()
  const connections = await tenantPrisma.connection.findMany({ select: { id: true } })
  const ids = new Set(connections.map((c: any) => c.id))

  // Union with vDC bindings — PVE under .connectionIds, PBS under
  // .pbsConnectionIds. Imported lazily to keep the dependency direction
  // tenant → vdc only at call time (vdc/scope.ts depends on this module
  // for DEFAULT_TENANT_ID, so a top-level import would cycle).
  const { getVdcScope } = await import('@/lib/vdc/scope')
  const tenantId = await getCurrentTenantId()
  const scope = getVdcScope(tenantId)
  if (scope) {
    for (const cid of scope.connectionIds) ids.add(cid)
    for (const cid of scope.pbsConnectionIds) ids.add(cid)
  }

  return ids
}

/**
 * Verify a connection ID is reachable by the current tenant: either it
 * belongs to the tenant directly, OR the tenant has a vDC binding that
 * references it (PVE via vdcs.connection_id, PBS via vdc_pbs_namespaces).
 * Returns a 404 NextResponse if neither, or null if OK.
 */
export async function verifyConnectionOwnership(connectionId: string): Promise<Response | null> {
  const tenantConnectionIds = await getTenantConnectionIds()
  if (tenantConnectionIds.has(connectionId)) return null
  // Fall back to vDC scope so vDC tenants can reach provider-owned PVE/PBS
  // referenced by their bindings (mirror of the bypass used by getConnectionById).
  const { getVdcScope } = await import('@/lib/vdc/scope')
  const scope = getVdcScope(await getCurrentTenantId())
  if (scope && (scope.connectionIds.has(connectionId) || scope.pbsConnectionIds.has(connectionId))) {
    return null
  }
  const { NextResponse } = await import('next/server')
  return NextResponse.json({ error: 'Connection not found' }, { status: 404 })
}

/**
 * Enforce that the current session is operating in the provider tenant.
 * Used to scope provider-level operations (tenant CRUD, vDC admin, provider-bridges).
 * Returns a 403 NextResponse if not in the provider tenant, or null if OK.
 */
export async function requireProviderTenant(): Promise<Response | null> {
  const tenantId = await getCurrentTenantId()
  if (tenantId !== DEFAULT_TENANT_ID) {
    const { NextResponse } = await import('next/server')
    return NextResponse.json(
      { error: 'This operation is only available from the provider tenant' },
      { status: 403 }
    )
  }
  return null
}

/**
 * List all tenants (admin only).
 */
export function listTenants(): Tenant[] {
  const db = getDb()
  return db.prepare(
    "SELECT id, slug, name, description, enabled, settings, created_by as createdBy, created_at as createdAt, updated_at as updatedAt FROM tenants ORDER BY name"
  ).all() as Tenant[]
}

/**
 * Create a new tenant.
 */
export function createTenant(data: { slug: string; name: string; description?: string; createdBy?: string }): Tenant {
  const db = getDb()
  const now = new Date().toISOString()
  const id = crypto.randomUUID()

  db.prepare(
    "INSERT INTO tenants (id, slug, name, description, enabled, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?)"
  ).run(id, data.slug, data.name, data.description || null, data.createdBy || null, now, now)

  return db.prepare("SELECT id, slug, name, description, enabled, settings, created_by as createdBy, created_at as createdAt, updated_at as updatedAt FROM tenants WHERE id = ?").get(id) as Tenant
}

/**
 * Update a tenant.
 */
export function updateTenant(id: string, data: { name?: string; slug?: string; description?: string; enabled?: boolean }): Tenant | null {
  const db = getDb()
  const now = new Date().toISOString()
  const tenant = db.prepare("SELECT * FROM tenants WHERE id = ?").get(id) as any
  if (!tenant) return null

  db.prepare(
    "UPDATE tenants SET name = ?, slug = ?, description = ?, enabled = ?, updated_at = ? WHERE id = ?"
  ).run(
    data.name ?? tenant.name,
    data.slug ?? tenant.slug,
    data.description ?? tenant.description,
    data.enabled !== undefined ? (data.enabled ? 1 : 0) : tenant.enabled,
    now,
    id
  )

  return db.prepare("SELECT id, slug, name, description, enabled, settings, created_by as createdBy, created_at as createdAt, updated_at as updatedAt FROM tenants WHERE id = ?").get(id) as Tenant
}

/**
 * Delete a tenant (cannot delete 'default').
 */
export function deleteTenant(id: string): boolean {
  if (id === DEFAULT_TENANT_ID) return false
  const db = getDb()
  const result = db.prepare("DELETE FROM tenants WHERE id = ? AND id != 'default'").run(id)
  return result.changes > 0
}

/**
 * Add a user to a tenant.
 * If isDefault is true, clears any existing is_default flag for the user.
 * If isDefault is false and the user has no existing default tenant yet, this
 * membership becomes the user's default automatically (so login lands here
 * instead of falling back to the provider tenant).
 */
export function addUserToTenant(userId: string, tenantId: string, isDefault = false): void {
  const db = getDb()
  const now = new Date().toISOString()

  const tx = db.transaction(() => {
    let markDefault = isDefault
    if (!markDefault) {
      const existingDefault = db.prepare(
        "SELECT 1 FROM user_tenants WHERE user_id = ? AND is_default = 1 LIMIT 1"
      ).get(userId)
      if (!existingDefault) markDefault = true
    }

    if (markDefault) {
      db.prepare("UPDATE user_tenants SET is_default = 0 WHERE user_id = ?").run(userId)
    }

    db.prepare(
      "INSERT OR IGNORE INTO user_tenants (user_id, tenant_id, is_default, joined_at) VALUES (?, ?, ?, ?)"
    ).run(userId, tenantId, markDefault ? 1 : 0, now)
  })
  tx()
}

export class TenantMembershipError extends Error {
  constructor(message: string, public readonly code: "LAST_TENANT" | "NOT_A_MEMBER") {
    super(message)
    this.name = "TenantMembershipError"
  }
}

/**
 * Remove a user from a tenant.
 * Refuses to strip the user's last membership (would orphan them).
 * Cleans up role and direct-permission assignments scoped to the removed tenant.
 * If the removed membership was the user's default, transfers the default flag
 * to another of their memberships (oldest join first).
 */
export function removeUserFromTenant(userId: string, tenantId: string): void {
  const db = getDb()

  const existing = db.prepare(
    "SELECT is_default FROM user_tenants WHERE user_id = ? AND tenant_id = ?"
  ).get(userId, tenantId) as { is_default: number } | undefined
  if (!existing) throw new TenantMembershipError("User is not a member of this tenant", "NOT_A_MEMBER")

  const replacement = db.prepare(
    "SELECT tenant_id FROM user_tenants WHERE user_id = ? AND tenant_id != ? ORDER BY joined_at ASC LIMIT 1"
  ).get(userId, tenantId) as { tenant_id: string } | undefined
  if (!replacement) {
    throw new TenantMembershipError(
      "Cannot remove the user's last tenant membership",
      "LAST_TENANT"
    )
  }

  const tx = db.transaction(() => {
    db.prepare("DELETE FROM user_tenants WHERE user_id = ? AND tenant_id = ?").run(userId, tenantId)
    db.prepare("DELETE FROM rbac_user_roles WHERE user_id = ? AND tenant_id = ?").run(userId, tenantId)
    db.prepare("DELETE FROM rbac_user_permissions WHERE user_id = ? AND tenant_id = ?").run(userId, tenantId)
    if (existing.is_default) {
      db.prepare("UPDATE user_tenants SET is_default = 1 WHERE user_id = ? AND tenant_id = ?")
        .run(userId, replacement.tenant_id)
    }
  })
  tx()
}

/**
 * Get users in a tenant.
 */
export function getTenantUsers(tenantId: string): any[] {
  const db = getDb()
  return db.prepare(`
    SELECT u.id, u.email, u.name, u.role, u.enabled, ut.is_default, ut.joined_at
    FROM users u
    JOIN user_tenants ut ON ut.user_id = u.id
    WHERE ut.tenant_id = ?
    ORDER BY u.name
  `).all(tenantId)
}
