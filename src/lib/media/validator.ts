import { getEnv } from "@/lib/validation/env";
/**
 * Media file validation.
 * Validates file type, size, and magic bytes (file signature) before accepting uploads.
 *
 * @module lib/media/validator
 * @security
 *   - Validates MIME type against allowlist
 *   - Checks file signature (magic bytes) to prevent type spoofing
 *   - Enforces file size limits
 *   - NEVER trusts the client-provided Content-Type alone
 */

// ─── Allowed Types ──────────────────────────────────────────

function getAllowedTypes(): { video: string[]; image: string[] } {
  const videoStr = getEnv().ALLOWED_VIDEO_TYPES;
  const imageStr = getEnv().ALLOWED_IMAGE_TYPES;

  return {
    video: videoStr.split(",").map((t) => t.trim().toLowerCase()),
    image: imageStr.split(",").map((t) => t.trim().toLowerCase()),
  };
}

function getMaxUploadSize(): number {
  return getEnv().MAX_UPLOAD_SIZE; // 10GB
}

// ─── MIME type mapping ──────────────────────────────────────

const EXTENSION_TO_MIME: Record<string, string> = {
  mp4: "video/mp4",
  webm: "video/webm",
  mkv: "video/x-matroska",
  mov: "video/quicktime",
  avi: "video/x-msvideo",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  heic: "image/heic",
};

const MIME_TO_EXTENSION: Record<string, string> = {
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/x-matroska": "mkv",
  "video/quicktime": "mov",
  "video/x-msvideo": "avi",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/heic": "heic",
};

// ─── Magic bytes (file signatures) ──────────────────────────

// ─── Validation Types ───────────────────────────────────────

export type MediaType = "IMAGE" | "VIDEO";

export interface ValidationResult {
  valid: boolean;
  error?: string;
  mediaType?: MediaType;
  mimeType?: string;
  extension?: string;
}

// ─── Public API ─────────────────────────────────────────────

/**
 * Validate a file's extension against the allowlist.
 */
export function validateFileExtension(filename: string): ValidationResult {
  const ext = extractExtension(filename);
  if (!ext) {
    return { valid: false, error: "File has no extension" };
  }

  const allowed = getAllowedTypes();

  if (allowed.video.includes(ext)) {
    const mimeType = EXTENSION_TO_MIME[ext] ?? "application/octet-stream";
    return { valid: true, mediaType: "VIDEO", mimeType, extension: ext };
  }

  if (allowed.image.includes(ext)) {
    const mimeType = EXTENSION_TO_MIME[ext] ?? "application/octet-stream";
    return { valid: true, mediaType: "IMAGE", mimeType, extension: ext };
  }

  return {
    valid: false,
    error: `File type '.${ext}' is not allowed. Allowed: ${[...allowed.video, ...allowed.image].join(", ")}`,
  };
}

/**
 * Validate a Content-Type (MIME type) against the allowlist.
 */
export function validateMimeType(contentType: string): ValidationResult {
  const mime = contentType.split(";")[0].trim().toLowerCase();
  const ext = MIME_TO_EXTENSION[mime];

  if (!ext) {
    return { valid: false, error: `MIME type '${mime}' is not recognized` };
  }

  return validateFileExtension(`file.${ext}`);
}

/**
 * Validate file size against the configured maximum.
 */
export function validateFileSize(sizeBytes: number): ValidationResult {
  const maxSize = getMaxUploadSize();

  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) {
    return { valid: false, error: "File size must be greater than 0" };
  }

  if (sizeBytes > maxSize) {
    const maxMB = Math.round(maxSize / (1024 * 1024));
    return { valid: false, error: `File exceeds maximum size of ${maxMB} MB` };
  }

  return { valid: true };
}

/**
 * Validate file magic bytes (file signature) to prevent type spoofing.
 * Call this with the first 16+ bytes of the file.
 *
 * @param header - The first N bytes of the file (at least 16)
 * @param declaredMime - The MIME type declared by the client
 */
