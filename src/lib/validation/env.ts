/**
 * Environment variable validation using Zod.
 * Validates ALL required env vars at startup.
 * Access via the exported `env` object — never raw `process.env`.
 *
 * @module lib/validation/env
 * @security Never expose this module to client-side code.
 */
import { z } from "zod";

const envSchema = z.object({
  // ─── Database ─────────────────────────────────────────
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),

  // ─── Object Storage (S3 / MinIO) ─────────────────────
  S3_ENDPOINT: z.string().url("S3_ENDPOINT must be a valid URL"),
  S3_ACCESS_KEY: z.string().min(1, "S3_ACCESS_KEY is required"),
  S3_SECRET_KEY: z.string().min(1, "S3_SECRET_KEY is required"),
  S3_BUCKET: z.string().min(1, "S3_BUCKET is required"),
  S3_REGION: z.string().default("us-east-1"),

  // ─── Redis ────────────────────────────────────────────
  REDIS_URL: z.string().min(1, "REDIS_URL is required"),

  // ─── Session & Security ───────────────────────────────
  SESSION_SECRET: z.string().min(32, "SESSION_SECRET must be at least 32 characters"),
  SESSION_IDLE_TIMEOUT: z.coerce.number().int().positive().default(86400), // 24h
  SESSION_ABSOLUTE_TIMEOUT: z.coerce.number().int().positive().default(604800), // 7d

  // ─── Rate Limiting ────────────────────────────────────
  RATE_LIMIT_WINDOW: z.coerce.number().int().positive().default(900), // 15 min
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(5),

  // ─── Upload ───────────────────────────────────────────
  MAX_UPLOAD_SIZE: z.coerce.number().int().positive().default(10_737_418_240), // 10GB
  ALLOWED_VIDEO_TYPES: z.string().default("mp4,webm,mkv,mov,avi"),
  ALLOWED_IMAGE_TYPES: z.string().default("jpg,jpeg,png,webp,gif,heic"),

  // ─── Media Processing ─────────────────────────────────
  ENABLE_TRANSCODING: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  FFMPEG_TIMEOUT: z.coerce.number().int().positive().default(600),

  // ─── Application ──────────────────────────────────────
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  APP_URL: z.string().url().default("http://localhost:3000"),
  APP_NAME: z.string().default("PrivateFlix"),
  APP_ACCENT_COLOR: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#8b5cf6"),
});

export type Env = z.infer<typeof envSchema>;

function validateEnv(): Env {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const errors = result.error.flatten().fieldErrors;
    const errorMessages = Object.entries(errors)
      .map(([key, msgs]) => `  ${key}: ${msgs?.join(", ")}`)
      .join("\n");

    console.error("❌ Environment validation failed:\n" + errorMessages);
    throw new Error("Invalid environment configuration. Check the errors above.");
  }

  return result.data;
}

/**
 * Validated environment variables.
 * Import this instead of using `process.env` directly.
 */
export const env = validateEnv();
