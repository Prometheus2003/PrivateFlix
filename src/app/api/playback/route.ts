import { NextRequest } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/auth/require-auth";
import { assertSameOrigin, authError, authFailure } from "@/lib/auth/http";
import { prisma } from "@/lib/db/prisma";
import {
  libraryBody,
  libraryJson,
  paginationSchema,
} from "@/lib/media/library-http";
const querySchema = paginationSchema
  .extend({ mode: z.enum(["history", "continue"]).default("history") })
  .strict();
export const runtime = "nodejs";
export async function GET(request: NextRequest) {
  try {
    const { user } = await requireAuth(request);
    const parsed = querySchema.safeParse(
      Object.fromEntries(request.nextUrl.searchParams),
    );
    if (!parsed.success) throw authError(400, "Invalid history filters");
    const { page, limit, mode } = parsed.data;
    const rows = await prisma.playbackProgress.findMany({
      where: {
        userId: user.id,
        media: {
          ownerId: user.id,
          deletedAt: null,
          processingStatus: "READY",
          type: "VIDEO",
        },
        ...(mode === "continue"
          ? { completed: false, positionSeconds: { gt: 0 } }
          : {}),
      },
      select: {
        positionSeconds: true,
        durationSeconds: true,
        completed: true,
        lastPlayedAt: true,
        media: {
          select: {
            id: true,
            title: true,
            type: true,
            thumbnailStorageKey: true,
          },
        },
      },
      orderBy: [{ lastPlayedAt: "desc" }, { mediaId: "asc" }],
      skip: (page - 1) * limit,
      take: limit + 1,
    });
    return libraryJson({
      items: rows.slice(0, limit).map(({ media, ...progress }) => ({
        ...progress,
        media: {
          id: media.id,
          title: media.title,
          type: media.type,
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
export async function DELETE(request: NextRequest) {
  try {
    const { user } = await requireAuth(request);
    assertSameOrigin(request);
    await libraryBody(request, z.object({ confirm: z.literal(true) }).strict());
    const result = await prisma.playbackProgress.deleteMany({
      where: { userId: user.id },
    });
    return libraryJson({ removed: result.count });
  } catch (error) {
    return authFailure(error);
  }
}
