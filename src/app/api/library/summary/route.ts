import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { authFailure } from "@/lib/auth/http";
import { libraryJson } from "@/lib/media/library-http";
import { prisma } from "@/lib/db/prisma";
export const runtime = "nodejs";
const activityLabels: Record<string, string> = {
  media_uploaded: "Media uploaded privately",
  media_deleted: "Media permanently deleted",
  media_delete_requested: "Media deletion requested",
  media_processing_retried: "Media processing retried",
  password_changed: "Owner password changed",
  session_revoked: "Session access revoked",
  login_success: "Owner signed in",
  setup_complete: "Private library created",
  logout_all: "All sessions signed out",
};
export async function GET(request: NextRequest) {
  try {
    const { user } = await requireAuth(request);
    const totalsQuery = prisma.media.groupBy({
      by: ["type"],
      orderBy: { type: "asc" },
      where: { ownerId: user.id, deletedAt: null },
      _count: { id: true },
      _sum: { fileSize: true },
    });
    const [types, favorites, collections, playlists, activity] =
      await prisma.$transaction(
        [
          totalsQuery,
          prisma.favorite.count({
            where: {
              userId: user.id,
              media: { ownerId: user.id, deletedAt: null },
            },
          }),
          prisma.collection.count({ where: { ownerId: user.id } }),
          prisma.playlist.count({ where: { ownerId: user.id } }),
          prisma.auditEvent.findMany({
            where: {
              userId: user.id,
              action: { in: Object.keys(activityLabels) },
            },
            select: { id: true, action: true, createdAt: true },
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            take: 8,
          }),
        ],
        { isolationLevel: "RepeatableRead" },
      );
    return libraryJson({
      totalMedia: types.reduce((sum, row) => sum + row._count.id, 0),
      videos: types.find((row) => row.type === "VIDEO")?._count.id ?? 0,
      photos: types.find((row) => row.type === "IMAGE")?._count.id ?? 0,
      originalBytes: Number(
        types.reduce(
          (sum, row) => sum + (row._sum.fileSize ?? BigInt(0)),
          BigInt(0),
        ),
      ),
      favorites,
      collections,
      playlists,
      activity: activity.map((row) => ({
        id: row.id,
        label: activityLabels[row.action],
        createdAt: row.createdAt,
      })),
    });
  } catch (error) {
    return authFailure(error);
  }
}
