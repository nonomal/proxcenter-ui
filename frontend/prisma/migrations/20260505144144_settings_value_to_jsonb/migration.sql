-- Step 4 cleanup: flip settings.value TEXT → JSONB.
--
-- Every existing row was written via lib/db/settings.ts:setSetting which
-- always JSON.stringify'd the payload, so USING value::jsonb casts cleanly.
-- Application layer stops parsing/stringifying — Prisma returns the parsed
-- object directly via the Json type.

ALTER TABLE "settings"
  ALTER COLUMN "value" TYPE JSONB USING "value"::jsonb;
