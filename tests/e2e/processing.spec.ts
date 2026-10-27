import { expect, test } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { createHash, randomBytes } from "node:crypto";
import { hash, verify } from "argon2";
test.beforeEach(async ({ page }) => {
  // The runner's HTTP listener represents its canonical HTTPS reverse proxy.
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
});
test("private thumbnails, playback, seeking and downloads work on desktop and mobile", async ({
  page,
  context,
}, testInfo) => {
  test.skip(
    process.env.PRIVATEFLIX_PROCESSING_TEST !== "1",
    "Requires live processing fixtures",
  );
  if (
    new URL(process.env.DATABASE_URL!).pathname !== "/privateflix_security_test"
  )
    throw new Error("Test database required");
  const db = new PrismaClient();
  try {
    const user = await db.user.findFirstOrThrow();
    const token = randomBytes(32).toString("hex");
    await db.session.create({
      data: {
        userId: user.id,
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
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "My library." }),
    ).toBeVisible({ timeout: 20000 });
    const storagePanel = page.getByRole("region", { name: "Your storage" });
    await expect(
      storagePanel.getByText("New uploads: S3 / MinIO", { exact: true }),
    ).toBeVisible({ timeout: 20000 });
    await storagePanel.locator("summary").click();
    await expect(storagePanel.getByText(/npm run drive:connect/)).toBeVisible();
    await storagePanel.locator("summary").click();
    const images = page.locator('img[src*="/thumbnail"]');
    await expect(images).toHaveCount(2);
    await expect
      .poll(() =>
        images.evaluateAll((elements) =>
          elements.every(
            (element) =>
              element instanceof HTMLImageElement &&
              element.complete &&
              element.naturalWidth > 0,
          ),
        ),
      )
      .toBe(true);
    await page.screenshot({
      path: testInfo.outputPath("processing-desktop.png"),
      fullPage: true,
    });
    await page.getByRole("button", { name: "Play video" }).click();
    const player = page.locator("video");
    await expect(player).toHaveAttribute("src", /\/api\/media\/.+\/stream$/);
    await expect(page.getByText("Loading your saved position…")).toHaveCount(
      0,
      { timeout: 20000 },
    );
    await expect
      .poll(() =>
        player.evaluate((element) => (element as HTMLVideoElement).readyState),
      )
      .toBeGreaterThanOrEqual(2);
    await player.evaluate((element) => (element as HTMLVideoElement).play());
    await expect
      .poll(() =>
        player.evaluate((element) => (element as HTMLVideoElement).currentTime),
      )
      .toBeGreaterThan(0.1);
    await player.evaluate((element) => {
      const video = element as HTMLVideoElement;
      video.pause();
      video.currentTime = 0.5;
    });
    await expect
      .poll(() =>
        player.evaluate((element) => (element as HTMLVideoElement).currentTime),
      )
      .toBeGreaterThanOrEqual(0.5);
    await page.screenshot({
      path: testInfo.outputPath("video-player.png"),
      fullPage: true,
    });
    const downloadEvent = page.waitForEvent("download");
    await page.getByRole("link", { name: "Download original" }).click();
    const download = await downloadEvent;
    expect(download.suggestedFilename()).toBe("fixture.mp4");
    expect(await download.failure()).toBeNull();
    await page.getByRole("button", { name: "Close viewer" }).click();
    await page.getByRole("button", { name: "View photo" }).click();
    await expect
      .poll(() =>
        page
          .locator(".media-viewer img")
          .evaluate((element) => (element as HTMLImageElement).naturalWidth),
      )
      .toBe(320);
    await page.keyboard.press("Escape");
    await expect(page.locator(".media-viewer")).toHaveCount(0);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("link", { name: "Storage", exact: true }).click();
    await expect(storagePanel).toBeInViewport();
    await storagePanel.locator("summary").click();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath("processing-mobile.png"),
      fullPage: true,
    });
    await page.getByRole("button", { name: "Play video" }).click();
    await expect(page.locator(".media-viewer")).toBeVisible();
    expect(
      await page
        .locator(".media-viewer")
        .evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath("video-mobile.png"),
      fullPage: true,
    });
    await page.keyboard.press("Escape");
    await expect(page.locator("video")).toHaveCount(0);
    expect(errors).toEqual([]);
    const src = await images.first().getAttribute("src");
    await context.clearCookies();
    expect((await page.request.get("/api/system/storage")).status()).toBe(401);
    expect((await page.request.get(src!)).status()).toBe(401);
    const video = await db.media.findFirstOrThrow({
      where: { type: "VIDEO", processingStatus: "READY" },
    });
    expect(
      (
        await page.request.get(`/api/media/${video.id}/stream`, {
          headers: { Range: "bytes=0-1" },
        })
      ).status(),
    ).toBe(401);
    expect(
      (await page.request.get(`/api/media/${video.id}/download`)).status(),
    ).toBe(401);
  } finally {
    await db.$disconnect();
  }
});

