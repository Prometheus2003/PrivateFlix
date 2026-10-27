import "server-only";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { authError } from "@/lib/auth/http";
const mediaIds = z
  .array(z.string().uuid())
  .min(1)
  .max(100)
  .refine((ids) => new Set(ids).size === ids.length);
const tags = z.array(z.string().trim().min(1).max(40)).max(20);
export const bulkSchema = z.discriminatedUnion("action", [
  z
    .object({ action: z.literal("favorite"), mediaIds, favorite: z.boolean() })
    .strict(),
  z
    .object({
      action: z.literal("collection"),
      mediaIds,
      collectionId: z.string().uuid().nullable(),
      mode: z.enum(["add", "move"]),
    })
    .strict(),
  z
    .object({
      action: z.literal("tags"),
      mediaIds,
      tags,
      mode: z.enum(["add", "replace", "remove"]),
    })
    .strict(),
  z
    .object({ action: z.literal("delete"), mediaIds, confirm: z.literal(true) })
    .strict(),
]);
export const mediaMutationLock = (tx: Prisma.TransactionClient) =>
  tx.$executeRaw`SELECT pg_advisory_xact_lock(7253409)`;
export async function mutateMedia(
  ownerId: string,
  input: z.infer<typeof bulkSchema>,
) {
  return prisma.$transaction(
    async (tx) => {
      await mediaMutationLock(tx);
      // Keep tag and collection transactions in a consistent lock order.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(7253407)`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(7253405)`;
      const rows = await tx.media.findMany({
        where: {
          id: { in: input.mediaIds },
          ownerId,
          ...(input.action === "delete"
            ? { OR: [{ deletedAt: null }, { processingStatus: "DELETING" }] }
            : { deletedAt: null }),
        },
        select: { id: true, processingStatus: true, deletedAt: true },
      });
      if (rows.length !== input.mediaIds.length)
        throw authError(404, "One or more media items were not found");
      if (input.action === "favorite") {
        if (input.favorite)
          await tx.favorite.createMany({
            data: input.mediaIds.map((mediaId) => ({
              userId: ownerId,
              mediaId,
            })),
            skipDuplicates: true,
          });
        else
          await tx.favorite.deleteMany({
            where: { userId: ownerId, mediaId: { in: input.mediaIds } },
          });
      } else if (input.action === "collection") {
        if (!input.collectionId && input.mode !== "move")
          throw authError(400, "Choose a collection");
        if (
          input.collectionId &&
          !(await tx.collection.findFirst({
            where: { id: input.collectionId, ownerId },
            select: { id: true },
          }))
        )
          throw authError(404, "Collection not found");
        if (input.mode === "move")
          await tx.collectionItem.deleteMany({
            where: { mediaId: { in: input.mediaIds }, collection: { ownerId } },
          });
        if (input.collectionId)
          await tx.collectionItem.createMany({
            data: input.mediaIds.map((mediaId) => ({
              mediaId,
              collectionId: input.collectionId!,
            })),
            skipDuplicates: true,
          });
      } else if (input.action === "tags") {
        if (!input.tags.length && input.mode !== "replace")
          throw authError(400, "Enter at least one tag");
        const names = [
          ...new Set(input.tags.map((name) => name.toLocaleLowerCase("en-US"))),
        ];
        if (input.mode !== "remove") {
          const existing = await tx.tag.count({
            where: { ownerId, name: { in: names } },
          });
          if (
            (await tx.tag.count({ where: { ownerId } })) +
              names.length -
              existing >
            500
          )
            throw authError(409, "Tag limit reached (500)");
          await tx.tag.createMany({
            data: names.map((name) => ({ ownerId, name })),
            skipDuplicates: true,
          });
        }
        const selected = await tx.tag.findMany({
          where: { ownerId, name: { in: names } },
          select: { id: true },
        });
        if (input.mode === "replace")
          await tx.mediaTag.deleteMany({
            where: { mediaId: { in: input.mediaIds }, tag: { ownerId } },
          });
        if (input.mode === "remove")
          await tx.mediaTag.deleteMany({
            where: {
              mediaId: { in: input.mediaIds },
              tagId: { in: selected.map((tag) => tag.id) },
              tag: { ownerId },
            },
          });
        else {
          for (const row of rows) {
            const count = await tx.mediaTag.count({
              where: { mediaId: row.id, tag: { ownerId } },
            });
            const shared = await tx.mediaTag.count({
              where: {
                mediaId: row.id,
                tagId: { in: selected.map((tag) => tag.id) },
              },
            });
            if (count + selected.length - shared > 20)
              throw authError(
                409,
                "A media item would exceed its 20-tag limit",
              );
          }
          await tx.mediaTag.createMany({
            data: input.mediaIds.flatMap((mediaId) =>
              selected.map((tag) => ({ mediaId, tagId: tag.id })),
            ),
            skipDuplicates: true,
          });
        }
        await tx.tag.deleteMany({
          where: { ownerId, mediaTags: { none: {} } },
        });
      } else {
        if (
          rows.some(
            (row) =>
              !["READY", "FAILED", "DELETING"].includes(row.processingStatus),
          )
        )
          throw authError(
            409,
            "Wait for processing or cancel unfinished uploads before deleting media",
          );
        if (
          await tx.upload.findFirst({
            where: {
              ownerId,
              mediaId: { in: input.mediaIds },
              status: {
                in: ["PENDING", "UPLOADING", "UPLOADED", "PROCESSING"],
              },
              NOT: {
                status: { in: ["UPLOADED", "PROCESSING"] },
                media: { processingStatus: "FAILED" },
              },
            },
            select: { id: true },
          })
        )
          throw authError(409, "An upload is still active");
        const now = new Date();
        if (
          await tx.processingJob.findFirst({
            where: {
              mediaId: { in: input.mediaIds },
              type: { not: "CLEANUP" },
              status: "PROCESSING",
              leaseExpiresAt: { gt: now },
            },
            select: { id: true },
          })
        )
          throw authError(409, "Media processing is still active");
        // Older workers left terminal processing failures marked UPLOADED.
        // Normalize only those receipts after confirming no processor owns them.
        await tx.upload.updateMany({
          where: {
            ownerId,
            mediaId: {
              in: rows
                .filter((row) => row.processingStatus === "FAILED")
                .map((row) => row.id),
            },
            status: { in: ["UPLOADED", "PROCESSING"] },
          },
          data: { status: "FAILED", errorMessage: "Media processing failed" },
        });
        await tx.media.updateMany({
          where: { id: { in: input.mediaIds }, ownerId, deletedAt: null },
          data: { deletedAt: now, processingStatus: "DELETING" },
        });
        for (const row of rows) {
          if (
            !(await tx.processingJob.findFirst({
              where: {
                mediaId: row.id,
                type: "CLEANUP",
                status: { in: ["QUEUED", "PROCESSING"] },
              },
              select: { id: true },
            }))
          )
            await tx.processingJob.create({
              data: { mediaId: row.id, type: "CLEANUP" },
            });
        }
        await tx.auditEvent.createMany({
          data: rows
            .filter((row) => !row.deletedAt)
            .map((row) => ({
              userId: ownerId,
              action: "media_delete_requested",
              resourceType: "media",
              resourceId: row.id,
            })),
        });
      }
      return {
        updated: rows.length,
        deletionQueued: input.action === "delete",
      };
    },
    { maxWait: 10000, timeout: 20000 },
  );
}
