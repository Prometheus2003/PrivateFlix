import { NextRequest, NextResponse } from "next/server";
import { requireAuth, getSafeUserAgent } from "@/lib/auth/require-auth";
import {
  hashPassword,
  verifyPassword,
  validatePasswordStrength,
} from "@/lib/auth/password";
import {
  revokeAllSessions,
  createSession,
  setSessionCookie,
} from "@/lib/auth/session";
import { changePasswordSchema } from "@/lib/validation/schemas";
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
    await consumeAuthAttempt("password");
    const parsed = changePasswordSchema.safeParse(await readAuthBody(request));
    if (!parsed.success) throw authError(400, "Invalid password details");
    const { currentPassword, newPassword } = parsed.data;
    const strengthError = validatePasswordStrength(newPassword);
    if (strengthError) throw authError(400, strengthError);
    const result = await authTransaction(async (tx) => {
      const active = await tx.session.findFirst({
        where: {
          id: session.id,
          userId: user.id,
          revokedAt: null,
          expiresAt: { gt: new Date() },
        },
      });
      const owner = await tx.user.findUnique({ where: { id: user.id } });
      if (
        !active ||
        !owner ||
        !(await verifyPassword(owner.passwordHash, currentPassword))
      )
        throw authError(401, "Invalid credentials");
      await tx.user.update({
        where: { id: user.id },
        data: {
          passwordHash: await hashPassword(newPassword),
          passwordChangedAt: new Date(),
        },
      });
      await revokeAllSessions(user.id, tx);
      const replacement = await createSession(
        { userId: user.id, userAgent: getSafeUserAgent(request) },
        tx,
      );
      await tx.auditEvent.create({
        data: { userId: user.id, action: "password_changed" },
      });
      return replacement;
    });
    await setSessionCookie(result.rawToken);
    return NextResponse.json(
      { message: "Password changed successfully" },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return authFailure(error);
  }
}