test("history resumes playback and owner settings persist with working security controls", async ({
  page,
  context,
}, testInfo) => {
  test.skip(
    process.env.PRIVATEFLIX_PROCESSING_TEST !== "1",
    "Requires disposable live decoder fixtures",
  );
  test.setTimeout(90000);
  if (
    new URL(process.env.DATABASE_URL!).pathname !== "/privateflix_security_test"
  )
    throw new Error("Test database required");
  const db = new PrismaClient();
  const password = "Synthetic_Owner_123!";
  const replacement = "Synthetic_Replacement_456!";
  try {
    const owner = await db.user.findFirstOrThrow();
    const libraryCount = await db.media.count({
      where: { ownerId: owner.id, deletedAt: null },
    });
    const media = await db.media.findFirstOrThrow({
      where: {
        ownerId: owner.id,
        type: "VIDEO",
        processingStatus: "READY",
        deletedAt: null,
      },
    });
    await db.playbackProgress.deleteMany({ where: { userId: owner.id } });
    await db.appSetting.deleteMany({
      where: { key: `preferences:${owner.id}` },
    });
    await db.user.update({
      where: { id: owner.id },
      data: { passwordHash: await hash(password) },
    });
    const token = randomBytes(32).toString("hex");
    await db.session.create({
      data: {
        userId: owner.id,
        tokenHash: createHash("sha256").update(token).digest("hex"),
        expiresAt: new Date(Date.now() + 3600000),
        userAgent: "Synthetic current browser",
      },
    });
    const other = await db.session.create({
      data: {
        userId: owner.id,
        tokenHash: createHash("sha256").update(randomBytes(32)).digest("hex"),
        expiresAt: new Date(Date.now() + 3600000),
        userAgent: "Synthetic other browser",
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
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "My library." }),
    ).toBeVisible({ timeout: 20000 });
    await page
      .getByRole("button", {
        name: `Edit details: ${media.title}`,
        exact: true,
      })
      .click();
    const details = page.getByRole("dialog", {
      name: "Media details",
      exact: true,
    });
    await expect(details.getByLabel("Title", { exact: true })).toBeVisible({
      timeout: 20000,
    });
    await details
      .getByLabel("Title", { exact: true })
      .fill("Edited fixture video");
    await details
      .getByLabel("Media description", { exact: true })
      .fill("Quiet evening trail");
    await details
      .getByLabel("Tags", { exact: true })
      .fill("Travel, travel, Weekend");
    await page.route(`**/api/media/${media.id}`, (route) =>
      route.fulfill({ status: 503, json: { error: "The test save failed" } }),
    );
    await details
      .getByRole("button", { name: "Save media details", exact: true })
      .click();
    await expect(details.getByRole("alert")).toHaveText("The test save failed");
    expect(
      (await db.media.findUniqueOrThrow({ where: { id: media.id } })).title,
    ).toBe(media.title);
    await page.unroute(`**/api/media/${media.id}`);
    await details
      .getByRole("button", { name: "Save media details", exact: true })
      .click();
    await expect(details).toHaveCount(0);
    await page
      .getByLabel("Search your library", { exact: true })
      .fill("quiet evening");
    await expect(page.getByRole("article")).toHaveCount(1);
    await expect(
      page.getByRole("heading", { name: "Edited fixture video", exact: true }),
    ).toBeVisible();
    await page
      .getByLabel("Search your library", { exact: true })
      .fill("weekend");
    await expect(
      page.getByRole("heading", { name: "Edited fixture video", exact: true }),
    ).toBeVisible();
    await page.getByLabel("Search your library", { exact: true }).fill("");
    await expect(page.getByRole("article")).toHaveCount(libraryCount);
    await page.getByRole("button", { name: "Play video", exact: true }).click();
    const player = page.locator("video");
    await expect(page.getByText("Loading your saved position…")).toHaveCount(
      0,
      { timeout: 20000 },
    );
    await expect
      .poll(() =>
        player.evaluate((element) => (element as HTMLVideoElement).readyState),
      )
      .toBeGreaterThanOrEqual(2);
    await player.evaluate(async (element) => {
      const video = element as HTMLVideoElement;
      await video.play();
      video.pause();
      video.currentTime = 3.25;
    });
    await expect
      .poll(
        async () =>
          (
            await db.playbackProgress.findUnique({
              where: {
                userId_mediaId: { userId: owner.id, mediaId: media.id },
              },
            })
          )?.positionSeconds,
      )
      .toBeGreaterThanOrEqual(3);
    await page.route(`**/api/playback/${media.id}`, (route) =>
      route.fulfill({ status: 503, json: { error: "Temporary test failure" } }),
    );
    await page
      .getByRole("button", { name: "Close viewer", exact: true })
      .click();
    await expect(
      page.getByText(
        "Your playback position could not be saved. Check your connection and try again.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(page.locator(".media-viewer")).toHaveCount(1);
    await page.unroute(`**/api/playback/${media.id}`);
    await page
      .getByRole("button", { name: "Retry saving position", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Retry saving position", exact: true }),
    ).toHaveCount(0);
    await page
      .getByRole("button", { name: "Close viewer", exact: true })
      .click();
    await expect(page.locator(".media-viewer")).toHaveCount(0);
    await expect
      .poll(
        async () =>
          (
            await db.playbackProgress.findUnique({
              where: {
                userId_mediaId: { userId: owner.id, mediaId: media.id },
              },
            })
          )?.positionSeconds,
      )
      .toBeGreaterThanOrEqual(3);
    const history = page.getByRole("region", {
      name: "Your viewing",
      exact: true,
    });
    await expect(
      history.getByRole("button", { name: "Resume", exact: true }),
    ).toBeVisible();
    await history.getByRole("button", { name: "Resume", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Resume playback", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Resume playback", exact: true })
      .click();
    await expect
      .poll(() =>
        player.evaluate((element) => (element as HTMLVideoElement).currentTime),
      )
      .toBeGreaterThanOrEqual(3);
    await player.evaluate((element) => (element as HTMLVideoElement).pause());
    await page.screenshot({ path: testInfo.outputPath("history-resume.png") });
    await page
      .getByRole("button", { name: "Close viewer", exact: true })
      .click();
    await expect(page.locator(".media-viewer")).toHaveCount(0);
    await history
      .getByRole("button", { name: "Mark watched", exact: true })
      .click();
    await expect(
      history.getByText(
        "Videos you start will appear here so you can return to them.",
      ),
    ).toBeVisible();
    await history
      .getByRole("button", { name: "Recently watched", exact: true })
      .click();
    await expect(
      history.getByRole("button", { name: "Mark unwatched", exact: true }),
    ).toBeVisible();
    await history
      .getByRole("button", { name: "Recently watched", exact: true })
      .click();
    await expect(
      history.getByRole("button", { name: "Watch again", exact: true }),
    ).toBeVisible();
    const settings = page.getByRole("region", {
      name: "Settings",
      exact: true,
    });
    await expect(
      settings.getByRole("button", { name: "Save preferences", exact: true }),
    ).toBeVisible();
    await settings.getByLabel("Theme", { exact: true }).selectOption("light");
    await settings
      .getByLabel("Default playback speed", { exact: true })
      .selectOption("1.5");
    await settings
      .getByRole("button", { name: "Save preferences", exact: true })
      .click();
    await expect(
      settings.getByText("Preferences saved.", { exact: true }),
    ).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light", {
      timeout: 20000,
    });
    await expect(
      settings.getByLabel("Default playback speed", { exact: true }),
    ).toHaveValue("1.5");
    await page.setViewportSize({ width: 375, height: 812 });
    await settings.scrollIntoViewIfNeeded();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await settings.screenshot({
      path: testInfo.outputPath("settings-light-mobile.png"),
    });
    await page.setViewportSize({ width: 844, height: 390 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await settings.screenshot({
      path: testInfo.outputPath("settings-landscape.png"),
    });
    await page.setViewportSize({ width: 1280, height: 900 });
    await settings.getByLabel("Theme", { exact: true }).selectOption("dark");
    await settings
      .getByRole("button", { name: "Save preferences", exact: true })
      .click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    const otherSession = settings
      .locator("li")
      .filter({ hasText: "Synthetic other browser" });
    await otherSession
      .getByRole("button", { name: "Revoke session", exact: true })
      .click();
    const revoke = page.getByRole("dialog", {
      name: "Revoke this session?",
      exact: true,
    });
    await revoke.getByLabel("Current password", { exact: true }).fill(password);
    await revoke
      .getByRole("button", { name: "Confirm revocation", exact: true })
      .click();
    await expect(revoke).toHaveCount(0);
    expect(
      (await db.session.findUniqueOrThrow({ where: { id: other.id } }))
        .revokedAt,
    ).not.toBeNull();
    await settings
      .getByLabel("Current password for password change", { exact: true })
      .fill(password);
    await settings
      .getByLabel("New password", { exact: true })
      .fill(replacement);
    await settings
      .getByLabel("Confirm new password", { exact: true })
      .fill("Mismatch_123456!");
    await settings
      .getByRole("button", { name: "Change password", exact: true })
      .click();
    await expect(settings.getByRole("alert")).toHaveText(
      "The new passwords do not match.",
    );
    await settings
      .getByLabel("Confirm new password", { exact: true })
      .fill(replacement);
    await settings
      .getByRole("button", { name: "Change password", exact: true })
      .click();
    await expect(
      settings.getByText(
        "Password changed. Other sessions have been signed out.",
        { exact: true },
      ),
    ).toBeVisible();
    expect(
      await verify(
        (await db.user.findUniqueOrThrow({ where: { id: owner.id } }))
          .passwordHash,
        replacement,
      ),
    ).toBe(true);
    expect(
      await db.session.count({ where: { userId: owner.id, revokedAt: null } }),
    ).toBe(1);
    await history
      .getByRole("button", { name: "Clear history", exact: true })
      .click();
    const clear = page.getByRole("dialog", {
      name: "Clear all viewing history?",
      exact: true,
    });
    await clear
      .getByRole("button", { name: "Remove history", exact: true })
      .click();
    await expect(clear).toHaveCount(0);
    expect(
      await db.playbackProgress.count({ where: { userId: owner.id } }),
    ).toBe(0);
    expect(
      await db.media.count({ where: { ownerId: owner.id, deletedAt: null } }),
    ).toBe(libraryCount);
    expect(errors).toEqual([]);
  } finally {
    await db.$disconnect();
  }
});
