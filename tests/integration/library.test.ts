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
import { GET as listMedia } from "@/app/api/media/route";
import { PUT as favorite } from "@/app/api/media/[id]/favorite/route";
import {
  GET as listCollections,
  POST as createCollection,
} from "@/app/api/collections/route";
import {
  PATCH as editCollection,
  DELETE as deleteCollection,
} from "@/app/api/collections/[id]/route";
import { PUT as membership } from "@/app/api/collections/[id]/items/route";
import {
  GET as details,
  PATCH as editDetails,
} from "@/app/api/media/[id]/route";

const enabled = process.env.PRIVATEFLIX_SECURITY_TEST === "1";
let ownerId = "",
  token = "";
let firstId = "",
  secondId = "",
  thirdId = "",
  deletedId = "";
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
const list = (query = "", headers: Record<string, string> = {}) =>
  listMedia(
    request(`/api/media${query ? `?${query}` : ""}`, "GET", undefined, headers),
  );
const setFavorite = (
  id: string,
  value: boolean,
  headers: Record<string, string> = {},
) =>
  favorite(
    request(`/api/media/${id}/favorite`, "PUT", { favorite: value }, headers),
    context(id),
  );
const setMembership = (
  collectionId: string,
  mediaId: string,
  present: boolean,
  headers: Record<string, string> = {},
) =>
  membership(
    request(
      `/api/collections/${collectionId}/items`,
      "PUT",
      { mediaId, present },
      headers,
    ),
    context(collectionId),
  );
async function collection(name = "Travel") {
  const response = await createCollection(
    request("/api/collections", "POST", {
      name,
      description: "Private memories",
    }),
  );
  expect(response.status).toBe(201);
  return (await response.json()).collection as {
    id: string;
    name: string;
    description: string;
    count: number;
  };
}

