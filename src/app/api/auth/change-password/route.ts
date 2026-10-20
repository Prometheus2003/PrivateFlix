/**
 * POST /api/auth/change-password
 *
 * Change the owner's password. Requires current password verification.
 *
 * @security
 *   - Requires authentication
 *   - Verifies current password before accepting new one
 *   - Revokes all other sessions (session rotation)
 *   - Creates a new session
 *   - Logs audit event
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { requireAuth, getClientIp, getSafeUserAgent } from "@/lib/auth/require-auth";
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
import { logAuditEvent, AuditAction } from "@/lib/auth/audit";

export async function POST(request: NextRequest) {
  try {
    const { user } = await requireAuth(request);
    const ipAddress = getClientIp(request);

    // Parse body
    const body = await request.json().catch(() => null);
    if (!body) {
      return NextResponse.json(
        { error: "Invalid request body" },
        { status: 400, headers: { "Cache-Control": "private, no-store" } }
      );
    }

    // Validate input
    const validation = changePasswordSchema.safeParse(body);
    if (!validation.success) {
      return NextResponse.json(
        {
          error: "Validation failed",
          details: validation.error.flatten().fieldErrors,
        },
        { status: 400, headers: { "Cache-Control": "private, no-store" } }
      );
    }

    const { currentPassword, newPassword } = validation.data;

    // Validate password strength
    const strengthError = validatePasswordStrength(newPassword);
    if (strengthError) {
      return NextResponse.json(
        { error: strengthError },
        { status: 400, headers: { "Cache-Control": "private, no-store" } }
      );
    }

    // Load user with password hash
    const fullUser = await prisma.user.findUnique({
      where: { id: user.id },
    });

    if (!fullUser) {
      return NextResponse.json(
        { error: "User not found" },
        { status: 404, headers: { "Cache-Control": "private, no-store" } }
      );
    }

    // Verify current password
    const currentValid = await verifyPassword(fullUser.passwordHash, currentPassword);
    if (!currentValid) {
      return NextResponse.json(
        { error: "Current password is incorrect" },
        { status: 401, headers: { "Cache-Control": "private, no-store" } }
      );
    }

    // Hash new password
    const newHash = await hashPassword(newPassword);

    // Update password and revoke all sessions in a transaction
    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: {
          passwordHash: newHash,
          passwordChangedAt: new Date(),
        },
      });
    });

    // Revoke all existing sessions
    await revokeAllSessions(user.id);

    // Create new session (session rotation)
    const userAgent = getSafeUserAgent(request);
    const { rawToken } = await createSession({
      userId: user.id,
      ipAddress,
      userAgent,
    });

    await setSessionCookie(rawToken);

    // Audit log
    await logAuditEvent({
      userId: user.id,
      action: AuditAction.PASSWORD_CHANGED,
      ipAddress,
    });

    return NextResponse.json(
      { message: "Password changed successfully" },
      { headers: { "Cache-Control": "private, no-store" } }
    );
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("[CHANGE_PASSWORD] Error:", error);
    return NextResponse.json(
      { error: "An unexpected error occurred" },
      { status: 500, headers: { "Cache-Control": "private, no-store" } }
    );
  }
}
