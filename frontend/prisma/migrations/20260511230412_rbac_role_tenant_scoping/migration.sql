-- Add tenant scoping to custom RBAC roles. System roles stay global (null tenant_id).
ALTER TABLE "rbac_roles" ADD COLUMN "tenant_id" TEXT;

-- Backfill: existing custom roles were implicitly created from the provider
-- tenant before this change. Assign them to 'default' so they keep the same
-- visibility scope as the tenant they were created from.
UPDATE "rbac_roles" SET "tenant_id" = 'default' WHERE "is_system" = false;

-- Drop the global unique constraint on name; custom roles can now share names
-- across tenants. The new compound unique enforces uniqueness within a tenant.
ALTER TABLE "rbac_roles" DROP CONSTRAINT IF EXISTS "rbac_roles_name_key";

CREATE UNIQUE INDEX "rbac_roles_tenant_id_name_key" ON "rbac_roles"("tenant_id", "name");
CREATE INDEX "rbac_roles_tenant_id_idx" ON "rbac_roles"("tenant_id");
