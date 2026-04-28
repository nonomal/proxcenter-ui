export const dynamic = "force-dynamic"
// src/app/api/v1/rbac/assignments/route.ts
import { NextRequest, NextResponse } from "next/server"

import { getServerSession } from "next-auth"

import { nanoid } from "nanoid"

import { authOptions } from "@/lib/auth/config"
import { getDb } from "@/lib/db/sqlite"
import { audit } from "@/lib/audit"
import { hasPermission, isUserSuperAdmin, isUserProtected, PROTECTED_ROLE_IDS, PROTECTED_ROLE_ID_LIST_SQL } from "@/lib/rbac"
import { getCurrentTenantId } from "@/lib/tenant"
import { demoResponse } from "@/lib/demo/demo-api"

// GET /api/v1/rbac/assignments - Liste toutes les assignations
export async function GET(req: NextRequest) {
  const demo = demoResponse(req)
  if (demo) return demo

  try {
    const session = await getServerSession(authOptions)

    if (!session?.user) {
      return NextResponse.json({ error: "Non autorisé" }, { status: 401 })
    }

    const db = getDb()
    const tenantId = await getCurrentTenantId()
    const url = new URL(req.url)
    const userId = url.searchParams.get("user_id")
    const roleId = url.searchParams.get("role_id")

    // Hide every trace of protected roles (super_admin + provider_admin) —
    // both assignments AND any user who holds them anywhere — from
    // non-super-admin callers.
    const callerIsSuperAdmin = isUserSuperAdmin(session.user.id)
    const hideSuperAdminClause = callerIsSuperAdmin
      ? ""
      : `AND ur.role_id NOT IN ${PROTECTED_ROLE_ID_LIST_SQL}
         AND NOT EXISTS (
           SELECT 1 FROM rbac_user_roles sur
           WHERE sur.user_id = ur.user_id AND sur.role_id IN ${PROTECTED_ROLE_ID_LIST_SQL}
             AND (sur.expires_at IS NULL OR sur.expires_at > datetime('now'))
         )`

    let query = `
      SELECT
        ur.id,
        ur.user_id,
        ur.role_id,
        ur.scope_type,
        ur.scope_target,
        ur.granted_at,
        ur.expires_at,
        u.email as user_email,
        u.name as user_name,
        r.name as role_name,
        r.color as role_color,
        r.is_system as role_is_system,
        g.email as granted_by_email
      FROM rbac_user_roles ur
      JOIN users u ON u.id = ur.user_id
      JOIN rbac_roles r ON r.id = ur.role_id
      LEFT JOIN users g ON g.id = ur.granted_by
      WHERE ur.tenant_id = ?
        ${hideSuperAdminClause}
    `
    const params: any[] = [tenantId]

    if (userId) {
      query += " AND ur.user_id = ?"
      params.push(userId)
    }

    if (roleId) {
      query += " AND ur.role_id = ?"
      params.push(roleId)
    }

    query += " ORDER BY ur.granted_at DESC"

    const assignments = db.prepare(query).all(...params) as any[]

    // Surface the global role_super_admin assignment for super-admins who are
    // members of the current tenant. Without this they appear with no role in
    // /security/users of any non-default tenant — their assignment lives on
    // the provider tenant only. Visible to super-admin callers only (the hide
    // filter above already strips protected roles for everyone else).
    if (callerIsSuperAdmin) {
      const superAdminFilter = userId ? "AND ur.user_id = ?" : ""
      const crossTenantParams: any[] = [tenantId, tenantId]
      if (userId) crossTenantParams.push(userId)
      const crossTenant = db.prepare(`
        SELECT
          ur.id,
          ur.user_id,
          ur.role_id,
          ur.scope_type,
          ur.scope_target,
          ur.granted_at,
          ur.expires_at,
          u.email as user_email,
          u.name as user_name,
          r.name as role_name,
          r.color as role_color,
          r.is_system as role_is_system,
          g.email as granted_by_email
        FROM rbac_user_roles ur
        JOIN users u ON u.id = ur.user_id
        JOIN rbac_roles r ON r.id = ur.role_id
        LEFT JOIN users g ON g.id = ur.granted_by
        JOIN user_tenants ut ON ut.user_id = ur.user_id AND ut.tenant_id = ?
        WHERE ur.role_id = 'role_super_admin'
          AND ur.tenant_id != ?
          AND (ur.expires_at IS NULL OR ur.expires_at > datetime('now'))
          ${superAdminFilter}
      `).all(...crossTenantParams) as any[]

      // Prepend so RoleChip (which picks roles[0]) shows "Super Admin" first.
      const seen = new Set(assignments.map(a => a.id))
      for (const row of crossTenant) {
        if (!seen.has(row.id)) assignments.unshift(row)
      }
    }

    // Transformer les résultats
    const data = assignments.map(a => ({
      id: a.id,
      user: {
        id: a.user_id,
        email: a.user_email,
        name: a.user_name
      },
      role: {
        id: a.role_id,
        name: a.role_name,
        color: a.role_color,
        is_system: a.role_is_system === 1
      },
      scope_type: a.scope_type,
      scope_target: a.scope_target,
      granted_at: a.granted_at,
      granted_by_email: a.granted_by_email,
      expires_at: a.expires_at
    }))

    return NextResponse.json({
      data,
      meta: { total: data.length }
    })

  } catch (error: any) {
    console.error("GET /api/v1/rbac/assignments error:", error)
    
return NextResponse.json(
      { error: error.message || "Erreur serveur" },
      { status: 500 }
    )
  }
}

