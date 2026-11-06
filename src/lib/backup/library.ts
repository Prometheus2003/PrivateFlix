import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import {
  BackupError,
  matchesReference,
  readEntries,
  type MediaReference,
  type MediaSnapshot,
} from "./media-archive";

const preserved = {
  deletedAt: null,
  OR: [
    { processingStatus: "READY" },
    {
      processingStatus: "FAILED",
      OR: [{ uploadedAt: { not: null } }, { checksum: { not: null } }],
    },
  ],
} satisfies Prisma.MediaWhereInput;

export async function backupOwner(db: Prisma.TransactionClient = prisma) {
  const [owner, activeMedia, activeUpload, activeJob] = await Promise.all([
    db.user.findFirst({ select: { id: true } }),
    db.media.findFirst({
      where: {
        processingStatus: {
          in: ["PENDING", "UPLOADING", "UPLOADED", "PROCESSING", "DELETING"],
        },
      },
      select: { id: true },
    }),
    db.upload.findFirst({
      where: {
        status: { in: ["PENDING", "UPLOADING", "UPLOADED", "PROCESSING"] },
      },
      select: { id: true },
    }),
    db.processingJob.findFirst({
      where: {
        status: { in: ["QUEUED", "PROCESSING"] },
        type: { not: "CLEANUP" },
      },
      select: { id: true },
    }),
  ]);
  if (!owner) throw new BackupError("The database has no PrivateFlix owner");
  if (activeMedia || activeUpload || activeJob)
    throw new BackupError(
      "Finish or cancel pending uploads, processing, and deletions before backup or restore",
    );
  return owner.id;
}

export async function* mediaReferences(
  ownerId: string,
  db: Prisma.TransactionClient = prisma,
): AsyncGenerator<MediaReference> {
  let last: string | undefined;
  for (;;) {
    const page = await db.media.findMany({
      where: { ...preserved, ownerId, id: { gt: last } },
      orderBy: { id: "asc" },
      take: 100,
      select: {
        id: true,
        storageKey: true,
        fileSize: true,
        checksum: true,
        thumbnailStorageKey: true,
        previewStorageKey: true,
      },
    });
    if (!page.length) return;
    for (const media of page) {
      yield {
        mediaId: media.id,
        part: "original",
        key: media.storageKey,
        bytes: media.fileSize,
        sha256: media.checksum ?? undefined,
      };
      if (media.thumbnailStorageKey)
        yield {
          mediaId: media.id,
          part: "thumbnail",
          key: media.thumbnailStorageKey,
        };
      if (media.previewStorageKey)
        yield {
          mediaId: media.id,
          part: "preview",
          key: media.previewStorageKey,
        };
    }
    last = page[page.length - 1].id;
  }
}

export async function assertSnapshotMatches(
  folder: string,
  snapshot: MediaSnapshot,
  db: Prisma.TransactionClient = prisma,
) {
  if ((await backupOwner(db)) !== snapshot.ownerId)
    throw new BackupError("The archive belongs to a different library");
  const references = mediaReferences(snapshot.ownerId, db);
  for await (const { entry } of readEntries(folder, snapshot)) {
    const next = await references.next();
    if (next.done || !matchesReference(next.value, entry))
      throw new BackupError("The archive and database media inventory differ");
  }
  if (!(await references.next()).done)
    throw new BackupError("The archive and database media inventory differ");
}

export async function switchToRestoredObjects(
  folder: string,
  snapshot: MediaSnapshot,
) {
  await prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`
        LOCK TABLE users, media, uploads, processing_jobs, drive_objects,
          sessions, auth_throttles IN SHARE ROW EXCLUSIVE MODE NOWAIT
      `;
      await assertSnapshotMatches(folder, snapshot, tx);
      const prefix = `recovery/${snapshot.snapshotId}/`;
      await tx.media.updateMany({
        where: { ownerId: snapshot.ownerId, NOT: preserved },
        data: { thumbnailStorageKey: null, previewStorageKey: null },
      });
      await tx.$executeRaw`
        UPDATE media SET
          "storageKey" = ${prefix} || id || '/original',
          "thumbnailStorageKey" = CASE WHEN "thumbnailStorageKey" IS NOT NULL
            THEN ${prefix} || id || '/thumbnail' END,
          "previewStorageKey" = CASE WHEN "previewStorageKey" IS NOT NULL
            THEN ${prefix} || id || '/preview' END
        WHERE "ownerId" = CAST(${snapshot.ownerId} AS uuid)
      `;
      await tx.$executeRaw`
        UPDATE uploads SET "storageUploadId" = NULL,
          "operationToken" = NULL, "operationExpiresAt" = NULL
        WHERE "ownerId" = CAST(${snapshot.ownerId} AS uuid)
          AND ("storageUploadId" IS NOT NULL OR "operationToken" IS NOT NULL
            OR "operationExpiresAt" IS NOT NULL)
      `;
      await tx.processingJob.deleteMany({
        where: { type: "CLEANUP", status: { not: "COMPLETED" } },
      });
      await tx.driveObject.deleteMany();
      await tx.session.deleteMany();
      await tx.authThrottle.deleteMany();
    },
    { timeout: 600000 },
  );
}
