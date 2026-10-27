import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { assertSameOrigin, authError, authFailure } from "@/lib/auth/http";
import { prisma } from "@/lib/db/prisma";
import {
  libraryBody,
  libraryJson,
  collectionSchema,
  paginationSchema,
} from "@/lib/media/library-http";
import { playlistLock } from "@/lib/media/playlists";
export const runtime = "nodejs";
export async function GET(request: NextRequest) {
  try {
    const { user } = await requireAuth(request);
    const query = paginationSchema
      .strict()
      .safeParse(Object.fromEntries(request.nextUrl.searchParams));
    if (!query.success) throw authError(400, "Invalid pagination");
    const { page, limit } = query.data;
    const rows = await prisma.playlist.findMany({
      where: { ownerId: user.id },
      select: {
        id: true,
        name: true,
        description: true,
        _count: {
          select: {
            items: {
              where: {
                media: {
                  ownerId: user.id,
                  deletedAt: null,
                  type: "VIDEO",
                  processingStatus: "READY",
                },
              },
            },
          },
        },
      },
      orderBy: [{ name: "asc" }, { id: "asc" }],
      skip: (page - 1) * limit,
      take: limit + 1,
    });
    return libraryJson({
      playlists: rows
        .slice(0, limit)
        .map(({ _count, ...row }) => ({ ...row, count: _count.items })),
      page,
      hasMore: rows.length > limit,
    });
  } catch (error) {
    return authFailure(error);
  }
}
export async function POST(request: NextRequest) {
  try {
    const { user } = await requireAuth(request);
    assertSameOrigin(request);
    const input = await libraryBody(request, collectionSchema);
    const playlist = await prisma.$transaction(async (tx) => {
      await playlistLock(tx);
      if ((await tx.playlist.count({ where: { ownerId: user.id } })) >= 100)
        throw authError(409, "Playlist limit reached (100)");
      return tx.playlist.create({
        data: { ownerId: user.id, ...input },
        select: { id: true, name: true, description: true },
      });
    });
    return libraryJson({ playlist: { ...playlist, count: 0 } }, 201);
  } catch (error) {
    return authFailure(error);
  }
}
