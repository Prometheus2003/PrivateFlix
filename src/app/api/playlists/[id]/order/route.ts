import { NextRequest } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/auth/require-auth";
import { assertSameOrigin, authError, authFailure } from "@/lib/auth/http";
import { prisma } from "@/lib/db/prisma";
import { libraryBody, libraryId, libraryJson } from "@/lib/media/library-http";
import { ownedPlaylist, playlistLock } from "@/lib/media/playlists";
export const runtime = "nodejs";
export async function PUT(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { user } = await requireAuth(request);
    assertSameOrigin(request);
    const id = libraryId((await context.params).id);
    const { mediaIds } = await libraryBody(
      request,
      z
        .object({
          mediaIds: z
            .array(z.string().uuid())
            .max(100)
            .refine((ids) => new Set(ids).size === ids.length),
        })
        .strict(),
    );
    await prisma.$transaction(async (tx) => {
      await playlistLock(tx);
      await ownedPlaylist(tx, user.id, id);
      const items = await tx.playlistItem.findMany({
        where: {
          playlistId: id,
          media: {
            ownerId: user.id,
            deletedAt: null,
            type: "VIDEO",
            processingStatus: "READY",
          },
        },
        select: { mediaId: true },
        take: 101,
      });
      if (
        items.length !== mediaIds.length ||
        items.some((item) => !mediaIds.includes(item.mediaId))
      )
        throw authError(409, "Playlist changed. Refresh before reordering.");
      for (const [position, mediaId] of mediaIds.entries())
        await tx.playlistItem.update({
          where: { playlistId_mediaId: { playlistId: id, mediaId } },
          data: { position },
        });
    });
    return libraryJson({ saved: true });
  } catch (error) {
    return authFailure(error);
  }
}
