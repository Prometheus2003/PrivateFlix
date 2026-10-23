/**
 * Zod validation schemas for all API routes.
 * Centralizes input validation to prevent injection and invalid data.
 *
 * @module lib/validation/schemas
 */
import { z } from "zod";

// ─── Auth Schemas ───────────────────────────────────────────

/** First-run setup: create the owner account */
export const setupSchema = z
  .object({
    email: z
      .string()
      .email("Invalid email address")
      .max(255, "Email must be at most 255 characters")
      .toLowerCase()
      .trim(),
    username: z
      .string()
      .min(3, "Username must be at least 3 characters")
      .max(50, "Username must be at most 50 characters")
      .regex(
        /^[a-zA-Z0-9_-]+$/,
        "Username can only contain letters, numbers, hyphens, and underscores",
      )
      .trim(),
    password: z
      .string()
      .min(12, "Password must be at least 12 characters")
      .max(128, "Password must be at most 128 characters"),
    confirmPassword: z.string(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });

export type SetupInput = z.infer<typeof setupSchema>;

/** Login */
export const loginSchema = z.object({
  login: z.string().min(1, "Email or username is required").max(255).trim(),
  password: z.string().min(1, "Password is required").max(128),
});

export type LoginInput = z.infer<typeof loginSchema>;

/** Password change */
export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, "Current password is required").max(128),
    newPassword: z
      .string()
      .min(12, "New password must be at least 12 characters")
      .max(128, "New password must be at most 128 characters"),
    confirmNewPassword: z.string(),
  })
  .refine((data) => data.newPassword === data.confirmNewPassword, {
    message: "Passwords do not match",
    path: ["confirmNewPassword"],
  })
  .refine((data) => data.currentPassword !== data.newPassword, {
    message: "New password must be different from current password",
    path: ["newPassword"],
  });

export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

// ─── Media Schemas ──────────────────────────────────────────

/** Media metadata update */
export const updateMediaSchema = z.object({
  title: z.string().min(1).max(500).trim().optional(),
  description: z.string().max(5000).trim().optional(),
  tags: z.array(z.string().min(1).max(100).trim()).max(50).optional(),
  collectionId: z.string().uuid().nullable().optional(),
});

export type UpdateMediaInput = z.infer<typeof updateMediaSchema>;

// ─── Collection Schemas ─────────────────────────────────────

export const createCollectionSchema = z.object({
  name: z.string().min(1, "Name is required").max(255).trim(),
  description: z.string().max(2000).trim().optional(),
  parentId: z.string().uuid().nullable().optional(),
});

export const updateCollectionSchema = z.object({
  name: z.string().min(1).max(255).trim().optional(),
  description: z.string().max(2000).trim().optional(),
  coverMediaId: z.string().uuid().nullable().optional(),
  parentId: z.string().uuid().nullable().optional(),
});

// ─── Playlist Schemas ───────────────────────────────────────

export const createPlaylistSchema = z.object({
  name: z.string().min(1, "Name is required").max(255).trim(),
  description: z.string().max(2000).trim().optional(),
});

export const updatePlaylistSchema = z.object({
  name: z.string().min(1).max(255).trim().optional(),
  description: z.string().max(2000).trim().optional(),
});

// ─── Pagination Schema ──────────────────────────────────────

export const paginationSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  sortBy: z.string().optional(),
  sortOrder: z.enum(["asc", "desc"]).default("desc"),
});

export type PaginationInput = z.infer<typeof paginationSchema>;

// ─── Playback Schema ────────────────────────────────────────

export const updatePlaybackSchema = z.object({
  positionSeconds: z.number().min(0),
  durationSeconds: z.number().min(0).optional(),
  completed: z.boolean().optional(),
});

// ─── Search Schema ──────────────────────────────────────────

export const searchSchema = z.object({
  query: z.string().max(500).trim().optional(),
  type: z.enum(["IMAGE", "VIDEO", "ALL"]).default("ALL"),
  collectionId: z.string().uuid().optional(),
  tags: z.array(z.string()).optional(),
  favoriteOnly: z.coerce.boolean().default(false),
  dateFrom: z.coerce.date().optional(),
  dateTo: z.coerce.date().optional(),
  minDuration: z.coerce.number().min(0).optional(),
  maxDuration: z.coerce.number().min(0).optional(),
  ...paginationSchema.shape,
});
