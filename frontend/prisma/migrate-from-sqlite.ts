/**
 * One-shot data migration from the legacy SQLite database to Postgres.
 *
 * Usage:
 *   DATABASE_URL=postgresql://... \
 *   SQLITE_PATH=./data/proxcenter.db \
 *     npx tsx prisma/migrate-from-sqlite.ts
 *
 * Idempotent: every row is inserted via Prisma `upsert` so repeated runs
 * converge to the same Postgres state. Tables touched (in dependency order):
 *
 *   tenants → users → user_tenants → audit_logs (best-effort)
 *   rbac_roles → rbac_permissions → rbac_role_permissions
 *   rbac_user_roles → rbac_user_permissions
 *   ldap_config (singleton) → oidc_config (singleton)
 *   security_policies (singleton) → settings → favorites
 *
 * Skipped on purpose:
 *   - sessions (NextAuth uses JWT, no DB row required)
 *   - vDC tables (refactor lands later, will get its own migration step)
 *   - alert_rules, alert_instances, datacenters, *_green_config (step 2.4)
 *
 * Also covered: the 9 Prisma-managed tables (Connection, ManagedHost,
 * DashboardLayout, Alert→frontend_alerts, AlertSilence, CustomImage,
 * Blueprint, Deployment, MigrationJob). These live in Postgres after the
 * baseline migration but the SCHEMA-only baseline doesn't carry data over —
 * existing rows from the SQLite Prisma DB need to be copied so the frontend
 * keeps showing the user's connections / blueprints / deployments after
 * the cutover.
 *
 * The script connects to Postgres through the same Prisma driver adapter
 * the runtime uses, so any wiring issue surfaces here before runtime.
 */

import path from "path"
import fs from "fs"
import Database from "better-sqlite3"

import { PrismaClient } from "@prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl || !databaseUrl.startsWith("postgres")) {
  console.error("[migrate-from-sqlite] DATABASE_URL must point to Postgres.")
  process.exit(1)
}

const sqlitePath = process.env.SQLITE_PATH || path.join(process.cwd(), "data", "proxcenter.db")
if (!fs.existsSync(sqlitePath)) {
  console.error(`[migrate-from-sqlite] SQLite file not found at ${sqlitePath}.`)
  console.error("[migrate-from-sqlite] Pass SQLITE_PATH=... to point at a different location.")
  process.exit(1)
}

const sqlite = new Database(sqlitePath, { readonly: true })
const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: databaseUrl }),
})

function rowsOf<T = any>(query: string): T[] {
  try {
    return sqlite.prepare(query).all() as T[]
  } catch (e: any) {
    // Table missing on the legacy DB → nothing to copy.
    if (String(e?.message || "").toLowerCase().includes("no such table")) {
      return []
    }
    throw e
  }
}

/** Coerce an int (0/1) or null into a real boolean for Prisma. */
function bool(v: unknown): boolean {
  return v === 1 || v === true || v === "1" || v === "true"
}

/** Parse an SQLite TEXT timestamp (ISO 8601) into a Date, falling back to now() on bad data. */
function date(v: unknown): Date {
  if (v instanceof Date) return v
  if (typeof v === "string" && v) {
    const parsed = new Date(v)
    if (!Number.isNaN(parsed.getTime())) return parsed
  }
  return new Date()
}

/** Parse a JSON-encoded TEXT field, returning Prisma.JsonValue or undefined. */
function json(v: unknown): any {
  if (v === null || v === undefined || v === "") return undefined
  if (typeof v !== "string") return v
  try {
    return JSON.parse(v)
  } catch {
    return undefined
  }
}

async function migrateTenants() {
  const rows = rowsOf("SELECT * FROM tenants")
  for (const r of rows) {
    await prisma.tenant.upsert({
      where: { id: r.id },
      update: {
        slug: r.slug,
        name: r.name,
        description: r.description,
        enabled: bool(r.enabled),
        settings: json(r.settings),
        createdBy: r.created_by,
        updatedAt: date(r.updated_at),
      },
      create: {
        id: r.id,
        slug: r.slug,
        name: r.name,
        description: r.description,
        enabled: bool(r.enabled),
        settings: json(r.settings),
        createdBy: r.created_by,
        createdAt: date(r.created_at),
        updatedAt: date(r.updated_at),
      },
    })
  }
  return rows.length
}

async function migrateUsers() {
  const rows = rowsOf("SELECT * FROM users")
  for (const r of rows) {
    await prisma.user.upsert({
      where: { id: r.id },
      update: {
        email: r.email,
        password: r.password,
        name: r.name,
        avatar: r.avatar,
        role: r.role,
        authProvider: r.auth_provider,
        ldapDn: r.ldap_dn,
        oidcSub: r.oidc_sub,
        enabled: bool(r.enabled),
        lastLoginAt: r.last_login_at ? date(r.last_login_at) : null,
        updatedAt: date(r.updated_at),
        tenantId: r.tenant_id || "default",
      },
      create: {
        id: r.id,
        tenantId: r.tenant_id || "default",
        email: r.email,
        password: r.password,
        name: r.name,
        avatar: r.avatar,
        role: r.role || "viewer",
        authProvider: r.auth_provider || "credentials",
        ldapDn: r.ldap_dn,
        oidcSub: r.oidc_sub,
        enabled: bool(r.enabled),
        lastLoginAt: r.last_login_at ? date(r.last_login_at) : null,
        createdAt: date(r.created_at),
        updatedAt: date(r.updated_at),
      },
    })
  }
  return rows.length
}

async function migrateUserTenants() {
  const rows = rowsOf("SELECT * FROM user_tenants")
  for (const r of rows) {
    await prisma.userTenant.upsert({
      where: { userId_tenantId: { userId: r.user_id, tenantId: r.tenant_id } },
      update: { isDefault: bool(r.is_default) },
      create: {
        userId: r.user_id,
        tenantId: r.tenant_id,
        isDefault: bool(r.is_default),
        joinedAt: date(r.joined_at),
      },
    })
  }
  return rows.length
}

