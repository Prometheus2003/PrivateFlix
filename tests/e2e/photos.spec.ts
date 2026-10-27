import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import {
  S3Client,
  CopyObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { randomUUID, randomBytes, createHash } from "node:crypto";
test("photo zoom, keyboard navigation and fullscreen keep originals private", async ({
  page,
  context,
}, testInfo) => {
  test.skip(
    process.env.PRIVATEFLIX_PROCESSING_TEST !== "1",
    "Requires isolated photo fixtures",
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
    copyKey = "";
  try {
    const owner = await db.user.findFirstOrThrow();
    const original = await db.media.findFirstOrThrow({
      where: {
        ownerId: owner.id,
        type: "IMAGE",
        processingStatus: "READY",
        deletedAt: null,
      },
    });
    copyKey = `${original.storageKey}-photo-${randomUUID()}`;
    await s3.send(
      new CopyObjectCommand({
        Bucket: process.env.S3_BUCKET,
        Key: copyKey,
        CopySource: `/${process.env.S3_BUCKET}/${original.storageKey.split("/").map(encodeURIComponent).join("/")}`,
      }),
    );
    const copy = await db.media.create({
      data: {
        ownerId: owner.id,
        title: "Photo zoom fixture",
        originalFilename: "photo-copy.png",
        type: "IMAGE",
        mimeType: original.mimeType,
        storageKey: copyKey,
        fileSize: original.fileSize,
        checksum: original.checksum,
        width: original.width,
        height: original.height,
        processingStatus: "READY",
        thumbnailStorageKey: original.thumbnailStorageKey,
      },
    });
    copyId = copy.id;
    const token = randomBytes(32).toString("hex");
    await db.session.create({
      data: {
        userId: owner.id,
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
    await page
      .getByRole("article", { name: copy.title, exact: true })
      .getByRole("button", { name: "View photo", exact: true })
      .click();
    let viewer = page.getByRole("dialog", { name: copy.title, exact: true });
    const image = viewer.getByRole("img", { name: copy.title, exact: true });
    await expect
      .poll(
        () =>
          image.evaluate(
            (element) => (element as HTMLImageElement).naturalWidth,
          ),
        { timeout: 20000 },
      )
      .toBe(320);
    const before = (await image.boundingBox())!.width;
    await viewer.getByRole("button", { name: "Zoom in", exact: true }).click();
    await expect(
      viewer.getByRole("status", { name: "Photo zoom", exact: true }),
    ).toHaveText("125%");
    expect((await image.boundingBox())!.width).toBeGreaterThan(before);
    await page.keyboard.press("0");
    await expect(
      viewer.getByRole("status", { name: "Photo zoom", exact: true }),
    ).toHaveText("100%");
    await page.keyboard.press("ArrowRight");
    viewer = page.getByRole("dialog", { name: original.title, exact: true });
    await expect(viewer).toBeVisible();
    await expect(viewer.locator("img")).toHaveAttribute(
      "src",
      new RegExp(`/api/media/${original.id}/stream$`),
    );
    const source = await viewer.locator("img").getAttribute("src");
    expect(new URL(source!, page.url()).origin).toBe(
      new URL(page.url()).origin,
    );
    await expect(
      viewer.getByRole("region", { name: /Photo preview/ }),
    ).toBeFocused();
    await page.keyboard.press("ArrowLeft");
    viewer = page.getByRole("dialog", { name: copy.title, exact: true });
    await expect(viewer).toBeVisible();
    await viewer
      .getByRole("button", { name: "Enter fullscreen", exact: true })
      .click();
    if (await page.evaluate(() => document.fullscreenEnabled)) {
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              document.fullscreenElement?.classList.contains(
                "photo-viewer-content",
              ) ?? false,
          ),
        )
        .toBe(true);
      await viewer
        .getByRole("button", { name: "Exit fullscreen", exact: true })
        .click();
      await expect
        .poll(() => page.evaluate(() => document.fullscreenElement === null))
        .toBe(true);
    }
    await page.setViewportSize({ width: 375, height: 812 });
    expect(
      await viewer.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("photo-mobile.png") });
    await page.setViewportSize({ width: 844, height: 390 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    expect(
      await viewer.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("photo-landscape.png") });
    await page.keyboard.press("Escape");
    await expect(page.locator(".media-viewer")).toHaveCount(0);
    await context.clearCookies();
    expect(
      (await page.request.get(`/api/media/${copy.id}/stream`)).status(),
    ).toBe(401);
    expect(errors).toEqual([]);
  } finally {
    if (copyId) await db.media.deleteMany({ where: { id: copyId } });
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
