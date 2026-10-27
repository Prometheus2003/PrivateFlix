import "server-only";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { paginationSchema } from "./library-http";
const mimeTypes = {
  mp4: "video/mp4",
  webm: "video/webm",
  mkv: "video/x-matroska",
  mov: "video/quicktime",
  avi: "video/x-msvideo",
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  heic: "image/heic",
} as const;
export const libraryQuerySchema = paginationSchema
  .extend({
    q: z.string().trim().max(120).optional(),
    type: z.enum(["all", "VIDEO", "IMAGE"]).default("all"),
    favorite: z.enum(["true", "false"]).default("false"),
    collection: z.string().uuid().optional(),
    sort: z
      .enum(["newest", "oldest", "title", "duration", "recent"])
      .default("newest"),
    format: z
      .enum([
        "mp4",
        "webm",
        "mkv",
        "mov",
        "avi",
        "jpg",
        "png",
        "webp",
        "gif",
        "heic",
      ])
      .optional(),
    from: z.iso.datetime().optional(),
    to: z.iso.datetime().optional(),
    minDuration: z.coerce.number().finite().min(0).max(31536000).optional(),
    maxDuration: z.coerce.number().finite().min(0).max(31536000).optional(),
    watch: z.enum(["all", "watched", "unwatched", "started"]).default("all"),
  })
  .strict()
  .refine(
    (value) =>
      !value.from || !value.to || Date.parse(value.from) < Date.parse(value.to),
    "Invalid date range",
  )
  .refine(
    (value) =>
      value.minDuration === undefined ||
      value.maxDuration === undefined ||
      value.minDuration <= value.maxDuration,
    "Invalid duration range",
  );
