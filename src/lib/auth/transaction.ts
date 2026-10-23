import { prisma } from "@/lib/db/prisma";
import type { Prisma } from "@prisma/client";

// Shared lock serializes credential/session mutations across server processes.
export function authTransaction<T>(
  operation: (tx: Prisma.TransactionClient) => Promise<T>,
) {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(7253401)`;
      return operation(tx);
    },
    { maxWait: 10000, timeout: 20000 },
  );
}
