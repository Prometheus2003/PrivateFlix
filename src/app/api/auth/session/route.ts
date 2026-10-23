/**
 * GET /api/auth/session
 *
 * Returns the current session and user info if authenticated.
 * Used by the frontend to check auth status.
 *
 * @security
 *   - Returns 401 if not authenticated
 *   - Never returns sensitive fields (passwordHash, tokenHash)
 *   - Cache-Control: private, no-store
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { getActiveSessions } from "@/lib/auth/session";

export async function GET(request: NextRequest) {
  try {
    const { user, session } = await requireAuth(request);

    // Get active session count
    const activeSessions = await getActiveSessions(user.id);

    return NextResponse.json(
      {
        user: {
          id: user.id,
          email: user.email,
          username: user.username,
        },
        session: {
          id: session.id,
          createdAt: session.createdAt,
          expiresAt: session.expiresAt,
          lastActivityAt: session.lastActivityAt,
        },
        activeSessionCount: activeSessions.length,
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    if (error instanceof Response) return error;
    return NextResponse.json(
      { error: "An unexpected error occurred" },
      { status: 500, headers: { "Cache-Control": "private, no-store" } },
    );
  }
}
