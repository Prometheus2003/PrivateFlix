import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { assertSameOrigin, authError, authFailure } from "@/lib/auth/http";
import { prisma } from "@/lib/db/prisma";
import {
  libraryBody,
  libraryId,
  libraryJson,
  collectionSchema,
  paginationSchema,
} from "@/lib/media/library-http";
import { ownedPlaylist, playlistLock } from "@/lib/media/playlists";
type Context = { params: Promise<{ id: string }> };
export const runtime = "nodejs";
export async function GET(request: NextRequest, context: Context) {
  try {
    const { user } = await requireAuth(request);
    const id = libraryId((await context.params).id);
    const query = paginationSchema
      .strict()
      .safeParse(Object.fromEntries(request.nextUrl.searchParams));
    if (!query.success) throw authError(400, "Invalid pagination");
    const { page, limit } = query.data;
    const playlist = await ownedPlaylist(prisma, user.id, id);
    const rows = await prisma.playlistItem.findMany({
      where: {
        playlistId: id,
        playlist: { ownerId: user.id },
        media: {
          ownerId: user.id,
          deletedAt: null,
          type: "VIDEO",
          processingStatus: "READY",
        },
      },
      select: {
        position: true,
        media: {
          select: {
            id: true,
            title: true,
            type: true,
            duration: true,
            thumbnailStorageKey: true,
          },
        },
      },
      orderBy: [{ position: "asc" }, { mediaId: "asc" }],
      skip: (page - 1) * limit,
      take: limit + 1,
    });
    return libraryJson({
      playlist,
      items: rows.slice(0, limit).map(({ media, position }) => ({
        position,
        media: {
          id: media.id,
          title: media.title,
          type: media.type,
          duration: media.duration,
          hasThumbnail: Boolean(media.thumbnailStorageKey),
        },
      })),
      page,
      hasMore: rows.length > limit,
    });
  } catch (error) {
    return authFailure(error);
  }
}
export async function PATCH(request: NextRequest, context: Context) {
  try {
    const { user } = await requireAuth(request);
    assertSameOrigin(request);
    const id = libraryId((await context.params).id);
    const input = await libraryBody(request, collectionSchema);
    const playlist = await prisma.$transaction(async (tx) => {
      await playlistLock(tx);
      await ownedPlaylist(tx, user.id, id);
      return tx.playlist.update({
        where: { id, ownerId: user.id },
        data: input,
        select: { id: true, name: true, description: true },
      });
    });
    return libraryJson({ playlist });
  } catch (error) {
    return authFailure(error);
  }
}
export async function DELETE(request: NextRequest, context: Context) {
  try {
    const { user } = await requireAuth(request);
    assertSameOrigin(request);
    const id = libraryId((await context.params).id);
    await prisma.$transaction(async (tx) => {
      await playlistLock(tx);
      await ownedPlaylist(tx, user.id, id);
      await tx.playlist.delete({ where: { id, ownerId: user.id } });
    });
    return libraryJson({ deleted: true });
  } catch (error) {
    return authFailure(error);
  }
}
