import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { authFailure } from "@/lib/auth/http";
import { prisma } from "@/lib/db/prisma";
import { libraryJson } from "@/lib/media/library-http";
import { getEnv } from "@/lib/validation/env";
import packageInfo from "../../../../../package.json";
export const runtime = "nodejs";
export async function GET(request: NextRequest) {
  try {
    const { user } = await requireAuth(request);
    const env = getEnv();
    const [totals, failed, pendingDeletions, failedCleanup] =
      await prisma.$transaction([
        prisma.media.aggregate({
          where: { ownerId: user.id, deletedAt: null },
          _count: { id: true },
          _sum: { fileSize: true },
        }),
        prisma.media.count({
          where: {
            ownerId: user.id,
            deletedAt: null,
            processingStatus: "FAILED",
          },
        }),
        prisma.media.count({
          where: {
            ownerId: user.id,
            processingStatus: "DELETING",
            deletedAt: { not: null },
          },
        }),
        prisma.processingJob.count({
          where: {
            type: "CLEANUP",
            status: "FAILED",
            media: { ownerId: user.id },
          },
        }),
      ]);
    return libraryJson({
      version: packageInfo.version,
      database: "available",
      libraryItems: totals._count.id,
      libraryBytes: Number(totals._sum.fileSize ?? 0),
      failedMedia: failed,
      pendingDeletions,
      failedCleanup,
      maxUploadBytes: env.MAX_UPLOAD_SIZE,
      thumbnailGeneration: "automatic",
      transcoding: "not-implemented",
      backup: "not-configured",
      checkedAt: new Date().toISOString(),
    });
  } catch (error) {
    return authFailure(error);
  }
}
