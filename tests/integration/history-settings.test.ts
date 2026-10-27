import { randomBytes, randomUUID, createHash } from "node:crypto";
import { beforeEach, afterAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
vi.mock("server-only", () => ({}));
vi.mock("@/lib/validation/env", () => ({
  getEnv: () => ({
    APP_URL: "https://privateflix.test",
    NODE_ENV: "test",
    SESSION_IDLE_TIMEOUT: 60,
    SESSION_ABSOLUTE_TIMEOUT: 3600,
    MAX_UPLOAD_SIZE: 10737418240,
  }),
}));
import { prisma } from "@/lib/db/prisma";
import {
  GET as getProgress,
  PUT as saveProgress,
  DELETE as removeProgress,
} from "@/app/api/playback/[mediaId]/route";
import {
  GET as listHistory,
  DELETE as clearHistory,
} from "@/app/api/playback/route";
import {
  GET as getPreferences,
  PUT as putPreferences,
} from "@/app/api/settings/route";
import { GET as systemStatus } from "@/app/api/system/status/route";
const enabled = process.env.PRIVATEFLIX_SECURITY_TEST === "1";
let userId = "",
  token = "",
  videoId = "",
  imageId = "",
  deletedId = "",
  pendingId = "";
const context = (mediaId: string) => ({ params: Promise.resolve({ mediaId }) });
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
const save = (
  body: unknown,
  id = videoId,
  headers: Record<string, string> = {},
) =>
  saveProgress(
    request(`/api/playback/${id}`, "PUT", body, headers),
    context(id),
  );
describe.skipIf(!enabled)(
  "private playback history and preferences on isolated PostgreSQL",
  () => {
    beforeEach(async () => {
      if (
        new URL(process.env.DATABASE_URL!).pathname !==
        "/privateflix_security_test"
      )
        throw new Error("Refusing non-test database");
      await prisma.auditEvent.deleteMany();
      await prisma.user.deleteMany();
      await prisma.appSetting.deleteMany();
      userId = (
        await prisma.user.create({
          data: {
            email: "history@example.test",
            username: "history-owner",
            passwordHash: "unused",
          },
        })
      ).id;
      token = randomBytes(32).toString("hex");
      await prisma.session.create({
        data: {
          userId,
          tokenHash: createHash("sha256").update(token).digest("hex"),
          expiresAt: new Date(Date.now() + 3600000),
        },
      });
      [videoId, imageId, deletedId, pendingId] = Array.from({ length: 4 }, () =>
        randomUUID(),
      );
      await prisma.media.createMany({
        data: [videoId, imageId, deletedId, pendingId].map((id, index) => ({
          id,
          ownerId: userId,
          title: `Fixture ${index}`,
          originalFilename: `fixture-${index}.mp4`,
          type: index === 1 ? "IMAGE" : "VIDEO",
          storageKey: `private/${id}`,
          mimeType: index === 1 ? "image/png" : "video/mp4",
          fileSize: BigInt(1024),
          duration: index === 1 ? null : 100,
          processingStatus: index === 3 ? "PROCESSING" : "READY",
          deletedAt: index === 2 ? new Date() : null,
        })),
      });
    });
    afterAll(async () => {
      await prisma.$disconnect();
    });
    it("authenticates every history, preference and status operation", async () => {
      const anonymous = { cookie: "" };
      const results = await Promise.all([
        getProgress(
          request(`/api/playback/${videoId}`, "GET", undefined, anonymous),
          context(videoId),
        ),
        save({ positionSeconds: 5 }, videoId, anonymous),
        removeProgress(
          request(`/api/playback/${videoId}`, "DELETE", undefined, anonymous),
          context(videoId),
        ),
        listHistory(request("/api/playback", "GET", undefined, anonymous)),
        clearHistory(
          request("/api/playback", "DELETE", { confirm: true }, anonymous),
        ),
        getPreferences(request("/api/settings", "GET", undefined, anonymous)),
        putPreferences(request("/api/settings", "PUT", {}, anonymous)),
        systemStatus(
          request("/api/system/status", "GET", undefined, anonymous),
        ),
      ]);
      for (const result of results) {
        expect(result.status).toBe(401);
        expect(result.headers.get("cache-control")).toBe("private, no-store");
      }
      expect(await prisma.playbackProgress.count()).toBe(0);
    });
    it("rejects cross-origin history and settings writes", async () => {
      const cross = { origin: "https://evil.test" };
      for (const response of [
        await save({ positionSeconds: 1 }, videoId, cross),
        await putPreferences(request("/api/settings", "PUT", {}, cross)),
        await clearHistory(
          request("/api/playback", "DELETE", { confirm: true }, cross),
        ),
        await removeProgress(
          request(`/api/playback/${videoId}`, "DELETE", undefined, cross),
          context(videoId),
        ),
      ])
        expect(response.status).toBe(403);
    });
    it("returns null until the owner actually records a viewing", async () => {
      const response = await getProgress(
        request(`/api/playback/${videoId}`),
        context(videoId),
      );
      expect(await response.json()).toEqual({
        progress: null,
        durationSeconds: 100,
      });
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    });
    it("saves positions against the trusted server duration and clamps overflow", async () => {
      expect(await (await save({ positionSeconds: 34 })).json()).toEqual({
        positionSeconds: 34,
        durationSeconds: 100,
        completed: false,
      });
      expect(await (await save({ positionSeconds: 500 })).json()).toEqual({
        positionSeconds: 100,
        durationSeconds: 100,
        completed: true,
      });
      expect(await prisma.playbackProgress.count()).toBe(1);
    });
    it("supports explicit watched and unwatched states", async () => {
      expect(
        (await (await save({ positionSeconds: 0, completed: true })).json())
          .positionSeconds,
      ).toBe(100);
      expect(
        (await (await save({ positionSeconds: 0, completed: false })).json())
          .completed,
      ).toBe(false);
      expect(
        (
          await (
            await listHistory(request("/api/playback?mode=continue"))
          ).json()
        ).items,
      ).toHaveLength(0);
    });
    it("marks playback completed at 95 percent and can resume earlier", async () => {
      expect(
        (await (await save({ positionSeconds: 95 })).json()).completed,
      ).toBe(true);
      expect(
        (await (await save({ positionSeconds: 94 })).json()).completed,
      ).toBe(false);
    });
    it.each([
      { positionSeconds: -1 },
      { positionSeconds: "3" },
      { positionSeconds: 3, durationSeconds: 999 },
      { positionSeconds: 1, secret: "unexpected" },
      {},
      { positionSeconds: 31_536_001 },
    ])("rejects invalid or forged progress %j", async (body) => {
      expect((await save(body)).status).toBe(400);
    });
    it("keeps images, deleted, unfinished and missing media out of history", async () => {
      for (const id of [imageId, deletedId, pendingId, randomUUID()]) {
        expect(
          (await getProgress(request(`/api/playback/${id}`), context(id)))
            .status,
        ).toBe(404);
        expect((await save({ positionSeconds: 1 }, id)).status).toBe(404);
        expect(
          (
            await removeProgress(
              request(`/api/playback/${id}`, "DELETE"),
              context(id),
            )
          ).status,
        ).toBe(404);
      }
      expect((await save({ positionSeconds: 1 }, "bad-id")).status).toBe(400);
    });
    it("excludes deleted videos, applies continue filtering and uses bounded pagination", async () => {
      await save({ positionSeconds: 20 });
      await prisma.playbackProgress.createMany({
        data: [
          {
            userId,
            mediaId: deletedId,
            positionSeconds: 10,
            durationSeconds: 100,
          },
          {
            userId,
            mediaId: pendingId,
            positionSeconds: 10,
            durationSeconds: 100,
          },
        ],
      });
      const history = await (
        await listHistory(request("/api/playback?limit=1"))
      ).json();
      expect(history.items).toHaveLength(1);
      expect(history.items[0].media.id).toBe(videoId);
      expect(history.hasMore).toBe(false);
      expect(JSON.stringify(history)).not.toMatch(
        /storageKey|tokenHash|userId|ownerId/,
      );
      expect(
        (await listHistory(request("/api/playback?limit=101"))).status,
      ).toBe(400);
      expect(
        (await listHistory(request("/api/playback?mode=all"))).status,
      ).toBe(400);
    });
    it("removes one history row idempotently without deleting media", async () => {
      await save({ positionSeconds: 20 });
      for (let i = 0; i < 2; i++)
        expect(
          (
            await removeProgress(
              request(`/api/playback/${videoId}`, "DELETE"),
              context(videoId),
            )
          ).status,
        ).toBe(200);
      expect(await prisma.playbackProgress.count()).toBe(0);
      expect(await prisma.media.count()).toBe(4);
    });
    it("requires clear confirmation and preserves media and preferences", async () => {
      await save({ positionSeconds: 20 });
      await putPreferences(
        request("/api/settings", "PUT", {
          theme: "light",
          playbackSpeed: 1.5,
          autoplay: true,
        }),
      );
      expect(
        (await clearHistory(request("/api/playback", "DELETE", {}))).status,
      ).toBe(400);
      expect(
        (
          await clearHistory(
            request("/api/playback", "DELETE", { confirm: true }),
          )
        ).status,
      ).toBe(200);
      expect(await prisma.playbackProgress.count()).toBe(0);
      expect(await prisma.media.count()).toBe(4);
      expect(await prisma.appSetting.count()).toBe(1);
    });
    it("loads safe defaults and persists only approved preference fields", async () => {
      expect(
        (await (await getPreferences(request("/api/settings"))).json())
          .preferences,
      ).toEqual({ theme: "dark", playbackSpeed: 1, autoplay: false });
      const next = { theme: "light", playbackSpeed: 1.25, autoplay: true };
      expect(
        (
          await (
            await putPreferences(request("/api/settings", "PUT", next))
          ).json()
        ).preferences,
      ).toEqual(next);
      expect(
        (await (await getPreferences(request("/api/settings"))).json())
          .preferences,
      ).toEqual(next);
      expect(
        (
          await putPreferences(
            request("/api/settings", "PUT", {
              ...next,
              STORAGE_PROVIDER: "evil",
            }),
          )
        ).status,
      ).toBe(400);
      expect(
        (
          await putPreferences(
            request("/api/settings", "PUT", { ...next, playbackSpeed: 8 }),
          )
        ).status,
      ).toBe(400);
      expect(await prisma.appSetting.count()).toBe(1);
    });
    it("ignores corrupted preferences and never exposes arbitrary application settings", async () => {
      await prisma.appSetting.createMany({
        data: [
          { key: `preferences:${userId}`, value: "corrupt" },
          { key: "sensitive", value: "must-not-leak" },
        ],
      });
      const result = await getPreferences(request("/api/settings"));
      expect(await result.text()).not.toContain("must-not-leak");
    });
    it("returns only safe owner system diagnostics", async () => {
      const result = await systemStatus(request("/api/system/status"));
      const data = await result.json();
      expect(data.libraryItems).toBe(3);
      expect(data.libraryBytes).toBe(3072);
      expect(data.backup).toBe("not-configured");
      expect(JSON.stringify(data)).not.toMatch(
        /password|token|DATABASE_URL|storageKey|originalFilename/,
      );
      expect(result.headers.get("cache-control")).toBe("private, no-store");
    });
    it("rejects revoked sessions without writing a position", async () => {
      await prisma.session.updateMany({ data: { revokedAt: new Date() } });
      expect((await save({ positionSeconds: 10 })).status).toBe(401);
      expect(await prisma.playbackProgress.count()).toBe(0);
    });
  },
);