describe.skipIf(!enabled)(
  "private library organization with isolated PostgreSQL",
  () => {
    beforeEach(async () => {
      if (
        new URL(process.env.DATABASE_URL!).pathname !==
        "/privateflix_security_test"
      )
        throw new Error("Refusing to modify a non-test database");
      await prisma.auditEvent.deleteMany();
      await prisma.user.deleteMany();
      ownerId = (
        await prisma.user.create({
          data: {
            email: "library@example.test",
            username: "library-owner",
            passwordHash: "unused",
          },
          select: { id: true },
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
      const fixtures = [
        {
          id: randomUUID(),
          title: "Alpha sunset",
          type: "VIDEO" as const,
          originalFilename: "alpha.mp4",
          mimeType: "video/mp4",
          createdAt: new Date("2026-10-01T00:00:00Z"),
        },
        {
          id: randomUUID(),
          title: "Budget 100%_done\\safe",
          type: "IMAGE" as const,
          originalFilename: "receipt.png",
          mimeType: "image/png",
          createdAt: new Date("2026-10-02T00:00:00Z"),
        },
        {
          id: randomUUID(),
          title: "Archive travel",
          type: "VIDEO" as const,
          originalFilename: "Beach.MP4",
          mimeType: "video/mp4",
          createdAt: new Date("2026-10-03T00:00:00Z"),
        },
        {
          id: randomUUID(),
          title: "Hidden sunset",
          type: "IMAGE" as const,
          originalFilename: "deleted.png",
          mimeType: "image/png",
          createdAt: new Date("2026-10-04T00:00:00Z"),
          deletedAt: new Date(),
        },
      ];
      [firstId, secondId, thirdId, deletedId] = fixtures.map(
        (value) => value.id,
      );
      await prisma.media.createMany({
        data: fixtures.map((value) => ({
          ...value,
          ownerId,
          storageKey: `private/${value.id}/original`,
          thumbnailStorageKey: `private/${value.id}/thumbnail`,
          processingStatus: "READY",
          fileSize: BigInt(1024),
        })),
      });
    });
    afterAll(async () => {
      await prisma.$disconnect();
    });
    it("protects metadata reads and writes and rejects cross-origin edits", async () => {
      expect(
        (
          await details(
            request(`/api/media/${firstId}`, "GET", undefined, { cookie: "" }),
            context(firstId),
          )
        ).status,
      ).toBe(401);
      expect(
        (
          await editDetails(
            request(
              `/api/media/${firstId}`,
              "PATCH",
              { title: "Changed", description: "", tags: [] },
              { cookie: "" },
            ),
            context(firstId),
          )
        ).status,
      ).toBe(401);
      expect(
        (
          await editDetails(
            request(
              `/api/media/${firstId}`,
              "PATCH",
              { title: "Changed", description: "", tags: [] },
              { origin: "https://evil.test" },
            ),
            context(firstId),
          )
        ).status,
      ).toBe(403);
    });
    it("edits safe metadata and normalized tags without exposing storage or extracted metadata", async () => {
      const response = await editDetails(
        request(`/api/media/${firstId}`, "PATCH", {
          title: "Edited title",
          description: "Evening in the mountains",
          tags: [" Travel ", "travel", "Holidays"],
        }),
        context(firstId),
      );
      expect(response.status).toBe(200);
      const fetched = await details(
        request(`/api/media/${firstId}`),
        context(firstId),
      );
      const body = await fetched.json();
      expect(body.media.title).toBe("Edited title");
      expect(body.media.tags.sort()).toEqual(["holidays", "travel"]);
      expect(JSON.stringify(body)).not.toMatch(
        /storageKey|checksum|metadata|ownerId/,
      );
      expect(fetched.headers.get("cache-control")).toBe("private, no-store");
      expect(
        (await (await list("q=mountains")).json()).media.map(
          (item: { id: string }) => item.id,
        ),
      ).toEqual([firstId]);
      expect(
        (await (await list("q=HOLIDAYS")).json()).media.map(
          (item: { id: string }) => item.id,
        ),
      ).toEqual([firstId]);
    });
    it("validates metadata fields and rejects missing or deleted resources", async () => {
      for (const data of [
        { title: "", description: "", tags: [] },
        { title: "Valid", description: "", tags: Array(21).fill("tag") },
        { title: "Valid", description: "", tags: [], ownerId: "forged" },
      ])
        expect(
          (
            await editDetails(
              request(`/api/media/${firstId}`, "PATCH", data),
              context(firstId),
            )
          ).status,
        ).toBe(400);
      for (const id of [deletedId, randomUUID()]) {
        expect(
          (await details(request(`/api/media/${id}`), context(id))).status,
        ).toBe(404);
        expect(
          (
            await editDetails(
              request(`/api/media/${id}`, "PATCH", {
                title: "No",
                description: "",
                tags: [],
              }),
              context(id),
            )
          ).status,
        ).toBe(404);
      }
    });
    it("removes unused tags without changing other media tags or original keys", async () => {
      const before = await prisma.media.findUniqueOrThrow({
        where: { id: firstId },
        select: { storageKey: true },
      });
      for (const id of [firstId, thirdId])
        await editDetails(
          request(`/api/media/${id}`, "PATCH", {
            title: "Shared",
            description: "",
            tags: ["shared"],
          }),
          context(id),
        );
      await editDetails(
        request(`/api/media/${firstId}`, "PATCH", {
          title: "Shared",
          description: "",
          tags: [],
        }),
        context(firstId),
      );
      expect(
        await prisma.tag.count({ where: { ownerId, name: "shared" } }),
      ).toBe(1);
      expect(await prisma.mediaTag.count({ where: { mediaId: thirdId } })).toBe(
        1,
      );
      expect(
        (await prisma.media.findUniqueOrThrow({ where: { id: firstId } }))
          .storageKey,
      ).toBe(before.storageKey);
    });
    it("sorts videos by descending duration while leaving unknown duration last", async () => {
      await prisma.media.update({
        where: { id: firstId },
        data: { duration: 15 },
      });
      await prisma.media.update({
        where: { id: thirdId },
        data: { duration: 100 },
      });
      const body = await (await list("sort=duration")).json();
      expect(body.media.map((item: { id: string }) => item.id)).toEqual([
        thirdId,
        firstId,
        secondId,
      ]);
    });

    it("protects all organization endpoints before reading or mutating owner data", async () => {
      const group = await collection();
      const anonymous = { cookie: "" };
      const responses = await Promise.all([
        list("", anonymous),
        listCollections(
          request("/api/collections", "GET", undefined, anonymous),
        ),
        createCollection(
          request(
            "/api/collections",
            "POST",
            { name: "Should not exist" },
            anonymous,
          ),
        ),
        setFavorite(firstId, true, anonymous),
        editCollection(
          request(
            `/api/collections/${group.id}`,
            "PATCH",
            { name: "Changed" },
            anonymous,
          ),
          context(group.id),
        ),
        deleteCollection(
          request(
            `/api/collections/${group.id}`,
            "DELETE",
            undefined,
            anonymous,
          ),
          context(group.id),
        ),
        setMembership(group.id, firstId, true, anonymous),
      ]);
      expect(responses.every((value) => value.status === 401)).toBe(true);
      expect(
        responses.every(
          (value) => value.headers.get("cache-control") === "private, no-store",
        ),
      ).toBe(true);
      expect(await prisma.favorite.count()).toBe(0);
      expect(await prisma.collectionItem.count()).toBe(0);
      expect(
        (await prisma.collection.findUniqueOrThrow({ where: { id: group.id } }))
          .name,
      ).toBe("Travel");
      expect(await prisma.collection.count()).toBe(1);
    });
    it("rejects cross-origin and absent-origin mutations without side effects", async () => {
      const group = await collection();
      for (const origin of ["", "https://attacker.test"]) {
        const headers = { origin };
        expect((await setFavorite(firstId, true, headers)).status).toBe(403);
        expect(
          (await setMembership(group.id, firstId, true, headers)).status,
        ).toBe(403);
        expect(
          (
            await createCollection(
              request("/api/collections", "POST", { name: "No" }, headers),
            )
          ).status,
        ).toBe(403);
        expect(
          (
            await editCollection(
              request(
                `/api/collections/${group.id}`,
                "PATCH",
                { name: "No" },
                headers,
              ),
              context(group.id),
            )
          ).status,
        ).toBe(403);
        expect(
          (
            await deleteCollection(
              request(
                `/api/collections/${group.id}`,
                "DELETE",
                undefined,
                headers,
              ),
              context(group.id),
            )
          ).status,
        ).toBe(403);
      }
      expect(await prisma.favorite.count()).toBe(0);
      expect(await prisma.collectionItem.count()).toBe(0);
      expect(await prisma.collection.count()).toBe(1);
    });
    it("paginates stable owner-only results and omits all internal storage references", async () => {
      const response = await list("limit=2");
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      const body = await response.json();
      expect(body).toMatchObject({ page: 1, total: 3, hasMore: true });
      expect(body.media.map((value: { id: string }) => value.id)).toEqual([
        thirdId,
        secondId,
      ]);
      expect(
        body.media.every(
          (value: { isFavorite: boolean }) => value.isFavorite === false,
        ),
      ).toBe(true);
      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain("private/");
      expect(serialized).not.toContain("storageKey");
      expect(serialized).not.toContain("thumbnailStorageKey");
      const second = await (await list("limit=2&page=2")).json();
      expect(second).toMatchObject({ page: 2, total: 3, hasMore: false });
      expect(second.media.map((value: { id: string }) => value.id)).toEqual([
        firstId,
      ]);
      expect((await (await list("limit=2&page=100")).json()).media).toEqual([]);
    });
    it("supports case-insensitive title/filename search and literal SQL wildcard characters", async () => {
      expect(
        (await (await list("q=aLpHa")).json()).media.map(
          (value: { id: string }) => value.id,
        ),
      ).toEqual([firstId]);
      expect(
        (await (await list("q=beach")).json()).media.map(
          (value: { id: string }) => value.id,
        ),
      ).toEqual([thirdId]);
      for (const query of ["%", "_", "\\", "100%_done\\safe"]) {
        const body = await (
          await list(new URLSearchParams({ q: query }).toString())
        ).json();
        expect(body.total).toBe(1);
        expect(body.media.map((value: { id: string }) => value.id)).toEqual([
          secondId,
        ]);
      }
      expect((await (await list("q=does-not-exist")).json()).total).toBe(0);
    });
    it("combines media type, favorites, collection and search without widening the result set", async () => {
      const group = await collection();
      await setFavorite(firstId, true);
      await setFavorite(secondId, true);
      await setMembership(group.id, firstId, true);
      await setMembership(group.id, thirdId, true);
      const query = new URLSearchParams({
        type: "VIDEO",
        favorite: "true",
        collection: group.id,
        q: "sunset",
        limit: "1",
      });
      const body = await (await list(query.toString())).json();
      expect(body).toMatchObject({ total: 1, hasMore: false });
      expect(body.media.map((value: { id: string }) => value.id)).toEqual([
        firstId,
      ]);
      expect(body.media[0].isFavorite).toBe(true);
      expect(
        (await (await list("type=IMAGE")).json()).media.map(
          (value: { id: string }) => value.id,
        ),
      ).toEqual([secondId]);
      expect((await (await list("favorite=false")).json()).total).toBe(3);
    });
    it("sorts by newest, oldest and title with deterministic pagination", async () => {
      expect(
        (await (await list("sort=oldest")).json()).media.map(
          (value: { id: string }) => value.id,
        ),
      ).toEqual([firstId, secondId, thirdId]);
      expect(
        (await (await list("sort=title")).json()).media.map(
          (value: { id: string }) => value.id,
        ),
      ).toEqual([firstId, thirdId, secondId]);
      const order = [];
      for (const page of [1, 2, 3])
        order.push(
          (await (await list(`sort=newest&limit=1&page=${page}`)).json())
            .media[0].id,
        );
      expect(order).toEqual([thirdId, secondId, firstId]);
    });
    it.each([
      "page=0",
      "page=100001",
      "limit=101",
      "limit=0",
      "type=AUDIO",
      "sort=random",
      "favorite=1",
      "collection=not-a-uuid",
      `q=${"x".repeat(121)}`,
    ])("rejects invalid library query %s", async (query) => {
      expect((await list(query)).status).toBe(400);
    });
    it("sets and clears favorites idempotently without leaking deleted or unowned identifiers", async () => {
      for (let i = 0; i < 2; i++) {
        const response = await setFavorite(firstId, true);
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
          mediaId: firstId,
          isFavorite: true,
        });
      }
      expect(await prisma.favorite.count()).toBe(1);
      expect((await setFavorite(deletedId, true)).status).toBe(404);
      expect((await setFavorite(randomUUID(), true)).status).toBe(404);
      expect((await setFavorite("invalid", true)).status).toBe(400);
      for (let i = 0; i < 2; i++)
        expect((await setFavorite(firstId, false)).status).toBe(200);
      expect(await prisma.favorite.count()).toBe(0);
    });
    it("keeps duplicate concurrent favorites and membership requests idempotent", async () => {
      const group = await collection();
      const responses = await Promise.all([
        ...Array.from({ length: 4 }, () => setFavorite(firstId, true)),
        ...Array.from({ length: 4 }, () =>
          setMembership(group.id, firstId, true),
        ),
      ]);
      expect(responses.every((response) => response.status === 200)).toBe(true);
      expect(await prisma.favorite.count()).toBe(1);
      expect(await prisma.collectionItem.count()).toBe(1);
    });
    it("enforces the collection cap even when two creates race for the last slot", async () => {
      await prisma.collection.createMany({
        data: Array.from({ length: 99 }, (_, index) => ({
          ownerId,
          name: `Group ${index}`,
        })),
      });
      const responses = await Promise.all([
        createCollection(
          request("/api/collections", "POST", { name: "Last slot A" }),
        ),
        createCollection(
          request("/api/collections", "POST", { name: "Last slot B" }),
        ),
      ]);
      expect(responses.map((response) => response.status).sort()).toEqual([
        201, 409,
      ]);
      expect(await prisma.collection.count()).toBe(100);
    });
    it("stops organization requests when the authenticated session is revoked", async () => {
      const group = await collection();
      await prisma.session.updateMany({
        where: { userId: ownerId },
        data: { revokedAt: new Date() },
      });
      const responses = await Promise.all([
        list(),
        listCollections(request("/api/collections")),
        setFavorite(firstId, true),
        setMembership(group.id, firstId, true),
        createCollection(
          request("/api/collections", "POST", { name: "Revoked" }),
        ),
      ]);
      expect(responses.every((response) => response.status === 401)).toBe(true);
      expect(await prisma.favorite.count()).toBe(0);
      expect(await prisma.collectionItem.count()).toBe(0);
      expect(await prisma.collection.count()).toBe(1);
    });
    it("excludes soft-deleted media even when stale favorites and memberships exist", async () => {
      const group = await collection();
      await prisma.favorite.create({
        data: { userId: ownerId, mediaId: deletedId },
      });
      await prisma.collectionItem.create({
        data: { collectionId: group.id, mediaId: deletedId },
      });
      expect((await (await list("favorite=true")).json()).total).toBe(0);
      expect((await (await list(`collection=${group.id}`)).json()).total).toBe(
        0,
      );
      const groups = await (
        await listCollections(request("/api/collections"))
      ).json();
      expect(groups.collections[0].count).toBe(0);
    });
    it("creates, renames and paginates private collections with safe count-only metadata", async () => {
      const first = await collection("First");
      await collection("Second");
      const edit = await editCollection(
        request(`/api/collections/${first.id}`, "PATCH", {
          name: "Edited",
          description: "Updated",
        }),
        context(first.id),
      );
      expect(edit.status).toBe(200);
      expect((await edit.json()).collection).toMatchObject({
        id: first.id,
        name: "Edited",
        description: "Updated",
      });
      const response = await listCollections(
        request("/api/collections?limit=1"),
      );
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      const body = await response.json();
      expect(body).toMatchObject({ page: 1, hasMore: true });
      expect(body.collections).toHaveLength(1);
      const second = await (
        await listCollections(request("/api/collections?limit=1&page=2"))
      ).json();
      expect(second.hasMore).toBe(false);
      expect(second.collections).toHaveLength(1);
      expect(body.collections[0].id).not.toBe(second.collections[0].id);
      expect(JSON.stringify(body)).not.toContain("ownerId");
      expect(JSON.stringify(body)).not.toContain("storageKey");
    });
    it("adds and removes collection membership idempotently and counts only current media", async () => {
      const group = await collection();
      for (let i = 0; i < 2; i++) {
        const response = await setMembership(group.id, firstId, true);
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
          collectionId: group.id,
          mediaId: firstId,
          present: true,
        });
      }
      expect(await prisma.collectionItem.count()).toBe(1);
      expect(
        (await (await listCollections(request("/api/collections"))).json())
          .collections[0].count,
      ).toBe(1);
      for (let i = 0; i < 2; i++)
        expect((await setMembership(group.id, firstId, false)).status).toBe(
          200,
        );
      expect(await prisma.collectionItem.count()).toBe(0);
      expect((await setMembership(group.id, deletedId, true)).status).toBe(404);
      expect((await setMembership(group.id, randomUUID(), true)).status).toBe(
        404,
      );
      expect((await setMembership(randomUUID(), firstId, true)).status).toBe(
        404,
      );
      expect((await list(`collection=${randomUUID()}`)).status).toBe(404);
    });
    it("deletes grouping metadata while preserving every original, favorite and unrelated membership", async () => {
      const group = await collection("Delete grouping");
      const other = await collection("Keep grouping");
      await setMembership(group.id, firstId, true);
      await setMembership(other.id, firstId, true);
      await setFavorite(firstId, true);
      const original = await prisma.media.findUniqueOrThrow({
        where: { id: firstId },
      });
      const response = await deleteCollection(
        request(`/api/collections/${group.id}`, "DELETE"),
        context(group.id),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ deleted: true });
      expect(
        await prisma.collection.findUnique({ where: { id: group.id } }),
      ).toBeNull();
      expect(
        await prisma.collectionItem.count({
          where: { collectionId: group.id },
        }),
      ).toBe(0);
      expect(
        await prisma.collectionItem.count({
          where: { collectionId: other.id, mediaId: firstId },
        }),
      ).toBe(1);
      expect(await prisma.favorite.count({ where: { mediaId: firstId } })).toBe(
        1,
      );
      expect(
        await prisma.media.findUniqueOrThrow({ where: { id: firstId } }),
      ).toEqual(original);
      expect(
        (
          await deleteCollection(
            request(`/api/collections/${group.id}`, "DELETE"),
            context(group.id),
          )
        ).status,
      ).toBe(404);
    });
    it("rejects unknown/deleted identifiers and invalid mutation shapes before writing", async () => {
      const group = await collection();
      const unknown = randomUUID();
      expect(
        (
          await editCollection(
            request(`/api/collections/${unknown}`, "PATCH", { name: "No" }),
            context(unknown),
          )
        ).status,
      ).toBe(404);
      expect(
        (
          await deleteCollection(
            request(`/api/collections/${unknown}`, "DELETE"),
            context(unknown),
          )
        ).status,
      ).toBe(404);
      for (const body of [
        { favorite: "true" },
        { favorite: true, ownerId },
        {},
      ])
        expect(
          (
            await favorite(
              request(`/api/media/${firstId}/favorite`, "PUT", body),
              context(firstId),
            )
          ).status,
        ).toBe(400);
      for (const body of [
        { name: "" },
        { name: "x".repeat(81) },
        { name: "Valid", description: "x".repeat(501) },
        { name: "Valid", ownerId },
      ])
        expect(
          (await createCollection(request("/api/collections", "POST", body)))
            .status,
        ).toBe(400);
      expect((await setMembership(group.id, "not-an-id", true)).status).toBe(
        400,
      );
      expect(
        (
          await membership(
            request(`/api/collections/${group.id}/items`, "PUT", {
              mediaId: firstId,
              present: "true",
            }),
            context(group.id),
          )
        ).status,
      ).toBe(400);
      expect(await prisma.favorite.count()).toBe(0);
      expect(await prisma.collectionItem.count()).toBe(0);
      expect(await prisma.collection.count()).toBe(1);
    });
  },
);
