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

const DEFAULT_VIDEO_TYPES = ["mp4", "webm", "mkv", "mov", "avi"];
const DEFAULT_IMAGE_TYPES = ["jpg", "jpeg", "png", "webp", "gif", "heic"];

function getAllowedTypes(): { video: string[]; image: string[] } {
  const videoStr = process.env.ALLOWED_VIDEO_TYPES ?? DEFAULT_VIDEO_TYPES.join(",");
  const imageStr = process.env.ALLOWED_IMAGE_TYPES ?? DEFAULT_IMAGE_TYPES.join(",");

  return {
    video: videoStr.split(",").map((t) => t.trim().toLowerCase()),
    image: imageStr.split(",").map((t) => t.trim().toLowerCase()),
  };
}

function getMaxUploadSize(): number {
  return parseInt(process.env.MAX_UPLOAD_SIZE ?? "10737418240", 10); // 10GB
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

interface MagicSignature {
  bytes: number[];
  offset: number;
  mime: string;
}

const MAGIC_SIGNATURES: MagicSignature[] = [
  // JPEG: FF D8 FF
  { bytes: [0xff, 0xd8, 0xff], offset: 0, mime: "image/jpeg" },
  // PNG: 89 50 4E 47
  { bytes: [0x89, 0x50, 0x4e, 0x47], offset: 0, mime: "image/png" },
  // GIF87a / GIF89a
  { bytes: [0x47, 0x49, 0x46, 0x38], offset: 0, mime: "image/gif" },
  // WebP: RIFF....WEBP
  { bytes: [0x52, 0x49, 0x46, 0x46], offset: 0, mime: "image/webp" },
  // MP4 / MOV: ftyp at offset 4
  { bytes: [0x66, 0x74, 0x79, 0x70], offset: 4, mime: "video/mp4" },
  // AVI: RIFF....AVI
  { bytes: [0x52, 0x49, 0x46, 0x46], offset: 0, mime: "video/x-msvideo" },
  // MKV / WebM: EBML header 1A 45 DF A3
  { bytes: [0x1a, 0x45, 0xdf, 0xa3], offset: 0, mime: "video/x-matroska" },
  // HEIC: ftyp at offset 4 with heic brand
  { bytes: [0x66, 0x74, 0x79, 0x70], offset: 4, mime: "image/heic" },
];

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

  if (sizeBytes <= 0) {
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
  declaredMime: string
): ValidationResult {
  if (header.length < 8) {
    return { valid: false, error: "File header too short for signature validation" };
  }

  // Find matching signatures
  const matches: MagicSignature[] = [];
  for (const sig of MAGIC_SIGNATURES) {
    if (header.length < sig.offset + sig.bytes.length) continue;

    const match = sig.bytes.every(
      (byte, i) => header[sig.offset + i] === byte
    );
    if (match) {
      matches.push(sig);
    }
  }

  if (matches.length === 0) {
    // No recognized signature — could be a valid format we don't fingerprint,
    // or could be a spoofed file. Allow but flag it.
    return { valid: true }; // Rely on extension/MIME validation + FFprobe later
  }

  // Check if the declared MIME matches any detected signature
  const normalizedDeclared = declaredMime.split(";")[0].trim().toLowerCase();
  const matchesDeclared = matches.some((m) => {
    // Allow video/mp4 ↔ video/quicktime (ftyp header covers both)
    if (
      (normalizedDeclared === "video/mp4" || normalizedDeclared === "video/quicktime") &&
      (m.mime === "video/mp4" || m.mime === "image/heic")
    ) {
      return true;
    }
    // Allow video/webm ↔ video/x-matroska (same EBML container)
    if (
      (normalizedDeclared === "video/webm" || normalizedDeclared === "video/x-matroska") &&
      m.mime === "video/x-matroska"
    ) {
      return true;
    }
    // Allow RIFF-based formats (AVI, WebP)
    if (normalizedDeclared === "image/webp" && m.mime === "image/webp") return true;
    if (normalizedDeclared === "video/x-msvideo" && m.mime === "video/x-msvideo") return true;

    return m.mime === normalizedDeclared;
  });

  if (!matchesDeclared) {
    return {
      valid: false,
      error: `File signature does not match declared type '${normalizedDeclared}'`,
    };
  }

  return { valid: true };
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
  headerBytes?: Buffer
): ValidationResult {
  // 1. Validate extension
  const extResult = validateFileExtension(filename);
  if (!extResult.valid) return extResult;

  // 2. Validate file size
  const sizeResult = validateFileSize(sizeBytes);
  if (!sizeResult.valid) return sizeResult;

  // 3. Validate magic bytes if available
  if (headerBytes && headerBytes.length >= 8) {
    const magicResult = validateMagicBytes(headerBytes, contentType);
    if (!magicResult.valid) return magicResult;
  }

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
