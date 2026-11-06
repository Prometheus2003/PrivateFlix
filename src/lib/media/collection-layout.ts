import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { authError } from "@/lib/auth/http";
export const collectionLock = (tx: Prisma.TransactionClient) =>
  tx.$executeRaw`SELECT pg_advisory_xact_lock(7253405)`;
export function collectionSelect(ownerId: string) {
  return {
    id: true,
    name: true,
    description: true,
    parentId: true,
    sortOrder: true,
    coverMedia: {
      select: {
        id: true,
        ownerId: true,
        deletedAt: true,
        processingStatus: true,
        thumbnailStorageKey: true,
      },
    },
    _count: {
      select: { items: { where: { media: { ownerId, deletedAt: null } } } },
    },
  } satisfies Prisma.CollectionSelect;
}
type Row = Prisma.CollectionGetPayload<{
  select: ReturnType<typeof collectionSelect>;
}>;
export function collectionSummary(row: Row, ownerId: string) {
  const { _count, coverMedia, ...data } = row;
  return {
    ...data,
    count: _count.items,
    coverMediaId:
      coverMedia?.ownerId === ownerId &&
      !coverMedia.deletedAt &&
      coverMedia.processingStatus === "READY" &&
      coverMedia.thumbnailStorageKey
        ? coverMedia.id
        : null,
  };
}
export async function saveCollectionLayout(
  ownerId: string,
  rows: { id: string; parentId: string | null }[],
) {
  await prisma.$transaction(async (tx) => {
    await collectionLock(tx);
    const existing = await tx.collection.findMany({
      where: { ownerId },
      select: { id: true },
      take: 101,
    });
    const available = new Set(existing.map((row) => row.id));
    if (
      rows.some(
        (row) =>
          !available.has(row.id) ||
          (row.parentId !== null && !available.has(row.parentId)),
      )
    )
      throw authError(404, "Collection not found");
    if (existing.length !== rows.length || existing.length > 100)
      throw authError(
        409,
        "Collections changed. Refresh before saving their organization.",
      );
    const parents = new Map(rows.map((row) => [row.id, row.parentId]));
    for (const row of rows) {
      const visited = new Set<string>();
      let current: string | null = row.id,
        depth = 0;
      while (current) {
        if (visited.has(current))
          throw authError(
            409,
            "A collection cannot be nested inside itself or its descendants",
          );
        visited.add(current);
        if (++depth > 5)
          throw authError(
            409,
            "Collections can be nested at most five levels deep",
          );
        current = parents.get(current) ?? null;
      }
    }
    for (let index = 0; index < rows.length; index++)
      await tx.collection.update({
        where: { id: rows[index].id, ownerId },
        data: { parentId: rows[index].parentId, sortOrder: index },
      });
  });
}
