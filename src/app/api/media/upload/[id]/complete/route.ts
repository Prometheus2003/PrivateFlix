import { NextRequest } from "next/server";
import { mutateMultipart } from "@/lib/media/multipart";
export const runtime = "nodejs";
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  return mutateMultipart(request, (await context.params).id, "complete");
}
