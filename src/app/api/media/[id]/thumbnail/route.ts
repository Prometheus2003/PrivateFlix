import { NextRequest } from "next/server";
import { Readable, addAbortSignal } from "node:stream";
import { z } from "zod";
import { requireAuth } from "@/lib/auth/require-auth";
import { authError, authFailure } from "@/lib/auth/http";
import { prisma } from "@/lib/db/prisma";
import { storage } from "@/lib/storage";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { user } = await requireAuth(request);
    const parsed = z
      .string()
      .uuid()
      .safeParse((await context.params).id);
    if (!parsed.success) throw authError(404, "Thumbnail not found");
    const media = await prisma.media.findFirst({
      where: {
        id: parsed.data,
        ownerId: user.id,
        deletedAt: null,
        processingStatus: "READY",
      },
      select: { thumbnailStorageKey: true },
    });
    if (!media?.thumbnailStorageKey)
      throw authError(404, "Thumbnail not found");
    const object = await storage.getObject(media.thumbnailStorageKey);
    if (
      object.metadata.contentType !== "image/jpeg" ||
      object.metadata.contentLength > 4 * 1024 * 1024
    ) {
      object.stream.destroy();
      throw authError(404, "Thumbnail not found");
    }
    addAbortSignal(request.signal, object.stream);
    return new Response(
      Readable.toWeb(object.stream) as ReadableStream<Uint8Array>,
      {
        headers: {
          "Content-Type": "image/jpeg",
          "Content-Length": String(object.metadata.contentLength),
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
        },
      },
    );
  } catch (error) {
    return authFailure(error);
  }
}
