import "server-only";
/**
 * Prisma client singleton.
 * Prevents multiple client instances in development (hot-reload).
 *
 * @module lib/db/prisma
 * @security Server-only — never import in client components.
 */
import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: [], // Avoid credential-bearing query inputs in ORM diagnostics.
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
