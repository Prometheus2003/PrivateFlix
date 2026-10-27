import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import {
  S3Client,
  CopyObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { randomUUID, randomBytes, createHash } from "node:crypto";
test("private playlists save order, navigate videos and delete only grouping", async ({
  page,
  context,
}, testInfo) => {
  test.skip(
    process.env.PRIVATEFLIX_PROCESSING_TEST !== "1",
    "Requires isolated live media fixtures",
  );
  test.setTimeout(90000);
  if (
    new URL(process.env.DATABASE_URL!).pathname !== "/privateflix_security_test"
  )
    throw new Error("Test database required");
  const db = new PrismaClient();
  const s3 = new S3Client({
    endpoint: process.env.S3_ENDPOINT,
    region: "us-east-1",
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY!,
      secretAccessKey: process.env.S3_SECRET_KEY!,
    },
  });
  let copyId = "",
    copyKey = "",
    playlistId = "",
    ownerId = "";
  try {
    const owner = await db.user.findFirstOrThrow();
    ownerId = owner.id;
    const originalCount = await db.media.count({
      where: { ownerId, deletedAt: null },
    });
    const original = await db.media.findFirstOrThrow({
      where: {
        ownerId,
        type: "VIDEO",
        processingStatus: "READY",
        deletedAt: null,
      },
    });
    copyKey = `${original.storageKey}-queue-${randomUUID()}`;
    await s3.send(
      new CopyObjectCommand({
        Bucket: process.env.S3_BUCKET,
        Key: copyKey,
        CopySource: `/${process.env.S3_BUCKET}/${original.storageKey.split("/").map(encodeURIComponent).join("/")}`,
      }),
    );
    const copy = await db.media.create({
      data: {
        ownerId,
        title: "Second queue video",
        originalFilename: "queue-copy.mp4",
        type: "VIDEO",
        mimeType: original.mimeType,
        storageKey: copyKey,
        fileSize: original.fileSize,
        checksum: original.checksum,
        duration: original.duration,
        width: original.width,
        height: original.height,
        processingStatus: "READY",
        thumbnailStorageKey: original.thumbnailStorageKey,
      },
    });
    copyId = copy.id;
    await db.playbackProgress.deleteMany({ where: { userId: ownerId } });
    const token = randomBytes(32).toString("hex");
    await db.session.create({
      data: {
        userId: ownerId,
        tokenHash: createHash("sha256").update(token).digest("hex"),
        expiresAt: new Date(Date.now() + 3600000),
      },
    });
    await context.addCookies([
      {
        name: "privateflix_session",
        value: token,
        url: "http://127.0.0.1:3319",
        httpOnly: true,
        sameSite: "Strict",
      },
    ]);
    await page.route("**/api/**", async (route) => {
      if (["GET", "HEAD"].includes(route.request().method()))
        return route.continue();
      const headers = {
        ...(await route.request().allHeaders()),
        origin: "https://localhost:3319",
        "sec-fetch-site": "same-origin",
      };
      await route.fulfill({ response: await route.fetch({ headers }) });
    });
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "My library." }),
    ).toBeVisible({ timeout: 20000 });
    const panel = page.getByRole("region", {
      name: "Your playlists",
      exact: true,
    });
    await panel
      .getByRole("button", { name: "New playlist", exact: true })
      .click();
    const create = page.getByRole("dialog", {
      name: "New playlist",
      exact: true,
    });
    await create
      .getByLabel("Playlist name", { exact: true })
      .fill("Evening queue");
    await create
      .getByLabel("Playlist description", { exact: true })
      .fill("Private test queue");
    await create
      .getByRole("button", { name: "Save playlist", exact: true })
      .click();
    await expect(create).toHaveCount(0);
    playlistId = (
      await db.playlist.findFirstOrThrow({
        where: { ownerId, name: "Evening queue" },
      })
    ).id;
    for (const title of [original.title, copy.title]) {
      await page
        .getByRole("button", { name: `Add to playlist: ${title}`, exact: true })
        .click();
      const add = page.getByRole("dialog", {
        name: "Add to playlist",
        exact: true,
      });
      await add
        .getByLabel("Choose playlist", { exact: true })
        .selectOption(playlistId);
      await add
        .getByRole("button", { name: "Add video to playlist", exact: true })
        .click();
      await expect(add).toHaveCount(0);
    }
    await panel
      .getByLabel("Playlist", { exact: true })
      .selectOption(playlistId);
    await expect(panel.getByRole("listitem")).toHaveCount(2);
    await panel
      .getByRole("button", {
        name: `Move down: ${original.title}`,
        exact: true,
      })
      .click();
    await expect(panel.getByRole("listitem").first()).toContainText(copy.title);
    const stored = await db.playlistItem.findMany({
      where: { playlistId },
      orderBy: { position: "asc" },
    });
    expect(stored.map((item) => item.mediaId)).toEqual([copy.id, original.id]);
    await panel
      .getByRole("button", { name: "Edit playlist", exact: true })
      .click();
    const edit = page.getByRole("dialog", {
      name: "Edit playlist",
      exact: true,
    });
    await edit.getByLabel("Playlist name", { exact: true }).fill("Night queue");
    await edit
      .getByRole("button", { name: "Save playlist", exact: true })
      .click();
    await expect(edit).toHaveCount(0);
    await expect(
      panel.getByRole("heading", { name: "Night queue", exact: true }),
    ).toBeVisible();
    await page.setViewportSize({ width: 375, height: 812 });
    await panel.scrollIntoViewIfNeeded();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await panel.screenshot({
      path: testInfo.outputPath("playlists-mobile.png"),
    });
    await page.setViewportSize({ width: 1280, height: 900 });
    await panel
      .getByRole("button", { name: "Play playlist", exact: true })
      .click();
    let viewer = page.getByRole("dialog", { name: copy.title, exact: true });
    await expect(viewer).toBeVisible();
    await expect(viewer.getByText("Loading your saved position…")).toHaveCount(
      0,
      { timeout: 20000 },
    );
    const player = viewer.locator("video");
    await expect
      .poll(() =>
        player.evaluate((element) => (element as HTMLVideoElement).readyState),
      )
      .toBeGreaterThanOrEqual(2);
    await player.evaluate(async (element) => {
      const video = element as HTMLVideoElement;
      await video.play();
      video.pause();
      video.currentTime = 2;
    });
    await viewer
      .getByRole("button", { name: "Next video", exact: true })
      .click();
    viewer = page.getByRole("dialog", { name: original.title, exact: true });
    await expect(viewer).toBeVisible();
    await viewer
      .getByRole("button", { name: "Previous video", exact: true })
      .click();
    viewer = page.getByRole("dialog", { name: copy.title, exact: true });
    await expect(
      viewer.getByRole("button", { name: "Resume playback", exact: true }),
    ).toBeVisible();
    await viewer
      .getByRole("button", { name: "Close viewer", exact: true })
      .click();
    await panel
      .getByRole("button", { name: "Delete playlist", exact: true })
      .click();
    const remove = page.getByRole("dialog", {
      name: "Delete this playlist?",
      exact: true,
    });
    await remove
      .getByRole("button", { name: "Confirm playlist deletion", exact: true })
      .click();
    await expect(remove).toHaveCount(0);
    expect(
      await db.playlist.findUnique({ where: { id: playlistId } }),
    ).toBeNull();
    expect(await db.media.count({ where: { ownerId, deletedAt: null } })).toBe(
      originalCount + 1,
    );
  } finally {
    if (playlistId) await db.playlist.deleteMany({ where: { id: playlistId } });
    if (copyId) await db.media.deleteMany({ where: { id: copyId } });
    if (ownerId)
      await db.playbackProgress.deleteMany({ where: { userId: ownerId } });
    if (copyKey)
      await s3.send(
        new DeleteObjectCommand({
          Bucket: process.env.S3_BUCKET,
          Key: copyKey,
        }),
      );
    s3.destroy();
    await db.$disconnect();
  }
});
