// src/app/api/v1/users/[id]/route.ts
import { NextResponse } from "next/server"

import { getServerSession } from "next-auth"

import { authOptions } from "@/lib/auth/config"
import { prisma } from "@/lib/db/prisma"
import { hashPassword } from "@/lib/auth/password"
import { checkPermission, PERMISSIONS, isUserSuperAdmin, isUserProtected } from "@/lib/rbac"
import { getCurrentTenantId } from "@/lib/tenant"

/**
 * Hide provider-level accounts (super_admin + provider_admin) from
 * non-super-admin callers. Returns 404 rather than 403 so existence is not
 * leaked.
 */
async function denyIfTargetIsProtectedAndCallerIsNot(
  targetUserId: string,
  callerUserId: string | undefined
): Promise<NextResponse | null> {
  if (!(await isUserProtected(targetUserId))) return null
  if (callerUserId && (await isUserSuperAdmin(callerUserId))) return null
  return NextResponse.json({ error: "Utilisateur non trouvé" }, { status: 404 })
}

/**
 * Fetch a user that belongs to the given tenant. Returns the full Prisma row
 * or null if the user doesn't exist or has no membership in this tenant.
 * Centralised so the GET / PATCH / DELETE handlers all use the same lookup
 * + tenant-scoping rules.
 */
async function findUserInTenant(userId: string, tenantId: string) {
  const membership = await prisma.userTenant.findUnique({
    where: { userId_tenantId: { userId, tenantId } },
    include: { user: true },
  })
  return membership?.user ?? null
}

export const runtime = "nodejs"

// GET /api/v1/users/[id] - Récupérer un utilisateur
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    // RBAC: Check admin.users permission
    const denied = await checkPermission(PERMISSIONS.ADMIN_USERS)
    if (denied) return denied

    const { id } = await params
    const session = await getServerSession(authOptions)
    const superAdminBlock = await denyIfTargetIsProtectedAndCallerIsNot(id, session?.user?.id)
    if (superAdminBlock) return superAdminBlock

    const tenantId = await getCurrentTenantId()
    const user = await findUserInTenant(id, tenantId)

    if (!user) {
      return NextResponse.json({ error: "Utilisateur non trouvé" }, { status: 404 })
    }

    return NextResponse.json({
      data: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        auth_provider: user.authProvider,
        enabled: user.enabled,
        last_login_at: user.lastLoginAt?.toISOString() ?? null,
        created_at: user.createdAt.toISOString(),
        updated_at: user.updatedAt.toISOString(),
      },
    })
  } catch (error: any) {
    console.error("Erreur GET user:", error)
    return NextResponse.json({ error: error?.message || "Erreur serveur" }, { status: 500 })
  }
}

