import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import {
  S3Client,
  CopyObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { randomUUID, randomBytes, createHash } from "node:crypto";
test("bulk organization and confirmed deletion preserve private originals until cleanup", async ({
  page,
  context,
}, testInfo) => {
  test.skip(
    process.env.PRIVATEFLIX_PROCESSING_TEST !== "1",
    "Isolated fixtures required",
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
  const ids: string[] = [],
    keys: string[] = [];
  let groupId = "";
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
    for (let n = 1; n <= 2; n++) {
      const key = `${original.storageKey}-bulk-${randomUUID()}`;
      keys.push(key);
      await s3.send(
        new CopyObjectCommand({
          Bucket: process.env.S3_BUCKET,
          Key: key,
          CopySource: `/${process.env.S3_BUCKET}/${original.storageKey.split("/").map(encodeURIComponent).join("/")}`,
        }),
      );
      ids.push(
        (
          await db.media.create({
            data: {
              ownerId: owner.id,
              title: `Bulk fixture ${n}`,
              originalFilename: `bulk-${n}.png`,
              type: "IMAGE",
              mimeType: original.mimeType,
              fileSize: original.fileSize,
              storageKey: key,
              width: 320,
              height: 240,
              processingStatus: "READY",
            },
          })
        ).id,
      );
    }
    groupId = (
      await db.collection.create({
        data: { ownerId: owner.id, name: "Bulk collection" },
      })
    ).id;
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
    const library = page.getByRole("region", { name: "Your media" });
    await page
      .getByRole("searchbox", { name: "Search your library" })
      .fill("Bulk fixture");
    await expect(library.getByRole("article")).toHaveCount(2, {
      timeout: 20000,
    });
    await library
      .getByRole("button", { name: "Select items", exact: true })
      .click();
    const selectPage = () =>
      library.getByRole("button", { name: "Select page", exact: true }).click();
    const apply = () =>
      library
        .getByRole("button", { name: "Apply to selection", exact: true })
        .click();
    await selectPage();
    await expect(
      library.getByText("2 selected on this page", { exact: true }),
    ).toBeVisible();
    await apply();
    await expect
      .poll(() =>
        db.favorite.count({
          where: { userId: owner.id, mediaId: { in: ids } },
        }),
      )
      .toBe(2);
    await expect(
      library.getByText("0 selected on this page", { exact: true }),
    ).toBeVisible();
    await selectPage();
    await library
      .getByRole("combobox", { name: "Bulk action", exact: true })
      .selectOption("addcollection");
    await apply();
    let dialog = page.getByRole("dialog", {
      name: "Add to collection",
      exact: true,
    });
    await dialog
      .getByRole("combobox", { name: "Target collection" })
      .selectOption(groupId);
    await dialog
      .getByRole("button", { name: "Apply changes", exact: true })
      .click();
    await expect(dialog).toHaveCount(0);
    expect(
      await db.collectionItem.count({ where: { collectionId: groupId } }),
    ).toBe(2);
    await selectPage();
    await library
      .getByRole("combobox", { name: "Bulk action", exact: true })
      .selectOption("addtags");
    await apply();
    dialog = page.getByRole("dialog", { name: "Add tags", exact: true });
    await dialog
      .getByRole("textbox", { name: "Tags for selected media" })
      .fill("TRAVEL, family");
    await dialog
      .getByRole("button", { name: "Apply changes", exact: true })
      .click();
    await expect(dialog).toHaveCount(0);
    expect(await db.mediaTag.count({ where: { mediaId: { in: ids } } })).toBe(
      4,
    );
    await library
      .getByRole("article", { name: "Bulk fixture 1", exact: true })
      .getByRole("button", { name: "View photo", exact: true })
      .click();
    const viewer = page.getByRole("dialog", {
      name: "Bulk fixture 1",
      exact: true,
    });
    await expect(viewer.getByText(/^Tags:/)).toContainText("travel");
    await viewer
      .getByRole("button", { name: "Remove favorite", exact: true })
      .click();
    await expect(
      viewer.getByRole("button", { name: "Favorite media", exact: true }),
    ).toBeVisible();
    await viewer
      .getByRole("button", { name: "Edit media details", exact: true })
      .click();
    await expect(
      page.getByRole("dialog", { name: "Media details", exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("dialog", { name: "Media details", exact: true }),
    ).toHaveCount(0);
    await expect(viewer).toBeVisible();
    await viewer
      .getByRole("button", { name: "Delete this media", exact: true })
      .click();
    dialog = page.getByRole("dialog", {
      name: "Delete selected media?",
      exact: true,
    });
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(viewer).toBeVisible();
    expect(
      (await db.media.findUniqueOrThrow({ where: { id: ids[0] } })).deletedAt,
    ).toBeNull();
    await viewer
      .getByRole("button", { name: "Close viewer", exact: true })
      .click();
    await expect(viewer).toHaveCount(0);
    await selectPage();
    await library
      .getByRole("combobox", { name: "Bulk action", exact: true })
      .selectOption("delete");
    await apply();
    dialog = page.getByRole("dialog", {
      name: "Delete selected media?",
      exact: true,
    });
    await expect(dialog.getByRole("listitem")).toHaveCount(2);
    await page.setViewportSize({ width: 375, height: 812 });
    expect(
      await dialog.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath("bulk-delete-mobile.png"),
    });
    await dialog
      .getByRole("button", { name: "Queue permanent deletion", exact: true })
      .click();
    await expect(dialog).toHaveCount(0);
    await expect(library.getByRole("article")).toHaveCount(0);
    expect(
      await db.media.count({
        where: {
          id: { in: ids },
          processingStatus: "DELETING",
          deletedAt: { not: null },
        },
      }),
    ).toBe(2);
    expect(
      await db.processingJob.count({
        where: { mediaId: { in: ids }, type: "CLEANUP", status: "QUEUED" },
      }),
    ).toBe(2);
    expect(
      (await page.request.get(`/api/media/${ids[0]}/stream`)).status(),
    ).toBe(404);
    expect(
      await db.media.count({
        where: { id: original.id, processingStatus: "READY", deletedAt: null },
      }),
    ).toBe(1);
    const retryKey = `${original.storageKey}-retry-${randomUUID()}`;
    keys.push(retryKey);
    await s3.send(
      new CopyObjectCommand({
        Bucket: process.env.S3_BUCKET,
        Key: retryKey,
        CopySource: `/${process.env.S3_BUCKET}/${original.storageKey.split("/").map(encodeURIComponent).join("/")}`,
      }),
    );
    const failed = await db.media.create({
      data: {
        ownerId: owner.id,
        title: "Retry fixture",
        originalFilename: "retry.png",
        type: "IMAGE",
        mimeType: original.mimeType,
        fileSize: original.fileSize,
        checksum: original.checksum,
        storageKey: retryKey,
        processingStatus: "FAILED",
      },
    });
    ids.push(failed.id);
    await db.processingJob.create({
      data: {
        mediaId: failed.id,
        type: "METADATA",
        status: "FAILED",
        attempts: 3,
      },
    });
    await db.upload.create({
      data: { ownerId: owner.id, mediaId: failed.id, status: "FAILED" },
    });
    await page
      .getByRole("searchbox", { name: "Search your library" })
      .fill("Retry fixture");
    const failedCard = library.getByRole("article", {
      name: "Retry fixture",
      exact: true,
    });
    await failedCard
      .getByRole("button", { name: "Retry processing", exact: true })
      .click();
    await expect
      .poll(
        async () =>
          (await db.media.findUniqueOrThrow({ where: { id: failed.id } }))
            .processingStatus,
        { timeout: 30000 },
      )
      .toBe("READY");
    await library.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(
      failedCard.getByRole("button", { name: "View photo", exact: true }),
    ).toBeVisible();
    const processed = await db.media.findUniqueOrThrow({
      where: { id: failed.id },
    });
    if (processed.thumbnailStorageKey) keys.push(processed.thumbnailStorageKey);
    expect(errors).toEqual([]);
  } finally {
    if (groupId) await db.collection.deleteMany({ where: { id: groupId } });
    await db.media.deleteMany({ where: { id: { in: ids } } });
    for (const key of keys)
      await s3.send(
        new DeleteObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key }),
      );
    s3.destroy();
    await db.$disconnect();
  }
});
