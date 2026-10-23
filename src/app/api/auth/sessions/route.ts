import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { getActiveSessions, clearSessionCookie } from "@/lib/auth/session";
import { verifyPassword } from "@/lib/auth/password";
import {
  assertSameOrigin,
  readAuthBody,
  authError,
  authFailure,
} from "@/lib/auth/http";
import { consumeAuthAttempt } from "@/lib/auth/rate-limiter";
import { authTransaction } from "@/lib/auth/transaction";
import { z } from "zod";
export async function GET(request: NextRequest) {
  try {
    const { user, session } = await requireAuth(request);
    const sessions = await getActiveSessions(user.id);
    return NextResponse.json(
      {
        sessions: sessions.map((s) => ({ ...s, current: s.id === session.id })),
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return authFailure(error);
  }
}
export async function DELETE(request: NextRequest) {
  try {
    const { user, session } = await requireAuth(request);
    assertSameOrigin(request);
    await consumeAuthAttempt("revoke");
    const parsed = z
      .object({
        sessionId: z.string().uuid(),
        currentPassword: z.string().min(1).max(128),
      })
      .safeParse(await readAuthBody(request));
    if (!parsed.success) throw authError(400, "Invalid session details");
    await authTransaction(async (tx) => {
      const owner = await tx.user.findUnique({ where: { id: user.id } });
      const current = await tx.session.findFirst({
        where: {
          id: session.id,
          userId: user.id,
          revokedAt: null,
          expiresAt: { gt: new Date() },
        },
      });
      if (
        !current ||
        !owner ||
        !(await verifyPassword(owner.passwordHash, parsed.data.currentPassword))
      )
        throw authError(401, "Invalid credentials");
      const target = await tx.session.findFirst({
        where: { id: parsed.data.sessionId, userId: user.id },
      });
      if (!target) throw authError(404, "Session not found");
      await tx.session.update({
        where: { id: target.id },
        data: { revokedAt: new Date() },
      });
      await tx.auditEvent.create({
        data: {
          userId: user.id,
          action: "session_revoked",
          resourceType: "session",
          resourceId: target.id,
        },
      });
    });
    if (parsed.data.sessionId === session.id) await clearSessionCookie();
    return NextResponse.json(
      { message: "Session revoked" },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return authFailure(error);
  }
}