export function validateMagicBytes(
  header: Buffer,
  declaredMime: string,
): ValidationResult {
  const mime = declaredMime.split(";")[0].trim().toLowerCase();
  const text = (offset: number, length: number) =>
    header.subarray(offset, offset + length).toString("ascii");
  let valid = false;
  switch (mime) {
    case "image/jpeg":
      valid =
        header.length >= 3 &&
        header.subarray(0, 3).equals(Buffer.from([255, 216, 255]));
      break;
    case "image/png":
      valid = header
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      break;
    case "image/gif":
      valid = ["GIF87a", "GIF89a"].includes(text(0, 6));
      break;
    case "image/webp":
      valid =
        header.length >= 12 && text(0, 4) === "RIFF" && text(8, 4) === "WEBP";
      break;
    case "video/x-msvideo":
      valid =
        header.length >= 12 && text(0, 4) === "RIFF" && text(8, 4) === "AVI ";
      break;
    case "video/webm":
    case "video/x-matroska":
      valid =
        header.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163])) &&
        header.includes(
          Buffer.from(mime === "video/webm" ? "webm" : "matroska"),
        );
      break;
    case "image/heic":
    case "video/mp4":
    case "video/quicktime": {
      if (header.length < 16 || text(4, 4) !== "ftyp") break;
      const brand = text(8, 4);
      const heic = [
        "heic",
        "heix",
        "hevc",
        "hevx",
        "heim",
        "heis",
        "hevm",
        "hevs",
      ];
      valid =
        mime === "image/heic"
          ? heic.includes(brand)
          : mime === "video/quicktime"
            ? brand === "qt  "
            : [
                "isom",
                "iso2",
                "iso3",
                "iso4",
                "iso5",
                "iso6",
                "mp41",
                "mp42",
                "avc1",
                "M4V ",
                "MSNV",
                "dash",
              ].includes(brand);
      break;
    }
  }
  return valid
    ? { valid: true }
    : {
        valid: false,
        error: "File signature does not match its declared media type",
      };
}

/**
 * Full validation pipeline for an upload.
 *
 * @param filename - Original filename
 * @param contentType - Client-declared MIME type
 * @param sizeBytes - File size in bytes
 * @param headerBytes - First 16+ bytes of the file (for magic byte check)
 */
export function validateUpload(
  filename: string,
  contentType: string,
  sizeBytes: number,
  headerBytes?: Buffer,
): ValidationResult {
  // 1. Validate extension
  const extResult = validateFileExtension(filename);
  if (!extResult.valid) return extResult;

  // 2. Validate file size
  const sizeResult = validateFileSize(sizeBytes);
  if (!sizeResult.valid) return sizeResult;

  const mime = contentType.split(";")[0].trim().toLowerCase();
  if (!validateMimeType(mime).valid || mime !== extResult.mimeType)
    return { valid: false, error: "Filename and media type do not match" };
  if (!headerBytes)
    return { valid: false, error: "File signature is required" };
  const magicResult = validateMagicBytes(headerBytes, mime);
  if (!magicResult.valid) return magicResult;
  return extResult;
}

// ─── Helpers ────────────────────────────────────────────────

function extractExtension(filename: string): string | null {
  const lastDot = filename.lastIndexOf(".");
  if (lastDot === -1 || lastDot === filename.length - 1) return null;
  return filename.substring(lastDot + 1).toLowerCase();
}

/**
 * Get the extension for a MIME type.
 */
export function mimeToExtension(mime: string): string | null {
  const normalized = mime.split(";")[0].trim().toLowerCase();
  return MIME_TO_EXTENSION[normalized] ?? null;
}

/**
 * Get the MIME type for a file extension.
 */
export function extensionToMime(ext: string): string | null {
  const normalized = ext.toLowerCase().replace(/^\./, "");
  return EXTENSION_TO_MIME[normalized] ?? null;
}
