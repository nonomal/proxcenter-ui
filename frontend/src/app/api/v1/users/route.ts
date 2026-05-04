// src/app/api/v1/users/route.ts
import { NextResponse } from "next/server"

import { nanoid } from "nanoid"

import { getServerSession } from "next-auth"

import { prisma } from "@/lib/db/prisma"
import { hashPassword } from "@/lib/auth/password"
import { authOptions } from "@/lib/auth/config"
import { checkPermission, PERMISSIONS, isUserSuperAdmin, PROTECTED_ROLE_IDS } from "@/lib/rbac"
import { getCurrentTenantId } from "@/lib/tenant"

export const runtime = "nodejs"

/**
 * Compute the set of user IDs that hold a protected (provider-tier) role
 * still active right now. Used to filter the user list shown to non-super-admin
 * callers — they must not enumerate provider operators.
 */
async function loadProtectedUserIds(): Promise<Set<string>> {
  const rows = await prisma.rbacUserRole.findMany({
    where: {
      roleId: { in: [...PROTECTED_ROLE_IDS] },
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
    select: { userId: true },
    distinct: ["userId"],
  })
  return new Set(rows.map(r => r.userId))
}

// GET /api/v1/users - Liste des utilisateurs
export async function GET() {
  try {
    // RBAC: Check admin.users permission
    const denied = await checkPermission(PERMISSIONS.ADMIN_USERS)
    if (denied) return denied

    const tenantId = await getCurrentTenantId()

    // Hide provider-level accounts (super_admin + provider_admin, both
    // wildcard) from non-super-admin callers so a tenant admin — who holds
    // admin.users scoped to their tenant — can't enumerate, edit, or delete
    // a provider operator.
    const session = await getServerSession(authOptions)
    const callerIsSuperAdmin = session?.user?.id ? await isUserSuperAdmin(session.user.id) : false
    const protectedIds = callerIsSuperAdmin ? new Set<string>() : await loadProtectedUserIds()

    const memberships = await prisma.userTenant.findMany({
      where: {
        tenantId,
        ...(protectedIds.size > 0 ? { userId: { notIn: Array.from(protectedIds) } } : {}),
      },
      include: { user: true },
      orderBy: { user: { createdAt: "desc" } },
    })

    const users = memberships.map(m => ({
      id: m.user.id,
      email: m.user.email,
      name: m.user.name,
      role: m.user.role,
      auth_provider: m.user.authProvider,
      enabled: m.user.enabled,
      last_login_at: m.user.lastLoginAt?.toISOString() ?? null,
      created_at: m.user.createdAt.toISOString(),
      updated_at: m.user.updatedAt.toISOString(),
    }))

    const adminCount = users.filter(u => u.role === "admin").length

    return NextResponse.json({
      data: users,
      meta: {
        total: users.length,
        adminCount,
      },
    })
  } catch (error: any) {
    console.error("Erreur GET users:", error)
    return NextResponse.json({ error: error?.message || "Erreur serveur" }, { status: 500 })
  }
}

// POST /api/v1/users - Créer un utilisateur
export async function POST(req: Request) {
  try {
    // RBAC: Check admin.users permission
    const denied = await checkPermission(PERMISSIONS.ADMIN_USERS)
    if (denied) return denied

    const body = await req.json()
    const { email, password, name } = body

    if (!email || !password) {
      return NextResponse.json({ error: "Email et mot de passe requis" }, { status: 400 })
    }

    // Valider l'email
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    if (email.length > 254 || !emailRegex.test(email)) {
      return NextResponse.json({ error: "Format d'email invalide" }, { status: 400 })
    }

    // Valider le mot de passe
    if (password.length < 8) {
      return NextResponse.json(
        { error: "Le mot de passe doit contenir au moins 8 caractères" },
        { status: 400 }
      )
    }

    const normalisedEmail = email.toLowerCase().trim()

    // Vérifier si l'email existe déjà
    const existing = await prisma.user.findUnique({
      where: { email: normalisedEmail },
      select: { id: true },
    })
    if (existing) {
      return NextResponse.json({ error: "Cet email est déjà utilisé" }, { status: 400 })
    }

    // Hasher le mot de passe
    const hashedPassword = await hashPassword(password)

    // Créer l'utilisateur + l'adhésion par défaut atomiquement.
    const id = nanoid()
    const now = new Date()
    const tenantId = await getCurrentTenantId()

    await prisma.$transaction([
      prisma.user.create({
        data: {
          id,
          email: normalisedEmail,
          password: hashedPassword,
          name: name || null,
          role: "user",
          authProvider: "credentials",
          enabled: true,
          createdAt: now,
          updatedAt: now,
        },
      }),
      prisma.userTenant.create({
        data: {
          userId: id,
          tenantId,
          isDefault: true,
          joinedAt: now,
        },
      }),
    ])

    // Audit
    const { audit } = await import("@/lib/audit")
    await audit({
      action: "create",
      category: "users",
      resourceType: "user",
      resourceId: id,
      resourceName: normalisedEmail,
      details: { name: name || null },
      status: "success",
    })

    return NextResponse.json({
      success: true,
      data: {
        id,
        email: normalisedEmail,
        name: name || null,
        auth_provider: "credentials",
        enabled: 1,
        created_at: now.toISOString(),
      },
    })
  } catch (error: any) {
    console.error("Erreur POST users:", error)
    return NextResponse.json({ error: error?.message || "Erreur serveur" }, { status: 500 })
  }
}
