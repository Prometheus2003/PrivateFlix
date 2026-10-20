/**
 * In-memory rate limiter for login and setup endpoints.
 * Uses a sliding window counter per IP address.
 *
 * @module lib/auth/rate-limiter
 * @security
 *   - Prevents brute-force attacks on login
 *   - Progressive delays after threshold
 *   - Temporary lockout after excessive attempts
 *   - In-memory store (resets on restart — acceptable for single-instance)
 */

interface RateLimitEntry {
  /** Timestamps of recent attempts within the window */
  attempts: number[];
  /** Lockout until this timestamp (if locked) */
  lockedUntil?: number;
}

interface RateLimitConfig {
  /** Window size in seconds */
  windowSeconds: number;
  /** Max attempts within the window before rate limiting */
  maxAttempts: number;
  /** Number of attempts that triggers a lockout */
  lockoutThreshold: number;
  /** Lockout duration in seconds */
  lockoutDurationSeconds: number;
}

const DEFAULT_CONFIG: RateLimitConfig = {
  windowSeconds: 900, // 15 minutes
  maxAttempts: 5,
  lockoutThreshold: 10,
  lockoutDurationSeconds: 900, // 15 minutes
};

/** In-memory store keyed by IP address */
const store = new Map<string, RateLimitEntry>();

/** Periodic cleanup interval */
let cleanupInterval: ReturnType<typeof setInterval> | null = null;

function ensureCleanup() {
  if (cleanupInterval) return;
  cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of store.entries()) {
      // Remove entries with no recent attempts and no active lockout
      const hasRecentAttempts = entry.attempts.some(
        (t) => now - t < DEFAULT_CONFIG.windowSeconds * 1000
      );
      const isLocked = entry.lockedUntil && entry.lockedUntil > now;
      if (!hasRecentAttempts && !isLocked) {
        store.delete(key);
      }
    }
  }, 60_000); // Clean every minute

  // Don't prevent Node.js from exiting
  if (cleanupInterval.unref) {
    cleanupInterval.unref();
  }
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds?: number;
  isLocked: boolean;
}

/**
 * Check rate limit for an IP address.
 * Call this BEFORE processing the login/setup attempt.
 */
export function checkRateLimit(
  ipAddress: string,
  config: Partial<RateLimitConfig> = {}
): RateLimitResult {
  ensureCleanup();

  const cfg = { ...DEFAULT_CONFIG, ...config };
  const now = Date.now();
  const windowStart = now - cfg.windowSeconds * 1000;

  let entry = store.get(ipAddress);
  if (!entry) {
    entry = { attempts: [] };
    store.set(ipAddress, entry);
  }

  // Check lockout
  if (entry.lockedUntil && entry.lockedUntil > now) {
    const retryAfterSeconds = Math.ceil((entry.lockedUntil - now) / 1000);
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds,
      isLocked: true,
    };
  } else if (entry.lockedUntil) {
    // Lockout expired — clear it
    entry.lockedUntil = undefined;
  }

  // Clean old attempts outside window
  entry.attempts = entry.attempts.filter((t) => t > windowStart);

  // Check if over limit
  if (entry.attempts.length >= cfg.maxAttempts) {
    // Check if we should escalate to lockout
    if (entry.attempts.length >= cfg.lockoutThreshold) {
      entry.lockedUntil = now + cfg.lockoutDurationSeconds * 1000;
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: cfg.lockoutDurationSeconds,
        isLocked: true,
      };
    }

    // Calculate retry time (oldest attempt + window)
    const oldestInWindow = Math.min(...entry.attempts);
    const retryAfterSeconds = Math.ceil(
      (oldestInWindow + cfg.windowSeconds * 1000 - now) / 1000
    );

    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.max(1, retryAfterSeconds),
      isLocked: false,
    };
  }

  return {
    allowed: true,
    remaining: cfg.maxAttempts - entry.attempts.length,
    isLocked: false,
  };
}

/**
 * Record a failed attempt for an IP address.
 * Call this AFTER a failed login/setup attempt.
 */
export function recordFailedAttempt(ipAddress: string): void {
  let entry = store.get(ipAddress);
  if (!entry) {
    entry = { attempts: [] };
    store.set(ipAddress, entry);
  }
  entry.attempts.push(Date.now());
}

/**
 * Clear rate limit state for an IP (after successful login).
 */
export function clearRateLimit(ipAddress: string): void {
  store.delete(ipAddress);
}

/**
 * Reset the entire rate limit store (for testing).
 */
export function resetRateLimitStore(): void {
  store.clear();
}
