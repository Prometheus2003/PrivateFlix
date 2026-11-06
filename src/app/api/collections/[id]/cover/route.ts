import { NextRequest } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/auth/require-auth";
import { assertSameOrigin, authError, authFailure } from "@/lib/auth/http";
import { prisma } from "@/lib/db/prisma";
import { libraryBody, libraryId, libraryJson } from "@/lib/media/library-http";
import { collectionLock } from "@/lib/media/collection-layout";
export const runtime = "nodejs";
export async function PUT(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { user } = await requireAuth(request);
    assertSameOrigin(request);
    const id = libraryId((await context.params).id);
    const input = await libraryBody(
      request,
      z.object({ mediaId: z.string().uuid().nullable() }).strict(),
    );
    await prisma.$transaction(async (tx) => {
      await collectionLock(tx);
      if (
        !(await tx.collection.findFirst({
          where: { id, ownerId: user.id },
          select: { id: true },
        }))
      )
        throw authError(404, "Collection not found");
      if (
        input.mediaId &&
        !(await tx.media.findFirst({
          where: {
            id: input.mediaId,
            ownerId: user.id,
            deletedAt: null,
            processingStatus: "READY",
            thumbnailStorageKey: { not: null },
          },
          select: { id: true },
        }))
      )
        throw authError(404, "Ready cover media not found");
      await tx.collection.update({
        where: { id, ownerId: user.id },
        data: { coverMediaId: input.mediaId },
      });
    });
    return libraryJson({ saved: true });
  } catch (error) {
    return authFailure(error);
  }
}