// PATCH /api/v1/users/[id] - Modifier un utilisateur
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await getServerSession(authOptions)
    const { id } = await params
    const body = await req.json()
    const { name, enabled, password } = body

    const isSelf = session?.user?.id === id
    const selfServiceFields = new Set(["name", "password"])
    const hasAdminFields = Object.keys(body).some(k => !selfServiceFields.has(k))

    // Self-service: users can change their own name/password without admin.users
    // Admin fields (enabled, role, etc.) or editing another user requires admin.users
    if (!isSelf || hasAdminFields) {
      const denied = await checkPermission(PERMISSIONS.ADMIN_USERS)
      if (denied) return denied
    }

    // Prevent self-lockout: a user — including admins — cannot disable their
    // own account. Re-enabling needs another admin.
    if (isSelf && enabled === false) {
      return NextResponse.json(
        { error: "Vous ne pouvez pas désactiver votre propre compte" },
        { status: 400 }
      )
    }

    const superAdminBlock = await denyIfTargetIsProtectedAndCallerIsNot(id, session?.user?.id)
    if (superAdminBlock) return superAdminBlock

    const tenantId = await getCurrentTenantId()
    const user = await findUserInTenant(id, tenantId)
    if (!user) {
      return NextResponse.json({ error: "Utilisateur non trouvé" }, { status: 404 })
    }

    // Build the Prisma update payload from whitelisted fields only.
    const data: Record<string, unknown> = {}
    if (name !== undefined) data.name = name
    if (enabled !== undefined) data.enabled = !!enabled
    if (password) {
      if (password.length < 8) {
        return NextResponse.json(
          { error: "Le mot de passe doit contenir au moins 8 caractères" },
          { status: 400 }
        )
      }
      data.password = await hashPassword(password)
    }

    if (Object.keys(data).length === 0) {
      return NextResponse.json({ error: "Aucune modification fournie" }, { status: 400 })
    }

    data.updatedAt = new Date()

    const updated = await prisma.user.update({
      where: { id },
      data,
    })

    // Audit
    const { audit } = await import("@/lib/audit")
    const changes: Record<string, any> = {}
    if (name !== undefined) changes.name = name
    if (enabled !== undefined) changes.enabled = enabled
    if (password) changes.passwordChanged = true

    await audit({
      action: "update",
      category: "users",
      resourceType: "user",
      resourceId: id,
      resourceName: updated.email,
      details: changes,
      status: "success",
    })

    return NextResponse.json({
      success: true,
      data: {
        id: updated.id,
        email: updated.email,
        name: updated.name,
        role: updated.role,
        auth_provider: updated.authProvider,
        enabled: updated.enabled,
        last_login_at: updated.lastLoginAt?.toISOString() ?? null,
        created_at: updated.createdAt.toISOString(),
        updated_at: updated.updatedAt.toISOString(),
      },
    })
  } catch (error: any) {
    console.error("Erreur PATCH user:", error)
    return NextResponse.json({ error: error?.message || "Erreur serveur" }, { status: 500 })
  }
}

// DELETE /api/v1/users/[id] - Supprimer un utilisateur
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    // RBAC: Check admin.users permission
    const denied = await checkPermission(PERMISSIONS.ADMIN_USERS)
    if (denied) return denied

    const session = await getServerSession(authOptions)
    const { id } = await params
    const superAdminBlock = await denyIfTargetIsProtectedAndCallerIsNot(id, session?.user?.id)
    if (superAdminBlock) return superAdminBlock

    const tenantId = await getCurrentTenantId()
    const user = await findUserInTenant(id, tenantId)
    if (!user) {
      return NextResponse.json({ error: "Utilisateur non trouvé" }, { status: 404 })
    }

    // Empêcher la suppression de son propre compte
    if (user.id === session?.user?.id) {
      return NextResponse.json(
        { error: "Vous ne pouvez pas supprimer votre propre compte" },
        { status: 400 }
      )
    }

    // Drop the membership in the current tenant first; then check whether the
    // user has any other membership left. If not, hard-delete the user from
    // Postgres (Prisma cascade also drops their userTenant rows but we want
    // the count check between the two operations).
    await prisma.userTenant.delete({
      where: { userId_tenantId: { userId: id, tenantId } },
    })

    const remainingMemberships = await prisma.userTenant.count({ where: { userId: id } })

    if (remainingMemberships === 0) {
      // No tenants left: hard-delete the user + all their RBAC grants.
      // Cascade deletes (defined in the Prisma schema) drop rbac_user_roles +
      // rbac_user_permissions, but we delete them explicitly first to avoid
      // any FK-on-delete edge case with concurrent reads.
      await prisma.$transaction([
        prisma.rbacUserRole.deleteMany({ where: { userId: id } }),
        prisma.rbacUserPermission.deleteMany({ where: { userId: id } }),
        prisma.user.delete({ where: { id } }),
      ])
    } else {
      // Still a member elsewhere: only strip the RBAC grants scoped to the
      // tenant we just removed them from.
      await prisma.$transaction([
        prisma.rbacUserRole.deleteMany({ where: { userId: id, tenantId } }),
        prisma.rbacUserPermission.deleteMany({ where: { userId: id, tenantId } }),
      ])
    }

    // Audit
    const { audit } = await import("@/lib/audit")
    await audit({
      action: "delete",
      category: "users",
      resourceType: "user",
      resourceId: id,
      resourceName: user.email,
      details: {},
      status: "success",
    })

    return NextResponse.json({ success: true })
  } catch (error: any) {
    console.error("Erreur DELETE user:", error)
    return NextResponse.json({ error: error?.message || "Erreur serveur" }, { status: 500 })
  }
}
