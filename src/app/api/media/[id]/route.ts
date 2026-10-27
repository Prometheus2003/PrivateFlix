import { NextRequest } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/auth/require-auth";
import { assertSameOrigin, authError, authFailure } from "@/lib/auth/http";
import { prisma } from "@/lib/db/prisma";
import { libraryBody, libraryId, libraryJson } from "@/lib/media/library-http";
const metadataSchema = z
  .object({
    title: z.string().trim().min(1).max(300),
    description: z.string().trim().max(2000),
    tags: z.array(z.string().trim().min(1).max(40)).max(20),
  })
  .strict();
type Context = { params: Promise<{ id: string }> };
export const runtime = "nodejs";
export async function GET(request: NextRequest, context: Context) {
  try {
    const { user } = await requireAuth(request);
    const id = libraryId((await context.params).id);
    const media = await prisma.media.findFirst({
      where: { id, ownerId: user.id, deletedAt: null },
      select: {
        id: true,
        title: true,
        description: true,
        type: true,
        mimeType: true,
        duration: true,
        width: true,
        height: true,
        createdAt: true,
        mediaTags: {
          where: { tag: { ownerId: user.id } },
          select: { tag: { select: { name: true } } },
          take: 20,
        },
        collectionItems: {
          where: { collection: { ownerId: user.id } },
          select: { collection: { select: { id: true, name: true } } },
          take: 100,
        },
      },
    });
    if (!media) throw authError(404, "Media not found");
    const { mediaTags, collectionItems, ...summary } = media;
    return libraryJson({
      media: {
        ...summary,
        tags: mediaTags.map((item) => item.tag.name),
        collections: collectionItems.map((item) => item.collection),
      },
    });
  } catch (error) {
    return authFailure(error);
  }
}
export async function PATCH(request: NextRequest, context: Context) {
  try {
    const { user } = await requireAuth(request);
    assertSameOrigin(request);
    const id = libraryId((await context.params).id);
    const data = await libraryBody(request, metadataSchema);
    const tags = [
      ...new Set(data.tags.map((name) => name.toLocaleLowerCase("en-US"))),
    ];
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(7253407)`;
      if (
        !(await tx.media.findFirst({
          where: { id, ownerId: user.id, deletedAt: null },
          select: { id: true },
        }))
      )
        throw authError(404, "Media not found");
      const existing = await tx.tag.findMany({
        where: { ownerId: user.id, name: { in: tags } },
        select: { id: true, name: true },
      });
      if (
        (await tx.tag.count({ where: { ownerId: user.id } })) +
          tags.length -
          existing.length >
        500
      )
        throw authError(409, "Tag limit reached (500)");
      await tx.tag.createMany({
        data: tags.map((name) => ({ ownerId: user.id, name })),
        skipDuplicates: true,
      });
      const stored = await tx.tag.findMany({
        where: { ownerId: user.id, name: { in: tags } },
        select: { id: true },
      });
      await tx.mediaTag.deleteMany({
        where: { mediaId: id, tag: { ownerId: user.id } },
      });
      await tx.mediaTag.createMany({
        data: stored.map((tag) => ({ mediaId: id, tagId: tag.id })),
        skipDuplicates: true,
      });
      await tx.media.update({
        where: { id, ownerId: user.id },
        data: { title: data.title, description: data.description },
      });
      // Empty tags are housekeeping, not an ever-growing owner vocabulary.
      await tx.tag.deleteMany({
        where: { ownerId: user.id, mediaTags: { none: {} } },
      });
    });
    return libraryJson({ saved: true });
  } catch (error) {
    return authFailure(error);
  }
}
