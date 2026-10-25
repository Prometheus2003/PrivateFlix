import "server-only";
import { randomUUID, createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm, stat, mkdir } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { storage } from "@/lib/storage";
import { getEnv } from "@/lib/validation/env";
import { probeMedia, createThumbnail } from "./processor-tools";
export async function processMediaJob(
  id: string,
  workspace: string,
  shutdown?: AbortSignal,
) {
  z.string().uuid().parse(id);
  const token = randomUUID(),
    now = new Date();
  const job = await prisma.$transaction(async (tx) => {
    const claim = await tx.processingJob.updateMany({
      where: {
        id,
        type: "METADATA",
        OR: [
          { status: "QUEUED" },
          { status: "PROCESSING", leaseExpiresAt: { lt: now } },
        ],
      },
      data: {
        status: "PROCESSING",
        leaseToken: token,
        leaseExpiresAt: new Date(now.getTime() + 30 * 60000),
        startedAt: now,
      },
    });
    if (!claim.count) return null;
    const found = await tx.processingJob.findUniqueOrThrow({
      where: { id },
      include: { media: true },
    });
    if (found.attempts >= found.maxAttempts) {
      await tx.processingJob.update({
        where: { id },
        data: {
          status: "FAILED",
          errorMessage: "Processing retry limit reached",
          leaseToken: null,
          leaseExpiresAt: null,
        },
      });
      await tx.media.updateMany({
        where: {
          id: found.mediaId,
          ownerId: found.media.ownerId,
          processingStatus: { in: ["UPLOADED", "PROCESSING"] },
        },
        data: {
          processingStatus: "FAILED",
          processingError: "Processing retry limit reached",
        },
      });
      return null;
    }
    if (
      found.media.deletedAt ||
      !["UPLOADED", "PROCESSING"].includes(found.media.processingStatus)
    ) {
      await tx.processingJob.update({
        where: { id },
        data: {
          status: "COMPLETED",
          completedAt: now,
          leaseToken: null,
          leaseExpiresAt: null,
        },
      });
      return null;
    }
    await tx.processingJob.update({
      where: { id },
      data: { attempts: { increment: 1 } },
    });
    await tx.media.update({
      where: { id: found.mediaId, ownerId: found.media.ownerId },
      data: { processingStatus: "PROCESSING", processingError: null },
    });
    return { ...found, attempts: found.attempts + 1 };
  });
  if (!job) return;
  const root = resolve(workspace);
  let directory: string | undefined,
    thumbnailKey: string | undefined,
    published = false;
  const signal = AbortSignal.any([
    AbortSignal.timeout(getEnv().FFMPEG_TIMEOUT * 1000),
    ...(shutdown ? [shutdown] : []),
  ]);
  try {
    await mkdir(root, { recursive: true, mode: 0o700 });
    directory = await mkdtemp(join(root, "job-"));
    const input = join(directory, "original"),
      output = join(directory, "thumbnail.jpg");
    const object = await storage.getObject(job.media.storageKey);
    const expected = Number(job.media.fileSize);
    if (
      !Number.isSafeInteger(expected) ||
      expected <= 0 ||
      expected > getEnv().MAX_UPLOAD_SIZE ||
      object.metadata.contentLength !== expected
    ) {
      object.stream.destroy();
      throw new Error("Invalid original size");
    }
    let bytes = 0;
    const hash = createHash("sha256");
    const bounded = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > expected)
          callback(new Error("Original exceeds declared size"));
        else {
          hash.update(chunk);
          callback(null, chunk);
        }
      },
    });
    await pipeline(
      object.stream,
      bounded,
      createWriteStream(input, { flags: "wx", mode: 0o600 }),
      { signal },
    );
    if (
      bytes !== expected ||
      !job.media.checksum ||
      hash.digest("hex") !== job.media.checksum
    )
      throw new Error("Original checksum mismatch");
    const metadata = await probeMedia(input, job.media.type, signal);
    await createThumbnail(input, output, metadata.streamIndex, signal);
    const result = await stat(output);
    if (!result.isFile() || result.size <= 0 || result.size > 4 * 1024 * 1024)
      throw new Error("Invalid thumbnail size");
    signal.throwIfAborted();
    thumbnailKey =
      job.media.storageKey.substring(
        0,
        job.media.storageKey.lastIndexOf("/") + 1,
      ) +
      "thumbnail-" +
      token +
      ".jpg";
    const thumbnailStream = createReadStream(output);
    try {
      await storage.putObject(thumbnailKey, thumbnailStream, {
        contentType: "image/jpeg",
        contentLength: result.size,
      });
    } finally {
      thumbnailStream.destroy();
    }
    signal.throwIfAborted();
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.processingJob.updateMany({
        where: { id, status: "PROCESSING", leaseToken: token },
        data: {
          status: "COMPLETED",
          completedAt: new Date(),
          leaseToken: null,
          leaseExpiresAt: null,
          errorMessage: null,
        },
      });
      if (!claimed.count) throw new Error("Processing lease lost");
      const media = await tx.media.updateMany({
        where: {
          id: job.mediaId,
          ownerId: job.media.ownerId,
          deletedAt: null,
          processingStatus: "PROCESSING",
        },
        data: {
          width: metadata.width,
          height: metadata.height,
          duration: metadata.duration,
          codec: metadata.codec,
          bitrate: metadata.bitrate,
          thumbnailStorageKey: thumbnailKey,
          processingStatus: "READY",
          processingError: null,
        },
      });
      if (!media.count) throw new Error("Media changed during processing");
      await tx.upload.updateMany({
        where: {
          mediaId: job.mediaId,
          ownerId: job.media.ownerId,
          status: { in: ["UPLOADED", "PROCESSING"] },
        },
        data: { status: "READY" },
      });
    });
    published = true;
  } catch {
    await prisma.$transaction(async (tx) => {
      const failed = job.attempts >= job.maxAttempts;
      const changed = await tx.processingJob.updateMany({
        where: { id, status: "PROCESSING", leaseToken: token },
        data: {
          status: failed ? "FAILED" : "QUEUED",
          leaseToken: null,
          leaseExpiresAt: null,
          errorMessage: "Media processing failed",
        },
      });
      if (changed.count)
        await tx.media.updateMany({
          where: {
            id: job.mediaId,
            ownerId: job.media.ownerId,
            processingStatus: "PROCESSING",
          },
          data: {
            processingStatus: failed ? "FAILED" : "UPLOADED",
            processingError: failed ? "Media could not be processed" : null,
          },
        });
    });
  } finally {
    if (thumbnailKey && !published)
      await storage
        .deleteObject(thumbnailKey)
        .catch(() => console.error("[PROCESSING] Thumbnail cleanup pending"));
    if (directory && resolve(directory).startsWith(root + sep))
      await rm(directory, { recursive: true, force: true });
  }
}
