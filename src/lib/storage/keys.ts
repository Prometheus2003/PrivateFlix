/**
 * Opaque storage key generation.
 * Produces server-side-only object keys that are never exposed to the client.
 *
 * Key structure: {mediaType}/{year}/{month}/{uuid}/{purpose}.{ext}
 * Example: video/2026/10/a1b2c3d4-e5f6-7890-abcd-ef1234567890/original.mp4
 * Example: video/2026/10/a1b2c3d4-e5f6-7890-abcd-ef1234567890/thumb_001.webp
 *
 * @module lib/storage/keys
 * @security
 *   - Keys are opaque to the client — NEVER exposed in API responses
 *   - Original filenames are NEVER used in storage keys
 *   - UUIDs prevent key guessing / enumeration
 */
import crypto from "node:crypto";

export type MediaCategory = "video" | "image";

export type KeyPurpose =
  | "original"
  | "thumbnail"
  | "preview"
  | "hls_manifest"
  | "hls_segment";

/**
 * Generate a unique opaque storage key for a media object.
 *
 * @param category - "video" or "image"
 * @param extension - File extension without dot (e.g. "mp4", "webp")
 * @param purpose - What this object represents
 * @param mediaId - Optional existing media UUID (for related objects like thumbnails)
 */
export function generateStorageKey(
  category: MediaCategory,
  extension: string,
  purpose: KeyPurpose = "original",
  mediaId?: string,
): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const id = mediaId ?? crypto.randomUUID();
  const safeExt = sanitizeExtension(extension);

  return `${category}/${year}/${month}/${id}/${purpose}.${safeExt}`;
}

/**
 * Generate a storage key for an HLS segment.
 *
 * @param mediaId - The media UUID
 * @param quality - Quality label (e.g. "720p", "1080p")
 * @param segmentNumber - Zero-padded segment index
 */
export function generateHlsSegmentKey(
  mediaId: string,
  quality: string,
  segmentNumber: number,
): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const segNum = String(segmentNumber).padStart(5, "0");

  return `video/${year}/${month}/${mediaId}/hls/${quality}/segment_${segNum}.ts`;
}

/**
 * Generate a storage key for an HLS manifest (m3u8).
 */
export function generateHlsManifestKey(
  mediaId: string,
  quality?: string,
): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");

  if (quality) {
    return `video/${year}/${month}/${mediaId}/hls/${quality}/playlist.m3u8`;
  }
  return `video/${year}/${month}/${mediaId}/hls/master.m3u8`;
}

/**
 * Extract the media ID from a storage key.
 * Returns null if the key format is unrecognized.
 */
export function extractMediaIdFromKey(key: string): string | null {
  // Expected format: {type}/{year}/{month}/{uuid}/{purpose}.{ext}
  const parts = key.split("/");
  if (parts.length < 4) return null;
  // The UUID is always the 4th segment (index 3)
  const uuid = parts[3];
  // Basic UUID format validation
  if (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uuid)
  ) {
    return uuid;
  }
  return null;
}

/**
 * Get all related storage key prefixes for a media item.
 * Useful for bulk deletion of a media item and all its variants.
 */
export function getMediaKeyPrefix(
  category: MediaCategory,
  mediaId: string,
  uploadDate: Date,
): string {
  const year = uploadDate.getFullYear();
  const month = String(uploadDate.getMonth() + 1).padStart(2, "0");
  return `${category}/${year}/${month}/${mediaId}/`;
}

/**
 * Sanitize a file extension: lowercase, strip dots, alphanumeric + limited chars only.
 */
function sanitizeExtension(ext: string): string {
  return (
    ext
      .toLowerCase()
      .replace(/^\.+/, "")
      .replace(/[^a-z0-9]/g, "")
      .substring(0, 10) || "bin"
  );
}
