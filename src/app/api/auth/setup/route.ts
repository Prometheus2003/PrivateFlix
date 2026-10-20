/**
 * POST /api/auth/setup
 *
 * First-run setup: creates the owner account.
 * This endpoint disables itself after successful initialization.
 *
 * @security
 *   - Checks appInitialized flag — rejects if already set
 *   - Rate-limited to prevent abuse
 *   - Hashes password with Argon2id
 *   - Creates server-side session
 *   - Logs audit event
 *   - No public registration — this is the ONLY account creation path
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { hashPassword, validatePasswordStrength } from "@/lib/auth/password";
import { createSession, setSessionCookie } from "@/lib/auth/session";
import { setupSchema } from "@/lib/validation/schemas";
import { logAuditEvent, AuditAction } from "@/lib/auth/audit";
import { checkRateLimit, recordFailedAttempt, clearRateLimit } from "@/lib/auth/rate-limiter";
import { getClientIp, getSafeUserAgent, isAppInitialized } from "@/lib/auth/require-auth";

export async function POST(request: NextRequest) {
  const ipAddress = getClientIp(request);

  // Rate limit
  const rateLimit = checkRateLimit(ipAddress);
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "Too many attempts. Please try again later." },
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
    // Check if already initialized
    const initialized = await isAppInitialized();
    if (initialized) {
      return NextResponse.json(
        { error: "Application is already set up" },
        {
          status: 403,
          headers: { "Cache-Control": "private, no-store" },
        }
      );
    }

    // Also check if any user exists (double-check)
    const existingUser = await prisma.user.findFirst();
    if (existingUser) {
      // Mark as initialized if somehow missed
      await prisma.appSetting.upsert({
        where: { key: "appInitialized" },
        update: { value: "true" },
        create: { key: "appInitialized", value: "true" },
      });
      return NextResponse.json(
        { error: "Application is already set up" },
        {
          status: 403,
          headers: { "Cache-Control": "private, no-store" },
        }
      );
    }

    // Parse and validate input
    const body = await request.json().catch(() => null);
    if (!body) {
      recordFailedAttempt(ipAddress);
      return NextResponse.json(
        { error: "Invalid request body" },
        { status: 400, headers: { "Cache-Control": "private, no-store" } }
      );
    }

    const validation = setupSchema.safeParse(body);
    if (!validation.success) {
      recordFailedAttempt(ipAddress);
      return NextResponse.json(
        {
          error: "Validation failed",
          details: validation.error.flatten().fieldErrors,
        },
        { status: 400, headers: { "Cache-Control": "private, no-store" } }
      );
    }

    const { email, username, password } = validation.data;

    // Validate password strength
    const strengthError = validatePasswordStrength(password);
    if (strengthError) {
      recordFailedAttempt(ipAddress);
      return NextResponse.json(
        { error: strengthError },
        { status: 400, headers: { "Cache-Control": "private, no-store" } }
      );
    }

    // Hash password with Argon2id
    const passwordHash = await hashPassword(password);

    // Create owner account and mark app as initialized (atomic transaction)
    const user = await prisma.$transaction(async (tx) => {
      const newUser = await tx.user.create({
        data: {
          email,
          username,
          passwordHash,
        },
      });

      await tx.appSetting.upsert({
        where: { key: "appInitialized" },
        update: { value: "true" },
        create: { key: "appInitialized", value: "true" },
      });

      return newUser;
    });

    // Create session
    const userAgent = getSafeUserAgent(request);
    const { rawToken } = await createSession({
      userId: user.id,
      ipAddress,
      userAgent,
    });

    // Set session cookie
    await setSessionCookie(rawToken);

    // Clear rate limit on success
    clearRateLimit(ipAddress);

    // Audit log
    await logAuditEvent({
      userId: user.id,
      action: AuditAction.SETUP_COMPLETE,
      ipAddress,
      details: { email: user.email, username: user.username },
    });

    return NextResponse.json(
      {
        message: "Account created successfully",
        user: {
          id: user.id,
          email: user.email,
          username: user.username,
        },
      },
      {
        status: 201,
        headers: { "Cache-Control": "private, no-store" },
      }
    );
  } catch (error) {
    console.error("[SETUP] Error:", error);
    return NextResponse.json(
      { error: "An unexpected error occurred" },
      { status: 500, headers: { "Cache-Control": "private, no-store" } }
    );
  }
}
