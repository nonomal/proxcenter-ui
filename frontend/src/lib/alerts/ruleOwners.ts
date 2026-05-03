/**
 * Tracks which tenant authored each orchestrator alert rule.
 *
 * The Go orchestrator stores rules with no tenant_id. Without this map a
 * vDC-tenant rule would be visible to (and trigger alerts for) the
 * provider, leaking tenant policy and spamming the wrong dashboard.
 *
 * Rows live in `alert_rule_owners(rule_id, tenant_id)`. Migration of pre-
 * existing rules is implicit: any rule that has no row here is treated as
 * provider-owned (back-compat for setups that ran before this table).
 */

import { getDb } from "@/lib/db/sqlite"
import { DEFAULT_TENANT_ID } from "@/lib/tenant"

export function setRuleOwner(ruleId: string, tenantId: string): void {
  const db = getDb()
  db.prepare(
    `INSERT INTO alert_rule_owners (rule_id, tenant_id)
     VALUES (?, ?)
     ON CONFLICT(rule_id) DO UPDATE SET tenant_id = excluded.tenant_id`
  ).run(ruleId, tenantId)
}

export function deleteRuleOwner(ruleId: string): void {
  const db = getDb()
  db.prepare(`DELETE FROM alert_rule_owners WHERE rule_id = ?`).run(ruleId)
}

export function getRuleOwner(ruleId: string): string | null {
  const db = getDb()
  const row = db.prepare(
    `SELECT tenant_id FROM alert_rule_owners WHERE rule_id = ?`
  ).get(ruleId) as { tenant_id: string } | undefined
  return row?.tenant_id ?? null
}

/**
 * Decide whether a rule (by id) is visible to the given tenant.
 *
 * - vDC tenants only see rules they authored (must have a row here with
 *   matching tenant_id).
 * - Provider tenant sees rules it authored AND rules with no row (legacy
 *   pre-migration entries that we treat as provider-owned by default).
 */
export function ruleVisibleToTenant(ruleId: string, tenantId: string): boolean {
  const owner = getRuleOwner(ruleId)
  if (owner === null) return tenantId === DEFAULT_TENANT_ID
  return owner === tenantId
}
