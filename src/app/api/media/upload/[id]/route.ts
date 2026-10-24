import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/auth/require-auth";
import { authError, authFailure } from "@/lib/auth/http";
import { prisma } from "@/lib/db/prisma";

export const runtime = "nodejs";
const pageSchema = z.coerce.number().int().min(1).max(100);

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { user } = await requireAuth(request);
    const id = z
      .string()
      .uuid()
      .safeParse((await context.params).id);
    const page = pageSchema.safeParse(
      request.nextUrl.searchParams.get("page") ?? "1",
    );
    if (!id.success || !page.success)
      return authError(400, "Invalid upload query");
    const upload = await prisma.upload.findFirst({
      where: { id: id.data, ownerId: user.id },
      select: {
        id: true,
        mediaId: true,
        status: true,
        bytesUploaded: true,
        totalBytes: true,
        partSize: true,
        createdAt: true,
        updatedAt: true,
        parts: {
          where: { etag: { not: null } },
          orderBy: { partNumber: "asc" },
          skip: (page.data - 1) * 100,
          take: 101,
          select: { partNumber: true, byteLength: true, checksum: true },
        },
      },
    });
    if (!upload) return authError(404, "Upload not found");
    return NextResponse.json(
      {
        upload: {
          ...upload,
          bytesUploaded: Number(upload.bytesUploaded),
          totalBytes: Number(upload.totalBytes),
          parts: upload.parts.slice(0, 100),
        },
        page: page.data,
        hasMore: upload.parts.length > 100,
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return authFailure(error);
  }
}
