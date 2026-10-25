import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/auth/require-auth";
import { authError, authFailure } from "@/lib/auth/http";
import { prisma } from "@/lib/db/prisma";
const querySchema = z.object({
  page: z.coerce.number().int().min(1).max(100000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export async function GET(request: NextRequest) {
  try {
    const { user } = await requireAuth(request);
    const parsed = querySchema.safeParse(
      Object.fromEntries(request.nextUrl.searchParams),
    );
    if (!parsed.success) throw authError(400, "Invalid pagination");
    const { page, limit } = parsed.data;
    const rows = await prisma.media.findMany({
      where: { ownerId: user.id, deletedAt: null },
      select: {
        id: true,
        title: true,
        type: true,
        mimeType: true,
        fileSize: true,
        processingStatus: true,
        createdAt: true,
        thumbnailStorageKey: true,
        width: true,
        height: true,
        duration: true,
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * limit,
      take: limit + 1,
    });
    return NextResponse.json(
      {
        media: rows.slice(0, limit).map(({ thumbnailStorageKey, ...row }) => ({
          ...row,
          fileSize: Number(row.fileSize),
          hasThumbnail:
            row.processingStatus === "READY" && Boolean(thumbnailStorageKey),
        })),
        page,
        hasMore: rows.length > limit,
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return authFailure(error);
  }
}
