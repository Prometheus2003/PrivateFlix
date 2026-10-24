import { beforeEach, afterAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { Readable } from "node:stream";
import { randomBytes, createHash } from "node:crypto";
vi.mock("server-only", () => ({}));
vi.mock("@/lib/validation/env", () => ({
  getEnv: () => ({
    APP_URL: "https://privateflix.test",
    NODE_ENV: "test",
    SESSION_IDLE_TIMEOUT: 60,
    SESSION_ABSOLUTE_TIMEOUT: 3600,
    ALLOWED_VIDEO_TYPES: "mp4",
    ALLOWED_IMAGE_TYPES: "png,jpg,jpeg",
    MAX_UPLOAD_SIZE: 1048576,
  }),
}));
const state = vi.hoisted(() => ({
  stored: Buffer.alloc(0),
  key: "",
  fail: false,
  afterWrite: async () => {},
}));
vi.mock("@/lib/storage", () => ({
  storage: {
    putObject: vi.fn(async (key: string, stream: Readable) => {
      state.key = key;
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(chunk);
      state.stored = Buffer.concat(chunks);
      if (state.fail) throw new Error("Backend unavailable");
      await state.afterWrite();
    }),
    deleteObject: vi.fn(async () => {}),
  },
}));
import { prisma } from "@/lib/db/prisma";
import { POST as upload } from "@/app/api/media/upload/route";
import { GET as list } from "@/app/api/media/route";
import { GET as progress } from "@/app/api/media/upload/[id]/route";
import { storage } from "@/lib/storage";
const enabled = process.env.PRIVATEFLIX_SECURITY_TEST === "1";
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  Buffer.alloc(1024),
]);
let token = "",
  ownerId = "";
