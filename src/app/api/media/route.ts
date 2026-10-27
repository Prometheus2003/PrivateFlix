import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { authError, authFailure } from "@/lib/auth/http";
import { prisma } from "@/lib/db/prisma";
import { libraryJson } from "@/lib/media/library-http";
import { libraryQuerySchema, loadLibrary } from "@/lib/media/library-query";
export const runtime = "nodejs";
export async function GET(request: NextRequest) {
  try {
    const { user } = await requireAuth(request);
    const parsed = libraryQuerySchema.safeParse(
      Object.fromEntries(request.nextUrl.searchParams),
    );
    if (!parsed.success) throw authError(400, "Invalid library filters");
    const { page, limit, collection } = parsed.data;
    if (
      collection &&
      !(await prisma.collection.findFirst({
        where: { id: collection, ownerId: user.id },
        select: { id: true },
      }))
    )
      throw authError(404, "Collection not found");
    const [rows, total] = await loadLibrary(user.id, parsed.data);
    return libraryJson({
      media: rows
        .slice(0, limit)
        .map(
          ({
            thumbnailStorageKey,
            favorites,
            collectionItems,
            checksum,
            processingJobs,
            ...row
          }) => ({
            ...row,
            fileSize: Number(row.fileSize),
            hasThumbnail:
              row.processingStatus === "READY" && Boolean(thumbnailStorageKey),
            isFavorite: favorites.length > 0,
            canRetryProcessing:
              row.processingStatus === "FAILED" &&
              Boolean(checksum) &&
              processingJobs.length > 0,
            collections: collectionItems.map((item) => item.collection),
          }),
        ),
      page,
      hasMore: rows.length > limit,
      total,
    });
  } catch (error) {
    return authFailure(error);
  }
}
