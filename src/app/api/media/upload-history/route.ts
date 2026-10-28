import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { authError, authFailure } from "@/lib/auth/http";
import { libraryJson, paginationSchema } from "@/lib/media/library-http";
import { prisma } from "@/lib/db/prisma";
export const runtime = "nodejs";
export async function GET(request: NextRequest) {
  try {
    const { user } = await requireAuth(request);
    const parsed = paginationSchema
      .strict()
      .safeParse(Object.fromEntries(request.nextUrl.searchParams));
    if (!parsed.success) throw authError(400, "Invalid upload history page");
    const { page, limit } = parsed.data;
    const rows = await prisma.upload.findMany({
      where: { ownerId: user.id },
      select: {
        id: true,
        status: true,
        totalBytes: true,
        bytesUploaded: true,
        createdAt: true,
        media: {
          select: {
            id: true,
            title: true,
            ownerId: true,
            deletedAt: true,
            processingStatus: true,
          },
        },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      skip: (page - 1) * limit,
    });
    return libraryJson({
      uploads: rows.slice(0, limit).map((row) => ({
        id: row.id,
        status: row.status,
        totalBytes: Number(row.totalBytes),
        bytesUploaded: Number(row.bytesUploaded),
        createdAt: row.createdAt,
        media:
          row.media?.ownerId === user.id && !row.media.deletedAt
            ? {
                id: row.media.id,
                title: row.media.title,
                processingStatus: row.media.processingStatus,
              }
            : null,
        reason:
          row.status === "FAILED"
            ? row.media?.processingStatus === "FAILED"
              ? "Media processing failed. Review this item in Your media for retry or deletion."
              : "Upload failed. Resume saved parts when available, or select the original again."
            : row.status === "CANCELLED"
              ? "Upload cancelled; cleanup of saved parts is queued."
              : null,
      })),
      page,
      hasMore: rows.length > limit,
    });
  } catch (error) {
    return authFailure(error);
  }
}
