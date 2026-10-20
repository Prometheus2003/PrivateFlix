/**
 * POST /api/auth/login
 *
 * Authenticate the owner with email/username and password.
 *
 * @security
 *   - Rate-limited per IP
 *   - Generic error messages (no "user not found" vs "wrong password" distinction)
 *   - Hashes password comparison with Argon2id
 *   - Creates new server-side session on success
 *   - Rotates session (no old session reuse)
 *   - Logs audit events for success and failure
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { verifyPassword, needsRehash, hashPassword } from "@/lib/auth/password";
import { createSession, setSessionCookie } from "@/lib/auth/session";
import { loginSchema } from "@/lib/validation/schemas";
import { logAuditEvent, AuditAction } from "@/lib/auth/audit";
import {
  checkRateLimit,
  recordFailedAttempt,
  clearRateLimit,
} from "@/lib/auth/rate-limiter";
import { getClientIp, getSafeUserAgent } from "@/lib/auth/require-auth";

/** Generic error message — never reveal whether user exists */
const INVALID_CREDENTIALS_MSG = "Invalid credentials";

export async function POST(request: NextRequest) {
  const ipAddress = getClientIp(request);

  // Rate limit check
  const rateLimit = checkRateLimit(ipAddress);
  if (!rateLimit.allowed) {
    await logAuditEvent({
      action: AuditAction.LOGIN_RATE_LIMITED,
      ipAddress,
      details: { isLocked: rateLimit.isLocked },
    });

    return NextResponse.json(
      { error: "Too many login attempts. Please try again later." },
      {
        status: 429,
        headers: {
          "Retry-After": String(rateLimit.retryAfterSeconds ?? 60),
          "Cache-Control": "private, no-store",
        },
      }
    );
  }

  try {
    // Parse body
    const body = await request.json().catch(() => null);
    if (!body) {
      recordFailedAttempt(ipAddress);
      return NextResponse.json(
        { error: INVALID_CREDENTIALS_MSG },
        { status: 401, headers: { "Cache-Control": "private, no-store" } }
      );
    }

    const validation = loginSchema.safeParse(body);
    if (!validation.success) {
      recordFailedAttempt(ipAddress);
      return NextResponse.json(
        { error: INVALID_CREDENTIALS_MSG },
        { status: 401, headers: { "Cache-Control": "private, no-store" } }
      );
    }

    const { login, password } = validation.data;

    // Find user by email OR username
    const user = await prisma.user.findFirst({
      where: {
        OR: [
          { email: login.toLowerCase() },
          { username: login },
        ],
      },
    });

    if (!user) {
      // Perform a dummy hash to prevent timing attacks
      await verifyPassword(
        "$argon2id$v=19$m=65536,t=3,p=4$dW5rbm93bg$dW5rbm93bg",
        password
      );
      recordFailedAttempt(ipAddress);
      await logAuditEvent({
        action: AuditAction.LOGIN_FAILED,
        ipAddress,
        details: { reason: "user_not_found" },
      });
      return NextResponse.json(
        { error: INVALID_CREDENTIALS_MSG },
        { status: 401, headers: { "Cache-Control": "private, no-store" } }
      );
    }

    // Verify password
    const valid = await verifyPassword(user.passwordHash, password);
    if (!valid) {
      recordFailedAttempt(ipAddress);
      await logAuditEvent({
        userId: user.id,
        action: AuditAction.LOGIN_FAILED,
        ipAddress,
        details: { reason: "wrong_password" },
      });
      return NextResponse.json(
        { error: INVALID_CREDENTIALS_MSG },
        { status: 401, headers: { "Cache-Control": "private, no-store" } }
      );
    }

    // Check if password needs rehashing (e.g., parameters upgraded)
    if (await needsRehash(user.passwordHash)) {
      const newHash = await hashPassword(password);
      await prisma.user.update({
        where: { id: user.id },
        data: { passwordHash: newHash },
      });
    }

    // Create new session
    const userAgent = getSafeUserAgent(request);
    const { rawToken } = await createSession({
      userId: user.id,
      ipAddress,
      userAgent,
    });

    // Set session cookie
    await setSessionCookie(rawToken);

    // Update last login timestamp
    await prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    // Clear rate limit on success
    clearRateLimit(ipAddress);

    // Audit log
    await logAuditEvent({
      userId: user.id,
      action: AuditAction.LOGIN_SUCCESS,
      resourceType: "session",
      ipAddress,
    });

    return NextResponse.json(
      {
        message: "Login successful",
        user: {
          id: user.id,
          email: user.email,
          username: user.username,
        },
      },
      {
        status: 200,
        headers: { "Cache-Control": "private, no-store" },
      }
    );
  } catch (error) {
    console.error("[LOGIN] Error:", error);
    return NextResponse.json(
      { error: "An unexpected error occurred" },
      { status: 500, headers: { "Cache-Control": "private, no-store" } }
    );
  }
}