async function migrateRbacRoles() {
  const rows = rowsOf("SELECT * FROM rbac_roles")
  for (const r of rows) {
    await prisma.rbacRole.upsert({
      where: { id: r.id },
      update: {
        name: r.name,
        description: r.description,
        isSystem: bool(r.is_system),
        color: r.color,
        updatedAt: date(r.updated_at),
      },
      create: {
        id: r.id,
        name: r.name,
        description: r.description,
        isSystem: bool(r.is_system),
        color: r.color,
        createdAt: date(r.created_at),
        updatedAt: date(r.updated_at),
      },
    })
  }
  return rows.length
}

async function migrateRbacPermissions() {
  const rows = rowsOf("SELECT * FROM rbac_permissions")
  for (const r of rows) {
    await prisma.rbacPermission.upsert({
      where: { id: r.id },
      update: {
        name: r.name,
        category: r.category,
        description: r.description,
        isDangerous: bool(r.is_dangerous),
      },
      create: {
        id: r.id,
        name: r.name,
        category: r.category,
        description: r.description,
        isDangerous: bool(r.is_dangerous),
        createdAt: date(r.created_at),
      },
    })
  }
  return rows.length
}

async function migrateRbacRolePermissions() {
  const rows = rowsOf("SELECT * FROM rbac_role_permissions")
  for (const r of rows) {
    await prisma.rbacRolePermission.upsert({
      where: { roleId_permissionId: { roleId: r.role_id, permissionId: r.permission_id } },
      update: {},
      create: { roleId: r.role_id, permissionId: r.permission_id },
    })
  }
  return rows.length
}

async function migrateRbacUserRoles() {
  const rows = rowsOf("SELECT * FROM rbac_user_roles")
  for (const r of rows) {
    await prisma.rbacUserRole.upsert({
      where: { id: r.id },
      update: {
        userId: r.user_id,
        roleId: r.role_id,
        scopeType: r.scope_type,
        scopeTarget: r.scope_target,
        tenantId: r.tenant_id || "default",
        grantedById: r.granted_by,
        grantedAt: date(r.granted_at),
        expiresAt: r.expires_at ? date(r.expires_at) : null,
      },
      create: {
        id: r.id,
        userId: r.user_id,
        roleId: r.role_id,
        scopeType: r.scope_type || "global",
        scopeTarget: r.scope_target,
        tenantId: r.tenant_id || "default",
        grantedById: r.granted_by,
        grantedAt: date(r.granted_at),
        expiresAt: r.expires_at ? date(r.expires_at) : null,
      },
    })
  }
  return rows.length
}

async function migrateRbacUserPermissions() {
  const rows = rowsOf("SELECT * FROM rbac_user_permissions")
  for (const r of rows) {
    await prisma.rbacUserPermission.upsert({
      where: { id: r.id },
      update: {
        userId: r.user_id,
        permissionId: r.permission_id,
        scopeType: r.scope_type,
        scopeTarget: r.scope_target,
        tenantId: r.tenant_id || "default",
        grantedById: r.granted_by,
        grantedAt: date(r.granted_at),
        expiresAt: r.expires_at ? date(r.expires_at) : null,
      },
      create: {
        id: r.id,
        userId: r.user_id,
        permissionId: r.permission_id,
        scopeType: r.scope_type || "global",
        scopeTarget: r.scope_target,
        tenantId: r.tenant_id || "default",
        grantedById: r.granted_by,
        grantedAt: date(r.granted_at),
        expiresAt: r.expires_at ? date(r.expires_at) : null,
      },
    })
  }
  return rows.length
}

async function migrateLdapConfig() {
  const rows = rowsOf("SELECT * FROM ldap_config")
  for (const r of rows) {
    await prisma.ldapConfig.upsert({
      where: { id: r.id },
      update: {
        enabled: bool(r.enabled),
        url: r.url,
        bindDn: r.bind_dn,
        bindPasswordEnc: r.bind_password_enc,
        baseDn: r.base_dn,
        userFilter: r.user_filter,
        emailAttribute: r.email_attribute,
        nameAttribute: r.name_attribute,
        tlsInsecure: bool(r.tls_insecure),
        startTls: bool(r.start_tls),
        groupAttribute: r.group_attribute || "memberOf",
        groupRoleMapping: json(r.group_role_mapping) ?? {},
        defaultRole: r.default_role || "role_viewer",
        requireGroup: bool(r.require_group),
        allowedGroups: json(r.allowed_groups) ?? [],
        updatedAt: date(r.updated_at),
      },
      create: {
        id: r.id,
        tenantId: r.tenant_id || "default",
        enabled: bool(r.enabled),
        url: r.url,
        bindDn: r.bind_dn,
        bindPasswordEnc: r.bind_password_enc,
        baseDn: r.base_dn,
        userFilter: r.user_filter,
        emailAttribute: r.email_attribute,
        nameAttribute: r.name_attribute,
        tlsInsecure: bool(r.tls_insecure),
        startTls: bool(r.start_tls),
        groupAttribute: r.group_attribute || "memberOf",
        groupRoleMapping: json(r.group_role_mapping) ?? {},
        defaultRole: r.default_role || "role_viewer",
        requireGroup: bool(r.require_group),
        allowedGroups: json(r.allowed_groups) ?? [],
        createdAt: date(r.created_at),
        updatedAt: date(r.updated_at),
      },
    })
  }
  return rows.length
}

async function migrateOidcConfig() {
  const rows = rowsOf("SELECT * FROM oidc_config")
  for (const r of rows) {
    await prisma.oidcConfig.upsert({
      where: { id: r.id },
      update: {
        enabled: bool(r.enabled),
        providerName: r.provider_name,
        issuerUrl: r.issuer_url,
        clientId: r.client_id,
        clientSecretEnc: r.client_secret_enc,
        scopes: r.scopes,
        authorizationUrl: r.authorization_url,
        tokenUrl: r.token_url,
        userinfoUrl: r.userinfo_url,
        claimEmail: r.claim_email,
        claimName: r.claim_name,
        claimGroups: r.claim_groups,
        autoProvision: bool(r.auto_provision),
        defaultRole: r.default_role || "viewer",
        groupRoleMapping: json(r.group_role_mapping) ?? {},
        updatedAt: date(r.updated_at),
      },
      create: {
        id: r.id,
        tenantId: r.tenant_id || "default",
        enabled: bool(r.enabled),
        providerName: r.provider_name || "SSO",
        issuerUrl: r.issuer_url || "",
        clientId: r.client_id || "",
        clientSecretEnc: r.client_secret_enc,
        scopes: r.scopes || "openid profile email",
        authorizationUrl: r.authorization_url,
        tokenUrl: r.token_url,
        userinfoUrl: r.userinfo_url,
        claimEmail: r.claim_email || "email",
        claimName: r.claim_name || "name",
        claimGroups: r.claim_groups,
        autoProvision: bool(r.auto_provision),
        defaultRole: r.default_role || "viewer",
        groupRoleMapping: json(r.group_role_mapping) ?? {},
        createdAt: date(r.created_at),
        updatedAt: date(r.updated_at),
      },
    })
  }
  return rows.length
}

