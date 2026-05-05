import { PrismaClient } from "@prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient }

function getDatabaseUrl() {
  const url = process.env.DATABASE_URL
  if (!url) {
    // Build-time placeholder. The runtime instance gets the real URL from env.
    // An empty / unset URL would have crashed PrismaPg with a confusing
    // libpq parse error, so surface a clearer build-time fallback.
    return "postgres://placeholder@localhost:5432/placeholder?sslmode=disable"
  }
  return url
}

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    adapter: new PrismaPg({ connectionString: getDatabaseUrl() }),
    log: ["error", "warn"],
  })

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma
}
