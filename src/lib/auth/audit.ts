/**
 * Security audit event logging.
 * Records authentication events, access attempts, and security-relevant actions.
 *
 * @module lib/auth/audit
 * @security
 *   - NEVER log passwords, session tokens, or media content
 *   - Safe to log: action type, user ID, IP address, timestamps, resource IDs
 */
import { prisma } from "@/lib/db/prisma";
import type { Prisma } from "@prisma/client";

interface AuditEventInput {
  userId?: string | null;
  action: string;
  resourceType?: string;
  resourceId?: string;
  ipAddress?: string;
  details?: Record<string, unknown>;
}

/**
 * Log a security audit event.
 * Fire-and-forget — failures are logged to console but don't block the request.
 */
export async function logAuditEvent(event: AuditEventInput): Promise<void> {
  try {
    await prisma.auditEvent.create({
      data: {
        userId: event.userId ?? null,
        action: event.action,
        resourceType: event.resourceType ?? null,
        resourceId: event.resourceId ?? null,
        ipAddress: event.ipAddress ?? null,
        details: event.details ? (event.details as Prisma.InputJsonValue) : undefined,
      },
    });
  } catch (error) {
    // Log to console but don't throw — audit failure must not break auth flow
    console.error("[AUDIT] Failed to log event:", event.action, error);
  }
}

/** Well-known audit event actions */
export const AuditAction = {
  SETUP_COMPLETE: "setup_complete",
  LOGIN_SUCCESS: "login_success",
  LOGIN_FAILED: "login_failed",
  LOGIN_RATE_LIMITED: "login_rate_limited",
  LOGOUT: "logout",
  LOGOUT_ALL: "logout_all",
  PASSWORD_CHANGED: "password_changed",
  SESSION_EXPIRED: "session_expired",
  MEDIA_UPLOADED: "media_uploaded",
  MEDIA_DELETED: "media_deleted",
  MEDIA_ACCESSED: "media_accessed",
  SETTINGS_CHANGED: "settings_changed",
  PASSWORD_RESET: "password_reset",
} as const;