async function migrateSecurityPolicies() {
  const rows = rowsOf("SELECT * FROM security_policies")
  for (const r of rows) {
    await prisma.securityPolicy.upsert({
      where: { id: r.id },
      update: {
        passwordMinLength: r.password_min_length,
        passwordRequireUppercase: bool(r.password_require_uppercase),
        passwordRequireLowercase: bool(r.password_require_lowercase),
        passwordRequireNumbers: bool(r.password_require_numbers),
        passwordRequireSpecial: bool(r.password_require_special),
        sessionTimeoutMinutes: r.session_timeout_minutes,
        sessionMaxConcurrent: r.session_max_concurrent,
        loginMaxFailedAttempts: r.login_max_failed_attempts,
        loginLockoutDurationMinutes: r.login_lockout_duration_minutes,
        auditRetentionDays: r.audit_retention_days,
        auditAutoCleanup: bool(r.audit_auto_cleanup),
        updatedAt: date(r.updated_at),
        updatedBy: r.updated_by,
      },
      create: {
        id: r.id,
        tenantId: r.tenant_id || "default",
        passwordMinLength: r.password_min_length,
        passwordRequireUppercase: bool(r.password_require_uppercase),
        passwordRequireLowercase: bool(r.password_require_lowercase),
        passwordRequireNumbers: bool(r.password_require_numbers),
        passwordRequireSpecial: bool(r.password_require_special),
        sessionTimeoutMinutes: r.session_timeout_minutes,
        sessionMaxConcurrent: r.session_max_concurrent,
        loginMaxFailedAttempts: r.login_max_failed_attempts,
        loginLockoutDurationMinutes: r.login_lockout_duration_minutes,
        auditRetentionDays: r.audit_retention_days,
        auditAutoCleanup: bool(r.audit_auto_cleanup),
        updatedAt: date(r.updated_at),
        updatedBy: r.updated_by,
      },
    })
  }
  return rows.length
}

async function migrateSettings() {
  const rows = rowsOf("SELECT * FROM settings")
  for (const r of rows) {
    await prisma.setting.upsert({
      where: { key_tenantId: { key: r.key, tenantId: r.tenant_id || "default" } },
      update: { value: r.value, updatedAt: date(r.updated_at) },
      create: { key: r.key, tenantId: r.tenant_id || "default", value: r.value, updatedAt: date(r.updated_at) },
    })
  }
  return rows.length
}

async function migrateFavorites() {
  const rows = rowsOf("SELECT * FROM favorites")
  for (const r of rows) {
    await prisma.favorite.upsert({
      where: { id: r.id },
      update: {
        userId: r.user_id,
        vmKey: r.vm_key,
        connectionId: r.connection_id,
        node: r.node,
        vmType: r.vm_type,
        vmid: r.vmid,
        vmName: r.vm_name,
        tenantId: r.tenant_id || "default",
      },
      create: {
        id: r.id,
        tenantId: r.tenant_id || "default",
        userId: r.user_id,
        vmKey: r.vm_key,
        connectionId: r.connection_id,
        node: r.node,
        vmType: r.vm_type,
        vmid: r.vmid,
        vmName: r.vm_name,
        createdAt: date(r.created_at),
      },
    })
  }
  return rows.length
}

// ──────────────────────────────────────────────────────────────────────────
// Prisma-managed tables (existed in SQLite via the archived Prisma migrations).
// Postgres has the empty schema after the baseline; we copy data over here.
// ──────────────────────────────────────────────────────────────────────────

async function migrateConnections() {
  const rows = rowsOf(`SELECT * FROM "Connection"`)
  for (const r of rows) {
    await prisma.connection.upsert({
      where: { id: r.id },
      update: {
        tenantId: r.tenant_id || "default",
        name: r.name,
        type: r.type || "pve",
        subType: r.sub_type,
        vmwareDatacenter: r.vmware_datacenter,
        hypervShareName: r.hyperv_share_name,
        baseUrl: r.baseUrl,
        behindProxy: bool(r.behindProxy),
        insecureTLS: bool(r.insecureTLS),
        hasCeph: bool(r.hasCeph),
        latitude: r.latitude,
        longitude: r.longitude,
        locationLabel: r.locationLabel,
        country: r.country,
        apiTokenEnc: r.apiTokenEnc,
        fingerprint: r.fingerprint,
        tags: r.tags,
        sshEnabled: bool(r.sshEnabled),
        sshPort: r.sshPort ?? 22,
        sshUser: r.sshUser ?? "root",
        sshAuthMethod: r.sshAuthMethod,
        sshKeyEnc: r.sshKeyEnc,
        sshPassEnc: r.sshPassEnc,
        sshUseSudo: bool(r.sshUseSudo),
        updatedAt: date(r.updatedAt),
      },
      create: {
        id: r.id,
        tenantId: r.tenant_id || "default",
        name: r.name,
        type: r.type || "pve",
        subType: r.sub_type,
        vmwareDatacenter: r.vmware_datacenter,
        hypervShareName: r.hyperv_share_name,
        baseUrl: r.baseUrl,
        behindProxy: bool(r.behindProxy),
        insecureTLS: bool(r.insecureTLS),
        hasCeph: bool(r.hasCeph),
        latitude: r.latitude,
        longitude: r.longitude,
        locationLabel: r.locationLabel,
        country: r.country,
        apiTokenEnc: r.apiTokenEnc,
        fingerprint: r.fingerprint,
        tags: r.tags,
        sshEnabled: bool(r.sshEnabled),
        sshPort: r.sshPort ?? 22,
        sshUser: r.sshUser ?? "root",
        sshAuthMethod: r.sshAuthMethod,
        sshKeyEnc: r.sshKeyEnc,
        sshPassEnc: r.sshPassEnc,
        sshUseSudo: bool(r.sshUseSudo),
        createdAt: date(r.createdAt),
        updatedAt: date(r.updatedAt),
      },
    })
  }
  return rows.length
}

