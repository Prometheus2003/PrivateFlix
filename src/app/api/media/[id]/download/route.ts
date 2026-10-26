import { NextRequest } from "next/server";
import { serveOriginal } from "@/lib/media/serve-original";
export function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  return serveOriginal(request, context.params, true);
}
export function HEAD(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  return serveOriginal(request, context.params, true);
}
