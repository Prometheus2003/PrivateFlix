/**
 * Password hashing and verification using Argon2id.
 *
 * @module lib/auth/password
 * @security
 *   - Uses Argon2id (recommended variant: side-channel + GPU resistance)
 *   - 64 MiB memory, 3 iterations, 4 parallelism
 *   - Salt is auto-generated per hash
 *   - NEVER log password values
 */
import argon2 from "argon2";

/** Argon2id configuration — OWASP recommended parameters */
const ARGON2_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 65536, // 64 MiB
  timeCost: 3, // 3 iterations
  parallelism: 4, // 4 lanes
};

/**
 * Hash a plaintext password with Argon2id.
 * Returns a PHC-format string containing algorithm, parameters, salt, and hash.
 */
export async function hashPassword(plaintext: string): Promise<string> {
  return argon2.hash(plaintext, ARGON2_OPTIONS);
}

/**
 * Verify a plaintext password against a stored Argon2id hash.
 * Uses constant-time comparison internally.
 */
export async function verifyPassword(
  storedHash: string,
  plaintext: string
): Promise<boolean> {
  try {
    return await argon2.verify(storedHash, plaintext);
  } catch {
    // If the hash format is invalid, verification fails gracefully
    return false;
  }
}

/**
 * Check if a stored hash needs rehashing (e.g., after parameter upgrade).
 */
export async function needsRehash(storedHash: string): Promise<boolean> {
  try {
    return argon2.needsRehash(storedHash, ARGON2_OPTIONS);
  } catch {
    return true;
  }
}

/**
 * Validate password strength.
 * Returns null if valid, or an error message string.
 */
export function validatePasswordStrength(password: string): string | null {
  if (password.length < 12) {
    return "Password must be at least 12 characters long";
  }
  if (password.length > 128) {
    return "Password must be at most 128 characters long";
  }
  if (!/[a-z]/.test(password)) {
    return "Password must contain at least one lowercase letter";
  }
  if (!/[A-Z]/.test(password)) {
    return "Password must contain at least one uppercase letter";
  }
  if (!/[0-9]/.test(password)) {
    return "Password must contain at least one number";
  }
  if (!/[^a-zA-Z0-9]/.test(password)) {
    return "Password must contain at least one special character";
  }
  return null;
}