async function migrateManagedHosts() {
  const rows = rowsOf(`SELECT * FROM "ManagedHost"`)
  for (const r of rows) {
    await prisma.managedHost.upsert({
      where: { id: r.id },
      update: {
        tenantId: r.tenant_id || "default",
        connectionId: r.connectionId,
        node: r.node,
        ip: r.ip,
        sshAddress: r.sshAddress,
        displayName: r.displayName,
        enabled: bool(r.enabled),
        notes: r.notes,
        description: r.description,
        tags: r.tags,
        updatedAt: date(r.updatedAt),
      },
      create: {
        id: r.id,
        tenantId: r.tenant_id || "default",
        connectionId: r.connectionId,
        node: r.node,
        ip: r.ip,
        sshAddress: r.sshAddress,
        displayName: r.displayName,
        enabled: bool(r.enabled),
        notes: r.notes,
        description: r.description,
        tags: r.tags,
        createdAt: date(r.createdAt),
        updatedAt: date(r.updatedAt),
      },
    })
  }
  return rows.length
}

async function migrateDashboardLayouts() {
  const rows = rowsOf(`SELECT * FROM "DashboardLayout"`)
  for (const r of rows) {
    await prisma.dashboardLayout.upsert({
      where: { id: r.id },
      update: {
        tenantId: r.tenant_id || "default",
        userId: r.userId || "default",
        name: r.name || "custom",
        widgets: json(r.widgets),
        isActive: bool(r.isActive),
        sortOrder: r.sort_order ?? 0,
        updatedAt: date(r.updatedAt),
      },
      create: {
        id: r.id,
        tenantId: r.tenant_id || "default",
        userId: r.userId || "default",
        name: r.name || "custom",
        widgets: json(r.widgets),
        isActive: bool(r.isActive),
        sortOrder: r.sort_order ?? 0,
        createdAt: date(r.createdAt),
        updatedAt: date(r.updatedAt),
      },
    })
  }
  return rows.length
}

async function migrateAlerts() {
  // Source table is `alerts`, target is `frontend_alerts` (renamed by §5.1).
  const rows = rowsOf("SELECT * FROM alerts")
  for (const r of rows) {
    await prisma.alert.upsert({
      where: { id: r.id },
      update: {
        tenantId: r.tenant_id || "default",
        fingerprint: r.fingerprint,
        severity: r.severity,
        message: r.message,
        source: r.source,
        sourceType: r.source_type || "pve",
        entityType: r.entity_type,
        entityId: r.entity_id,
        entityName: r.entity_name,
        metric: r.metric,
        currentValue: r.current_value,
        threshold: r.threshold,
        status: r.status || "active",
        occurrences: r.occurrences ?? 1,
        firstSeenAt: date(r.first_seen_at),
        lastSeenAt: date(r.last_seen_at),
        acknowledgedAt: r.acknowledged_at ? date(r.acknowledged_at) : null,
        acknowledgedBy: r.acknowledged_by,
        resolvedAt: r.resolved_at ? date(r.resolved_at) : null,
        updatedAt: date(r.updated_at),
      },
      create: {
        id: r.id,
        tenantId: r.tenant_id || "default",
        fingerprint: r.fingerprint,
        severity: r.severity,
        message: r.message,
        source: r.source,
        sourceType: r.source_type || "pve",
        entityType: r.entity_type,
        entityId: r.entity_id,
        entityName: r.entity_name,
        metric: r.metric,
        currentValue: r.current_value,
        threshold: r.threshold,
        status: r.status || "active",
        occurrences: r.occurrences ?? 1,
        firstSeenAt: date(r.first_seen_at),
        lastSeenAt: date(r.last_seen_at),
        acknowledgedAt: r.acknowledged_at ? date(r.acknowledged_at) : null,
        acknowledgedBy: r.acknowledged_by,
        resolvedAt: r.resolved_at ? date(r.resolved_at) : null,
        createdAt: date(r.created_at),
        updatedAt: date(r.updated_at),
      },
    })
  }
  return rows.length
}

async function migrateAlertSilences() {
  const rows = rowsOf("SELECT * FROM alert_silences")
  for (const r of rows) {
    await prisma.alertSilence.upsert({
      where: { id: r.id },
      update: {
        tenantId: r.tenant_id || "default",
        fingerprint: r.fingerprint,
        silencedBy: r.silenced_by,
        silencedAt: date(r.silenced_at),
        silencedUntil: r.silenced_until ? date(r.silenced_until) : null,
        reason: r.reason,
      },
      create: {
        id: r.id,
        tenantId: r.tenant_id || "default",
        fingerprint: r.fingerprint,
        silencedBy: r.silenced_by,
        silencedAt: date(r.silenced_at),
        silencedUntil: r.silenced_until ? date(r.silenced_until) : null,
        reason: r.reason,
        createdAt: date(r.created_at),
      },
    })
  }
  return rows.length
}

