import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { assertSameOrigin, authError, authFailure } from "@/lib/auth/http";
import { prisma } from "@/lib/db/prisma";
import {
  collectionSelect,
  collectionSummary,
} from "@/lib/media/collection-layout";
import {
  collectionSchema,
  libraryBody,
  libraryJson,
  paginationSchema,
} from "@/lib/media/library-http";

export const runtime = "nodejs";
export async function GET(request: NextRequest) {
  try {
    const { user } = await requireAuth(request);
    const parsed = paginationSchema
      .strict()
      .safeParse(Object.fromEntries(request.nextUrl.searchParams));
    if (!parsed.success) throw authError(400, "Invalid pagination");
    const { page, limit } = parsed.data;
    const rows = await prisma.collection.findMany({
      where: { ownerId: user.id },
      select: collectionSelect(user.id),
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }, { id: "asc" }],
      skip: (page - 1) * limit,
      take: limit + 1,
    });
    return libraryJson({
      collections: rows
        .slice(0, limit)
        .map((row) => collectionSummary(row, user.id)),
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
    const collection = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(7253405)");
      if ((await tx.collection.count({ where: { ownerId: user.id } })) >= 100)
        throw authError(409, "Collection limit reached (100)");
      const ordering = await tx.collection.aggregate({
        where: { ownerId: user.id },
        _max: { sortOrder: true },
      });
      return tx.collection.create({
        data: {
          ownerId: user.id,
          ...input,
          sortOrder: (ordering._max.sortOrder ?? -1) + 1,
        },
        select: collectionSelect(user.id),
      });
    });
    return libraryJson(
      { collection: collectionSummary(collection, user.id) },
      201,
    );
  } catch (error) {
    return authFailure(error);
  }
}
