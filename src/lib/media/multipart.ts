import "server-only";
import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { storage } from "@/lib/storage";
import { requireAuth } from "@/lib/auth/require-auth";
import {
  assertSameOrigin,
  authError,
  authFailure,
  readAuthBody,
} from "@/lib/auth/http";
import { generateStorageKey } from "@/lib/storage/keys";
import { validateFileExtension, validateFileSize } from "./validator";
import {
  readUploadPart,
  uploadPartLength,
  UPLOAD_PART_SIZE,
} from "./upload-parts";
import { validatedUploadStream, UploadValidationError } from "./upload-stream";

const checksum = z.string().regex(/^[a-f0-9]{64}$/);
const startSchema = z
  .object({
    filename: z
      .string()
      .min(1)
      .max(255)
      .regex(/^[^/\\\u0000-\u001f\u007f]+$/),
    mime: z.string().max(100),
    totalBytes: z.number().int().positive().safe(),
    checksum,
  })
  .strict();
const json = (value: unknown, status = 200) =>
  NextResponse.json(value, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
function failure(error: unknown) {
  if (error instanceof UploadValidationError || error instanceof z.ZodError)
    return authError(400, "Invalid upload data");
  if (
    error instanceof Error &&
    ["AbortError", "TimeoutError"].includes(error.name)
  )
    return authError(408, "Upload operation timed out; retry the same part");
  return authFailure(error);
}
export async function startMultipart(request: NextRequest) {
  let reserved:
    | { id: string; mediaId: string; key: string; ownerId: string }
    | undefined;
  let storageId: string | undefined;
  try {
    const { user } = await requireAuth(request);
    assertSameOrigin(request);
    const input = startSchema.parse(await readAuthBody(request));
    if (
      !validateFileSize(input.totalBytes).valid ||
      Math.ceil(input.totalBytes / UPLOAD_PART_SIZE) > 10000
    )
      throw authError(413, "Invalid upload size");
    const type = validateFileExtension(input.filename);
    if (
      !type.valid ||
      !type.extension ||
      !type.mediaType ||
      type.mimeType !== input.mime
    )
      throw authError(415, "Unsupported media type");
    const mediaId = randomUUID();
    const key = generateStorageKey(
      type.mediaType === "IMAGE" ? "image" : "video",
      type.extension,
      "original",
      mediaId,
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
          id: mediaId,
          ownerId: user.id,
          type: type.mediaType!,
          title: input.filename,
          originalFilename: input.filename,
          storageKey: key,
          mimeType: input.mime,
          fileSize: BigInt(input.totalBytes),
          processingStatus: "UPLOADING",
        },
      });
      return tx.upload.create({
        data: {
          ownerId: user.id,
          mediaId,
          status: "UPLOADING",
          totalBytes: BigInt(input.totalBytes),
          partSize: UPLOAD_PART_SIZE,
          expectedChecksum: input.checksum,
        },
        select: { id: true },
      });
    });
    reserved = { id: upload.id, mediaId, key, ownerId: user.id };
    storageId = await storage.createMultipartUpload(key, input.mime);
    await requireAuth(request);
    const initialized = await prisma.upload.updateMany({
      where: { id: upload.id, ownerId: user.id, status: "UPLOADING" },
      data: { storageUploadId: storageId },
    });
    if (!initialized.count)
      throw authError(409, "Upload initialization expired");
    return json(
      {
        uploadId: upload.id,
        mediaId,
        partSize: UPLOAD_PART_SIZE,
        partCount: Math.ceil(input.totalBytes / UPLOAD_PART_SIZE),
      },
      201,
    );
  } catch (error) {
    if (reserved) {
      const item = reserved;
      try {
        await prisma.$transaction([
          prisma.upload.update({
            where: { id: item.id, ownerId: item.ownerId },
            data: {
              status: "FAILED",
              storageUploadId: storageId,
              errorMessage: "Upload initialization failed",
            },
          }),
          prisma.media.update({
            where: { id: item.mediaId, ownerId: item.ownerId },
            data: { processingStatus: "FAILED" },
          }),
          prisma.processingJob.create({
            data: { mediaId: item.mediaId, type: "CLEANUP" },
          }),
        ]);
        if (storageId) await storage.abortMultipartUpload(item.key, storageId);
      } catch {
        console.error("[UPLOAD] Multipart initialization cleanup pending");
      }
    }
    return failure(error);
  }
}

/** One operation per upload across app instances. Immutable part checksums fence
 * late storage writes after a lease expires: a part can only ever contain the same bytes. */