async function migrateCustomImages() {
  const rows = rowsOf("SELECT * FROM custom_images")
  for (const r of rows) {
    await prisma.customImage.upsert({
      where: { id: r.id },
      update: {
        tenantId: r.tenant_id || "default",
        slug: r.slug,
        name: r.name,
        vendor: r.vendor || "custom",
        version: r.version || "",
        arch: r.arch || "amd64",
        format: r.format || "qcow2",
        sourceType: r.source_type || "url",
        downloadUrl: r.download_url,
        checksumUrl: r.checksum_url,
        volumeId: r.volume_id,
        defaultDiskSize: r.default_disk_size || "20G",
        minMemory: r.min_memory ?? 512,
        recommendedMemory: r.recommended_memory ?? 2048,
        minCores: r.min_cores ?? 1,
        recommendedCores: r.recommended_cores ?? 2,
        ostype: r.ostype || "l26",
        tags: r.tags,
        isShared: bool(r.is_shared),
        createdBy: r.created_by,
        updatedAt: date(r.updated_at),
      },
      create: {
        id: r.id,
        tenantId: r.tenant_id || "default",
        slug: r.slug,
        name: r.name,
        vendor: r.vendor || "custom",
        version: r.version || "",
        arch: r.arch || "amd64",
        format: r.format || "qcow2",
        sourceType: r.source_type || "url",
        downloadUrl: r.download_url,
        checksumUrl: r.checksum_url,
        volumeId: r.volume_id,
        defaultDiskSize: r.default_disk_size || "20G",
        minMemory: r.min_memory ?? 512,
        recommendedMemory: r.recommended_memory ?? 2048,
        minCores: r.min_cores ?? 1,
        recommendedCores: r.recommended_cores ?? 2,
        ostype: r.ostype || "l26",
        tags: r.tags,
        isShared: bool(r.is_shared),
        createdBy: r.created_by,
        createdAt: date(r.created_at),
        updatedAt: date(r.updated_at),
      },
    })
  }
  return rows.length
}

async function migrateBlueprints() {
  const rows = rowsOf("SELECT * FROM blueprints")
  for (const r of rows) {
    await prisma.blueprint.upsert({
      where: { id: r.id },
      update: {
        tenantId: r.tenant_id || "default",
        name: r.name,
        description: r.description,
        imageSlug: r.image_slug,
        hardware: json(r.hardware),
        cloudInit: json(r.cloud_init),
        tags: r.tags,
        isPublic: bool(r.is_public),
        createdBy: r.created_by,
        updatedAt: date(r.updated_at),
      },
      create: {
        id: r.id,
        tenantId: r.tenant_id || "default",
        name: r.name,
        description: r.description,
        imageSlug: r.image_slug,
        hardware: json(r.hardware),
        cloudInit: json(r.cloud_init),
        tags: r.tags,
        isPublic: bool(r.is_public),
        createdBy: r.created_by,
        createdAt: date(r.created_at),
        updatedAt: date(r.updated_at),
      },
    })
  }
  return rows.length
}

async function migrateDeployments() {
  const rows = rowsOf("SELECT * FROM deployments")
  for (const r of rows) {
    await prisma.deployment.upsert({
      where: { id: r.id },
      update: {
        tenantId: r.tenant_id || "default",
        blueprintId: r.blueprint_id,
        blueprintName: r.blueprint_name,
        connectionId: r.connection_id,
        node: r.node,
        vmid: r.vmid,
        vmName: r.vm_name,
        imageSlug: r.image_slug,
        config: json(r.config),
        status: r.status || "pending",
        currentStep: r.current_step,
        error: r.error,
        taskUpid: r.task_upid,
        startedAt: r.started_at ? date(r.started_at) : null,
        completedAt: r.completed_at ? date(r.completed_at) : null,
        updatedAt: date(r.updated_at),
      },
      create: {
        id: r.id,
        tenantId: r.tenant_id || "default",
        blueprintId: r.blueprint_id,
        blueprintName: r.blueprint_name,
        connectionId: r.connection_id,
        node: r.node,
        vmid: r.vmid,
        vmName: r.vm_name,
        imageSlug: r.image_slug,
        config: json(r.config),
        status: r.status || "pending",
        currentStep: r.current_step,
        error: r.error,
        taskUpid: r.task_upid,
        startedAt: r.started_at ? date(r.started_at) : null,
        completedAt: r.completed_at ? date(r.completed_at) : null,
        createdAt: date(r.created_at),
        updatedAt: date(r.updated_at),
      },
    })
  }
  return rows.length
}

async function migrateMigrationJobs() {
  const rows = rowsOf("SELECT * FROM migration_jobs")
  for (const r of rows) {
    await prisma.migrationJob.upsert({
      where: { id: r.id },
      update: {
        tenantId: r.tenant_id || "default",
        sourceConnectionId: r.source_connection_id,
        sourceVmId: r.source_vm_id,
        sourceVmName: r.source_vm_name,
        sourceHost: r.source_host,
        targetConnectionId: r.target_connection_id,
        targetNode: r.target_node,
        targetStorage: r.target_storage,
        targetVmid: r.target_vmid,
        config: json(r.config),
        status: r.status || "pending",
        currentStep: r.current_step,
        progress: r.progress ?? 0,
        totalDisks: r.total_disks,
        currentDisk: r.current_disk,
        bytesTransferred: r.bytes_transferred ? BigInt(r.bytes_transferred) : null,
        totalBytes: r.total_bytes ? BigInt(r.total_bytes) : null,
        transferSpeed: r.transfer_speed,
        error: r.error,
        logs: json(r.logs),
        startedAt: r.started_at ? date(r.started_at) : null,
        completedAt: r.completed_at ? date(r.completed_at) : null,
        createdBy: r.created_by,
        updatedAt: date(r.updated_at),
      },
      create: {
        id: r.id,
        tenantId: r.tenant_id || "default",
        sourceConnectionId: r.source_connection_id,
        sourceVmId: r.source_vm_id,
        sourceVmName: r.source_vm_name,
        sourceHost: r.source_host,
        targetConnectionId: r.target_connection_id,
        targetNode: r.target_node,
        targetStorage: r.target_storage,
        targetVmid: r.target_vmid,
        config: json(r.config),
        status: r.status || "pending",
        currentStep: r.current_step,
        progress: r.progress ?? 0,
        totalDisks: r.total_disks,
        currentDisk: r.current_disk,
        bytesTransferred: r.bytes_transferred ? BigInt(r.bytes_transferred) : null,
        totalBytes: r.total_bytes ? BigInt(r.total_bytes) : null,
        transferSpeed: r.transfer_speed,
        error: r.error,
        logs: json(r.logs),
        startedAt: r.started_at ? date(r.started_at) : null,
        completedAt: r.completed_at ? date(r.completed_at) : null,
        createdBy: r.created_by,
        createdAt: date(r.created_at),
        updatedAt: date(r.updated_at),
      },
    })
  }
  return rows.length
}

// ---------------------------------------------------------------------------
// vDC tables (step 2.3) — order matters: vdcs → child tables → vnets → subnets
// → ipam → pbs namespaces → pbs pve storages
// ---------------------------------------------------------------------------

