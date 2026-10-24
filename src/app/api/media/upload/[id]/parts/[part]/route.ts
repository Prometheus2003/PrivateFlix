import { NextRequest } from "next/server";
import { mutateMultipart } from "@/lib/media/multipart";
export const runtime = "nodejs";
export async function PUT(
  request: NextRequest,
  context: { params: Promise<{ id: string; part: string }> },
) {
  const { id, part } = await context.params;
  return mutateMultipart(request, id, "part", part);
}
