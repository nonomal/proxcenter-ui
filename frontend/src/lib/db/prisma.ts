import { PrismaClient } from "@prisma/client"
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3"
import { PrismaPg } from "@prisma/adapter-pg"

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient }

function getDatabaseUrl() {
  // Default to local path for build time, overridden at runtime by env var
  return process.env.DATABASE_URL || "file:./data/proxcenter.db"
}

/**
 * Pick the driver adapter based on the DATABASE_URL scheme. During the
 * SQLite → Postgres migration the codebase ships with both providers wired
 * up so a developer can run against either backend by flipping the env var,
 * with no code changes. Once the migration is complete and the boot-time
 * payload in lib/db/sqlite.ts is removed, the SQLite branch can go too.
 */
function buildAdapter(url: string) {
  if (url.startsWith("postgres://") || url.startsWith("postgresql://")) {
    return new PrismaPg({ connectionString: url })
  }
  // file:./..., file:/abs/path, or anything we don't recognise → SQLite path.
  return new PrismaBetterSqlite3({ url })
}

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    adapter: buildAdapter(getDatabaseUrl()),
    log: ["error", "warn"],
  })

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma
}