async function migrateVdcs() {
  const rows = rowsOf("SELECT * FROM vdcs")
  for (const r of rows) {
    const data = {
      tenantId: r.tenant_id || "default",
      connectionId: r.connection_id,
      name: r.name,
      slug: r.slug,
      description: r.description ?? null,
      pvePoolName: r.pve_pool_name,
      enabled: r.enabled === null ? true : bool(r.enabled),
      primaryStorage: r.primary_storage ?? null,
      sdnZoneName: r.sdn_zone_name ?? null,
      createdBy: r.created_by ?? null,
      updatedAt: date(r.updated_at),
    }
    await prisma.vdc.upsert({
      where: { id: r.id },
      update: data,
      create: { id: r.id, ...data, createdAt: date(r.created_at) },
    })
  }
  return rows.length
}

async function migrateVdcNodes() {
  const rows = rowsOf("SELECT * FROM vdc_nodes")
  for (const r of rows) {
    await prisma.vdcNode.upsert({
      where: { id: r.id },
      update: { vdcId: r.vdc_id, nodeName: r.node_name },
      create: { id: r.id, vdcId: r.vdc_id, nodeName: r.node_name },
    })
  }
  return rows.length
}

async function migrateVdcStorages() {
  const rows = rowsOf("SELECT * FROM vdc_storages")
  for (const r of rows) {
    await prisma.vdcStorage.upsert({
      where: { id: r.id },
      update: { vdcId: r.vdc_id, storageId: r.storage_id },
      create: { id: r.id, vdcId: r.vdc_id, storageId: r.storage_id },
    })
  }
  return rows.length
}

async function migrateVdcQuotas() {
  const rows = rowsOf("SELECT * FROM vdc_quotas")
  for (const r of rows) {
    const data = {
      vdcId: r.vdc_id,
      maxVcpus: r.max_vcpus ?? null,
      maxRamMb: r.max_ram_mb ?? null,
      maxStorageMb: r.max_storage_mb ?? null,
      maxVms: r.max_vms ?? null,
      maxSnapshots: r.max_snapshots ?? null,
      maxBackups: r.max_backups ?? null,
      maxVnets: r.max_vnets ?? null,
      updatedAt: date(r.updated_at),
    }
    await prisma.vdcQuota.upsert({
      where: { id: r.id },
      update: data,
      create: { id: r.id, ...data },
    })
  }
  return rows.length
}

async function migrateVdcUsageCache() {
  const rows = rowsOf("SELECT * FROM vdc_usage_cache")
  for (const r of rows) {
    const data = {
      vdcId: r.vdc_id,
      usedVcpus: r.used_vcpus ?? 0,
      usedRamMb: r.used_ram_mb ?? 0,
      usedStorageMb: r.used_storage_mb ?? 0,
      usedVms: r.used_vms ?? 0,
      usedSnapshots: r.used_snapshots ?? 0,
      usedBackups: r.used_backups ?? 0,
      lastSyncedAt: r.last_synced_at ? date(r.last_synced_at) : null,
    }
    await prisma.vdcUsageCache.upsert({
      where: { id: r.id },
      update: data,
      create: { id: r.id, ...data },
    })
  }
  return rows.length
}

async function migrateVdcSharedBridges() {
  const rows = rowsOf("SELECT * FROM vdc_shared_bridges")
  for (const r of rows) {
    const data = {
      vdcId: r.vdc_id,
      bridge: r.bridge,
      label: r.label ?? null,
    }
    await prisma.vdcSharedBridge.upsert({
      where: { id: r.id },
      update: data,
      create: { id: r.id, ...data, createdAt: date(r.created_at) },
    })
  }
  return rows.length
}

async function migrateVdcVnets() {
  const rows = rowsOf("SELECT * FROM vdc_vnets")
  for (const r of rows) {
    const data = {
      vdcId: r.vdc_id,
      pveName: r.pve_name,
      displayName: r.display_name ?? null,
      description: r.description ?? null,
      vxlanTag: r.vxlan_tag,
      firewall: r.firewall === null ? true : bool(r.firewall),
      createdBy: r.created_by ?? null,
    }
    await prisma.vdcVnet.upsert({
      where: { id: r.id },
      update: data,
      create: { id: r.id, ...data, createdAt: date(r.created_at) },
    })
  }
  return rows.length
}

async function migrateVdcSubnets() {
  const rows = rowsOf("SELECT * FROM vdc_subnets")
  for (const r of rows) {
    const data = {
      vnetId: r.vnet_id,
      cidr: r.cidr,
      gateway: r.gateway,
      dnsServers: r.dns_servers ?? null,
      ipamEnabled: r.ipam_enabled === null ? true : bool(r.ipam_enabled),
    }
    await prisma.vdcSubnet.upsert({
      where: { id: r.id },
      update: data,
      create: { id: r.id, ...data, createdAt: date(r.created_at) },
    })
  }
  return rows.length
}

async function migrateVdcIpamAllocations() {
  const rows = rowsOf("SELECT * FROM vdc_ipam_allocations")
  for (const r of rows) {
    // ip_int is BigInt on Postgres; SQLite returns a plain number (or possibly a
    // bigint via better-sqlite3 if integer-pragmatic mode is on). Coerce.
    const ipInt = typeof r.ip_int === "bigint" ? r.ip_int : BigInt(r.ip_int ?? 0)
    const data = {
      vdcId: r.vdc_id,
      subnetId: r.subnet_id,
      vnetId: r.vnet_id,
      connectionId: r.connection_id,
      ip: r.ip,
      ipInt,
      mac: r.mac,
      vmid: r.vmid ?? null,
      hostname: r.hostname ?? null,
    }
    await prisma.vdcIpamAllocation.upsert({
      where: { id: r.id },
      update: data,
      create: { id: r.id, ...data, createdAt: date(r.created_at) },
    })
  }
  return rows.length
}

async function migrateVdcPbsNamespaces() {
  const rows = rowsOf("SELECT * FROM vdc_pbs_namespaces")
  for (const r of rows) {
    const data = {
      vdcId: r.vdc_id,
      pbsConnectionId: r.pbs_connection_id,
      datastore: r.datastore,
      namespace: r.namespace,
      mode: r.mode || "auto",
      pbsTokenId: r.pbs_token_id ?? null,
      pbsTokenSecret: r.pbs_token_secret ?? null,
    }
    await prisma.vdcPbsNamespace.upsert({
      where: { id: r.id },
      update: data,
      create: { id: r.id, ...data, createdAt: date(r.created_at) },
    })
  }
  return rows.length
}

