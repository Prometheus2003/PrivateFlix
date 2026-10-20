/**
 * POST /api/auth/logout
 *
 * Revoke the current session and clear the cookie.
 *
 * @security
 *   - Validates session before revoking
 *   - Clears HttpOnly cookie
 *   - Logs audit event
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAuth, getClientIp } from "@/lib/auth/require-auth";
import { revokeSession, clearSessionCookie } from "@/lib/auth/session";
import { logAuditEvent, AuditAction } from "@/lib/auth/audit";

export async function POST(request: NextRequest) {
  try {
    const { user, session } = await requireAuth(request);

    // Revoke the session in the database
    await revokeSession(session.id);

    // Clear the cookie
    await clearSessionCookie();

    // Audit log
    await logAuditEvent({
      userId: user.id,
      action: AuditAction.LOGOUT,
      resourceType: "session",
      resourceId: session.id,
      ipAddress: getClientIp(request),
    });

    return NextResponse.json(
      { message: "Logged out successfully" },
      { headers: { "Cache-Control": "private, no-store" } }
    );
  } catch (error) {
    // If requireAuth threw a 401 Response, return it directly
    if (error instanceof Response) {
      // Already logged out or invalid session — clear cookie anyway
      await clearSessionCookie();
      return NextResponse.json(
        { message: "Logged out" },
        { headers: { "Cache-Control": "private, no-store" } }
      );
    }

    console.error("[LOGOUT] Error:", error);
    return NextResponse.json(
      { error: "An unexpected error occurred" },
      { status: 500, headers: { "Cache-Control": "private, no-store" } }
    );
  }
}
