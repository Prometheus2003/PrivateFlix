import { NextRequest } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/auth/require-auth";
import { assertSameOrigin, authError, authFailure } from "@/lib/auth/http";
import { prisma } from "@/lib/db/prisma";
import { libraryBody, libraryId, libraryJson } from "@/lib/media/library-http";

export const runtime = "nodejs";
export async function PUT(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { user } = await requireAuth(request);
    assertSameOrigin(request);
    const collectionId = libraryId((await context.params).id);
    const input = await libraryBody(
      request,
      z.object({ mediaId: z.string().uuid(), present: z.boolean() }).strict(),
    );
    await prisma.$transaction(async (tx) => {
      const collection = await tx.collection.findFirst({
        where: { id: collectionId, ownerId: user.id },
        select: { id: true },
      });
      const media = await tx.media.findFirst({
        where: { id: input.mediaId, ownerId: user.id, deletedAt: null },
        select: { id: true },
      });
      if (!collection || !media)
        throw authError(404, "Collection or media not found");
      if (input.present)
        await tx.collectionItem.createMany({
          data: { collectionId, mediaId: input.mediaId },
          skipDuplicates: true,
        });
      else
        await tx.collectionItem.deleteMany({
          where: {
            collectionId,
            mediaId: input.mediaId,
            collection: { ownerId: user.id },
            media: { ownerId: user.id },
          },
        });
    });
    return libraryJson({ collectionId, ...input });
  } catch (error) {
    return authFailure(error);
  }
}
