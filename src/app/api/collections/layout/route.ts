import { NextRequest } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/auth/require-auth";
import { assertSameOrigin, authFailure } from "@/lib/auth/http";
import { libraryBody, libraryJson } from "@/lib/media/library-http";
import { saveCollectionLayout } from "@/lib/media/collection-layout";
export const runtime = "nodejs";
export async function PUT(request: NextRequest) {
  try {
    const { user } = await requireAuth(request);
    assertSameOrigin(request);
    const input = await libraryBody(
      request,
      z
        .object({
          collections: z
            .array(
              z
                .object({
                  id: z.string().uuid(),
                  parentId: z.string().uuid().nullable(),
                })
                .strict(),
            )
            .max(100)
            .refine(
              (rows) => new Set(rows.map((row) => row.id)).size === rows.length,
            ),
        })
        .strict(),
    );
    await saveCollectionLayout(user.id, input.collections);
    return libraryJson({ saved: true });
  } catch (error) {
    return authFailure(error);
  }
}