// POST /api/v1/rbac/assignments - Assigner un rôle à un utilisateur
export async function POST(req: NextRequest) {
  const demo = demoResponse(req)
  if (demo) return demo

  try {
    const session = await getServerSession(authOptions)

    if (!session?.user) {
      return NextResponse.json({ error: "Non autorisé" }, { status: 401 })
    }

    const tenantId = await getCurrentTenantId()

    if (!hasPermission({ userId: session.user.id, permission: 'admin.rbac', tenantId })) {
      return NextResponse.json({ error: "Droits administrateur requis" }, { status: 403 })
    }

    const body = await req.json()
    const { user_id, role_id, scope_type, scope_target, expires_at } = body

    if (!user_id || !role_id) {
      return NextResponse.json({ error: "user_id et role_id requis" }, { status: 400 })
    }

    // Prevent self-escalation / self-lockout: a user cannot change their own
    // RBAC assignments. Another admin must do it.
    if (user_id === session.user.id) {
      return NextResponse.json(
        { error: "Vous ne pouvez pas modifier vos propres rôles" },
        { status: 400 }
      )
    }

    // Only an existing super admin can hand out provider-level wildcard
    // roles (super_admin + provider_admin). Also refuse to touch a target that
    // already holds one — prevents a tenant admin from shadowing / reassigning
    // a provider-level operator.
    const callerIsSuperAdmin = isUserSuperAdmin(session.user.id)
    if (!callerIsSuperAdmin) {
      if ((PROTECTED_ROLE_IDS as readonly string[]).includes(role_id)) {
        return NextResponse.json({ error: "Rôle non trouvé" }, { status: 404 })
      }
      if (isUserProtected(user_id)) {
        return NextResponse.json({ error: "Utilisateur non trouvé" }, { status: 404 })
      }
    }

    const validScopes = ["global", "connection", "node", "vm", "tag", "pool"]
    const scopeType = scope_type || "global"

    if (!validScopes.includes(scopeType)) {
      return NextResponse.json({ error: "scope_type invalide" }, { status: 400 })
    }

    if (scopeType !== "global" && !scope_target) {
      return NextResponse.json({ error: "scope_target requis pour ce type de scope" }, { status: 400 })
    }

    const db = getDb()

    // Vérifier que l'utilisateur existe
    const user = db.prepare("SELECT id, email FROM users WHERE id = ?").get(user_id) as any

    if (!user) {
      return NextResponse.json({ error: "Utilisateur non trouvé" }, { status: 404 })
    }

    // Vérifier que le rôle existe
    const role = db.prepare("SELECT id, name FROM rbac_roles WHERE id = ?").get(role_id) as any

    if (!role) {
      return NextResponse.json({ error: "Rôle non trouvé" }, { status: 404 })
    }

    // Vérifier si l'utilisateur a déjà un rôle différent assigné (within tenant)
    const existingRole = db.prepare(`
      SELECT ur.id, r.name as role_name
      FROM rbac_user_roles ur
      JOIN rbac_roles r ON r.id = ur.role_id
      WHERE ur.user_id = ? AND ur.role_id != ? AND ur.tenant_id = ?
      LIMIT 1
    `).get(user_id, role_id, tenantId) as any

    if (existingRole) {
      return NextResponse.json({ 
        error: `L'utilisateur a déjà le rôle "${existingRole.role_name}". Supprimez-le d'abord ou modifiez l'assignation existante.` 
      }, { status: 400 })
    }

    // Vérifier que cette assignation n'existe pas déjà (within tenant)
    const existing = db.prepare(`
      SELECT id FROM rbac_user_roles
      WHERE user_id = ? AND role_id = ? AND scope_type = ? AND COALESCE(scope_target, '') = COALESCE(?, '') AND tenant_id = ?
    `).get(user_id, role_id, scopeType, scope_target || null, tenantId)

    if (existing) {
      return NextResponse.json({ error: "Cette assignation existe déjà" }, { status: 400 })
    }

    const id = `assign_${nanoid(12)}`
    const now = new Date().toISOString()

    db.prepare(`
      INSERT INTO rbac_user_roles (id, user_id, role_id, scope_type, scope_target, granted_by, granted_at, expires_at, tenant_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, user_id, role_id, scopeType, scope_target || null, session.user.id, now, expires_at || null, tenantId)

    // Audit
    await audit({
      action: "rbac_role_assigned",
      category: "security",
      userId: session.user.id,
      userEmail: session.user.email,
      resourceType: "user",
      resourceId: user_id,
      resourceName: user.email,
      details: { 
        role_name: role.name, 
        role_id,
        scope_type: scopeType, 
        scope_target 
      },
      status: "success"
    })

    return NextResponse.json({
      data: {
        id,
        user_id,
        role_id,
        scope_type: scopeType,
        scope_target,
        granted_at: now,
        expires_at
      }
    }, { status: 201 })

  } catch (error: any) {
    console.error("POST /api/v1/rbac/assignments error:", error)
    
return NextResponse.json(
      { error: error.message || "Erreur serveur" },
      { status: 500 }
    )
  }
}
