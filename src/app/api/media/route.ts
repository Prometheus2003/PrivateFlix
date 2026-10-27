import { NextRequest } from "next/server";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { requireAuth } from "@/lib/auth/require-auth";
import { authError, authFailure } from "@/lib/auth/http";
import { prisma } from "@/lib/db/prisma";
import { libraryJson, paginationSchema } from "@/lib/media/library-http";
const querySchema = paginationSchema
  .extend({
    q: z.string().trim().max(120).optional(),
    type: z.enum(["all", "VIDEO", "IMAGE"]).default("all"),
    favorite: z.enum(["true", "false"]).default("false"),
    collection: z.string().uuid().optional(),
    sort: z.enum(["newest", "oldest", "title"]).default("newest"),
  })
  .strict();
export const runtime = "nodejs";
export async function GET(request: NextRequest) {
  try {
    const { user } = await requireAuth(request);
    const parsed = querySchema.safeParse(
      Object.fromEntries(request.nextUrl.searchParams),
    );
    if (!parsed.success) throw authError(400, "Invalid library filters");
    const { page, limit, q, type, favorite, collection, sort } = parsed.data;
    if (
      collection &&
      !(await prisma.collection.findFirst({
        where: { id: collection, ownerId: user.id },
        select: { id: true },
      }))
    )
      throw authError(404, "Collection not found");
    // Prisma's contains uses LIKE. Escape its metacharacters so search is a
    // literal substring, even for filenames containing percent or underscores.
    const search = q?.replace(/[\\%_]/g, "\\$&");
    const where: Prisma.MediaWhereInput = {
      ownerId: user.id,
      deletedAt: null,
      ...(type !== "all" ? { type } : {}),
      ...(favorite === "true"
        ? { favorites: { some: { userId: user.id } } }
        : {}),
      ...(collection
        ? {
            collectionItems: {
              some: {
                collectionId: collection,
                collection: { ownerId: user.id },
              },
            },
          }
        : {}),
      ...(search
        ? {
            OR: [
              { title: { contains: search, mode: "insensitive" } },
              { originalFilename: { contains: search, mode: "insensitive" } },
            ],
          }
        : {}),
    };
    const orderBy: Prisma.MediaOrderByWithRelationInput[] =
      sort === "title"
        ? [{ title: "asc" }, { id: "asc" }]
        : [
            { createdAt: sort === "oldest" ? "asc" : "desc" },
            { id: sort === "oldest" ? "asc" : "desc" },
          ];
    const [rows, total] = await prisma.$transaction(
      [
        prisma.media.findMany({
          where,
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
            favorites: {
              where: { userId: user.id },
              select: { userId: true },
              take: 1,
            },
          },
          orderBy,
          skip: (page - 1) * limit,
          take: limit + 1,
        }),
        prisma.media.count({ where }),
      ],
      { isolationLevel: "RepeatableRead" },
    );
    return libraryJson({
      media: rows
        .slice(0, limit)
        .map(({ thumbnailStorageKey, favorites, ...row }) => ({
          ...row,
          fileSize: Number(row.fileSize),
          hasThumbnail:
            row.processingStatus === "READY" && Boolean(thumbnailStorageKey),
          isFavorite: favorites.length > 0,
        })),
      page,
      hasMore: rows.length > limit,
      total,
    });
  } catch (error) {
    return authFailure(error);
  }
}
