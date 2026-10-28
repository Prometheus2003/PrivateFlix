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
import { prisma } from "@/lib/db/prisma";
import { POST as duplicates } from "@/app/api/media/duplicates/route";
import { GET as history } from "@/app/api/media/upload-history/route";
let ownerId = "",
  token = "",
  id = "";
function request(
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return new NextRequest(`https://privateflix.test${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      cookie: `privateflix_session=${token}`,
      origin: "https://privateflix.test",
      "content-type": "application/json",
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
const check = (
  body: unknown = { checksum: "a".repeat(64), totalBytes: 100 },
  headers: Record<string, string> = {},
) => duplicates(request("/api/media/duplicates", body, headers));
describe.skipIf(process.env.PRIVATEFLIX_SECURITY_TEST !== "1")(
  "duplicate warnings and safe upload history",
  () => {
    beforeEach(async () => {
      if (
        new URL(process.env.DATABASE_URL!).pathname !==
        "/privateflix_security_test"
      )
        throw new Error("Test database required");
      await prisma.auditEvent.deleteMany();
      await prisma.user.deleteMany();
      ownerId = (
        await prisma.user.create({
          data: {
            email: "queue@example.test",
            username: "queue",
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
            title: "Synthetic file",
            originalFilename: "file.png",
            type: "IMAGE",
            mimeType: "image/png",
            fileSize: 100,
            checksum: "a".repeat(64),
            storageKey: `private/${randomUUID()}`,
            processingStatus: "READY",
          },
        })
      ).id;
    });
    afterAll(async () => {
      await prisma.$disconnect();
    });
    it("authenticates before validating duplicate and history requests", async () => {
      expect((await check({}, { cookie: "" })).status).toBe(401);
      expect(
        (
          await history(
            request("/api/media/upload-history?page=bad", undefined, {
              cookie: "",
            }),
          )
        ).status,
      ).toBe(401);
      expect(
        (await check(undefined, { origin: "https://evil.test" })).status,
      ).toBe(403);
    });
    it("compares exact verified checksum and size without exposing matching media", async () => {
      const response = await check();
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(await response.json()).toEqual({ duplicate: true });
      expect(
        await (
          await check({ checksum: "a".repeat(64), totalBytes: 101 })
        ).json(),
      ).toEqual({ duplicate: false });
      expect(
        await (
          await check({ checksum: "b".repeat(64), totalBytes: 100 })
        ).json(),
      ).toEqual({ duplicate: false });
      expect(await prisma.media.count()).toBe(1);
    });
    it("ignores deleted originals and rejects unknown duplicate fields", async () => {
      await prisma.media.update({
        where: { id },
        data: { deletedAt: new Date() },
      });
      expect(await (await check()).json()).toEqual({ duplicate: false });
      for (const body of [
        { checksum: "bad", totalBytes: 100 },
        { checksum: "a".repeat(64), totalBytes: 0 },
        { checksum: "a".repeat(64), totalBytes: 100, ownerId },
      ])
        expect((await check(body)).status).toBe(400);
    });
    it("paginates history with stable order and safe fields", async () => {
      await prisma.upload.createMany({
        data: Array.from({ length: 23 }, () => ({
          ownerId,
          mediaId: id,
          status: "READY",
          totalBytes: BigInt(100),
          bytesUploaded: BigInt(100),
          storageUploadId: "server-only",
          expectedChecksum: "a".repeat(64),
        })),
      });
      const first = await history(request("/api/media/upload-history"));
      expect(first.status).toBe(200);
      expect(first.headers.get("cache-control")).toBe("private, no-store");
      const body = await first.json();
      expect(body.uploads).toHaveLength(20);
      expect(body.hasMore).toBe(true);
      expect(body.uploads[0].media).toEqual({
        id,
        title: "Synthetic file",
        processingStatus: "READY",
      });
      expect(JSON.stringify(body)).not.toContain("server-only");
      expect(body.uploads[0]).not.toHaveProperty("expectedChecksum");
      const next = await (
        await history(request("/api/media/upload-history?page=2"))
      ).json();
      expect(next.uploads).toHaveLength(3);
      expect(next.hasMore).toBe(false);
      expect(
        new Set(
          [...body.uploads, ...next.uploads].map(
            (row: { id: string }) => row.id,
          ),
        ).size,
      ).toBe(23);
    });
    it("handles removed media and failed/cancelled receipts without private extracted errors", async () => {
      await prisma.upload.createMany({
        data: [
          {
            ownerId,
            mediaId: id,
            status: "FAILED",
            errorMessage: "internal /private/path",
          },
          { ownerId, status: "CANCELLED" },
        ],
      });
      await prisma.media.update({
        where: { id },
        data: { processingStatus: "FAILED", deletedAt: new Date() },
      });
      const body = await (
        await history(request("/api/media/upload-history"))
      ).json();
      expect(
        body.uploads.every((row: { media: unknown }) => row.media === null),
      ).toBe(true);
      expect(JSON.stringify(body)).not.toContain("/private/path");
      expect(
        body.uploads.find((row: { status: string }) => row.status === "FAILED")
          .reason,
      ).toContain("Media processing failed");
      await prisma.media.delete({ where: { id } });
      expect(
        (await (await history(request("/api/media/upload-history"))).json())
          .uploads,
      ).toHaveLength(2);
    });
    it.each(["page=0", "limit=101", "page=oops", "unknown=true"])(
      "rejects invalid history bounds %s",
      async (query) => {
        expect(
          (await history(request(`/api/media/upload-history?${query}`))).status,
        ).toBe(400);
      },
    );
  },
);