async function claim(ownerId: string, id: string) {
  z.string().uuid().parse(id);
  const token = randomUUID();
  const found = await prisma.upload.findFirst({
    where: { id, ownerId, partSize: UPLOAD_PART_SIZE },
    select: { id: true },
  });
  if (!found) throw authError(404, "Upload not found");
  const result = await prisma.upload.updateMany({
    where: {
      id,
      ownerId,
      OR: [
        { operationToken: null },
        { operationExpiresAt: { lt: new Date() } },
      ],
    },
    data: {
      operationToken: token,
      operationExpiresAt: new Date(Date.now() + 15 * 60 * 1000),
    },
  });
  if (!result.count)
    throw authError(409, "Upload operation in progress", {
      "Retry-After": "2",
    });
  return token;
}
type Action = "part" | "complete" | "cancel";
export async function mutateMultipart(
  request: NextRequest,
  id: string,
  action: Action,
  part?: string,
) {
  let lease: { ownerId: string; token: string } | undefined;
  try {
    const { user } = await requireAuth(request);
    assertSameOrigin(request);
    const token = await claim(user.id, id);
    lease = { ownerId: user.id, token };
    const upload = await prisma.upload.findFirstOrThrow({
      where: { id, ownerId: user.id, operationToken: token },
      include: { media: true },
    });
    if (!upload.media || upload.media.ownerId !== user.id)
      throw authError(404, "Upload not found");
    const media = upload.media;
    const owned = { id, ownerId: user.id, operationToken: token };
    if (action === "cancel") {
      if (
        upload.status === "UPLOADED" ||
        (upload.completionStarted && upload.status !== "FAILED")
      )
        throw authError(409, "Completion has started; retry completion");
      await prisma.$transaction(async (tx) => {
        const changed = await tx.upload.updateMany({
          where: owned,
          data: { status: "CANCELLED" },
        });
        if (!changed.count) throw authError(409, "Upload operation expired");
        await tx.media.update({
          where: { id: media.id, ownerId: user.id },
          data: {
            processingStatus: "FAILED",
            processingError: "Upload cancelled",
            deletedAt: new Date(),
          },
        });
        if (upload.status !== "CANCELLED")
          await tx.processingJob.create({
            data: { mediaId: media.id, type: "CLEANUP" },
          });
      });
      if (upload.storageUploadId) {
        try {
          await storage.abortMultipartUpload(
            media.storageKey,
            upload.storageUploadId,
          );
        } catch (error) {
          if (!(error instanceof Error && error.name === "NoSuchUpload"))
            throw error;
        }
      }
      await storage.deleteObject(media.storageKey);
      return json({ uploadId: id, status: "CANCELLED" });
    }
    if (
      action === "complete" &&
      ["UPLOADED", "PROCESSING", "READY"].includes(upload.status)
    )
      return json({ uploadId: id, mediaId: media.id, status: "UPLOADED" });
    if (upload.status !== "UPLOADING" || !upload.storageUploadId)
      throw authError(409, "Upload is not accepting data");
    if (action === "part") {
      if (upload.completionStarted)
        throw authError(409, "Completion has started");
      const partNumber = z.coerce.number().int().min(1).max(10000).parse(part);
      const expected = uploadPartLength(Number(upload.totalBytes), partNumber);
      if (
        request.headers.has("content-encoding") ||
        request.headers.get("content-type") !== "application/octet-stream"
      )
        throw authError(415, "Binary part required");
      if (request.headers.get("content-length") !== String(expected))
        throw authError(400, "Incorrect part length");
      if (!request.body) throw authError(400, "Part body required");
      const verified = await readUploadPart(
        request.body,
        {
          totalBytes: Number(upload.totalBytes),
          partNumber,
          checksum: checksum.parse(request.headers.get("x-part-sha256")),
          filename: media.originalFilename,
          mime: media.mimeType,
        },
        AbortSignal.any([request.signal, AbortSignal.timeout(120000)]),
      );
      await requireAuth(request);
      const receipt = await prisma.$transaction(async (tx) => {
        const fenced = await tx.upload.updateMany({
          where: { ...owned, status: "UPLOADING", completionStarted: false },
          data: { updatedAt: new Date() },
        });
        if (!fenced.count) throw authError(409, "Upload operation expired");
        const prior = await tx.uploadPart.findUnique({
          where: { uploadId_partNumber: { uploadId: id, partNumber } },
        });
        if (prior && prior.checksum !== verified.checksum)
          throw authError(
            409,
            "Part content cannot change; start a new upload",
          );
        return (
          prior ??
          tx.uploadPart.create({
            data: {
              uploadId: id,
              partNumber,
              byteLength: verified.byteLength,
              checksum: verified.checksum,
            },
          })
        );
      });
      if (!receipt.etag) {
        const etag = await storage.uploadPart(
          media.storageKey,
          upload.storageUploadId,
          partNumber,
          verified.body,
        );
        await requireAuth(request);
        await prisma.$transaction(async (tx) => {
          const fenced = await tx.upload.updateMany({
            where: { ...owned, status: "UPLOADING", completionStarted: false },
            data: { updatedAt: new Date() },
          });
          if (!fenced.count) throw authError(409, "Upload operation expired");
          const saved = await tx.uploadPart.updateMany({
            where: {
              uploadId: id,
              partNumber,
              etag: null,
              checksum: verified.checksum,
            },
            data: { etag },
          });
          if (saved.count)
            await tx.upload.update({
              where: owned,
              data: { bytesUploaded: { increment: verified.byteLength } },
            });
        });
      }
      return json({
        uploadId: id,
        partNumber,
        byteLength: verified.byteLength,
        checksum: verified.checksum,
      });
    }
    // Freeze the manifest durably before the external completion call. Retrying
    // after a lost S3 response uses the existing object, never accepts new parts.
    const parts = await prisma.uploadPart.findMany({
      where: { uploadId: id },
      orderBy: { partNumber: "asc" },
      take: 10000,
    });
    if (
      parts.length !==
        Math.ceil(Number(upload.totalBytes) / UPLOAD_PART_SIZE) ||
      parts.some(
        (p, i) =>
          p.partNumber !== i + 1 ||
          !p.etag ||
          p.byteLength !==
            uploadPartLength(Number(upload.totalBytes), p.partNumber),
      )
    )
      throw authError(409, "Upload has missing parts");
    const frozen = await prisma.upload.updateMany({
      where: { ...owned, status: "UPLOADING" },
      data: { completionStarted: true },
    });
    if (!frozen.count) throw authError(409, "Upload operation expired");
    if (!(await storage.objectExists(media.storageKey))) {
      try {
        await storage.completeMultipartUpload(
          media.storageKey,
          upload.storageUploadId,
          parts.map((p) => ({ partNumber: p.partNumber, etag: p.etag! })),
        );
      } catch (error) {
        if (!(await storage.objectExists(media.storageKey))) throw error;
      }
    }
    const object = await storage.getObject(media.storageKey);
    if (object.metadata.contentLength !== Number(upload.totalBytes)) {
      object.stream.destroy();
      throw new UploadValidationError("Stored length mismatch");
    }
    const checked = validatedUploadStream(
      object.stream,
      media.originalFilename,
      media.mimeType,
      Number(upload.totalBytes),
      AbortSignal.any([request.signal, AbortSignal.timeout(10 * 60 * 1000)]),
    );
    for await (const chunk of checked.stream) {
      void chunk;
    }
    const result = checked.result();
    if (result.checksum !== upload.expectedChecksum)
      throw new UploadValidationError("Stored checksum mismatch");
    await requireAuth(request);
    await prisma.$transaction(async (tx) => {
      const changed = await tx.upload.updateMany({
        where: { ...owned, status: "UPLOADING" },
        data: { status: "UPLOADED", bytesUploaded: upload.totalBytes },
      });
      if (!changed.count) throw authError(409, "Upload operation expired");
      await tx.media.update({
        where: { id: media.id, ownerId: user.id },
        data: {
          processingStatus: "UPLOADED",
          checksum: result.checksum,
          uploadedAt: new Date(),
        },
      });
      await tx.processingJob.create({
        data: { mediaId: media.id, type: "METADATA" },
      });
      await tx.auditEvent.create({
        data: {
          userId: user.id,
          action: "media_uploaded",
          resourceType: "media",
          resourceId: media.id,
        },
      });
    });
    return json({ uploadId: id, mediaId: media.id, status: "UPLOADED" });
  } catch (error) {
    if (
      action === "complete" &&
      error instanceof UploadValidationError &&
      lease
    ) {
      const currentLease = lease;
      await prisma
        .$transaction(async (tx) => {
          const found = await tx.upload.findFirst({
            where: {
              id,
              ownerId: currentLease.ownerId,
              operationToken: currentLease.token,
              status: "UPLOADING",
            },
            select: { mediaId: true },
          });
          if (!found?.mediaId) return;
          await tx.upload.update({
            where: { id, ownerId: currentLease.ownerId },
            data: {
              status: "FAILED",
              errorMessage: "Completed object failed verification",
            },
          });
          await tx.media.update({
            where: { id: found.mediaId, ownerId: currentLease.ownerId },
            data: {
              processingStatus: "FAILED",
              processingError: "Completed object failed verification",
            },
          });
          await tx.processingJob.create({
            data: { mediaId: found.mediaId, type: "CLEANUP" },
          });
        })
        .catch(() =>
          console.error("[UPLOAD] Verification failure persistence pending"),
        );
    }
    return failure(error);
  } finally {
    if (lease)
      await prisma.upload
        .updateMany({
          where: { id, ownerId: lease.ownerId, operationToken: lease.token },
          data: { operationToken: null, operationExpiresAt: null },
        })
        .catch(() => console.error("[UPLOAD] Operation lease release pending"));
  }
}
