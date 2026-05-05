/**
 * Prisma client used by tests, plus a `truncate(...)` helper.
 *
 * Reads the DSN written by globalSetup (../setup/postgres.ts) so each test
 * worker connects to the per-run schema. Importing this module from any
 * test file is enough to share a single Prisma connection.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'

import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'

const DSN_FILE = path.resolve(__dirname, '..', '..', '..', '.test-dsn')

function readDsn(): string {
  try {
    const dsn = readFileSync(DSN_FILE, 'utf8').trim()
    if (!dsn) throw new Error('empty DSN')
    return dsn
  } catch (err) {
    throw new Error(
      '[test/setup/prisma-test] Could not read the test DSN at ' + DSN_FILE + '. ' +
      'Run vitest with the `globalSetup` configured (vitest.config.ts) — it writes ' +
      'this file before any test starts. Underlying error: ' + (err as Error).message,
    )
  }
}

const dsn = readDsn()

export const prismaTest = new PrismaClient({
  adapter: new PrismaPg({ connectionString: dsn }),
})

/**
 * TRUNCATE a list of tables, restarting their identity sequences and
 * cascading FK constraints. Use in a `beforeEach` to give each test a
 * clean slate without paying the cost of re-applying migrations.
 *
 * Example:
 *   beforeEach(() => truncate(['vdc_ipam_allocations', 'vdc_subnets', 'vdc_vnets', 'vdcs']))
 */
export async function truncate(tables: string[]): Promise<void> {
  if (tables.length === 0) return
  const list = tables.map((t) => `"${t}"`).join(', ')
  await prismaTest.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`)
}
