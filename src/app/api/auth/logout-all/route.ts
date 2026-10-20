/**
 * POST /api/auth/logout-all
 *
 * Revoke ALL active sessions for the owner and clear the current cookie.
 *
 * @security
 *   - Requires authentication
 *   - Revokes every session in the database
 *   - Logs audit event with count
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAuth, getClientIp } from "@/lib/auth/require-auth";
import { revokeAllSessions, clearSessionCookie } from "@/lib/auth/session";
import { logAuditEvent, AuditAction } from "@/lib/auth/audit";

export async function POST(request: NextRequest) {
  try {
    const { user } = await requireAuth(request);

    // Revoke all sessions
    const revokedCount = await revokeAllSessions(user.id);

    // Clear cookie
    await clearSessionCookie();

    // Audit log
    await logAuditEvent({
      userId: user.id,
      action: AuditAction.LOGOUT_ALL,
      ipAddress: getClientIp(request),
      details: { revokedCount },
    });

    return NextResponse.json(
      {
        message: "All sessions revoked",
        revokedCount,
      },
      { headers: { "Cache-Control": "private, no-store" } }
    );
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("[LOGOUT_ALL] Error:", error);
    return NextResponse.json(
      { error: "An unexpected error occurred" },
      { status: 500, headers: { "Cache-Control": "private, no-store" } }
    );
  }
}
