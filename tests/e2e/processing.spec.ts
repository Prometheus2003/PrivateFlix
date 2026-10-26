import { expect, test } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { createHash, randomBytes } from "node:crypto";
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
    ).toBeVisible();
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
