import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import { NextRequest } from "next/server";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
vi.mock("server-only", () => ({}));
vi.mock("@/lib/validation/env", () => ({
  getEnv: () => ({
    APP_URL: "https://privateflix.test",
    NODE_ENV: "test",
    SESSION_IDLE_TIMEOUT: 86400,
    SESSION_ABSOLUTE_TIMEOUT: 604800,
    ALLOWED_VIDEO_TYPES: "mp4",
    ALLOWED_IMAGE_TYPES: "png",
    MAX_UPLOAD_SIZE: 1048576,
    S3_ENDPOINT: process.env.S3_ENDPOINT,
    S3_REGION: "us-east-1",
    S3_BUCKET: process.env.S3_BUCKET,
    S3_ACCESS_KEY: process.env.S3_ACCESS_KEY,
    S3_SECRET_KEY: process.env.S3_SECRET_KEY,
  }),
}));
import { prisma } from "@/lib/db/prisma";
import { POST as upload } from "@/app/api/media/upload/route";
import { GET as thumbnail } from "@/app/api/media/[id]/thumbnail/route";
import { GET as list } from "@/app/api/media/route";
import { storage } from "@/lib/storage";
import { serveOriginal } from "@/lib/media/serve-original";
let token: string;
const enabled = process.env.PRIVATEFLIX_PROCESSING_TEST === "1";
function request(path: string, authenticated = true) {
  return new NextRequest("https://privateflix.test" + path, {
    headers: authenticated ? { cookie: "privateflix_session=" + token } : {},
  });
}
describe.skipIf(!enabled)("real Redis/FFmpeg/private storage pipeline", () => {
  beforeAll(async () => {
    if (
      new URL(process.env.DATABASE_URL!).pathname !==
        "/privateflix_security_test" ||
      process.env.S3_ENDPOINT !== "http://127.0.0.1:19000"
    )
      throw new Error("Isolated services required");
    await prisma.auditEvent.deleteMany();
    await prisma.user.deleteMany();
    const owner = await prisma.user.create({
      data: {
        email: "live@example.test",
        username: "live",
        passwordHash: "unused",
      },
    });
    token = randomBytes(32).toString("hex");
    await prisma.session.create({
      data: {
        userId: owner.id,
        tokenHash: createHash("sha256").update(token).digest("hex"),
        expiresAt: new Date(Date.now() + 3600000),
      },
    });
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });
  async function ingest(bytes: Buffer, extension: string) {
    const response = await upload(
      new NextRequest("https://privateflix.test/api/media/upload", {
        method: "POST",
        headers: {
          cookie: "privateflix_session=" + token,
          origin: "https://privateflix.test",
          "content-type": extension === "png" ? "image/png" : "video/mp4",
          "x-filename": "fixture." + extension,
          "content-length": String(bytes.length),
        },
        body: new Uint8Array(bytes),
      }),
    );
    expect(response.status).toBe(201);
    const media = await prisma.media.findFirstOrThrow({
      orderBy: { createdAt: "desc" },
    });
    return media;
  }
  async function waitFor(id: string, status: "READY" | "FAILED") {
    for (let i = 0; i < 100; i++) {
      const media = await prisma.media.findUniqueOrThrow({ where: { id } });
      if (media.processingStatus === status) return media;
      await delay(200);
    }
    throw new Error("Worker did not reach " + status);
  }
  for (const extension of ["png", "mp4"])
    it(
      "processes " + extension + " and serves thumbnails only to the owner",
      async () => {
        const original = await readFile(
          join(process.env.PRIVATEFLIX_FIXTURES!, "fixture." + extension),
        );
        const pending = await ingest(original, extension);
        const media = await waitFor(pending.id, "READY");
        expect(media).toMatchObject({ width: 320, height: 240 });
        if (extension === "mp4") expect(media.duration).toBeGreaterThan(0);
        expect(
          await prisma.processingJob.findFirst({
            where: { mediaId: media.id },
          }),
        ).toMatchObject({ status: "COMPLETED", attempts: 1 });
        const context = { params: Promise.resolve({ id: media.id }) };
        expect((await thumbnail(request("/", false), context)).status).toBe(
          401,
        );
        expect(
          (
            await thumbnail(request("/"), {
              params: Promise.resolve({ id: randomUUID() }),
            })
          ).status,
        ).toBe(404);
        const response = await thumbnail(request("/"), context);
        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe("private, no-store");
        expect(
          Buffer.from(await response.arrayBuffer()).subarray(0, 3),
        ).toEqual(Buffer.from([255, 216, 255]));
        expect(
          (
            await fetch(
              `${process.env.S3_ENDPOINT}/${process.env.S3_BUCKET}/${media.thumbnailStorageKey}`,
            )
          ).status,
        ).toBe(403);
        const listing = await (await list(request("/api/media"))).text();
        expect(listing).toContain('"hasThumbnail":true');
        expect(listing).not.toContain(media.storageKey);
        expect(listing).not.toContain(media.thumbnailStorageKey!);
        const stored = await storage.getObject(media.storageKey);
        const chunks: Buffer[] = [];
        for await (const chunk of stored.stream) chunks.push(chunk);
        expect(Buffer.concat(chunks)).toEqual(original);
        const rangedRequest = new NextRequest(
          "https://privateflix.test/api/media/" + media.id + "/stream",
          {
            headers: {
              cookie: "privateflix_session=" + token,
              range: "bytes=0-31",
            },
          },
        );
        const ranged = await serveOriginal(
          rangedRequest,
          Promise.resolve({ id: media.id }),
        );
        expect(ranged.status).toBe(206);
        expect(ranged.headers.get("content-range")).toBe(
          `bytes 0-31/${original.length}`,
        );
        expect(Buffer.from(await ranged.arrayBuffer())).toEqual(
          original.subarray(0, 32),
        );
      },
    );
  it("fails corrupt media without publishing a thumbnail or removing the original", async () => {
    const bytes = Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      Buffer.alloc(1024),
    ]);
    const media = await ingest(bytes, "png");
    await prisma.processingJob.updateMany({
      where: { mediaId: media.id },
      data: { maxAttempts: 1 },
    });
    const failed = await waitFor(media.id, "FAILED");
    expect(failed.thumbnailStorageKey).toBeNull();
    expect(await storage.objectExists(media.storageKey)).toBe(true);
    expect(
      (
        await thumbnail(request("/"), {
          params: Promise.resolve({ id: media.id }),
        })
      ).status,
    ).toBe(404);
  });
});
