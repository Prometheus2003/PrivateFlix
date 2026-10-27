import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { assertSameOrigin, authFailure } from "@/lib/auth/http";
import { libraryBody, libraryJson } from "@/lib/media/library-http";
import { bulkSchema, mutateMedia } from "@/lib/media/bulk";
export const runtime = "nodejs";
export async function POST(request: NextRequest) {
  try {
    const { user } = await requireAuth(request);
    assertSameOrigin(request);
    const input = await libraryBody(request, bulkSchema);
    return libraryJson(
      await mutateMedia(user.id, input),
      input.action === "delete" ? 202 : 200,
    );
  } catch (error) {
    return authFailure(error);
  }
}