function request(body = png, headers: Record<string, string> = {}) {
  return new NextRequest("https://privateflix.test/api/media/upload", {
    method: "POST",
    headers: {
      origin: "https://privateflix.test",
      cookie: "privateflix_session=" + token,
      "x-filename": "photo.png",
      "content-type": "image/png",
      "content-length": String(body.length),
      ...headers,
    },
    body: new Uint8Array(body),
  });
}
describe.skipIf(!enabled)(
  "media ingestion with isolated PostgreSQL and storage transport stub",
  () => {
    beforeEach(async () => {
      if (
        new URL(process.env.DATABASE_URL!).pathname !==
        "/privateflix_security_test"
      )
        throw new Error("Refusing to modify a non-test database");
      await prisma.auditEvent.deleteMany();
      await prisma.user.deleteMany();
      const owner = await prisma.user.create({
        data: {
          email: "upload@example.test",
          username: "uploader",
          passwordHash: "unused",
        },
        select: { id: true },
      });
      ownerId = owner.id;
      token = randomBytes(32).toString("hex");
      await prisma.session.create({
        data: {
          userId: ownerId,
          tokenHash: createHash("sha256").update(token).digest("hex"),
          expiresAt: new Date(Date.now() + 3600000),
        },
      });
      state.fail = false;
      state.key = "";
      state.stored = Buffer.alloc(0);
      state.afterWrite = async () => {};
      vi.mocked(storage.putObject).mockClear();
      vi.mocked(storage.deleteObject).mockClear();
    });
    afterAll(async () => {
      await prisma.$disconnect();
    });
    it("requires authentication and same origin before storing bytes", async () => {
      expect((await upload(request(png, { cookie: "" }))).status).toBe(401);
      expect(
        (await upload(request(png, { origin: "https://attacker.test" })))
          .status,
      ).toBe(403);
      expect(storage.putObject).not.toHaveBeenCalled();
      expect(await prisma.media.count()).toBe(0);
    });
    it("streams valid media, stores a checksum, and schedules metadata processing", async () => {
      const response = await upload(request());
      expect(response.status).toBe(201);
      const body = await response.json();
      expect(JSON.stringify(body)).not.toContain("storageKey");
      expect(JSON.stringify(body)).not.toContain(state.key);
      expect(state.key).not.toContain("photo.png");
      expect(state.stored).toEqual(png);
      const media = await prisma.media.findUniqueOrThrow({
        where: { id: body.media.id },
      });
      expect(media.ownerId).toBe(ownerId);
      expect(media.checksum).toBe(
        createHash("sha256").update(png).digest("hex"),
      );
      expect(media.processingStatus).toBe("UPLOADED");
      expect(
        await prisma.processingJob.count({
          where: { mediaId: media.id, type: "METADATA" },
        }),
      ).toBe(1);
    });
    it("rejects mismatched MIME and path-like filenames", async () => {
      expect(
        (await upload(request(png, { "content-type": "image/jpeg" }))).status,
      ).toBe(415);
      expect(
        (await upload(request(png, { "x-filename": "..%2Fphoto.png" }))).status,
      ).toBe(400);
      expect(storage.putObject).not.toHaveBeenCalled();
    });
    it("marks invalid signatures as failed and records cleanup intent", async () => {
      expect((await upload(request(Buffer.alloc(1024)))).status).toBe(400);
      const media = await prisma.media.findFirstOrThrow();
      expect(media.processingStatus).toBe("FAILED");
      expect(
        await prisma.processingJob.count({
          where: { mediaId: media.id, type: "CLEANUP" },
        }),
      ).toBe(1);
      expect(storage.deleteObject).toHaveBeenCalledWith(media.storageKey);
    });
    it("rejects a false Content-Length", async () => {
      expect(
        (
          await upload(
            request(png, { "content-length": String(png.length - 1) }),
          )
        ).status,
      ).toBe(400);
      expect((await prisma.upload.findFirstOrThrow()).status).toBe("FAILED");
    });
    it("does not finalize media after the session is revoked during upload", async () => {
      state.afterWrite = async () => {
        await prisma.session.updateMany({
          where: { userId: ownerId },
          data: { revokedAt: new Date() },
        });
      };
      expect((await upload(request())).status).toBe(401);
      expect((await prisma.media.findFirstOrThrow()).processingStatus).toBe(
        "FAILED",
      );
    });
    it("records a failed storage write without returning backend details", async () => {
      state.fail = true;
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const response = await upload(request());
        expect(response.status).toBe(500);
        expect(JSON.stringify(await response.json())).not.toContain(
          "Backend unavailable",
        );
        expect((await prisma.upload.findFirstOrThrow()).status).toBe("FAILED");
      } finally {
        log.mockRestore();
      }
    });
    it("lists only safe owner metadata with validated pagination", async () => {
      await upload(request());
      const response = await list(
        new NextRequest("https://privateflix.test/api/media?limit=1", {
          headers: { cookie: "privateflix_session=" + token },
        }),
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.media).toHaveLength(1);
      expect(body.media[0].fileSize).toBe(png.length);
      expect(body.media[0]).not.toHaveProperty("storageKey");
      expect(
        (
          await list(
            new NextRequest("https://privateflix.test/api/media?limit=1000", {
              headers: { cookie: "privateflix_session=" + token },
            }),
          )
        ).status,
      ).toBe(400);
      expect(
        (await list(new NextRequest("https://privateflix.test/api/media")))
          .status,
      ).toBe(401);
    });
    it("returns authenticated upload progress without internal storage identifiers", async () => {
      const uploaded = await (await upload(request())).json();
      const context = { params: Promise.resolve({ id: uploaded.uploadId }) };
      const url =
        "https://privateflix.test/api/media/upload/" + uploaded.uploadId;
      expect((await progress(new NextRequest(url), context)).status).toBe(401);
      const response = await progress(
        new NextRequest(url, {
          headers: { cookie: "privateflix_session=" + token },
        }),
        context,
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      const result = await response.json();
      expect(result.upload.bytesUploaded).toBe(png.length);
      expect(result.upload.status).toBe("UPLOADED");
      expect(result.upload).not.toHaveProperty("storageUploadId");
      expect(result.upload).not.toHaveProperty("ownerId");
      expect(JSON.stringify(result)).not.toContain(state.key);
      expect(
        (
          await progress(
            new NextRequest(url + "?page=101", {
              headers: { cookie: "privateflix_session=" + token },
            }),
            context,
          )
        ).status,
      ).toBe(400);
      expect(
        (
          await progress(
            new NextRequest(url, {
              headers: { cookie: "privateflix_session=" + token },
            }),
            {
              params: Promise.resolve({
                id: "00000000-0000-4000-8000-000000000000",
              }),
            },
          )
        ).status,
      ).toBe(404);
    });
    it("persists unique part receipts, paginates them, and cascades cleanup", async () => {
      const uploaded = await (await upload(request())).json();
      await prisma.upload.update({
        where: { id: uploaded.uploadId },
        data: { partSize: 8388608 },
      });
      const receipt = {
        uploadId: uploaded.uploadId,
        partNumber: 1,
        byteLength: 8,
        checksum: "a".repeat(64),
        etag: "internal-etag",
      };
      await prisma.uploadPart.createMany({
        data: Array.from({ length: 101 }, (_, i) => ({
          ...receipt,
          partNumber: i + 1,
        })),
      });
      await expect(
        prisma.uploadPart.create({ data: receipt }),
      ).rejects.toThrow();
      await expect(
        prisma.uploadPart.create({ data: { ...receipt, partNumber: 0 } }),
      ).rejects.toThrow();
      await expect(
        prisma.uploadPart.create({
          data: { ...receipt, partNumber: 102, byteLength: 8388609 },
        }),
      ).rejects.toThrow();
      await expect(
        prisma.uploadPart.create({
          data: { ...receipt, partNumber: 102, checksum: "bad" },
        }),
      ).rejects.toThrow();
      const url =
        "https://privateflix.test/api/media/upload/" + uploaded.uploadId;
      const context = { params: Promise.resolve({ id: uploaded.uploadId }) };
      const first = await (
        await progress(
          new NextRequest(url, {
            headers: { cookie: "privateflix_session=" + token },
          }),
          context,
        )
      ).json();
      expect(first.upload.parts).toHaveLength(100);
      expect(first.hasMore).toBe(true);
      expect(JSON.stringify(first)).not.toContain("internal-etag");
      const second = await (
        await progress(
          new NextRequest(url + "?page=2", {
            headers: { cookie: "privateflix_session=" + token },
          }),
          context,
        )
      ).json();
      expect(second.upload.parts).toHaveLength(1);
      expect(second.upload.parts[0].partNumber).toBe(101);
      expect(second.hasMore).toBe(false);
      await prisma.upload.delete({ where: { id: uploaded.uploadId } });
      expect(await prisma.uploadPart.count()).toBe(0);
    });
  },
);
