import "server-only";
import { prisma } from "@/lib/db/prisma";
import { storage } from "@/lib/storage";

const HOUR = 60 * 60 * 1000;
/** Bounded maintenance pass. Terminal records and opaque keys are retained for audit. */
export async function runUploadMaintenance(now = new Date()) {
  const stale = new Date(now.getTime() - 24 * HOUR);
  const abandoned = await prisma.upload.findMany({
    where: {
      status: "UPLOADING",
      partSize: { not: null },
      completionStarted: false,
      updatedAt: { lt: stale },
      OR: [{ operationToken: null }, { operationExpiresAt: { lt: now } }],
    },
    select: { id: true, ownerId: true, mediaId: true },
    take: 100,
    orderBy: { updatedAt: "asc" },
  });
  let expired = 0;
  for (const upload of abandoned) {
    if (!upload.mediaId) continue;
    const mediaId = upload.mediaId;
    expired += await prisma.$transaction(async (tx) => {
      const changed = await tx.upload.updateMany({
        where: {
          id: upload.id,
          ownerId: upload.ownerId,
          status: "UPLOADING",
          completionStarted: false,
          updatedAt: { lt: stale },
          OR: [{ operationToken: null }, { operationExpiresAt: { lt: now } }],
        },
        data: {
          status: "CANCELLED",
          errorMessage: "Upload expired after 24 hours of inactivity",
          operationToken: null,
          operationExpiresAt: null,
        },
      });
      if (!changed.count) return 0;
      await tx.media.update({
        where: { id: mediaId, ownerId: upload.ownerId },
        data: {
          processingStatus: "FAILED",
          processingError: "Upload expired",
          deletedAt: now,
        },
      });
      await tx.processingJob.create({ data: { mediaId, type: "CLEANUP" } });
      return 1;
    });
  }
  let cleaned = 0,
    failed = 0;
  try {
    await storage.cleanupStaging?.();
  } catch {
    failed++;
  }
  for (let i = 0; i < 20; i++) {
    const job = await prisma.$transaction(async (tx) => {
      // Claim atomically across app processes; do not hold a transaction during S3 I/O.
      await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(7253404)");
      const next = await tx.processingJob.findFirst({
        where: {
          type: "CLEANUP",
          OR: [
            {
              status: "QUEUED",
              createdAt: { lt: new Date(now.getTime() - HOUR / 2) },
              OR: [
                { startedAt: null },
                { startedAt: { lt: new Date(now.getTime() - HOUR / 2) } },
              ],
            },
            {
              status: "PROCESSING",
              startedAt: { lt: new Date(now.getTime() - HOUR) },
            },
          ],
        },
        orderBy: { createdAt: "asc" },
      });
      if (!next) return null;
      if (next.attempts >= next.maxAttempts) {
        await tx.processingJob.update({
          where: { id: next.id },
          data: {
            status: "FAILED",
            errorMessage: "Cleanup retry limit reached",
          },
        });
        return { exhausted: true as const, ...next };
      }
      return {
        exhausted: false as const,
        ...(await tx.processingJob.update({
          where: { id: next.id },
          data: {
            status: "PROCESSING",
            startedAt: now,
            attempts: { increment: 1 },
            errorMessage: null,
          },
        })),
      };
    });
    if (!job) break;
    if (job.exhausted) {
      failed++;
      continue;
    }
    try {
      const media = await prisma.media.findUnique({
        where: { id: job.mediaId },
        select: {
          id: true,
          ownerId: true,
          processingStatus: true,
          storageKey: true,
        },
      });
      // Stale cleanup intent must never delete a successful or still-active media item.
      if (media && media.processingStatus === "FAILED") {
        const uploads = await prisma.upload.findMany({
          where: { mediaId: media.id, ownerId: media.ownerId },
          select: { id: true, status: true, storageUploadId: true },
          take: 101,
        });
        if (
          uploads.length > 100 ||
          uploads.some((u) => !["FAILED", "CANCELLED"].includes(u.status))
        )
          throw new Error("Cleanup state conflict");
        for (const upload of uploads) {
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
        }
        await storage.deleteObject(media.storageKey);
      }
      await prisma.processingJob.updateMany({
        where: {
          id: job.id,
          status: "PROCESSING",
          attempts: job.attempts,
          startedAt: now,
        },
        data: { status: "COMPLETED", completedAt: now },
      });
      cleaned++;
    } catch {
      await prisma.processingJob.updateMany({
        where: {
          id: job.id,
          status: "PROCESSING",
          attempts: job.attempts,
          startedAt: now,
        },
        data: {
          status: job.attempts >= job.maxAttempts ? "FAILED" : "QUEUED",
          errorMessage:
            job.attempts >= job.maxAttempts
              ? "Storage cleanup failed; retry limit reached"
              : "Storage cleanup failed; retry pending",
        },
      });
      failed++;
    }
  }
  return { expired, cleaned, failed };
}

const globalMaintenance = globalThis as typeof globalThis & {
  privateflixMaintenance?: ReturnType<typeof setInterval>;
};
export function startUploadMaintenance() {
  if (globalMaintenance.privateflixMaintenance) return;
  let running = false;
  globalMaintenance.privateflixMaintenance = setInterval(() => {
    if (running) return;
    running = true;
    void runUploadMaintenance()
      .then((result) => {
        if (result.failed) console.error("[UPLOAD] Cleanup needs attention");
      })
      .catch(() => console.error("[UPLOAD] Maintenance unavailable"))
      .finally(() => {
        running = false;
      });
  }, 60_000);
  globalMaintenance.privateflixMaintenance.unref();
}
