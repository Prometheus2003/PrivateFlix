import { beforeEach, afterAll, describe, it, expect, vi } from "vitest";
import { randomUUID, randomBytes, createHash } from "node:crypto";
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
import { GET as list, POST as create } from "@/app/api/playlists/route";
import {
  GET as details,
  PATCH as edit,
  DELETE as remove,
} from "@/app/api/playlists/[id]/route";
import { PUT as membership } from "@/app/api/playlists/[id]/items/route";
import { PUT as reorder } from "@/app/api/playlists/[id]/order/route";
let ownerId = "",
  token = "",
  firstId = "",
  secondId = "",
  imageId = "";
const context = (id: string) => ({ params: Promise.resolve({ id }) });
function request(
  path: string,
  method = "GET",
  body?: unknown,
  extra: Record<string, string> = {},
) {
  return new NextRequest(`https://privateflix.test${path}`, {
    method,
    headers: {
      cookie: `privateflix_session=${token}`,
      origin: "https://privateflix.test",
      "content-type": "application/json",
      ...extra,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function playlist() {
  const response = await create(
    request("/api/playlists", "POST", {
      name: "Private queue",
      description: "Evening",
    }),
  );
  expect(response.status).toBe(201);
  return (await response.json()).playlist.id as string;
}
const item = (
  id: string,
  mediaId: string,
  present = true,
  extra: Record<string, string> = {},
) =>
  membership(
    request(`/api/playlists/${id}/items`, "PUT", { mediaId, present }, extra),
    context(id),
  );
describe.skipIf(process.env.PRIVATEFLIX_SECURITY_TEST !== "1")(
  "private playlists on isolated PostgreSQL",
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
            username: "queue-owner",
            email: "queue@example.test",
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
      [firstId, secondId, imageId] = [randomUUID(), randomUUID(), randomUUID()];
      await prisma.media.createMany({
        data: [firstId, secondId, imageId].map((id, index) => ({
          id,
          ownerId,
          title: `Fixture ${index}`,
          originalFilename: "fixture.mp4",
          storageKey: `private/${id}`,
          type: index === 2 ? "IMAGE" : "VIDEO",
          mimeType: index === 2 ? "image/png" : "video/mp4",
          processingStatus: "READY",
          fileSize: BigInt(10),
          duration: index === 2 ? null : 12,
        })),
      });
    });
    afterAll(async () => {
      await prisma.$disconnect();
    });
    it("authenticates all playlist operations before reading or writing", async () => {
      const id = await playlist();
      const anonymous = { cookie: "" };
      const results = await Promise.all([
        list(request("/api/playlists", "GET", undefined, anonymous)),
        create(request("/api/playlists", "POST", { name: "No" }, anonymous)),
        details(
          request(`/api/playlists/${id}`, "GET", undefined, anonymous),
          context(id),
        ),
        edit(
          request(`/api/playlists/${id}`, "PATCH", { name: "No" }, anonymous),
          context(id),
        ),
        remove(
          request(`/api/playlists/${id}`, "DELETE", undefined, anonymous),
          context(id),
        ),
        item(id, firstId, true, anonymous),
        reorder(
          request(
            `/api/playlists/${id}/order`,
            "PUT",
            { mediaIds: [] },
            anonymous,
          ),
          context(id),
        ),
      ]);
      for (const response of results) {
        expect(response.status).toBe(401);
        expect(response.headers.get("cache-control")).toBe("private, no-store");
      }
    });
    it("rejects cross-origin writes", async () => {
      const id = await playlist();
      const cross = { origin: "https://evil.test" };
      for (const response of [
        await create(request("/api/playlists", "POST", { name: "No" }, cross)),
        await edit(
          request(`/api/playlists/${id}`, "PATCH", { name: "No" }, cross),
          context(id),
        ),
        await remove(
          request(`/api/playlists/${id}`, "DELETE", undefined, cross),
          context(id),
        ),
        await item(id, firstId, true, cross),
        await reorder(
          request(`/api/playlists/${id}/order`, "PUT", { mediaIds: [] }, cross),
          context(id),
        ),
      ])
        expect(response.status).toBe(403);
    });
    it("adds owned videos idempotently under concurrent writes and returns safe summaries", async () => {
      const id = await playlist();
      const results = await Promise.all([
        item(id, firstId),
        item(id, firstId),
        item(id, secondId),
      ]);
      for (const response of results) expect(response.status).toBe(200);
      const response = await details(
        request(`/api/playlists/${id}?limit=100`),
        context(id),
      );
      const body = await response.json();
      expect(body.items).toHaveLength(2);
      expect(
        new Set(body.items.map((value: { position: number }) => value.position))
          .size,
      ).toBe(2);
      expect(JSON.stringify(body)).not.toMatch(/storageKey|ownerId|checksum/);
      expect(
        (await (await list(request("/api/playlists"))).json()).playlists[0]
          .count,
      ).toBe(2);
    });
    it("rejects nonvideo, deleted, unfinished and missing resources", async () => {
      const id = await playlist();
      expect((await item(id, imageId)).status).toBe(404);
      await prisma.media.update({
        where: { id: firstId },
        data: { deletedAt: new Date() },
      });
      expect((await item(id, firstId)).status).toBe(404);
      await prisma.media.update({
        where: { id: secondId },
        data: { processingStatus: "PROCESSING" },
      });
      expect((await item(id, secondId)).status).toBe(404);
      expect((await item(id, randomUUID())).status).toBe(404);
      expect(
        (
          await details(
            request("/api/playlists/missing"),
            context(randomUUID()),
          )
        ).status,
      ).toBe(404);
      expect(
        (await details(request("/api/playlists/bad"), context("bad"))).status,
      ).toBe(400);
    });
    it("persists complete queue order and rejects duplicate or stale lists", async () => {
      const id = await playlist();
      await item(id, firstId);
      await item(id, secondId);
      const order = (mediaIds: string[]) =>
        reorder(
          request(`/api/playlists/${id}/order`, "PUT", { mediaIds }),
          context(id),
        );
      expect((await order([secondId, firstId])).status).toBe(200);
      expect(
        (
          await (
            await details(request(`/api/playlists/${id}`), context(id))
          ).json()
        ).items.map((value: { media: { id: string } }) => value.media.id),
      ).toEqual([secondId, firstId]);
      expect((await order([firstId, firstId])).status).toBe(400);
      expect((await order([firstId])).status).toBe(409);
      expect((await order([firstId, randomUUID()])).status).toBe(409);
    });
    it("edits details and deletes grouping without deleting originals", async () => {
      const id = await playlist();
      await item(id, firstId);
      expect(
        (
          await edit(
            request(`/api/playlists/${id}`, "PATCH", {
              name: "Updated",
              description: "Private",
            }),
            context(id),
          )
        ).status,
      ).toBe(200);
      expect(
        (await prisma.playlist.findUniqueOrThrow({ where: { id } })).name,
      ).toBe("Updated");
      expect(
        (await remove(request(`/api/playlists/${id}`, "DELETE"), context(id)))
          .status,
      ).toBe(200);
      expect(await prisma.playlistItem.count()).toBe(0);
      expect(await prisma.media.count()).toBe(3);
    });
    it("removes membership idempotently and hides deleted video rows", async () => {
      const id = await playlist();
      await item(id, firstId);
      for (let i = 0; i < 2; i++)
        expect((await item(id, firstId, false)).status).toBe(200);
      await item(id, secondId);
      await prisma.media.update({
        where: { id: secondId },
        data: { deletedAt: new Date() },
      });
      expect(
        (
          await (
            await details(request(`/api/playlists/${id}`), context(id))
          ).json()
        ).items,
      ).toHaveLength(0);
    });
    it("enforces creation limits atomically and bounds list queries", async () => {
      await prisma.playlist.createMany({
        data: Array.from({ length: 99 }, (_, index) => ({
          ownerId,
          name: `Queue ${index}`,
        })),
      });
      const results = await Promise.all([
        create(request("/api/playlists", "POST", { name: "Last" })),
        create(request("/api/playlists", "POST", { name: "Overflow" })),
      ]);
      expect(results.map((response) => response.status).sort()).toEqual([
        201, 409,
      ]);
      expect(await prisma.playlist.count()).toBe(100);
      expect((await list(request("/api/playlists?limit=101"))).status).toBe(
        400,
      );
    });
  },
);
