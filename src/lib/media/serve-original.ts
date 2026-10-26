import "server-only";
import { NextRequest } from "next/server";
import { Readable, addAbortSignal } from "node:stream";
import { z } from "zod";
import { requireAuth } from "@/lib/auth/require-auth";
import { authError, authFailure } from "@/lib/auth/http";
import { prisma } from "@/lib/db/prisma";
import { storage } from "@/lib/storage";
import { getEnv } from "@/lib/validation/env";
import { parseByteRange } from "./byte-range";

export async function serveOriginal(
  request: NextRequest,
  params: Promise<{ id: string }>,
  download = false,
) {
  try {
    const { user, session } = await requireAuth(request);
    const id = z
      .string()
      .uuid()
      .safeParse((await params).id);
    if (!id.success) throw authError(404, "Media not found");
    const media = await prisma.media.findFirst({
      where: {
        id: id.data,
        ownerId: user.id,
        deletedAt: null,
        processingStatus: "READY",
      },
      select: {
        id: true,
        storageKey: true,
        mimeType: true,
        fileSize: true,
        checksum: true,
        originalFilename: true,
      },
    });
    if (!media) throw authError(404, "Media not found");
    const size = Number(media.fileSize);
    if (
      !Number.isSafeInteger(size) ||
      size <= 0 ||
      !media.checksum?.match(/^[a-f0-9]{64}$/)
    )
      throw new Error("Invalid stored media");
    const etag = `"${media.checksum}"`;
    let range;
    try {
      range = parseByteRange(
        request.method === "HEAD" ||
          (request.headers.has("if-range") &&
            request.headers.get("if-range") !== etag)
          ? null
          : request.headers.get("range"),
        size,
      );
    } catch {
      throw authError(416, "Requested range is not satisfiable", {
        "Content-Range": `bytes */${size}`,
        "Accept-Ranges": "bytes",
      });
    }
    const headers: Record<string, string> = {
      "Content-Type": media.mimeType,
      "Content-Length": String(range ? range.end - range.start + 1 : size),
      "Cache-Control": "private, no-store",
      "Accept-Ranges": "bytes",
      ETag: etag,
      "X-Content-Type-Options": "nosniff",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Content-Disposition": download
        ? `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(media.originalFilename).replace(/['()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase())}`
        : "inline",
    };
    if (range)
      headers["Content-Range"] = `bytes ${range.start}-${range.end}/${size}`;
    if (request.method === "HEAD") {
      const info = await storage.getObjectMetadata(media.storageKey);
      if (info.contentLength !== size || info.contentType !== media.mimeType)
        throw new Error("Original changed");
      return new Response(null, { headers });
    }
    const object = await storage.getObject(
      media.storageKey,
      range ?? undefined,
    );
    if (
      object.metadata.contentLength !== size ||
      object.metadata.contentType !== media.mimeType
    ) {
      object.stream.destroy();
      throw new Error("Original changed");
    }
    const abort = new AbortController();
    addAbortSignal(
      AbortSignal.any([
        request.signal,
        abort.signal,
        AbortSignal.timeout(
          Math.max(
            1,
            Math.min(2147483647, session.expiresAt.getTime() - Date.now()),
          ),
        ),
      ]),
      object.stream,
    );
    // Abort ongoing transfer after revocation/expiry/deletion, without renewing idle activity.
    let checking = false;
    const timer = setInterval(async () => {
      if (checking || object.stream.destroyed) return;
      checking = true;
      try {
        const [active, present] = await Promise.all([
          prisma.session.findFirst({
            where: {
              id: session.id,
              userId: user.id,
              revokedAt: null,
              expiresAt: { gt: new Date() },
              lastActivityAt: {
                gt: new Date(Date.now() - getEnv().SESSION_IDLE_TIMEOUT * 1000),
              },
            },
            select: { id: true },
          }),
          prisma.media.findFirst({
            where: {
              id: media.id,
              ownerId: user.id,
              deletedAt: null,
              processingStatus: "READY",
            },
            select: { id: true },
          }),
        ]);
        if (!active || !present) abort.abort();
      } catch {
        abort.abort();
      } finally {
        checking = false;
      }
    }, 5000);
    timer.unref();
    object.stream.once("close", () => clearInterval(timer));
    return new Response(
      Readable.toWeb(object.stream) as ReadableStream<Uint8Array>,
      { status: range ? 206 : 200, headers },
    );
  } catch (error) {
    return authFailure(error);
  }
}
