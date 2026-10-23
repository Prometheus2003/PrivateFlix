import { getEnv } from "@/lib/validation/env";
/**
 * Central authentication check for protected routes.
 * Call this at the start of EVERY protected API route and server component.
 *
 * @module lib/auth/require-auth
 * @security
 *   - Validates session cookie on every request
 *   - Returns 401 for missing/invalid sessions
 *   - Returns 404 (not 403) for resources not owned (prevents enumeration)
 *   - Sets Cache-Control: private, no-store on all responses
 */
import { NextRequest } from "next/server";
import { validateSession } from "@/lib/auth/session";

interface AuthResult {
  user: {
    id: string;
    email: string;
    username: string;
  };
  session: {
    id: string;
    userId: string;
    createdAt: Date;
    expiresAt: Date;
    lastActivityAt: Date;
  };
}

const SESSION_COOKIE_NAME = "privateflix_session";

/**
 * Require authentication for a request.
 * Throws a Response (401) if the session is invalid.
 *
 * Usage in route handlers:
 * ```ts
 * export async function GET(request: NextRequest) {
 *   const { user } = await requireAuth(request);
 *   // user is guaranteed to be authenticated
 * }
 * ```
 */
export async function requireAuth(request: NextRequest): Promise<AuthResult> {
  const sessionToken = request.cookies.get(SESSION_COOKIE_NAME)?.value;

  if (!sessionToken) {
    throw new Response(JSON.stringify({ error: "Authentication required" }), {
      status: 401,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "private, no-store",
      },
    });
  }

  // Read idle timeout from env (with fallback)
  const idleTimeout = getEnv().SESSION_IDLE_TIMEOUT;

  const result = await validateSession(sessionToken, idleTimeout);

  if (!result) {
    throw new Response(
      JSON.stringify({ error: "Session expired or invalid" }),
      {
        status: 401,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "private, no-store",
        },
      },
    );
  }

  return result;
}

/**
 * Check if the application has been initialized (owner account created).
 */
export async function isAppInitialized(): Promise<boolean> {
  // Lazy import to avoid circular deps
  const { prisma } = await import("@/lib/db/prisma");

  const setting = await prisma.appSetting.findUnique({
    where: { key: "appInitialized" },
  });

  return setting?.value === "true" || (await prisma.user.count()) > 0;
}

/**
 * Get the client IP address from the request.
 * Handles X-Forwarded-For from reverse proxies.
 */
export function getClientIp(_request: NextRequest): string {
  void _request;
  // Forwarded headers are untrusted until an explicit proxy contract exists.
  return "unknown";
}

/**
 * Get a safe user agent string (truncated).
 */
export function getSafeUserAgent(request: NextRequest): string {
  const ua = request.headers.get("user-agent") ?? "unknown";
  return ua.substring(0, 512);
}
