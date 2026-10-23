import { NextRequest, NextResponse } from "next/server";
import { verifyPassword, needsRehash, hashPassword } from "@/lib/auth/password";
import {
  createSession,
  setSessionCookie,
  hashSessionToken,
} from "@/lib/auth/session";
import { loginSchema } from "@/lib/validation/schemas";
import {
  assertSameOrigin,
  readAuthBody,
  authError,
  authFailure,
} from "@/lib/auth/http";
import { consumeAuthAttempt } from "@/lib/auth/rate-limiter";
import { authTransaction } from "@/lib/auth/transaction";
import { getSafeUserAgent } from "@/lib/auth/require-auth";

export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    await consumeAuthAttempt("login");
    const parsed = loginSchema.safeParse(await readAuthBody(request));
    if (!parsed.success) throw authError(401, "Invalid credentials");
    const { login, password } = parsed.data;
    const result = await authTransaction(async (tx) => {
      // Single-owner lookup always verifies the same real hash, including unknown logins.
      const owner = await tx.user.findFirst();
      const validPassword = owner
        ? await verifyPassword(owner.passwordHash, password)
        : (await hashPassword(password), false);
      if (
        !owner ||
        !validPassword ||
        (owner.email !== login.toLowerCase() && owner.username !== login)
      ) {
        await tx.auditEvent.create({ data: { action: "login_failed" } });
        return null;
      }
      const passwordHash = (await needsRehash(owner.passwordHash))
        ? await hashPassword(password)
        : owner.passwordHash;
      await tx.user.update({
        where: { id: owner.id },
        data: { passwordHash, lastLoginAt: new Date() },
      });
      const previous = request.cookies.get("privateflix_session")?.value;
      if (previous && /^[a-f0-9]{64}$/.test(previous)) {
        await tx.session.updateMany({
          where: {
            tokenHash: hashSessionToken(previous),
            userId: owner.id,
            revokedAt: null,
          },
          data: { revokedAt: new Date() },
        });
      }
      const { rawToken } = await createSession(
        { userId: owner.id, userAgent: getSafeUserAgent(request) },
        tx,
      );
      await tx.auditEvent.create({
        data: { userId: owner.id, action: "login_success" },
      });
      return {
        rawToken,
        user: { id: owner.id, email: owner.email, username: owner.username },
      };
    });
    if (!result) throw authError(401, "Invalid credentials");
    await setSessionCookie(result.rawToken);
    return NextResponse.json(
      { message: "Login successful", user: result.user },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return authFailure(error);
  }
}
