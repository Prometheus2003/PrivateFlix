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
    const input = await libraryBody(
      request,
      z.object({ mediaId: z.string().uuid(), present: z.boolean() }).strict(),
    );
    await prisma.$transaction(async (tx) => {
      await playlistLock(tx);
      await ownedPlaylist(tx, user.id, id);
      if (
        !(await tx.media.findFirst({
          where: {
            id: input.mediaId,
            ownerId: user.id,
            deletedAt: null,
            type: "VIDEO",
            processingStatus: "READY",
          },
          select: { id: true },
        }))
      )
        throw authError(404, "Video not found");
      if (!input.present) {
        await tx.playlistItem.deleteMany({
          where: { playlistId: id, mediaId: input.mediaId },
        });
        return;
      }
      if (
        await tx.playlistItem.findUnique({
          where: {
            playlistId_mediaId: { playlistId: id, mediaId: input.mediaId },
          },
        })
      )
        return;
      await tx.playlistItem.deleteMany({
        where: { playlistId: id, media: { deletedAt: { not: null } } },
      });
      if ((await tx.playlistItem.count({ where: { playlistId: id } })) >= 100)
        throw authError(409, "Playlist video limit reached (100)");
      const last = await tx.playlistItem.aggregate({
        where: { playlistId: id },
        _max: { position: true },
      });
      await tx.playlistItem.create({
        data: {
          playlistId: id,
          mediaId: input.mediaId,
          position: (last._max.position ?? -1) + 1,
        },
      });
    });
    return libraryJson({ saved: true });
  } catch (error) {
    return authFailure(error);
  }
}
