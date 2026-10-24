import { createHash } from "node:crypto";
import { z } from "zod";
import { validateFileSize, validateUpload } from "./validator";
import { UploadValidationError } from "./upload-stream";

export const UPLOAD_PART_SIZE = 8 * 1024 * 1024;
const partNumberSchema = z.number().int().min(1).max(10000);
const checksumSchema = z.string().regex(/^[a-f0-9]{64}$/);

/** The server chooses boundaries; a client cannot overlap or omit byte ranges. */
export function uploadPartLength(totalBytes: number, partNumber: number) {
  if (
    !validateFileSize(totalBytes).valid ||
    !partNumberSchema.safeParse(partNumber).success
  )
    throw new UploadValidationError("Invalid upload part");
  const partCount = Math.ceil(totalBytes / UPLOAD_PART_SIZE);
  if (partCount > 10000 || partNumber > partCount)
    throw new UploadValidationError("Invalid upload part");
  return Math.min(
    UPLOAD_PART_SIZE,
    totalBytes - (partNumber - 1) * UPLOAD_PART_SIZE,
  );
}

/** Buffer one bounded chunk, never the entire media file. Always verify retries by content. */
export async function readUploadPart(
  body: ReadableStream<Uint8Array>,
  input: {
    totalBytes: number;
    partNumber: number;
    checksum: string;
    filename: string;
    mime: string;
  },
  signal: AbortSignal,
) {
  const expected = uploadPartLength(input.totalBytes, input.partNumber);
  if (!checksumSchema.safeParse(input.checksum).success)
    throw new UploadValidationError("Invalid part checksum");
  signal.throwIfAborted();
  const reader = body.getReader();
  const buffer = Buffer.alloc(expected);
  let received = 0;
  // Cancellation unblocks a stalled reader. Callers supply a request/deadline signal.
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      if (received + value.byteLength > expected)
        throw new UploadValidationError("Part exceeds its expected size");
      buffer.set(value, received);
      received += value.byteLength;
    }
    if (received !== expected)
      throw new UploadValidationError("Part ended before its expected size");
    const checksum = createHash("sha256").update(buffer).digest("hex");
    if (checksum !== input.checksum)
      throw new UploadValidationError("Part checksum does not match");
    if (input.partNumber === 1) {
      const validation = validateUpload(
        input.filename,
        input.mime,
        input.totalBytes,
        buffer.subarray(0, 512),
      );
      if (!validation.valid)
        throw new UploadValidationError(validation.error ?? "Invalid media");
    }
    return { body: buffer, checksum, byteLength: received };
  } finally {
    signal.removeEventListener("abort", abort);
    void reader.cancel().catch(() => {});
  }
}
