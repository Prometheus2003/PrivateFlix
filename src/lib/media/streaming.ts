/**
 * Byte-range streaming helpers for authenticated media delivery.
 *
 * @module lib/media/streaming
 * @security
 *   - All streaming routes MUST call requireAuth() before using these helpers
 *   - Content is never cached (Cache-Control: private, no-store)
 *   - Range requests validate bounds against actual file size
 *   - Streams pipe directly from object storage — never buffered in memory
 */
import { NextRequest, NextResponse } from "next/server";
import type { StorageAdapter, ByteRange } from "@/lib/storage/adapter";

// ─── Types ──────────────────────────────────────────────────

interface StreamOptions {
  /** Storage key for the object */
  storageKey: string;
  /** MIME type of the content */
  contentType: string;
  /** Total file size in bytes */
  fileSize: number;
  /** Optional filename for Content-Disposition */
  filename?: string;
  /** Whether this is a download (attachment) vs inline display */
  download?: boolean;
}

// ─── Range Parsing ──────────────────────────────────────────

interface ParsedRange {
  start: number;
  end: number;
}

/**
 * Parse the Range header from a request.
 * Supports: bytes=start-end, bytes=start-, bytes=-suffix
 *
 * Returns null for invalid/missing ranges.
 */
export function parseRangeHeader(
  rangeHeader: string | null,
  fileSize: number
): ParsedRange | null {
  if (!rangeHeader) return null;

  const match = rangeHeader.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return null;

  const [, startStr, endStr] = match;

  let start: number;
  let end: number;

  if (startStr === "" && endStr !== "") {
    // bytes=-500 → last 500 bytes
    const suffix = parseInt(endStr, 10);
    if (isNaN(suffix) || suffix <= 0) return null;
    start = Math.max(0, fileSize - suffix);
    end = fileSize - 1;
  } else if (startStr !== "" && endStr === "") {
    // bytes=500- → from byte 500 to end
    start = parseInt(startStr, 10);
    if (isNaN(start) || start < 0) return null;
    end = fileSize - 1;
  } else if (startStr !== "" && endStr !== "") {
    // bytes=500-999 → specific range
    start = parseInt(startStr, 10);
    end = parseInt(endStr, 10);
    if (isNaN(start) || isNaN(end) || start < 0 || end < start) return null;
  } else {
    return null;
  }

  // Clamp end to file bounds
  end = Math.min(end, fileSize - 1);

  if (start > end || start >= fileSize) {
    return null; // Invalid range
  }

  return { start, end };
}

// ─── Streaming Response ─────────────────────────────────────

/**
 * Create a streaming response for media delivery.
 * Handles both full responses (200) and partial content (206).
 *
 * @security Always call requireAuth() before calling this function.
 */
export async function createStreamingResponse(
  request: NextRequest,
  storage: StorageAdapter,
  options: StreamOptions
): Promise<NextResponse> {
  const { storageKey, contentType, fileSize, filename, download } = options;

  // Parse Range header
  const rangeHeader = request.headers.get("range");
  const range = parseRangeHeader(rangeHeader, fileSize);

  // Common security headers
  const securityHeaders: Record<string, string> = {
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "Accept-Ranges": "bytes",
  };

  // Content-Disposition
  if (download && filename) {
    securityHeaders["Content-Disposition"] =
      `attachment; filename="${sanitizeFilename(filename)}"`;
  } else if (filename) {
    securityHeaders["Content-Disposition"] =
      `inline; filename="${sanitizeFilename(filename)}"`;
  }

  try {
    if (range) {
      // 206 Partial Content
      const byteRange: ByteRange = { start: range.start, end: range.end };
      const { stream } = await storage.getObject(storageKey, byteRange);
      const contentLength = range.end - range.start + 1;

      // Convert Node.js Readable to Web ReadableStream
      const webStream = nodeReadableToWebReadable(stream);

      return new NextResponse(webStream, {
        status: 206,
        headers: {
          ...securityHeaders,
          "Content-Type": contentType,
          "Content-Length": String(contentLength),
          "Content-Range": `bytes ${range.start}-${range.end}/${fileSize}`,
        },
      });
    } else if (rangeHeader) {
      // Range header was present but invalid → 416 Range Not Satisfiable
      return new NextResponse(null, {
        status: 416,
        headers: {
          ...securityHeaders,
          "Content-Range": `bytes */${fileSize}`,
        },
      });
    } else {
      // 200 Full response
      const { stream } = await storage.getObject(storageKey);
      const webStream = nodeReadableToWebReadable(stream);

      return new NextResponse(webStream, {
        status: 200,
        headers: {
          ...securityHeaders,
          "Content-Type": contentType,
          "Content-Length": String(fileSize),
        },
      });
    }
  } catch (error) {
    console.error("[STREAM] Error streaming object:", storageKey, error);
    return NextResponse.json(
      { error: "Failed to stream media" },
      { status: 500, headers: { "Cache-Control": "private, no-store" } }
    );
  }
}

// ─── Helpers ────────────────────────────────────────────────

/**
 * Convert a Node.js Readable stream to a Web API ReadableStream.
 * Required because NextResponse expects a Web ReadableStream.
 */
function nodeReadableToWebReadable(
  nodeStream: import("node:stream").Readable
): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      nodeStream.on("data", (chunk: Buffer) => {
        controller.enqueue(new Uint8Array(chunk));
      });
      nodeStream.on("end", () => {
        controller.close();
      });
      nodeStream.on("error", (err) => {
        controller.error(err);
      });
    },
    cancel() {
      nodeStream.destroy();
    },
  });
}

/**
 * Sanitize a filename for use in Content-Disposition header.
 * Prevents header injection and removes problematic characters.
 */
function sanitizeFilename(filename: string): string {
  return filename
    .replace(/[^\w\s.\-()]/g, "_")
    .replace(/\s+/g, " ")
    .substring(0, 255)
    .trim();
}
