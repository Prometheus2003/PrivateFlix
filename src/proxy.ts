import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { getEnv } from "@/lib/validation/env";

export function proxy(request: NextRequest) {
  const nonce = randomBytes(32).toString("base64");
  const dev = getEnv().NODE_ENV === "development";
  const csp = [
    "default-src 'self'",
    "script-src 'self' 'nonce-" +
      nonce +
      "' 'strict-dynamic'" +
      (dev ? " 'unsafe-eval'" : ""),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "media-src 'self' blob:",
    "connect-src 'self'",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
  const headers = new Headers(request.headers);
  headers.set("x-nonce", nonce);
  headers.set("Content-Security-Policy", csp);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set("Content-Security-Policy", csp);
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
export const config = {
  // Binary uploads enforce auth/origin in their route and must bypass Proxy body cloning.
  matcher: [
    "/((?!api/media/upload(?:/|$)|_next/static|_next/image|favicon.ico).*)",
  ],
};
