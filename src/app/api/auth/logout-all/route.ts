import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/auth/require-auth";
import { revokeAllSessions, clearSessionCookie } from "@/lib/auth/session";
import { verifyPassword } from "@/lib/auth/password";
import {
  assertSameOrigin,
  readAuthBody,
  authError,
  authFailure,
} from "@/lib/auth/http";
import { consumeAuthAttempt } from "@/lib/auth/rate-limiter";
import { authTransaction } from "@/lib/auth/transaction";

export async function POST(request: NextRequest) {
  try {
    const { user, session } = await requireAuth(request);
    assertSameOrigin(request);
    await consumeAuthAttempt("revoke");
    const parsed = z
      .object({ currentPassword: z.string().min(1).max(128) })
      .safeParse(await readAuthBody(request));
    if (!parsed.success) throw authError(400, "Current password required");
    const revokedCount = await authTransaction(async (tx) => {
      const owner = await tx.user.findUnique({ where: { id: user.id } });
      const active = await tx.session.findFirst({
        where: {
          id: session.id,
          revokedAt: null,
          expiresAt: { gt: new Date() },
        },
      });
      if (
        !active ||
        !owner ||
        !(await verifyPassword(owner.passwordHash, parsed.data.currentPassword))
      )
        throw authError(401, "Invalid credentials");
      const count = await revokeAllSessions(user.id, tx);
      await tx.auditEvent.create({
        data: {
          userId: user.id,
          action: "logout_all",
          details: { revokedCount: count },
        },
      });
      return count;
    });
    await clearSessionCookie();
    return NextResponse.json(
      { message: "All sessions revoked", revokedCount },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return authFailure(error);
  }
}
