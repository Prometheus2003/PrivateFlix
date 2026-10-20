/**
 * Server-side session management.
 * Sessions are stored in PostgreSQL. Session tokens are SHA-256 hashed before storage.
 *
 * @module lib/auth/session
 * @security
 *   - Tokens generated with crypto.randomBytes(32) → 256-bit entropy
 *   - Token hashed with SHA-256 before DB storage (raw token NEVER persisted)
 *   - HttpOnly, Secure (production), SameSite=Lax cookies
 *   - Idle timeout + absolute expiry
 *   - Revocation on logout / password change
 */
import crypto from "node:crypto";
import { cookies } from "next/headers";
import { prisma } from "@/lib/db/prisma";

const SESSION_COOKIE_NAME = "privateflix_session";

/**
 * Generate a cryptographically random session token (hex-encoded).
 */
export function generateSessionToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

/**
 * Hash a session token with SHA-256 for database storage.
 * The raw token is sent to the client; only the hash is stored.
 */
export function hashSessionToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

interface CreateSessionOptions {
  userId: string;
  ipAddress?: string | null;
  userAgent?: string | null;
  idleTimeoutSeconds?: number;
  absoluteTimeoutSeconds?: number;
}

/**
 * Create a new server-side session.
 * Returns the raw token (to be set as cookie) and the session record.
 */
export async function createSession(options: CreateSessionOptions) {
  const {
    userId,
    ipAddress,
    userAgent,
    idleTimeoutSeconds = 86400, // 24h
    absoluteTimeoutSeconds = 604800, // 7d
  } = options;

  const rawToken = generateSessionToken();
  const tokenHash = hashSessionToken(rawToken);

  const now = new Date();
  const expiresAt = new Date(now.getTime() + absoluteTimeoutSeconds * 1000);

  const session = await prisma.session.create({
    data: {
      userId,
      tokenHash,
      expiresAt,
      lastActivityAt: now,
      ipAddress: ipAddress ?? null,
      userAgent: userAgent ? userAgent.substring(0, 512) : null, // Truncate
    },
  });

  return { rawToken, session, idleTimeoutSeconds };
}

/**
 * Set the session cookie on the response.
 */
export async function setSessionCookie(
  rawToken: string,
  maxAgeSeconds: number = 604800
): Promise<void> {
  const cookieStore = await cookies();
  const isProduction = process.env.NODE_ENV === "production";

  cookieStore.set(SESSION_COOKIE_NAME, rawToken, {
    httpOnly: true,
    secure: isProduction,
    sameSite: "lax",
    path: "/",
    maxAge: maxAgeSeconds,
  });
}

/**
 * Get the raw session token from the request cookies.
 */
export async function getSessionToken(): Promise<string | null> {
  const cookieStore = await cookies();
  const cookie = cookieStore.get(SESSION_COOKIE_NAME);
  return cookie?.value ?? null;
}

/**
 * Validate a session token and return the session + user.
 * Checks: exists, not revoked, not expired (absolute + idle).
 * Updates lastActivityAt on success.
 */
export async function validateSession(
  rawToken: string,
  idleTimeoutSeconds: number = 86400
) {
  const tokenHash = hashSessionToken(rawToken);

  const session = await prisma.session.findUnique({
    where: { tokenHash },
    include: { user: true },
  });

  if (!session) {
    return null;
  }

  // Check if revoked
  if (session.revokedAt) {
    return null;
  }

  const now = new Date();

  // Check absolute expiry
  if (now > session.expiresAt) {
    return null;
  }

  // Check idle timeout
  const idleDeadline = new Date(
    session.lastActivityAt.getTime() + idleTimeoutSeconds * 1000
  );
  if (now > idleDeadline) {
    return null;
  }

  // Update last activity (but don't await — fire and forget for performance)
  prisma.session
    .update({
      where: { id: session.id },
      data: { lastActivityAt: now },
    })
    .catch(() => {
      // Non-critical — log but don't fail the request
    });

  return {
    session: {
      id: session.id,
      userId: session.userId,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
      lastActivityAt: session.lastActivityAt,
    },
    user: {
      id: session.user.id,
      email: session.user.email,
      username: session.user.username,
    },
  };
}

/**
 * Revoke a specific session (logout).
 */
export async function revokeSession(sessionId: string): Promise<void> {
  await prisma.session.update({
    where: { id: sessionId },
    data: { revokedAt: new Date() },
  });
}

/**
 * Revoke ALL sessions for a user (logout everywhere / password change).
 */
export async function revokeAllSessions(userId: string): Promise<number> {
  const result = await prisma.session.updateMany({
    where: {
      userId,
      revokedAt: null,
    },
    data: { revokedAt: new Date() },
  });
  return result.count;
}

/**
 * Clear the session cookie.
 */
export async function clearSessionCookie(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(SESSION_COOKIE_NAME);
}

/**
 * Get active (non-revoked, non-expired) sessions for a user.
 */
export async function getActiveSessions(userId: string) {
  const now = new Date();
  return prisma.session.findMany({
    where: {
      userId,
      revokedAt: null,
      expiresAt: { gt: now },
    },
    select: {
      id: true,
      createdAt: true,
      lastActivityAt: true,
      expiresAt: true,
      ipAddress: true,
      userAgent: true,
    },
    orderBy: { lastActivityAt: "desc" },
  });
}

/**
 * Clean up expired sessions (housekeeping).
 */
export async function cleanExpiredSessions(): Promise<number> {
  const result = await prisma.session.deleteMany({
    where: {
      OR: [
        { expiresAt: { lt: new Date() } },
        { revokedAt: { not: null } },
      ],
    },
  });
  return result.count;
}
