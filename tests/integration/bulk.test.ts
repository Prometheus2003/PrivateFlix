import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, randomBytes, randomUUID } from "node:crypto";
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
    deleteObject: vi.fn(async (key: string) => {
      void key;
    }),
    abortMultipartUpload: vi.fn(async () => {}),
  },
}));
import { prisma } from "@/lib/db/prisma";
import { storage } from "@/lib/storage";
import { POST as bulk } from "@/app/api/media/bulk/route";
import { DELETE as removeOne } from "@/app/api/media/[id]/route";
import { GET as list } from "@/app/api/media/route";
import { runUploadMaintenance } from "@/lib/media/cleanup";
import { mutateMedia } from "@/lib/media/bulk";
const enabled = process.env.PRIVATEFLIX_SECURITY_TEST === "1";
let ownerId = "",
  token = "",
  first = "",
  second = "",
  foreign = "";
function request(body?: unknown, headers: Record<string, string> = {}) {
  return new NextRequest("https://privateflix.test/api/media/bulk", {
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
const edit = (fields: object, mediaIds = [first, second]) =>
  bulk(request({ ...fields, mediaIds }));
async function group(name: string) {
  return prisma.collection.create({ data: { ownerId, name } });
}
async function expireJobs() {
  await prisma.processingJob.updateMany({
    where: { type: "CLEANUP" },
    data: { createdAt: new Date(0) },
  });
}
describe.skipIf(!enabled)(
  "atomic owner bulk actions and permanent cleanup",
  () => {
    beforeEach(async () => {
      if (
        new URL(process.env.DATABASE_URL!).pathname !==
        "/privateflix_security_test"
      )
        throw new Error("Test database required");
      vi.mocked(storage.deleteObject).mockReset().mockResolvedValue();
      vi.mocked(storage.abortMultipartUpload).mockClear();
      await prisma.auditEvent.deleteMany();
      await prisma.user.deleteMany();
      const owner = await prisma.user.create({
        data: {
          email: "bulk@example.test",
          username: "bulk",
          passwordHash: "unused",
        },
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
      [first, second, foreign] = [randomUUID(), randomUUID(), randomUUID()];
      await prisma.media.createMany({
        data: [first, second].map((id) => ({
          id,
          ownerId,
          title: "Synthetic fixture",
          originalFilename: "fixture.mp4",
          type: "VIDEO",
          mimeType: "video/mp4",
          fileSize: BigInt(100),
          storageKey: `private/${id}/original`,
          thumbnailStorageKey: `private/${id}/thumbnail`,
          previewStorageKey: `private/${id}/preview`,
          processingStatus: "READY",
        })),
      });
    });
    afterAll(async () => {
      await prisma.$disconnect();
    });
    it("scopes every mutation to the supplied authenticated principal", async () => {
      await expect(
        mutateMedia(randomUUID(), {
          action: "favorite",
          mediaIds: [first],
          favorite: true,
        }),
      ).rejects.toMatchObject({ status: 404 });
      expect(await prisma.favorite.count()).toBe(0);
    });
    it("authenticates before validation and rejects cross-origin changes", async () => {
      expect((await bulk(request({}, { cookie: "" }))).status).toBe(401);
      expect(
        (
          await bulk(
            request(
              { action: "favorite", mediaIds: [first], favorite: true },
              { origin: "https://evil.test" },
            ),
          )
        ).status,
      ).toBe(403);
      expect(await prisma.favorite.count()).toBe(0);
    });
    it("rejects duplicate, oversized, unknown and unconfirmed inputs", async () => {
      for (const body of [
        { action: "favorite", mediaIds: [], favorite: true },
        { action: "favorite", mediaIds: [first, first], favorite: true },
        {
          action: "favorite",
          mediaIds: Array.from({ length: 101 }, () => randomUUID()),
          favorite: true,
        },
        { action: "favorite", mediaIds: [first], favorite: true, ownerId },
        { action: "delete", mediaIds: [first] },
        { action: "delete", mediaIds: [first], confirm: false },
        { action: "tags", mediaIds: [first], tags: [], mode: "add" },
      ])
        expect((await bulk(request(body))).status).toBe(400);
    });
    it.each(["favorite", "collection", "tags", "delete"])(
      "rolls back %s if any selected ID is unavailable",
      async (action) => {
        const fields =
          action === "favorite"
            ? { favorite: true }
            : action === "collection"
              ? { collectionId: (await group("safe")).id, mode: "move" }
              : action === "tags"
                ? { tags: ["safe"], mode: "add" }
                : { confirm: true };
        expect(
          (await edit({ action, ...fields }, [first, foreign])).status,
        ).toBe(404);
        expect(await prisma.favorite.count()).toBe(0);
        expect(await prisma.collectionItem.count()).toBe(0);
        expect(await prisma.mediaTag.count()).toBe(0);
        expect(
          await prisma.media.count({ where: { deletedAt: { not: null } } }),
        ).toBe(0);
      },
    );
    it("applies idempotent favorites and owner-only collection add/move/unfile", async () => {
      const a = await group("A"),
        b = await group("B");
      for (let n = 0; n < 2; n++)
        expect(
          (await edit({ action: "favorite", favorite: true })).status,
        ).toBe(200);
      expect(await prisma.favorite.count()).toBe(2);
      expect((await edit({ action: "favorite", favorite: false })).status).toBe(
        200,
      );
      expect(await prisma.favorite.count()).toBe(0);
      expect(
        (await edit({ action: "collection", collectionId: a.id, mode: "add" }))
          .status,
      ).toBe(200);
      expect(
        (await edit({ action: "collection", collectionId: b.id, mode: "add" }))
          .status,
      ).toBe(200);
      expect(await prisma.collectionItem.count()).toBe(4);
      expect(
        (await edit({ action: "collection", collectionId: b.id, mode: "move" }))
          .status,
      ).toBe(200);
      expect(await prisma.collectionItem.count()).toBe(2);
      expect(
        (
          await edit({
            action: "collection",
            collectionId: randomUUID(),
            mode: "move",
          })
        ).status,
      ).toBe(404);
      expect(await prisma.collectionItem.count()).toBe(2);
      expect(
        (await edit({ action: "collection", collectionId: null, mode: "move" }))
          .status,
      ).toBe(200);
      expect(await prisma.collectionItem.count()).toBe(0);
    });
    it("normalizes, adds, removes, replaces and clears tags without orphan vocabulary", async () => {
      expect(
        (
          await edit({
            action: "tags",
            tags: ["TRAVEL", "travel", "family"],
            mode: "add",
          })
        ).status,
      ).toBe(200);
      expect(await prisma.mediaTag.count()).toBe(4);
      expect(
        (
          await edit({ action: "tags", tags: ["travel"], mode: "remove" }, [
            first,
          ])
        ).status,
      ).toBe(200);
      expect(await prisma.mediaTag.count()).toBe(3);
      expect(
        (await edit({ action: "tags", tags: ["new"], mode: "replace" })).status,
      ).toBe(200);
      expect((await prisma.tag.findMany()).map((tag) => tag.name)).toEqual([
        "new",
      ]);
      expect(
        (await edit({ action: "tags", tags: [], mode: "replace" })).status,
      ).toBe(200);
      expect(await prisma.tag.count()).toBe(0);
    });
    it("rolls back the entire tag operation if one item exceeds its cap", async () => {
      expect(
        (
          await edit(
            {
              action: "tags",
              tags: Array.from({ length: 20 }, (_, n) => `tag${n}`),
              mode: "add",
            },
            [second],
          )
        ).status,
      ).toBe(200);
      expect(
        (await edit({ action: "tags", tags: ["overflow"], mode: "add" }))
          .status,
      ).toBe(409);
      expect(await prisma.mediaTag.count({ where: { mediaId: first } })).toBe(
        0,
      );
      expect(await prisma.tag.count({ where: { name: "overflow" } })).toBe(0);
    });
    it("requires single deletion confirmation and hides media before cleanup, idempotently", async () => {
      const context = { params: Promise.resolve({ id: first }) };
      expect((await removeOne(request({}), context)).status).toBe(400);
      const response = await removeOne(request({ confirm: true }), context);
      expect(response.status).toBe(202);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(
        (await edit({ action: "delete", confirm: true }, [first])).status,
      ).toBe(202);
      expect(
        await prisma.processingJob.count({
          where: { mediaId: first, type: "CLEANUP" },
        }),
      ).toBe(1);
      const result = await list(
        new NextRequest("https://privateflix.test/api/media", {
          headers: { cookie: `privateflix_session=${token}` },
        }),
      );
      expect(
        (await result.json()).media.map((item: { id: string }) => item.id),
      ).toEqual([second]);
      expect((await runUploadMaintenance()).cleaned).toBe(0);
      expect(storage.deleteObject).not.toHaveBeenCalled();
    });
    it("rejects deletion of active uploads or processing without partial changes", async () => {
      await prisma.media.update({
        where: { id: second },
        data: { processingStatus: "PROCESSING" },
      });
      expect((await edit({ action: "delete", confirm: true })).status).toBe(
        409,
      );
      expect(
        await prisma.media.count({ where: { deletedAt: { not: null } } }),
      ).toBe(0);
      await prisma.media.update({
        where: { id: second },
        data: { processingStatus: "READY" },
      });
      await prisma.upload.create({
        data: { ownerId, mediaId: second, status: "UPLOADING" },
      });
      expect((await edit({ action: "delete", confirm: true })).status).toBe(
        409,
      );
      expect(await prisma.processingJob.count()).toBe(0);
    });
    it("normalizes legacy terminal processing receipts before deletion", async () => {
      await prisma.media.update({
        where: { id: first },
        data: { processingStatus: "FAILED" },
      });
      const upload = await prisma.upload.create({
        data: { ownerId, mediaId: first, status: "UPLOADED" },
      });
      expect(
        (await edit({ action: "delete", confirm: true }, [first])).status,
      ).toBe(202);
      expect(
        (await prisma.upload.findUniqueOrThrow({ where: { id: upload.id } }))
          .status,
      ).toBe("FAILED");
      await expireJobs();
      expect((await runUploadMaintenance()).cleaned).toBe(1);
      expect(
        await prisma.media.findUnique({ where: { id: first } }),
      ).toBeNull();
    });
    it("deletes originals and derivatives, related membership, history and cover references", async () => {
      const c = await prisma.collection.create({
        data: {
          ownerId,
          name: "Keep grouping",
          coverMediaId: first,
          items: { create: { mediaId: first } },
        },
      });
      await prisma.favorite.create({
        data: { userId: ownerId, mediaId: first },
      });
      await prisma.playbackProgress.create({
        data: { userId: ownerId, mediaId: first },
      });
      await prisma.playlist.create({
        data: {
          ownerId,
          name: "Keep playlist",
          items: { create: { mediaId: first } },
        },
      });
      await edit({ action: "tags", tags: ["disposable"], mode: "add" }, [
        first,
      ]);
      const upload = await prisma.upload.create({
        data: { ownerId, mediaId: first, status: "READY" },
      });
      await edit({ action: "delete", confirm: true }, [first]);
      await expireJobs();
      expect((await runUploadMaintenance()).cleaned).toBe(1);
      expect(
        vi.mocked(storage.deleteObject).mock.calls.map(([key]) => key),
      ).toEqual([
        `private/${first}/original`,
        `private/${first}/thumbnail`,
        `private/${first}/preview`,
      ]);
      expect(
        await prisma.media.findUnique({ where: { id: first } }),
      ).toBeNull();
      expect(
        await prisma.media.findUnique({ where: { id: second } }),
      ).not.toBeNull();
      expect(await prisma.favorite.count()).toBe(0);
      expect(await prisma.playbackProgress.count()).toBe(0);
      expect(await prisma.playlistItem.count()).toBe(0);
      expect(await prisma.tag.count()).toBe(0);
      expect(
        (await prisma.collection.findUniqueOrThrow({ where: { id: c.id } }))
          .coverMediaId,
      ).toBeNull();
      expect(
        (await prisma.upload.findUniqueOrThrow({ where: { id: upload.id } }))
          .mediaId,
      ).toBeNull();
      expect(
        await prisma.auditEvent.count({
          where: { action: "media_deleted", resourceId: first },
        }),
      ).toBe(1);
    });
    it("retains deletion intent after partial I/O failure and retries without touching another media", async () => {
      await edit({ action: "delete", confirm: true }, [first]);
      await expireJobs();
      vi.mocked(storage.deleteObject)
        .mockImplementationOnce(async () => {})
        .mockRejectedValueOnce(new Error("Unavailable"));
      const now = new Date();
      expect((await runUploadMaintenance(now)).failed).toBe(1);
      expect(
        (await prisma.media.findUniqueOrThrow({ where: { id: first } }))
          .processingStatus,
      ).toBe("DELETING");
      expect(
        (await runUploadMaintenance(new Date(now.getTime() + 60000))).cleaned,
      ).toBe(0);
      expect(
        (await runUploadMaintenance(new Date(now.getTime() + 31 * 60000)))
          .cleaned,
      ).toBe(1);
      expect(
        await prisma.media.findUnique({ where: { id: first } }),
      ).toBeNull();
      expect(
        await prisma.media.findUnique({ where: { id: second } }),
      ).not.toBeNull();
    });
    it("protects successful media from stale cleanup and blocks deletion while a processor lease is active", async () => {
      await prisma.processingJob.create({
        data: { mediaId: second, type: "CLEANUP", createdAt: new Date(0) },
      });
      await edit({ action: "delete", confirm: true }, [first]);
      await expireJobs();
      await prisma.processingJob.create({
        data: {
          mediaId: first,
          type: "METADATA",
          status: "PROCESSING",
          leaseExpiresAt: new Date(Date.now() + 3600000),
        },
      });
      const result = await runUploadMaintenance();
      expect(result).toMatchObject({ cleaned: 1, failed: 1 });
      expect(storage.deleteObject).not.toHaveBeenCalled();
      expect(await prisma.media.count()).toBe(2);
    });
  },
);
