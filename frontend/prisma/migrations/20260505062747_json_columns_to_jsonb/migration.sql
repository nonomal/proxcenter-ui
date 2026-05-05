-- Step 2.5: flip 6 JSON-as-TEXT columns to native JSONB.
--
-- Existing rows already hold valid JSON strings (the application layer
-- stringified before writing). USING column::jsonb casts them in place
-- without losing data. NULL values pass through untouched.
--
-- Once this lands the application layer must stop calling JSON.parse on
-- reads and JSON.stringify on writes — Prisma now returns/accepts the
-- parsed object directly.

ALTER TABLE "blueprints"
  ALTER COLUMN "hardware" TYPE JSONB USING "hardware"::jsonb;

ALTER TABLE "blueprints"
  ALTER COLUMN "cloud_init" TYPE JSONB USING "cloud_init"::jsonb;

ALTER TABLE "deployments"
  ALTER COLUMN "config" TYPE JSONB USING "config"::jsonb;

ALTER TABLE "migration_jobs"
  ALTER COLUMN "config" TYPE JSONB USING "config"::jsonb;

ALTER TABLE "migration_jobs"
  ALTER COLUMN "logs" TYPE JSONB USING "logs"::jsonb;

ALTER TABLE "DashboardLayout"
  ALTER COLUMN "widgets" TYPE JSONB USING "widgets"::jsonb;
