import type { Prisma } from "@prisma/client";
import { getEnv } from "@/lib/validation/env";
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
export async function createSession(
  options: CreateSessionOptions,
  db: Prisma.TransactionClient = prisma,
) {
  const {
    userId,
    ipAddress,
    userAgent,
    idleTimeoutSeconds = getEnv().SESSION_IDLE_TIMEOUT, // 24h
    absoluteTimeoutSeconds = getEnv().SESSION_ABSOLUTE_TIMEOUT, // 7d
  } = options;

  const rawToken = generateSessionToken();
  const tokenHash = hashSessionToken(rawToken);

  const now = new Date();
  const expiresAt = new Date(now.getTime() + absoluteTimeoutSeconds * 1000);

  const session = await db.session.create({
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
  maxAgeSeconds: number = getEnv().SESSION_ABSOLUTE_TIMEOUT,
): Promise<void> {
  const cookieStore = await cookies();
  const isProduction = getEnv().NODE_ENV === "production";

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
  idleTimeoutSeconds: number = getEnv().SESSION_IDLE_TIMEOUT,
) {
  if (!/^[a-f0-9]{64}$/.test(rawToken)) return null;
  const tokenHash = hashSessionToken(rawToken);
  const now = new Date();
  const valid = {
    tokenHash,
    revokedAt: null,
    expiresAt: { gt: now },
    lastActivityAt: { gt: new Date(now.getTime() - idleTimeoutSeconds * 1000) },
  };
  const touched = await prisma.session.updateMany({
    where: valid,
    data: { lastActivityAt: now },
  });
  if (touched.count !== 1) return null;
  const session = await prisma.session.findFirst({
    where: valid,
    select: {
      id: true,
      userId: true,
      createdAt: true,
      expiresAt: true,
      lastActivityAt: true,
      user: { select: { id: true, email: true, username: true } },
    },
  });
  if (!session) return null;
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
export async function revokeAllSessions(
  userId: string,
  db: Prisma.TransactionClient = prisma,
): Promise<number> {
  const result = await db.session.updateMany({
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
      lastActivityAt: {
        gt: new Date(now.getTime() - getEnv().SESSION_IDLE_TIMEOUT * 1000),
      },
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
    take: 100,
  });
}

/**
 * Clean up expired sessions (housekeeping).
 */
export async function cleanExpiredSessions(): Promise<number> {
  const result = await prisma.session.deleteMany({
    where: {
      OR: [{ expiresAt: { lt: new Date() } }, { revokedAt: { not: null } }],
    },
  });
  return result.count;
}
