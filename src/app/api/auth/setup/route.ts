import { NextRequest, NextResponse } from "next/server";
import { hashPassword, validatePasswordStrength } from "@/lib/auth/password";
import { createSession, setSessionCookie } from "@/lib/auth/session";
import { setupSchema } from "@/lib/validation/schemas";
import {
  assertSameOrigin,
  assertSetupToken,
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
    assertSetupToken(request);
    await consumeAuthAttempt("setup");
    const parsed = setupSchema.safeParse(await readAuthBody(request));
    if (!parsed.success) throw authError(400, "Invalid account details");
    const { email, username, password } = parsed.data;
    const strengthError = validatePasswordStrength(password);
    if (strengthError) throw authError(400, strengthError);
    const result = await authTransaction(async (tx) => {
      const setting = await tx.appSetting.findUnique({
        where: { key: "appInitialized" },
      });
      if (setting?.value === "true" || (await tx.user.count()))
        throw authError(403, "Application is already set up");
      const passwordHash = await hashPassword(password);
      const user = await tx.user.create({
        data: { email, username, passwordHash },
        select: { id: true, email: true, username: true },
      });
      await tx.appSetting.upsert({
        where: { key: "appInitialized" },
        create: { key: "appInitialized", value: "true" },
        update: { value: "true" },
      });
      const { rawToken } = await createSession(
        { userId: user.id, userAgent: getSafeUserAgent(request) },
        tx,
      );
      await tx.auditEvent.create({
        data: { userId: user.id, action: "setup_complete" },
      });
      return { user, rawToken };
    });
    await setSessionCookie(result.rawToken);
    return NextResponse.json(
      { message: "Account created successfully", user: result.user },
      { status: 201, headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return authFailure(error);
  }
}