async function migrateVdcPbsPveStorages() {
  const rows = rowsOf("SELECT * FROM vdc_pbs_pve_storages")
  for (const r of rows) {
    const data = {
      vdcPbsNamespaceId: r.vdc_pbs_namespace_id,
      pveConnectionId: r.pve_connection_id,
      pveStorageName: r.pve_storage_name,
      managed: r.managed === null ? true : bool(r.managed),
    }
    await prisma.vdcPbsPveStorage.upsert({
      where: { id: r.id },
      update: data,
      create: { id: r.id, ...data, createdAt: date(r.created_at) },
    })
  }
  return rows.length
}

// ---------------------------------------------------------------------------
// Step 2.4 — favorites + alerts + datacenters + green-config + health-score +
// compliance. Order matters because of FKs (datacenter_id, profile_id, rule_id).
// ---------------------------------------------------------------------------

async function migrateAlertRules() {
  const rows = rowsOf("SELECT * FROM alert_rules")
  for (const r of rows) {
    const data = {
      tenantId: r.tenant_id || "default",
      name: r.name,
      description: r.description ?? null,
      enabled: r.enabled === null ? true : bool(r.enabled),
      metric: r.metric,
      operator: r.operator,
      threshold: Number(r.threshold ?? 0),
      duration: r.duration ?? 0,
      severity: r.severity || "warning",
      scopeType: r.scope_type || "all",
      scopeTarget: r.scope_target ?? null,
      updatedAt: date(r.updated_at),
    }
    await prisma.alertRule.upsert({
      where: { id: r.id },
      update: data,
      create: { id: r.id, ...data, createdAt: date(r.created_at) },
    })
  }
  return rows.length
}

async function migrateAlertInstances() {
  const rows = rowsOf("SELECT * FROM alert_instances")
  for (const r of rows) {
    const data = {
      tenantId: r.tenant_id || "default",
      ruleId: r.rule_id,
      status: r.status || "active",
      entityType: r.entity_type,
      entityId: r.entity_id,
      entityName: r.entity_name ?? null,
      node: r.node ?? null,
      connectionId: r.connection_id ?? null,
      connectionName: r.connection_name ?? null,
      metric: r.metric,
      currentValue: r.current_value === null || r.current_value === undefined ? null : Number(r.current_value),
      threshold: Number(r.threshold ?? 0),
      severity: r.severity,
      message: r.message,
      triggeredAt: date(r.triggered_at),
      resolvedAt: r.resolved_at ? date(r.resolved_at) : null,
      acknowledgedAt: r.acknowledged_at ? date(r.acknowledged_at) : null,
      acknowledgedBy: r.acknowledged_by ?? null,
    }
    await prisma.alertInstance.upsert({
      where: { id: r.id },
      update: data,
      create: { id: r.id, ...data },
    })
  }
  return rows.length
}

async function migrateAlertRuleOwners() {
  const rows = rowsOf("SELECT * FROM alert_rule_owners")
  for (const r of rows) {
    const data = {
      tenantId: r.tenant_id || "default",
    }
    await prisma.alertRuleOwner.upsert({
      where: { ruleId: r.rule_id },
      update: data,
      create: { ruleId: r.rule_id, ...data, createdAt: date(r.created_at) },
    })
  }
  return rows.length
}

async function migrateDatacenters() {
  const rows = rowsOf("SELECT * FROM datacenters")
  for (const r of rows) {
    const data = {
      tenantId: r.tenant_id || "default",
      name: r.name,
      locationLabel: r.location_label ?? null,
      country: r.country ?? null,
      latitude: r.latitude === null || r.latitude === undefined ? null : Number(r.latitude),
      longitude: r.longitude === null || r.longitude === undefined ? null : Number(r.longitude),
      pue: Number(r.pue ?? 1.4),
      electricityPrice: Number(r.electricity_price ?? 0.18),
      currency: r.currency || "EUR",
      co2Factor: Number(r.co2_factor ?? 0.052),
      co2CountryPreset: r.co2_country_preset ?? null,
      tdpPerCoreW: Number(r.tdp_per_core_w ?? 10),
      wattsPerGbRam: Number(r.watts_per_gb_ram ?? 0.375),
      overheadPerNodeW: Number(r.overhead_per_node_w ?? 50),
      comment: r.comment ?? null,
      isDefault: bool(r.is_default),
      updatedAt: date(r.updated_at),
    }
    await prisma.datacenter.upsert({
      where: { id: r.id },
      update: data,
      create: { id: r.id, ...data, createdAt: date(r.created_at) },
    })
  }
  return rows.length
}

async function migrateConnectionGreenConfig() {
  const rows = rowsOf("SELECT * FROM connection_green_config")
  for (const r of rows) {
    const data = {
      datacenterId: r.datacenter_id ?? null,
      tdpPerCoreW: r.tdp_per_core_w === null || r.tdp_per_core_w === undefined ? null : Number(r.tdp_per_core_w),
      wattsPerGbRam: r.watts_per_gb_ram === null || r.watts_per_gb_ram === undefined ? null : Number(r.watts_per_gb_ram),
      overheadPerNodeW: r.overhead_per_node_w === null || r.overhead_per_node_w === undefined ? null : Number(r.overhead_per_node_w),
      updatedAt: date(r.updated_at),
    }
    await prisma.connectionGreenConfig.upsert({
      where: { connectionId: r.connection_id },
      update: data,
      create: { connectionId: r.connection_id, ...data },
    })
  }
  return rows.length
}

async function migrateNodeGreenConfig() {
  const rows = rowsOf("SELECT * FROM node_green_config")
  for (const r of rows) {
    const data = {
      datacenterId: r.datacenter_id ?? null,
      tdpPerCoreW: r.tdp_per_core_w === null || r.tdp_per_core_w === undefined ? null : Number(r.tdp_per_core_w),
      wattsPerGbRam: r.watts_per_gb_ram === null || r.watts_per_gb_ram === undefined ? null : Number(r.watts_per_gb_ram),
      overheadPerNodeW: r.overhead_per_node_w === null || r.overhead_per_node_w === undefined ? null : Number(r.overhead_per_node_w),
      updatedAt: date(r.updated_at),
    }
    await prisma.nodeGreenConfig.upsert({
      where: { connectionId_nodeName: { connectionId: r.connection_id, nodeName: r.node_name } },
      update: data,
      create: { connectionId: r.connection_id, nodeName: r.node_name, ...data },
    })
  }
  return rows.length
}

