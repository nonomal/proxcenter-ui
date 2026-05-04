// src/lib/db/settings.ts
//
// Tenant-scoped key/value settings store. Replaces ~20 raw-SQL callsites that
// repeated the same `SELECT value FROM settings WHERE key=? AND tenant_id=?`
// + INSERT-OR-REPLACE shape. Centralising avoids subtle divergence (some
// callers used `INSERT OR REPLACE`, others `INSERT ... ON CONFLICT`, others
// did UPDATE-then-INSERT-on-zero-rows).
//
// Storage convention: every value is JSON-encoded TEXT in the column. The
// Prisma model still types `value` as String (not Json) so the existing
// payload format on disk doesn't change during the SQLite → Postgres cutover;
// callers continue to receive parsed objects through this helper. A later
// cleanup can promote `value` to Json/JSONB once every callsite has been
// audited, but it's out of scope for the migration sprint.

import { prisma } from "@/lib/db/prisma"

const DEFAULT_TENANT = "default"

/**
 * Read a tenant-scoped setting. Falls back to the global default tenant when
 * the requested tenant has no override, mirroring the legacy behaviour the
 * security-policies and branding code used. Returns `null` when neither row
 * exists, so callers can `?? defaultValue` cleanly.
 *
 * `T` is the parsed JSON shape the caller expects. We don't validate it —
 * trust the writer; if the schema changed and a stale row is left over, the
 * caller is responsible for guarding their downstream consumption.
 */
export async function getSetting<T = unknown>(
  key: string,
  tenantId: string = DEFAULT_TENANT,
): Promise<T | null> {
  // Try the tenant-scoped row first.
  let row = await prisma.setting.findUnique({
    where: { key_tenantId: { key, tenantId } },
  })
  // Fall back to the default-tenant row when the caller is in a sub-tenant
  // that hasn't customised this key. Skipped when we're already in 'default'
  // so we don't double-query for the same primary key.
  if (!row && tenantId !== DEFAULT_TENANT) {
    row = await prisma.setting.findUnique({
      where: { key_tenantId: { key, tenantId: DEFAULT_TENANT } },
    })
  }
  if (!row) return null
  return parseValue<T>(row.value)
}

/**
 * Read a tenant-scoped setting with the raw on-disk string instead of the
 * parsed JSON. Useful for the small number of legacy callsites that ship the
 * value as-is back to the frontend (which then parses client-side). Same
 * fallback rules as getSetting.
 */
export async function getSettingRaw(
  key: string,
  tenantId: string = DEFAULT_TENANT,
): Promise<string | null> {
  let row = await prisma.setting.findUnique({
    where: { key_tenantId: { key, tenantId } },
  })
  if (!row && tenantId !== DEFAULT_TENANT) {
    row = await prisma.setting.findUnique({
      where: { key_tenantId: { key, tenantId: DEFAULT_TENANT } },
    })
  }
  return row?.value ?? null
}

/**
 * Upsert a tenant-scoped setting. The value is JSON.stringified before being
 * stored so callers pass plain JS objects/arrays/primitives. Strings are
 * stored as JSON-encoded strings (e.g. `"hello"` not `hello`) — symmetric
 * with getSetting/JSON.parse.
 */
export async function setSetting(
  key: string,
  tenantId: string,
  value: unknown,
): Promise<void> {
  const serialised = JSON.stringify(value ?? null)
  await prisma.setting.upsert({
    where: { key_tenantId: { key, tenantId } },
    update: { value: serialised, updatedAt: new Date() },
    create: { key, tenantId, value: serialised },
  })
}

/**
 * Like setSetting but accepts a pre-serialised string. Use when the caller
 * already has a JSON string in hand (e.g. forwarded from a request body)
 * and would otherwise stringify-then-parse-then-stringify needlessly.
 * Verifies the input is valid JSON to fail fast on bad data.
 */
export async function setSettingRaw(
  key: string,
  tenantId: string,
  jsonString: string,
): Promise<void> {
  // Validate the string is real JSON before persisting; cheap insurance
  // against silently corrupting future reads.
  try {
    JSON.parse(jsonString)
  } catch {
    throw new Error(`setSettingRaw: invalid JSON for key=${key}`)
  }
  await prisma.setting.upsert({
    where: { key_tenantId: { key, tenantId } },
    update: { value: jsonString, updatedAt: new Date() },
    create: { key, tenantId, value: jsonString },
  })
}

function parseValue<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T
  } catch {
    // Legacy rows may hold a raw (non-JSON) string. Surface it as-is so we
    // don't break callers that pre-date the JSON convention. New writes go
    // through setSetting which always stringifies.
    return (value as unknown) as T
  }
}
