import { beforeEach, afterAll, describe, it, expect, vi } from "vitest";
import { NextRequest } from "next/server";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { Readable } from "node:stream";
vi.mock("server-only", () => ({}));
vi.mock("@/lib/validation/env", () => ({
  getEnv: () => ({
    SESSION_IDLE_TIMEOUT: 86400,
    SESSION_ABSOLUTE_TIMEOUT: 604800,
  }),
}));
const state = vi.hoisted(() => ({
  hold: false,
  stream: undefined as Readable | undefined,
}));
vi.mock("@/lib/storage", () => ({
  storage: {
    getObject: vi.fn(
      async (_key: string, range?: { start: number; end: number }) => {
        const bytes = Buffer.from("0123456789");
        let sent = false;
        state.stream = state.hold
          ? new Readable({
              read() {
                if (!sent) {
                  sent = true;
                  this.push(bytes.subarray(0, 1));
                }
              },
            })
          : Readable.from(
              range ? bytes.subarray(range.start, range.end + 1) : bytes,
            );
        return {
          stream: state.stream,
          metadata: { contentLength: 10, contentType: "video/mp4" },
        };
      },
    ),
    getObjectMetadata: vi.fn(async () => ({
      contentLength: 10,
      contentType: "video/mp4",
    })),
  },
}));
import { prisma } from "@/lib/db/prisma";
import { storage } from "@/lib/storage";
import { serveOriginal } from "@/lib/media/serve-original";
let token: string, mediaId: string, sessionId: string;
const enabled = process.env.PRIVATEFLIX_SECURITY_TEST === "1";
describe.skipIf(!enabled)("private streaming with isolated PostgreSQL", () => {
  beforeEach(async () => {
    if (
      new URL(process.env.DATABASE_URL!).pathname !==
      "/privateflix_security_test"
    )
      throw new Error("Test database required");
    await prisma.auditEvent.deleteMany();
    await prisma.user.deleteMany();
    const owner = await prisma.user.create({
      data: {
        email: "stream@example.test",
        username: "stream",
        passwordHash: "unused",
      },
    });
    token = randomBytes(32).toString("hex");
    sessionId = (
      await prisma.session.create({
        data: {
          userId: owner.id,
          tokenHash: createHash("sha256").update(token).digest("hex"),
          expiresAt: new Date(Date.now() + 3600000),
        },
      })
    ).id;
    mediaId = (
      await prisma.media.create({
        data: {
          ownerId: owner.id,
          title: "Video",
          type: "VIDEO",
          originalFilename: 'a"movie.mp4',
          storageKey: randomUUID(),
          mimeType: "video/mp4",
          fileSize: 10,
          checksum: "a".repeat(64),
          processingStatus: "READY",
        },
      })
    ).id;
    state.hold = false;
    state.stream = undefined;
    vi.clearAllMocks();
  });
  afterAll(async () => {
    state.stream?.destroy();
    await prisma.$disconnect();
  });
  function request(
    headers: Record<string, string> = {},
    method = "GET",
    signal?: AbortSignal,
  ) {
    return new NextRequest(
      "https://privateflix.test/api/media/" + mediaId + "/stream",
      {
        method,
        headers: { cookie: "privateflix_session=" + token, ...headers },
        signal,
      },
    );
  }
  const params = () => Promise.resolve({ id: mediaId });
  it("requires active auth before revealing metadata or ranges", async () => {
    expect(
      (
        await serveOriginal(
          request({ cookie: "", range: "bytes=100-" }),
          params(),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await serveOriginal(
          request({ cookie: "privateflix_session=" + "b".repeat(64) }),
          params(),
        )
      ).status,
    ).toBe(401);
    await prisma.session.update({
      where: { id: sessionId },
      data: { expiresAt: new Date(0) },
    });
    expect((await serveOriginal(request(), params())).status).toBe(401);
    expect(storage.getObject).not.toHaveBeenCalled();
  });
  it("returns 404 for unknown, deleted and unfinished media", async () => {
    expect(
      (await serveOriginal(request(), Promise.resolve({ id: randomUUID() })))
        .status,
    ).toBe(404);
    await prisma.media.update({
      where: { id: mediaId },
      data: { processingStatus: "PROCESSING" },
    });
    expect((await serveOriginal(request(), params())).status).toBe(404);
    await prisma.media.update({
      where: { id: mediaId },
      data: { processingStatus: "READY", deletedAt: new Date() },
    });
    expect((await serveOriginal(request(), params())).status).toBe(404);
  });
  it("streams exact full and partial bodies with private headers", async () => {
    const full = await serveOriginal(request(), params());
    expect(full.status).toBe(200);
    expect(await full.text()).toBe("0123456789");
    const part = await serveOriginal(request({ range: "bytes=2-5" }), params());
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(part.headers.get("content-length")).toBe("4");
    expect(part.headers.get("cache-control")).toBe("private, no-store");
    expect(await part.text()).toBe("2345");
    const suffix = await serveOriginal(
      request({ range: "bytes=-2" }),
      params(),
    );
    expect(await suffix.text()).toBe("89");
  });
  it("rejects unsatisfiable ranges without opening storage", async () => {
    const response = await serveOriginal(
      request({ range: "bytes=10-" }),
      params(),
    );
    expect(response.status).toBe(416);
    expect(response.headers.get("content-range")).toBe("bytes */10");
    expect(storage.getObject).not.toHaveBeenCalled();
  });
  it("handles If-Range and HEAD and encodes download filenames", async () => {
    const changed = await serveOriginal(
      request({ range: "bytes=0-1", "if-range": '"old"' }),
      params(),
    );
    expect(changed.status).toBe(200);
    await changed.body?.cancel();
    const matched = await serveOriginal(
      request({ range: "bytes=0-1", "if-range": '"' + "a".repeat(64) + '"' }),
      params(),
    );
    expect(matched.status).toBe(206);
    await matched.body?.cancel();
    vi.mocked(storage.getObject).mockClear();
    const head = await serveOriginal(
      request({ range: "bytes=0-1" }, "HEAD"),
      params(),
      true,
    );
    expect(head.status).toBe(200);
    expect(head.body).toBeNull();
    expect(head.headers.get("content-length")).toBe("10");
    expect(head.headers.get("content-disposition")).toContain("a%22movie.mp4");
    expect(storage.getObject).not.toHaveBeenCalled();
  });
  it("stops an in-flight transfer after session revocation", async () => {
    state.hold = true;
    const response = await serveOriginal(request(), params());
    const reader = response.body!.getReader();
    await reader.read();
    await prisma.session.update({
      where: { id: sessionId },
      data: { revokedAt: new Date() },
    });
    await expect(reader.read()).rejects.toThrow();
    expect(state.stream?.destroyed).toBe(true);
    expect((await serveOriginal(request(), params())).status).toBe(401);
  });
  it("closes storage when the browser cancels a request", async () => {
    state.hold = true;
    const abort = new AbortController();
    const response = await serveOriginal(
      request({}, "GET", abort.signal),
      params(),
    );
    const reader = response.body!.getReader();
    await reader.read();
    abort.abort();
    await expect(reader.read()).rejects.toThrow();
    expect(state.stream?.destroyed).toBe(true);
  });
});
