import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { assertSameOrigin, authError, authFailure } from "@/lib/auth/http";
import { prisma } from "@/lib/db/prisma";
import {
  collectionSchema,
  libraryBody,
  libraryId,
  libraryJson,
} from "@/lib/media/library-http";

export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };
export async function PATCH(request: NextRequest, context: Context) {
  try {
    const { user } = await requireAuth(request);
    assertSameOrigin(request);
    const id = libraryId((await context.params).id);
    const input = await libraryBody(request, collectionSchema);
    const collection = await prisma.$transaction(async (tx) => {
      const changed = await tx.collection.updateMany({
        where: { id, ownerId: user.id },
        data: input,
      });
      if (!changed.count) throw authError(404, "Collection not found");
      return tx.collection.findFirstOrThrow({
        where: { id, ownerId: user.id },
        select: {
          id: true,
          name: true,
          description: true,
          _count: {
            select: {
              items: {
                where: { media: { ownerId: user.id, deletedAt: null } },
              },
            },
          },
        },
      });
    });
    const { _count, ...data } = collection;
    return libraryJson({ collection: { ...data, count: _count.items } });
  } catch (error) {
    return authFailure(error);
  }
}
export async function DELETE(request: NextRequest, context: Context) {
  try {
    const { user } = await requireAuth(request);
    assertSameOrigin(request);
    const id = libraryId((await context.params).id);
    // Cascading collection-item removal never deletes original media objects.
    const result = await prisma.collection.deleteMany({
      where: { id, ownerId: user.id },
    });
    if (!result.count) throw authError(404, "Collection not found");
    return libraryJson({ deleted: true });
  } catch (error) {
    return authFailure(error);
  }
}
