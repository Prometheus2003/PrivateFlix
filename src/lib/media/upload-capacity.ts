import "server-only";
import type { Prisma } from "@prisma/client";
import { authError } from "@/lib/auth/http";
import { getEnv } from "@/lib/validation/env";

export async function allocatedLibraryBytes(
  db: Prisma.TransactionClient,
  ownerId: string,
) {
  const { _sum } = await db.media.aggregate({
    where: {
      ownerId,
      OR: [
        {
          deletedAt: null,
          OR: [
            { processingStatus: { not: "FAILED" } },
            { uploadedAt: { not: null } },
            { checksum: { not: null } },
          ],
        },
        { processingStatus: "DELETING" },
      ],
    },
    _sum: { fileSize: true },
  });
  return _sum.fileSize ?? BigInt(0);
}

// Call before creating the media and upload rows in the same transaction.
export async function checkUploadCapacity(
  tx: Prisma.TransactionClient,
  ownerId: string,
  bytes: bigint,
) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(7253403)`;
  if ((await tx.upload.count({ where: { ownerId, status: "UPLOADING" } })) >= 3)
    throw authError(429, "Too many active uploads");

  const limit = getEnv().MAX_LIBRARY_BYTES;
  if (
    limit !== undefined &&
    (await allocatedLibraryBytes(tx, ownerId)) + bytes > BigInt(limit)
  )
    throw authError(
      413,
      "This file exceeds your remaining PrivateFlix library space",
    );
}
