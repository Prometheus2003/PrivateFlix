import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes, createHash, randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
vi.mock("server-only", () => ({}));
vi.mock("@/lib/validation/env", () => ({
  getEnv: () => ({
    APP_URL: "https://privateflix.test",
    NODE_ENV: "test",
    SESSION_IDLE_TIMEOUT: 60,
    SESSION_ABSOLUTE_TIMEOUT: 3600,
  }),
}));
vi.mock("@/lib/storage", () => ({
  storage: {
    getObjectMetadata: vi.fn(async () => ({
      contentLength: 100,
      contentType: "image/png",
    })),
  },
}));
import { prisma } from "@/lib/db/prisma";
import { storage } from "@/lib/storage";
import { POST as retry } from "@/app/api/media/[id]/retry/route";
import { GET as list } from "@/app/api/media/route";
let ownerId = "",
  token = "",
  id = "",
  failedJob = "";
function request(
  body: unknown = { confirm: true },
  headers: Record<string, string> = {},
) {
  return new NextRequest("https://privateflix.test/api/media/retry", {
    method: "POST",
    headers: {
      cookie: `privateflix_session=${token}`,
      origin: "https://privateflix.test",
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}
const run = (
  mediaId = id,
  body: unknown = { confirm: true },
  headers: Record<string, string> = {},
) =>
  retry(request(body, headers), { params: Promise.resolve({ id: mediaId }) });
describe.skipIf(process.env.PRIVATEFLIX_SECURITY_TEST !== "1")(
  "owner processing retry",
  () => {
    beforeEach(async () => {
      if (
        new URL(process.env.DATABASE_URL!).pathname !==
        "/privateflix_security_test"
      )
        throw new Error("Test database required");
      vi.mocked(storage.getObjectMetadata)
        .mockReset()
        .mockResolvedValue({ contentLength: 100, contentType: "image/png" });
      await prisma.auditEvent.deleteMany();
      await prisma.user.deleteMany();
      ownerId = (
        await prisma.user.create({
          data: {
            email: "retry@example.test",
            username: "retry",
            passwordHash: "unused",
          },
        })
      ).id;
      token = randomBytes(32).toString("hex");
      await prisma.session.create({
        data: {
          userId: ownerId,
          tokenHash: createHash("sha256").update(token).digest("hex"),
          expiresAt: new Date(Date.now() + 3600000),
        },
      });
      id = (
        await prisma.media.create({
          data: {
            ownerId,
            title: "Retry fixture",
            originalFilename: "fixture.png",
            type: "IMAGE",
            mimeType: "image/png",
            fileSize: 100,
            checksum: "a".repeat(64),
            storageKey: `private/${randomUUID()}/original`,
            processingStatus: "FAILED",
          },
        })
      ).id;
      failedJob = (
        await prisma.processingJob.create({
          data: {
            mediaId: id,
            type: "METADATA",
            status: "FAILED",
            attempts: 3,
          },
        })
      ).id;
      await prisma.upload.create({
        data: { ownerId, mediaId: id, status: "FAILED" },
      });
    });
    afterAll(async () => {
      await prisma.$disconnect();
    });
    it("authenticates first, requires confirmation and protects canonical origin", async () => {
      expect((await run("bad", {}, { cookie: "" })).status).toBe(401);
      expect(
        (await run(id, { confirm: true }, { origin: "https://evil.test" }))
          .status,
      ).toBe(403);
      expect((await run(id, {})).status).toBe(400);
      expect((await run(randomUUID())).status).toBe(404);
      expect(storage.getObjectMetadata).not.toHaveBeenCalled();
    });
    it("queues a fresh bounded job while preserving failed history and original fields", async () => {
      const before = await prisma.media.findUniqueOrThrow({ where: { id } });
      const response = await run();
      expect(response.status).toBe(202);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(await response.json()).toEqual({ queued: true });
      expect(
        await prisma.processingJob.count({
          where: {
            mediaId: id,
            type: "METADATA",
            status: "QUEUED",
            attempts: 0,
            maxAttempts: 3,
          },
        }),
      ).toBe(1);
      expect(
        (
          await prisma.processingJob.findUniqueOrThrow({
            where: { id: failedJob },
          })
        ).status,
      ).toBe("FAILED");
      const media = await prisma.media.findUniqueOrThrow({ where: { id } });
      expect(media).toMatchObject({
        processingStatus: "UPLOADED",
        processingError: null,
        checksum: before.checksum,
        storageKey: before.storageKey,
        fileSize: before.fileSize,
      });
      expect(
        (await prisma.upload.findFirstOrThrow({ where: { mediaId: id } }))
          .status,
      ).toBe("UPLOADED");
    });
    it("serializes simultaneous retry requests to one new job", async () => {
      const responses = await Promise.all([run(), run()]);
      expect(responses.map((response) => response.status).sort()).toEqual([
        202, 409,
      ]);
      expect(
        await prisma.processingJob.count({
          where: { mediaId: id, status: "QUEUED" },
        }),
      ).toBe(1);
    });
    it.each(["READY", "PROCESSING", "UPLOADING"] as const)(
      "rejects media in %s state",
      async (state) => {
        await prisma.media.update({
          where: { id },
          data: { processingStatus: state },
        });
        expect((await run()).status).toBe(409);
        expect(storage.getObjectMetadata).not.toHaveBeenCalled();
      },
    );
    it("requires a verified checksum and a terminal metadata failure", async () => {
      await prisma.media.update({ where: { id }, data: { checksum: null } });
      expect((await run()).status).toBe(409);
      await prisma.media.update({
        where: { id },
        data: { checksum: "a".repeat(64) },
      });
      await prisma.processingJob.delete({ where: { id: failedJob } });
      expect((await run()).status).toBe(409);
      expect(storage.getObjectMetadata).not.toHaveBeenCalled();
    });
    it("does not enqueue an absent or changed original", async () => {
      vi.mocked(storage.getObjectMetadata).mockRejectedValueOnce(
        new Error("NoSuchKey"),
      );
      expect((await run()).status).toBe(409);
      vi.mocked(storage.getObjectMetadata).mockResolvedValueOnce({
        contentLength: 101,
        contentType: "image/png",
      });
      expect((await run()).status).toBe(409);
      expect(
        await prisma.processingJob.count({
          where: { mediaId: id, status: "QUEUED" },
        }),
      ).toBe(0);
    });
    it("rejects an active upload, pending cleanup and another processor", async () => {
      await prisma.upload.updateMany({
        where: { mediaId: id },
        data: { status: "UPLOADING" },
      });
      expect((await run()).status).toBe(409);
      await prisma.upload.updateMany({
        where: { mediaId: id },
        data: { status: "FAILED" },
      });
      const job = await prisma.processingJob.create({
        data: { mediaId: id, type: "CLEANUP" },
      });
      expect((await run()).status).toBe(409);
      await prisma.processingJob.update({
        where: { id: job.id },
        data: {
          type: "METADATA",
          status: "PROCESSING",
          leaseExpiresAt: new Date(Date.now() + 60000),
        },
      });
      expect((await run()).status).toBe(409);
    });
    it("rechecks ownership and deletion after storage I/O", async () => {
      vi.mocked(storage.getObjectMetadata).mockImplementationOnce(async () => {
        await prisma.media.update({
          where: { id },
          data: { processingStatus: "DELETING", deletedAt: new Date() },
        });
        return { contentLength: 100, contentType: "image/png" };
      });
      expect((await run()).status).toBe(404);
      expect(
        await prisma.processingJob.count({
          where: { mediaId: id, status: "QUEUED" },
        }),
      ).toBe(0);
    });
    it("enforces per-media cooldown and daily retry cap", async () => {
      await prisma.auditEvent.create({
        data: {
          userId: ownerId,
          action: "media_processing_retried",
          resourceType: "media",
          resourceId: id,
        },
      });
      expect((await run()).status).toBe(429);
      await prisma.auditEvent.deleteMany();
      await prisma.auditEvent.createMany({
        data: Array.from({ length: 5 }, (_, n) => ({
          userId: ownerId,
          action: "media_processing_retried",
          resourceType: "media",
          resourceId: id,
          createdAt: new Date(Date.now() - (n + 2) * 60000),
        })),
      });
      expect((await run()).status).toBe(429);
    });
    it("exposes retry eligibility without original checksums, keys or job IDs", async () => {
      const response = await list(
        new NextRequest("https://privateflix.test/api/media", {
          headers: { cookie: `privateflix_session=${token}` },
        }),
      );
      const body = await response.json();
      expect(body.media[0].canRetryProcessing).toBe(true);
      expect(body.media[0]).not.toHaveProperty("checksum");
      expect(body.media[0]).not.toHaveProperty("processingJobs");
      expect(body.media[0]).not.toHaveProperty("storageKey");
    });
  },
);
