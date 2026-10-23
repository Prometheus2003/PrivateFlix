import { createHash, timingSafeEqual } from "node:crypto";
import { getEnv } from "@/lib/validation/env";

export function authError(
  status: number,
  error: string,
  headers: Record<string, string> = {},
) {
  return Response.json(
    { error },
    { status, headers: { "Cache-Control": "private, no-store", ...headers } },
  );
}

export function assertSameOrigin(request: Request) {
  if (
    request.headers.get("origin") !== new URL(getEnv().APP_URL).origin ||
    request.headers.get("sec-fetch-site") === "cross-site"
  ) {
    throw authError(403, "Request origin rejected");
  }
}

export function assertSetupToken(request: Request) {
  const expected = getEnv().SETUP_TOKEN;
  const supplied = request.headers.get("x-setup-token") ?? "";
  if (!expected)
    throw authError(503, "Setup is disabled until a setup token is configured");
  if (
    !/^[a-f0-9]{64}$/i.test(supplied) ||
    !timingSafeEqual(
      createHash("sha256").update(supplied).digest(),
      createHash("sha256").update(expected).digest(),
    )
  ) {
    throw authError(403, "Invalid setup token");
  }
}

export async function readAuthBody(request: Request): Promise<unknown> {
  if (
    request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !==
      "application/json" ||
    request.headers.has("content-encoding")
  )
    throw authError(415, "JSON request required");
  const reader = request.body?.getReader();
  if (!reader) throw authError(400, "Invalid request body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(authError(408, "Request timed out")),
      10000,
    );
    timer.unref();
  });
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), timeout]);
      if (done) break;
      size += value.byteLength;
      if (size > 8192) throw authError(413, "Request body too large");
      chunks.push(value);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    } catch {
      throw authError(400, "Invalid request body");
    }
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => {});
  }
}

export function authFailure(error: unknown): Response {
  if (error instanceof Response) return error;
  console.error("[AUTH] Operation failed");
  return authError(500, "An unexpected error occurred");
}
