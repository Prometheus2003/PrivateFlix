import { z } from "zod";
const secret = z
  .string()
  .min(16)
  .refine(
    (v) =>
      !/change.?this|change.?me|replace|placeholder|minioadmin|devpass/i.test(
        v,
      ),
    "Must be generated, not a placeholder",
  );
const url = (protocols: string[]) =>
  z
    .string()
    .url()
    .refine((v) => {
      try {
        return protocols.includes(new URL(v).protocol);
      } catch {
        return false;
      }
    }, "Unsupported protocol");
const positive = z.coerce.number().int().positive().safe();
const formats = z.string().regex(/^[a-z0-9]+(,[a-z0-9]+)*$/);
export const envSchema = z
  .object({
    DATABASE_URL: url(["postgresql:", "postgres:"]),
    S3_ENDPOINT: url(["http:", "https:"]).refine((v) => {
      let u: URL;
      try {
        u = new URL(v);
      } catch {
        return false;
      }
      return (
        !u.username && !u.password && u.pathname === "/" && !u.search && !u.hash
      );
    }),
    S3_ACCESS_KEY: secret,
    S3_SECRET_KEY: secret,
    S3_BUCKET: z
      .string()
      .min(3)
      .max(63)
      .regex(/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/),
    S3_REGION: z.string().min(1).default("us-east-1"),
    REDIS_URL: url(["redis:", "rediss:"]),
    SESSION_SECRET: secret.refine(
      (v) => /^[a-f0-9]{128}$/i.test(v),
      "Must be 64 random bytes as hex",
    ),
    SETUP_TOKEN: z
      .string()
      .regex(/^[a-f0-9]{64}$/i)
      .optional(),
    SESSION_IDLE_TIMEOUT: positive.default(86400),
    SESSION_ABSOLUTE_TIMEOUT: positive.default(604800),
    RATE_LIMIT_WINDOW: positive.default(900),
    RATE_LIMIT_MAX: positive.default(5),
    MAX_UPLOAD_SIZE: positive.default(10737418240),
    ALLOWED_VIDEO_TYPES: formats.default("mp4,webm,mkv,mov,avi"),
    ALLOWED_IMAGE_TYPES: formats.default("jpg,jpeg,png,webp,gif,heic"),
    ENABLE_TRANSCODING: z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),
    FFMPEG_TIMEOUT: positive.default(600),
    NODE_ENV: z
      .enum(["development", "production", "test"])
      .default("development"),
    APP_URL: url(["http:", "https:"]).default("http://localhost:3000"),
    APP_NAME: z.string().trim().min(1).max(80).default("PrivateFlix"),
    APP_ACCENT_COLOR: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .default("#8b5cf6"),
  })
  .superRefine((env, ctx) => {
    if (env.SESSION_IDLE_TIMEOUT > env.SESSION_ABSOLUTE_TIMEOUT)
      ctx.addIssue({
        code: "custom",
        path: ["SESSION_IDLE_TIMEOUT"],
        message: "Must not exceed absolute timeout",
      });
    let u: URL;
    try {
      u = new URL(env.APP_URL);
    } catch {
      return;
    }
    if (
      u.username ||
      u.password ||
      u.pathname !== "/" ||
      u.search ||
      u.hash ||
      (env.NODE_ENV === "production" && u.protocol !== "https:")
    )
      ctx.addIssue({
        code: "custom",
        path: ["APP_URL"],
        message: "Canonical origin required; production requires HTTPS",
      });
  });
export type Env = z.infer<typeof envSchema>;
export function parseEnv(input: Record<string, unknown>): Env {
  const result = envSchema.safeParse(input);
  if (!result.success) {
    const fields = [
      ...new Set(result.error.issues.map((issue) => issue.path.join("."))),
    ];
    throw new Error(`Invalid environment configuration: ${fields.join(", ")}`);
  }
  return result.data;
}
