import { NextRequest } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/auth/require-auth";
import { assertSameOrigin, authFailure } from "@/lib/auth/http";
import { libraryBody, libraryJson } from "@/lib/media/library-http";
import { prisma } from "@/lib/db/prisma";
export const runtime = "nodejs";
export async function POST(request: NextRequest) {
  try {
    const { user } = await requireAuth(request);
    assertSameOrigin(request);
    const input = await libraryBody(
      request,
      z
        .object({
          checksum: z.string().regex(/^[a-f0-9]{64}$/),
          totalBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        })
        .strict(),
    );
    const match = await prisma.media.findFirst({
      where: {
        ownerId: user.id,
        deletedAt: null,
        checksum: input.checksum,
        fileSize: BigInt(input.totalBytes),
      },
      select: { id: true },
    });
    return libraryJson({ duplicate: Boolean(match) });
  } catch (error) {
    return authFailure(error);
  }
}
