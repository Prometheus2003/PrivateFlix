import { prisma } from "@/lib/db/prisma";
import { getEnv } from "@/lib/validation/env";
import { authError } from "./http";
// Global scopes prevent forwarded-header spoofing and unbounded key growth.
// Reserve before hashing; PostgreSQL serializes workers and persists limits.
export async function consumeAuthAttempt(
  scope: "login" | "setup" | "password" | "revoke",
) {
  const { RATE_LIMIT_WINDOW, RATE_LIMIT_MAX } = getEnv();
  const retry = await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(7253402)");
    const now = new Date();
    const old = await tx.authThrottle.findUnique({ where: { scope } });
    if (old && old.expiresAt > now && old.attempts >= RATE_LIMIT_MAX) {
      return Math.max(
        1,
        Math.ceil((old.expiresAt.getTime() - now.getTime()) / 1000),
      );
    }
    if (!old || old.expiresAt <= now) {
      const data = {
        attempts: 1,
        expiresAt: new Date(now.getTime() + RATE_LIMIT_WINDOW * 1000),
      };
      await tx.authThrottle.upsert({
        where: { scope },
        create: { scope, ...data },
        update: data,
      });
    } else {
      await tx.authThrottle.update({
        where: { scope },
        data: { attempts: { increment: 1 } },
      });
    }
    return 0;
  });
  if (retry)
    throw authError(429, "Too many attempts. Please try again later.", {
      "Retry-After": String(retry),
    });
}
