import { NextRequest } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/auth/require-auth";
import { assertSameOrigin, authError, authFailure } from "@/lib/auth/http";
import { prisma } from "@/lib/db/prisma";
import { storage } from "@/lib/storage";
import { libraryBody, libraryId, libraryJson } from "@/lib/media/library-http";
import { mediaMutationLock } from "@/lib/media/bulk";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };
export async function POST(request: NextRequest, context: Context) {
  try {
    const { user } = await requireAuth(request);
    assertSameOrigin(request);
    const id = libraryId((await context.params).id);
    await libraryBody(request, z.object({ confirm: z.literal(true) }).strict());
    const original = await prisma.media.findFirst({
      where: { id, ownerId: user.id, deletedAt: null },
      select: {
        id: true,
        storageKey: true,
        fileSize: true,
        checksum: true,
        processingStatus: true,
      },
    });
    if (!original) throw authError(404, "Media not found");
    if (
      original.processingStatus !== "FAILED" ||
      !original.checksum ||
      !/^[a-f0-9]{64}$/.test(original.checksum) ||
      original.fileSize <= BigInt(0)
    )
      throw authError(
        409,
        "Only a verified original with failed processing can be retried",
      );
    if (
      !(await prisma.processingJob.findFirst({
        where: { mediaId: id, type: "METADATA", status: "FAILED" },
        select: { id: true },
      }))
    )
      throw authError(
        409,
        "This upload must be uploaded again before it can be processed",
      );
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const metadata = await Promise.race([
        storage.getObjectMetadata(original.storageKey),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Storage deadline")),
            10000,
          );
          timer.unref();
        }),
      ]);
      if (BigInt(metadata.contentLength) !== original.fileSize)
        throw new Error("Length mismatch");
    } catch {
      throw authError(
        409,
        "The original could not be verified in storage. Check storage before retrying.",
      );
    } finally {
      if (timer) clearTimeout(timer);
    }
    await requireAuth(request);
    const now = new Date();
    await prisma.$transaction(async (tx) => {
      await mediaMutationLock(tx);
      const media = await tx.media.findFirst({
        where: { id, ownerId: user.id, deletedAt: null },
        select: {
          processingStatus: true,
          storageKey: true,
          checksum: true,
          fileSize: true,
        },
      });
      if (!media) throw authError(404, "Media not found");
      if (
        media.processingStatus !== "FAILED" ||
        media.storageKey !== original.storageKey ||
        media.checksum !== original.checksum ||
        media.fileSize !== original.fileSize
      )
        throw authError(409, "Media changed. Refresh before retrying.");
      if (
        await tx.processingJob.findFirst({
          where: {
            mediaId: id,
            OR: [
              { type: "METADATA", status: { in: ["QUEUED", "PROCESSING"] } },
              { type: "CLEANUP", status: { in: ["QUEUED", "PROCESSING"] } },
            ],
          },
          select: { id: true },
        })
      )
        throw authError(409, "A media operation is already pending");
      if (
        await tx.upload.findFirst({
          where: {
            ownerId: user.id,
            mediaId: id,
            status: { in: ["PENDING", "UPLOADING"] },
          },
          select: { id: true },
        })
      )
        throw authError(409, "The upload has not finished");
      const last = await tx.auditEvent.findFirst({
        where: {
          userId: user.id,
          resourceId: id,
          action: "media_processing_retried",
        },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true },
      });
      if (last && now.getTime() - last.createdAt.getTime() < 60000)
        throw authError(
          429,
          "Wait one minute before retrying this media again",
        );
      if (
        (await tx.auditEvent.count({
          where: {
            userId: user.id,
            resourceId: id,
            action: "media_processing_retried",
            createdAt: { gte: new Date(now.getTime() - 86400000) },
          },
        })) >= 5
      )
        throw authError(429, "Processing retry limit reached for today (5)");
      await tx.media.update({
        where: { id, ownerId: user.id },
        data: { processingStatus: "UPLOADED", processingError: null },
      });
      await tx.upload.updateMany({
        where: { ownerId: user.id, mediaId: id, status: "FAILED" },
        data: { status: "UPLOADED", errorMessage: null },
      });
      await tx.processingJob.create({
        data: { mediaId: id, type: "METADATA" },
      });
      await tx.auditEvent.create({
        data: {
          userId: user.id,
          action: "media_processing_retried",
          resourceType: "media",
          resourceId: id,
        },
      });
    });
    return libraryJson({ queued: true }, 202);
  } catch (error) {
    return authFailure(error);
  }
}