type Query = z.infer<typeof libraryQuerySchema>;
const escaped = (text?: string) => text?.replace(/[\\%_]/g, "\\$&");
function whereFor(ownerId: string, query: Query): Prisma.MediaWhereInput {
  const search = escaped(query.q);
  return {
    ownerId,
    deletedAt: null,
    ...(query.type !== "all" ? { type: query.type } : {}),
    ...(query.favorite === "true"
      ? { favorites: { some: { userId: ownerId } } }
      : {}),
    ...(query.collection
      ? {
          collectionItems: {
            some: { collectionId: query.collection, collection: { ownerId } },
          },
        }
      : {}),
    ...(query.format ? { mimeType: mimeTypes[query.format] } : {}),
    ...(query.from || query.to
      ? {
          createdAt: {
            ...(query.from ? { gte: new Date(query.from) } : {}),
            ...(query.to ? { lt: new Date(query.to) } : {}),
          },
        }
      : {}),
    ...(query.minDuration !== undefined || query.maxDuration !== undefined
      ? {
          duration: {
            ...(query.minDuration !== undefined
              ? { gte: query.minDuration }
              : {}),
            ...(query.maxDuration !== undefined
              ? { lte: query.maxDuration }
              : {}),
          },
        }
      : {}),
    ...(query.watch !== "all"
      ? {
          AND: { type: "VIDEO" },
          playbackProgress:
            query.watch === "unwatched"
              ? { none: { userId: ownerId, completed: true } }
              : {
                  some: {
                    userId: ownerId,
                    completed: query.watch === "watched",
                    ...(query.watch === "started"
                      ? { positionSeconds: { gt: 0 } }
                      : {}),
                  },
                },
        }
      : {}),
    ...(search
      ? {
          OR: [
            { title: { contains: search, mode: "insensitive" } },
            { originalFilename: { contains: search, mode: "insensitive" } },
            { description: { contains: search, mode: "insensitive" } },
            {
              mediaTags: {
                some: {
                  tag: {
                    ownerId,
                    name: { contains: search, mode: "insensitive" },
                  },
                },
              },
            },
          ],
        }
      : {}),
  };
}
function selection(ownerId: string) {
  return {
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
    checksum: true,
    processingJobs: {
      where: { type: "METADATA", status: "FAILED" },
      select: { id: true },
      take: 1,
    },
    favorites: {
      where: { userId: ownerId },
      select: { userId: true },
      take: 1,
    },
    collectionItems: {
      where: { collection: { ownerId } },
      select: { collection: { select: { id: true, name: true } } },
      take: 3,
    },
  } satisfies Prisma.MediaSelect;
}
// Prisma cannot sort a media row by a scalar in its to-many progress relation.
// Select only the bounded page of IDs with parameterized SQL, then use the same
// safe ORM projection. Never sort a whole owner library in application memory.
function recentIds(ownerId: string, query: Query) {
  const clauses: Prisma.Sql[] = [
    Prisma.sql`m."ownerId"=${ownerId}::uuid`,
    Prisma.sql`m."deletedAt" IS NULL`,
  ];
  if (query.type !== "all")
    clauses.push(Prisma.sql`m.type::text=${query.type}`);
  if (query.favorite === "true")
    clauses.push(
      Prisma.sql`EXISTS (SELECT 1 FROM favorites f WHERE f."mediaId"=m.id AND f."userId"=${ownerId}::uuid)`,
    );
  if (query.collection)
    clauses.push(
      Prisma.sql`EXISTS (SELECT 1 FROM collection_items ci JOIN collections c ON c.id=ci."collectionId" WHERE ci."mediaId"=m.id AND c.id=${query.collection}::uuid AND c."ownerId"=${ownerId}::uuid)`,
    );
  if (query.format)
    clauses.push(Prisma.sql`m."mimeType"=${mimeTypes[query.format]}`);
  if (query.from)
    clauses.push(Prisma.sql`m."createdAt">=${new Date(query.from)}`);
  if (query.to) clauses.push(Prisma.sql`m."createdAt"<${new Date(query.to)}`);
  if (query.minDuration !== undefined)
    clauses.push(Prisma.sql`m.duration>=${query.minDuration}`);
  if (query.maxDuration !== undefined)
    clauses.push(Prisma.sql`m.duration<=${query.maxDuration}`);
  if (query.watch !== "all") {
    clauses.push(Prisma.sql`m.type::text='VIDEO'`);
    if (query.watch === "unwatched")
      clauses.push(
        Prisma.sql`NOT EXISTS (SELECT 1 FROM playback_progress pw WHERE pw."mediaId"=m.id AND pw."userId"=${ownerId}::uuid AND pw.completed=true)`,
      );
    else
      clauses.push(
        Prisma.sql`EXISTS (SELECT 1 FROM playback_progress pw WHERE pw."mediaId"=m.id AND pw."userId"=${ownerId}::uuid AND pw.completed=${query.watch === "watched"} ${query.watch === "started" ? Prisma.sql`AND pw."positionSeconds">0` : Prisma.empty})`,
      );
  }
  const search = escaped(query.q);
  if (search) {
    const pattern = `%${search}%`;
    clauses.push(
      Prisma.sql`(m.title ILIKE ${pattern} OR m."originalFilename" ILIKE ${pattern} OR m.description ILIKE ${pattern} OR EXISTS (SELECT 1 FROM media_tags mt JOIN tags t ON t.id=mt."tagId" WHERE mt."mediaId"=m.id AND t."ownerId"=${ownerId}::uuid AND t.name ILIKE ${pattern}))`,
    );
  }
  return Prisma.sql`SELECT m.id FROM media m LEFT JOIN playback_progress p ON p."mediaId"=m.id AND p."userId"=${ownerId}::uuid WHERE ${Prisma.join(clauses, " AND ")} ORDER BY p."lastPlayedAt" DESC NULLS LAST,m."createdAt" DESC,m.id DESC OFFSET ${(query.page - 1) * query.limit} LIMIT ${query.limit + 1}`;
}
export async function loadLibrary(ownerId: string, query: Query) {
  const where = whereFor(ownerId, query);
  const select = selection(ownerId);
  if (query.sort === "recent")
    return prisma.$transaction(
      async (tx) => {
        const ids = await tx.$queryRaw<Array<{ id: string }>>(
          recentIds(ownerId, query),
        );
        const ranks = new Map(ids.map((item, index) => [item.id, index]));
        const rows = await tx.media.findMany({
          where: { ...where, id: { in: ids.map((item) => item.id) } },
          select,
        });
        rows.sort((a, b) => ranks.get(a.id)! - ranks.get(b.id)!);
        return [rows, await tx.media.count({ where })] as const;
      },
      { isolationLevel: "RepeatableRead" },
    );
  const orderBy: Prisma.MediaOrderByWithRelationInput[] =
    query.sort === "title"
      ? [{ title: "asc" }, { id: "asc" }]
      : query.sort === "duration"
        ? [{ duration: { sort: "desc", nulls: "last" } }, { id: "asc" }]
        : [
            { createdAt: query.sort === "oldest" ? "asc" : "desc" },
            { id: query.sort === "oldest" ? "asc" : "desc" },
          ];
  return prisma.$transaction(
    [
      prisma.media.findMany({
        where,
        select,
        orderBy,
        skip: (query.page - 1) * query.limit,
        take: query.limit + 1,
      }),
      prisma.media.count({ where }),
    ],
    { isolationLevel: "RepeatableRead" },
  );
}
