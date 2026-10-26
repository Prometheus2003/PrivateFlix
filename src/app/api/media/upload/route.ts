import { NextRequest, NextResponse } from "next/server";
import { Readable } from "node:stream";
import type { ReadableStream } from "node:stream/web";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireAuth } from "@/lib/auth/require-auth";
import { assertSameOrigin, authError, authFailure } from "@/lib/auth/http";
import { prisma } from "@/lib/db/prisma";
import { storage } from "@/lib/storage";
import { generateUploadKey as generateStorageKey } from "@/lib/storage/upload-key";
import { validateFileExtension, validateFileSize } from "@/lib/media/validator";
import {
  validatedUploadStream,
  UploadValidationError,
} from "@/lib/media/upload-stream";
export const runtime = "nodejs";
const filenameSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[^/\\\u0000-\u001f\u007f]+$/);

export async function POST(request: NextRequest) {
  let reserved:
    | { id: string; mediaId: string; key: string; ownerId: string }
    | undefined;
  let source: Readable | undefined;
  let stream: Readable | undefined;
  try {
    const { user } = await requireAuth(request);
    assertSameOrigin(request);
    if (request.headers.has("content-encoding"))
      throw authError(415, "Compressed request bodies are not supported");
    const encodedName = request.headers.get("x-filename") ?? "";
    if (encodedName.length > 2048) throw authError(400, "Invalid filename");
    let filename: string;
    try {
      filename = filenameSchema.parse(decodeURIComponent(encodedName));
    } catch {
      throw authError(400, "Invalid filename");
    }
    const length = request.headers.get("content-length");
    if (!length || !/^[1-9][0-9]*$/.test(length))
      throw authError(411, "A positive Content-Length is required");
    const expected = Number(length);
    if (!validateFileSize(expected).valid)
      throw authError(413, "Invalid upload size");
    const extension = validateFileExtension(filename);
    const mime = request.headers
      .get("content-type")
      ?.split(";")[0]
      .trim()
      .toLowerCase();
    if (
      !extension.valid ||
      !extension.mimeType ||
      !extension.extension ||
      !extension.mediaType ||
      mime !== extension.mimeType
    )
      throw authError(415, "Unsupported or mismatched media type");
    if (!request.body) throw authError(400, "Upload body required");
    const id = randomUUID();
    const key = generateStorageKey(
      extension.mediaType === "IMAGE" ? "image" : "video",
      extension.extension,
      "original",
      id,
    );
    const upload = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(7253403)");
      if (
        (await tx.upload.count({
          where: { ownerId: user.id, status: "UPLOADING" },
        })) >= 3
      )
        throw authError(429, "Too many active uploads");
      await tx.media.create({
        data: {
          id,
          ownerId: user.id,
          type: extension.mediaType!,
          title: filename,
          originalFilename: filename,
          storageKey: key,
          mimeType: mime,
          fileSize: BigInt(expected),
          processingStatus: "UPLOADING",
        },
      });
      return tx.upload.create({
        data: {
          ownerId: user.id,
          mediaId: id,
          status: "UPLOADING",
          totalBytes: BigInt(expected),
        },
        select: { id: true },
      });
    });
    reserved = { id: upload.id, mediaId: id, key, ownerId: user.id };
    source = Readable.fromWeb(request.body as ReadableStream<Uint8Array>);
    const signal = AbortSignal.any([
      request.signal,
      AbortSignal.timeout(10 * 60 * 1000),
    ]);
    const verified = validatedUploadStream(
      source,
      filename,
      mime,
      expected,
      signal,
    );
    stream = verified.stream;
    await storage.putObject(key, stream, {
      contentType: mime,
      contentLength: expected,
    });
    const result = verified.result();
    await requireAuth(request); // A revoked/expired session cannot finalize a long upload.
    await prisma.$transaction(async (tx) => {
      await tx.media.update({
        where: { id, ownerId: user.id },
        data: {
          checksum: result.checksum,
          uploadedAt: new Date(),
          processingStatus: "UPLOADED",
        },
      });
      await tx.upload.update({
        where: { id: upload.id, ownerId: user.id },
        data: { status: "UPLOADED", bytesUploaded: BigInt(result.bytes) },
      });
      await tx.processingJob.create({
        data: { mediaId: id, type: "METADATA" },
      });
      await tx.auditEvent.create({
        data: {
          userId: user.id,
          action: "media_uploaded",
          resourceType: "media",
          resourceId: id,
        },
      });
    });
    return NextResponse.json(
      {
        media: {
          id,
          title: filename,
          type: extension.mediaType,
          mimeType: mime,
          fileSize: expected,
          processingStatus: "UPLOADED",
        },
        uploadId: upload.id,
      },
      { status: 201, headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    stream?.destroy();
    source?.destroy();
    if (reserved) {
      const item = reserved;
      // Persist cleanup intent before attempting storage cleanup. Never lose the opaque key.
      try {
        await prisma.$transaction([
          prisma.media.update({
            where: { id: item.mediaId, ownerId: item.ownerId },
            data: {
              processingStatus: "FAILED",
              processingError: "Upload failed",
            },
          }),
          prisma.upload.update({
            where: { id: item.id, ownerId: item.ownerId },
            data: { status: "FAILED", errorMessage: "Upload failed" },
          }),
          prisma.processingJob.create({
            data: { mediaId: item.mediaId, type: "CLEANUP" },
          }),
        ]);
        await storage.deleteObject(item.key);
      } catch {
        console.error("[UPLOAD] Cleanup pending");
      }
    }
    if (error instanceof UploadValidationError)
      return authError(400, error.message);
    if (request.signal.aborted) return authError(408, "Upload cancelled");
    return authFailure(error);
  } finally {
    stream?.destroy();
    source?.destroy();
  }
}
