import "server-only";
import type { DriveObject } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import type { DriveObjectRegistry } from "./drive";

const record = (value: DriveObject) => ({
  fileId: value.fileId,
  verifiedMd5: value.verifiedMd5,
  verifiedSize: value.verifiedSize === null ? null : Number(value.verifiedSize),
  revisionId: value.revisionId,
});

export const driveObjectRegistry: DriveObjectRegistry = {
  find: async (key) => {
    const value = await prisma.driveObject.findUnique({ where: { key } });
    return value ? record(value) : null;
  },
  reserve: async (key, fileId) => {
    // ON CONFLICT DO NOTHING elects one ID across app instances, even when
    // both callers start before a mapping exists. Unused generated IDs are not files.
    await prisma.driveObject.createMany({
      data: { key, fileId },
      skipDuplicates: true,
    });
    return record(
      await prisma.driveObject.findUniqueOrThrow({ where: { key } }),
    );
  },
  verify: async (key, fileId, md5, size, revisionId) => {
    const result = await prisma.driveObject.updateMany({
      where: {
        key,
        fileId,
        OR: [
          { verifiedMd5: null },
          { verifiedMd5: md5, verifiedSize: BigInt(size), revisionId },
        ],
      },
      data: {
        verifiedMd5: md5,
        verifiedSize: BigInt(size),
        revisionId,
        stagingPending: true,
      },
    });
    if (!result.count) throw new Error("Drive verification state conflict");
  },
  stagingRemoved: async (key) => {
    await prisma.driveObject.updateMany({
      where: { key },
      data: { stagingPending: false },
    });
  },
  pending: async () =>
    (
      await prisma.driveObject.findMany({
        where: {
          stagingPending: true,
          verifiedMd5: { not: null },
          verifiedSize: { not: null },
          revisionId: { not: null },
          createdAt: { lt: new Date(Date.now() - 30 * 60 * 1000) },
        },
        orderBy: { createdAt: "asc" },
        take: 20,
      })
    ).map((value) => ({ key: value.key, ...record(value) })),
  remove: async (key) => {
    await prisma.driveObject.deleteMany({ where: { key } });
  },
};