async function migrateHealthScoreHistory() {
  const rows = rowsOf("SELECT * FROM health_score_history")
  for (const r of rows) {
    const data = {
      tenantId: r.tenant_id || "default",
      date: r.date,
      score: r.score,
      cpuPct: r.cpu_pct === null || r.cpu_pct === undefined ? null : Number(r.cpu_pct),
      ramPct: r.ram_pct === null || r.ram_pct === undefined ? null : Number(r.ram_pct),
      storagePct: r.storage_pct === null || r.storage_pct === undefined ? null : Number(r.storage_pct),
      details: json(r.details),
      connectionId: r.connection_id ?? null,
    }
    await prisma.healthScoreHistory.upsert({
      where: { id: r.id },
      update: data,
      create: { id: r.id, ...data, createdAt: date(r.created_at) },
    })
  }
  return rows.length
}

async function migrateComplianceProfiles() {
  const rows = rowsOf("SELECT * FROM compliance_profiles")
  for (const r of rows) {
    const data = {
      tenantId: r.tenant_id || "default",
      name: r.name,
      description: r.description ?? null,
      frameworkId: r.framework_id ?? null,
      isActive: bool(r.is_active),
      connectionId: r.connection_id ?? null,
      createdBy: r.created_by ?? null,
      updatedAt: date(r.updated_at),
    }
    await prisma.complianceProfile.upsert({
      where: { id: r.id },
      update: data,
      create: { id: r.id, ...data, createdAt: date(r.created_at) },
    })
  }
  return rows.length
}

async function migrateComplianceProfileChecks() {
  const rows = rowsOf("SELECT * FROM compliance_profile_checks")
  for (const r of rows) {
    const data = {
      tenantId: r.tenant_id || "default",
      profileId: r.profile_id,
      checkId: r.check_id,
      enabled: r.enabled === null ? true : bool(r.enabled),
      weight: Number(r.weight ?? 1.0),
      controlRef: r.control_ref ?? null,
      category: r.category ?? null,
    }
    await prisma.complianceProfileCheck.upsert({
      where: { id: r.id },
      update: data,
      create: { id: r.id, ...data },
    })
  }
  return rows.length
}

async function main() {
  console.log("[migrate-from-sqlite] starting…")
  console.log(`[migrate-from-sqlite]   sqlite: ${sqlitePath}`)
  console.log(`[migrate-from-sqlite]   target: ${databaseUrl.replace(/\/\/[^@]+@/, "//***@")}`)

  const counts: Record<string, number> = {}

  // Prisma-managed tables first: they hold no FK to tenants/users so order
  // doesn't matter, but doing them up front means the rest of the script
  // exits cleanly even if a later table fails (data the user cares about
  // most — connections / deployments — is already across).
  counts.Connection = await migrateConnections()
  counts.ManagedHost = await migrateManagedHosts()
  counts.DashboardLayout = await migrateDashboardLayouts()
  counts.frontend_alerts = await migrateAlerts()
  counts.alert_silences = await migrateAlertSilences()
  counts.custom_images = await migrateCustomImages()
  counts.blueprints = await migrateBlueprints()
  counts.deployments = await migrateDeployments()
  counts.migration_jobs = await migrateMigrationJobs()

  counts.tenants = await migrateTenants()
  counts.users = await migrateUsers()
  counts.user_tenants = await migrateUserTenants()
  counts.rbac_permissions = await migrateRbacPermissions()
  counts.rbac_roles = await migrateRbacRoles()
  counts.rbac_role_permissions = await migrateRbacRolePermissions()
  counts.rbac_user_roles = await migrateRbacUserRoles()
  counts.rbac_user_permissions = await migrateRbacUserPermissions()
  counts.ldap_config = await migrateLdapConfig()
  counts.oidc_config = await migrateOidcConfig()
  counts.security_policies = await migrateSecurityPolicies()
  counts.settings = await migrateSettings()
  counts.favorites = await migrateFavorites()

  // vDC tables (step 2.3): order matters because of FKs.
  counts.vdcs = await migrateVdcs()
  counts.vdc_nodes = await migrateVdcNodes()
  counts.vdc_storages = await migrateVdcStorages()
  counts.vdc_quotas = await migrateVdcQuotas()
  counts.vdc_usage_cache = await migrateVdcUsageCache()
  counts.vdc_shared_bridges = await migrateVdcSharedBridges()
  counts.vdc_vnets = await migrateVdcVnets()
  counts.vdc_subnets = await migrateVdcSubnets()
  counts.vdc_ipam_allocations = await migrateVdcIpamAllocations()
  counts.vdc_pbs_namespaces = await migrateVdcPbsNamespaces()
  counts.vdc_pbs_pve_storages = await migrateVdcPbsPveStorages()

  // Step 2.4 — favorites already done above (line ~956). The rest:
  counts.alert_rules = await migrateAlertRules()
  counts.alert_instances = await migrateAlertInstances()
  counts.alert_rule_owners = await migrateAlertRuleOwners()
  counts.datacenters = await migrateDatacenters()
  counts.connection_green_config = await migrateConnectionGreenConfig()
  counts.node_green_config = await migrateNodeGreenConfig()
  counts.health_score_history = await migrateHealthScoreHistory()
  counts.compliance_profiles = await migrateComplianceProfiles()
  counts.compliance_profile_checks = await migrateComplianceProfileChecks()

  console.log("[migrate-from-sqlite] done. Rows copied:")
  for (const [table, count] of Object.entries(counts)) {
    console.log(`  ${table.padEnd(24)} ${count}`)
  }
}

main()
  .catch(e => {
    console.error("[migrate-from-sqlite] failed:", e)
    process.exit(1)
  })
  .finally(async () => {
    sqlite.close()
    await prisma.$disconnect()
  })
