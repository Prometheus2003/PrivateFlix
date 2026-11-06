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
import { prisma } from "@/lib/db/prisma";
import { PUT as layout } from "@/app/api/collections/layout/route";
import { PUT as cover } from "@/app/api/collections/[id]/cover/route";
import { GET as groups, POST as create } from "@/app/api/collections/route";
import { DELETE as remove } from "@/app/api/collections/[id]/route";
import { GET as summary } from "@/app/api/library/summary/route";
import { GET as mediaList } from "@/app/api/media/route";
let ownerId = "",
  token = "",
  mediaId = "",
  ids: string[] = [];
const context = (id: string) => ({ params: Promise.resolve({ id }) });
function request(
  path: string,
  method = "GET",
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return new NextRequest(`https://privateflix.test${path}`, {
    method,
    headers: {
      cookie: `privateflix_session=${token}`,
      origin: "https://privateflix.test",
      "content-type": "application/json",
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
const rows = () => ids.map((id) => ({ id, parentId: null as string | null }));
const save = (collections = rows(), headers: Record<string, string> = {}) =>
  layout(request("/api/collections/layout", "PUT", { collections }, headers));
const setCover = (
  id: string | null = mediaId,
  groupId = ids[0],
  headers: Record<string, string> = {},
) =>
  cover(
    request(
      `/api/collections/${groupId}/cover`,
      "PUT",
      { mediaId: id },
      headers,
    ),
    context(groupId),
  );
describe.skipIf(process.env.PRIVATEFLIX_SECURITY_TEST !== "1")(
  "collection presentation and safe dashboard",
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
            email: "layout@example.test",
            username: "layout",
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
      ids = [];
      for (const name of ["Alpha", "Beta", "Gamma"])
        ids.push(
          (
            await prisma.collection.create({
              data: { ownerId, name, sortOrder: ids.length },
            })
          ).id,
        );
      mediaId = (
        await prisma.media.create({
          data: {
            ownerId,
            title: "Private title marker",
            originalFilename: "private-filename-marker.png",
            type: "IMAGE",
            mimeType: "image/png",
            fileSize: 1024,
            storageKey: "private-storage-marker",
            thumbnailStorageKey: "private-thumbnail-marker",
            processingStatus: "READY",
          },
        })
      ).id;
      await prisma.collectionItem.create({
        data: { collectionId: ids[1], mediaId },
      });
    });
    afterAll(async () => {
      await prisma.$disconnect();
    });
    it("authenticates before validation for layout, covers and overview", async () => {
      expect((await save([], { cookie: "" })).status).toBe(401);
      expect((await setCover(mediaId, ids[0], { cookie: "" })).status).toBe(
        401,
      );
      expect(
        (
          await summary(
            request("/api/library/summary", "GET", undefined, { cookie: "" }),
          )
        ).status,
      ).toBe(401);
      expect((await save(rows(), { origin: "https://evil.test" })).status).toBe(
        403,
      );
      expect(
        (await setCover(mediaId, ids[0], { origin: "https://evil.test" }))
          .status,
      ).toBe(403);
    });
    it("saves complete order and nesting atomically while keeping direct memberships", async () => {
      const data = [
        { id: ids[2], parentId: null },
        { id: ids[1], parentId: ids[0] },
        { id: ids[0], parentId: null },
      ];
      const response = await save(data);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      const body = await (await groups(request("/api/collections"))).json();
      expect(body.collections.map((row: { id: string }) => row.id)).toEqual(
        data.map((row) => row.id),
      );
      expect(body.collections[1]).toMatchObject({ parentId: ids[0], count: 1 });
      expect(body.collections[2].count).toBe(0);
      const parentMedia = await mediaList(
        request(`/api/media?collection=${ids[0]}`),
      );
      expect((await parentMedia.json()).media).toHaveLength(0);
      expect(await prisma.media.count()).toBe(1);
      expect(await prisma.collectionItem.count()).toBe(1);
      const created = await create(
        request("/api/collections", "POST", { name: "New last" }),
      );
      expect(created.status).toBe(201);
      expect((await created.json()).collection.sortOrder).toBe(3);
    });
    it("rejects unavailable IDs, stale sets, duplicate IDs and oversized layout bodies", async () => {
      expect(
        (await save([{ id: randomUUID(), parentId: null }, ...rows().slice(1)]))
          .status,
      ).toBe(404);
      expect(
        (
          await save([
            { id: ids[0], parentId: randomUUID() },
            ...rows().slice(1),
          ])
        ).status,
      ).toBe(404);
      expect((await save(rows().slice(1))).status).toBe(409);
      expect((await save([rows()[0], rows()[0], rows()[2]])).status).toBe(400);
      expect(
        (
          await save(
            Array.from({ length: 101 }, () => ({
              id: randomUUID(),
              parentId: null,
            })),
          )
        ).status,
      ).toBe(400);
      expect(
        (
          await layout(
            request("/api/collections/layout", "PUT", {
              collections: rows(),
              ownerId,
            }),
          )
        ).status,
      ).toBe(400);
      expect(
        (await prisma.collection.findUniqueOrThrow({ where: { id: ids[0] } }))
          .sortOrder,
      ).toBe(0);
    });
    it("rejects self/circular hierarchies without partially reordering", async () => {
      expect(
        (await save([{ id: ids[0], parentId: ids[0] }, ...rows().slice(1)]))
          .status,
      ).toBe(409);
      expect(
        (
          await save([
            { id: ids[2], parentId: ids[1] },
            { id: ids[1], parentId: ids[0] },
            { id: ids[0], parentId: ids[2] },
          ])
        ).status,
      ).toBe(409);
      expect(
        await prisma.collection.count({ where: { parentId: { not: null } } }),
      ).toBe(0);
    });
    it("allows five levels and rejects a sixth", async () => {
      for (let n = 0; n < 3; n++)
        ids.push(
          (
            await prisma.collection.create({
              data: { ownerId, name: `Level ${n}` },
            })
          ).id,
        );
      const nested = ids.map((id, index) => ({
        id,
        parentId: index ? ids[index - 1] : null,
      }));
      expect((await save(nested)).status).toBe(409);
      nested[5].parentId = null;
      expect((await save(nested)).status).toBe(200);
    });
    it("serializes competing whole-layout writes so they cannot combine into a cycle", async () => {
      const responses = await Promise.all([
        save([{ id: ids[0], parentId: ids[1] }, ...rows().slice(1)]),
        save([rows()[0], { id: ids[1], parentId: ids[0] }, rows()[2]]),
      ]);
      expect(responses.map((response) => response.status)).toEqual([200, 200]);
      const a = await prisma.collection.findUniqueOrThrow({
          where: { id: ids[0] },
        }),
        b = await prisma.collection.findUniqueOrThrow({
          where: { id: ids[1] },
        });
      expect(a.parentId === b.id && b.parentId === a.id).toBe(false);
    });
    it("sets and clears a private ready thumbnail cover without leaking internal fields", async () => {
      expect((await setCover()).status).toBe(200);
      const body = await (await groups(request("/api/collections"))).json();
      expect(body.collections[0].coverMediaId).toBe(mediaId);
      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain("private-thumbnail-marker");
      expect(serialized).not.toContain(ownerId);
      expect((await setCover(null)).status).toBe(200);
      expect((await setCover(null)).status).toBe(200);
      expect(await prisma.media.count()).toBe(1);
    });
    it.each(["FAILED", "UPLOADING"] as const)(
      "rejects a %s cover",
      async (status) => {
        await prisma.media.update({
          where: { id: mediaId },
          data: { processingStatus: status },
        });
        expect((await setCover()).status).toBe(404);
      },
    );
    it("rejects missing/deleted thumbnails and hides a cover immediately when media is deleted", async () => {
      expect((await setCover(randomUUID())).status).toBe(404);
      expect((await setCover(mediaId, randomUUID())).status).toBe(404);
      await prisma.media.update({
        where: { id: mediaId },
        data: { thumbnailStorageKey: null },
      });
      expect((await setCover()).status).toBe(404);
      await prisma.media.update({
        where: { id: mediaId },
        data: { thumbnailStorageKey: "private-thumbnail-marker" },
      });
      await setCover();
      await prisma.media.update({
        where: { id: mediaId },
        data: { deletedAt: new Date(), processingStatus: "DELETING" },
      });
      expect(
        (await (await groups(request("/api/collections"))).json())
          .collections[0].coverMediaId,
      ).toBeNull();
    });
    it("keeps subcollections and originals when a parent grouping is deleted", async () => {
      await save([rows()[0], { id: ids[1], parentId: ids[0] }, rows()[2]]);
      expect(
        (
          await remove(
            request(`/api/collections/${ids[0]}`, "DELETE"),
            context(ids[0]),
          )
        ).status,
      ).toBe(200);
      expect(
        (await prisma.collection.findUniqueOrThrow({ where: { id: ids[1] } }))
          .parentId,
      ).toBeNull();
      expect(await prisma.media.count()).toBe(1);
      expect(await prisma.collectionItem.count()).toBe(1);
    });
    it("summarizes owner media and grouping counts while excluding deleted media", async () => {
      await prisma.media.createMany({
        data: [
          {
            ownerId,
            title: "Video",
            originalFilename: "clip.mp4",
            type: "VIDEO",
            mimeType: "video/mp4",
            storageKey: randomUUID(),
            fileSize: 2048,
          },
          {
            ownerId,
            title: "Deleted",
            originalFilename: "hidden.mp4",
            type: "VIDEO",
            mimeType: "video/mp4",
            storageKey: randomUUID(),
            fileSize: 9999,
            deletedAt: new Date(),
          },
        ],
      });
      await prisma.favorite.create({ data: { userId: ownerId, mediaId } });
      await prisma.playlist.create({ data: { ownerId, name: "One" } });
      const response = await summary(request("/api/library/summary"));
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(await response.json()).toMatchObject({
        totalMedia: 2,
        photos: 1,
        videos: 1,
        originalBytes: 3072,
        favorites: 1,
        collections: 3,
        playlists: 1,
      });
    });
    it("returns only eight approved activity labels with no media, session or audit metadata", async () => {
      await prisma.auditEvent.createMany({
        data: [
          ...Array.from({ length: 10 }, (_, index) => ({
            userId: ownerId,
            action: "media_uploaded",
            resourceId: mediaId,
            details: { private: "secret-marker" },
            createdAt: new Date(Date.now() - index * 1000),
          })),
          {
            userId: ownerId,
            action: "internal-secret-action",
            resourceId: mediaId,
            details: { private: "secret-marker" },
          },
        ],
      });
      const body = await (
        await summary(request("/api/library/summary"))
      ).json();
      expect(body.activity).toHaveLength(8);
      expect(
        body.activity.every(
          (row: { label: string }) => row.label === "Media uploaded privately",
        ),
      ).toBe(true);
      for (const marker of [
        "private-storage-marker",
        "Private title marker",
        "private-filename-marker",
        "secret-marker",
        "internal-secret-action",
        mediaId,
        ownerId,
      ])
        expect(JSON.stringify(body)).not.toContain(marker);
    });
  },
);
