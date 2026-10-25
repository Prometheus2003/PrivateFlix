import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/auth/require-auth";
import { authError, authFailure } from "@/lib/auth/http";
import { prisma } from "@/lib/db/prisma";
export async function GET(request: NextRequest) {
  try {
    const { user } = await requireAuth(request);
    const page = z.coerce
      .number()
      .int()
      .min(1)
      .max(100000)
      .safeParse(request.nextUrl.searchParams.get("page") ?? "1");
    if (!page.success) return authError(400, "Invalid page");
    const uploads = await prisma.upload.findMany({
      where: { ownerId: user.id, partSize: { not: null }, status: "UPLOADING" },
      select: {
        id: true,
        totalBytes: true,
        bytesUploaded: true,
        expectedChecksum: true,
        completionStarted: true,
        media: { select: { originalFilename: true, mimeType: true } },
      },
      orderBy: { createdAt: "desc" },
      skip: (page.data - 1) * 20,
      take: 21,
    });
    return NextResponse.json(
      {
        uploads: uploads.slice(0, 20).map((u) => ({
          ...u,
          totalBytes: Number(u.totalBytes),
          bytesUploaded: Number(u.bytesUploaded),
        })),
        hasMore: uploads.length > 20,
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return authFailure(error);
  }
}
