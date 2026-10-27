import { NextRequest } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/auth/require-auth";
import { assertSameOrigin, authError, authFailure } from "@/lib/auth/http";
import { prisma } from "@/lib/db/prisma";
import { libraryBody, libraryId, libraryJson } from "@/lib/media/library-http";
const progressSchema = z
  .object({
    positionSeconds: z.number().finite().min(0).max(31_536_000),
    completed: z.boolean().optional(),
  })
  .strict();
type Context = { params: Promise<{ mediaId: string }> };
export const runtime = "nodejs";
async function mediaFor(userId: string, mediaId: string) {
  const media = await prisma.media.findFirst({
    where: {
      id: mediaId,
      ownerId: userId,
      deletedAt: null,
      type: "VIDEO",
      processingStatus: "READY",
    },
    select: { id: true, duration: true },
  });
  if (!media) throw authError(404, "Video not found");
  return media;
}
export async function GET(request: NextRequest, context: Context) {
  try {
    const { user } = await requireAuth(request);
    const mediaId = libraryId((await context.params).mediaId);
    const media = await mediaFor(user.id, mediaId);
    const progress = await prisma.playbackProgress.findUnique({
      where: { userId_mediaId: { userId: user.id, mediaId } },
    });
    return libraryJson({
      progress: progress
        ? {
            positionSeconds: progress.positionSeconds,
            durationSeconds: progress.durationSeconds,
            completed: progress.completed,
            lastPlayedAt: progress.lastPlayedAt,
          }
        : null,
      durationSeconds: media.duration,
    });
  } catch (error) {
    return authFailure(error);
  }
}
export async function PUT(request: NextRequest, context: Context) {
  try {
    const { user } = await requireAuth(request);
    assertSameOrigin(request);
    const mediaId = libraryId((await context.params).mediaId);
    const data = await libraryBody(request, progressSchema);
    const media = await mediaFor(user.id, mediaId);
    if (!media.duration || !Number.isFinite(media.duration))
      throw authError(409, "Video duration is unavailable");
    const positionSeconds =
      data.completed === true
        ? media.duration
        : Math.min(data.positionSeconds, media.duration);
    const completed =
      data.completed ?? positionSeconds >= media.duration * 0.95;
    await prisma.playbackProgress.upsert({
      where: { userId_mediaId: { userId: user.id, mediaId } },
      create: {
        userId: user.id,
        mediaId,
        positionSeconds,
        durationSeconds: media.duration,
        completed,
      },
      update: {
        positionSeconds,
        durationSeconds: media.duration,
        completed,
        lastPlayedAt: new Date(),
      },
    });
    return libraryJson({
      positionSeconds,
      durationSeconds: media.duration,
      completed,
    });
  } catch (error) {
    return authFailure(error);
  }
}
export async function DELETE(request: NextRequest, context: Context) {
  try {
    const { user } = await requireAuth(request);
    assertSameOrigin(request);
    const mediaId = libraryId((await context.params).mediaId);
    await mediaFor(user.id, mediaId);
    await prisma.playbackProgress.deleteMany({
      where: { userId: user.id, mediaId },
    });
    return libraryJson({ removed: true });
  } catch (error) {
    return authFailure(error);
  }
}
