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
    const mediaId = libraryId((await context.params).id);
    const { favorite } = await libraryBody(
      request,
      z.object({ favorite: z.boolean() }).strict(),
    );
    await prisma.$transaction(async (tx) => {
      if (
        !(await tx.media.findFirst({
          where: { id: mediaId, ownerId: user.id, deletedAt: null },
          select: { id: true },
        }))
      )
        throw authError(404, "Media not found");
      if (favorite)
        await tx.favorite.createMany({
          data: { userId: user.id, mediaId },
          skipDuplicates: true,
        });
      else
        await tx.favorite.deleteMany({ where: { userId: user.id, mediaId } });
    });
    return libraryJson({ mediaId, isFavorite: favorite });
  } catch (error) {
    return authFailure(error);
  }
}
