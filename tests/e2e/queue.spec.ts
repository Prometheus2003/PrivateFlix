import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import {
  S3Client,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { createHash, randomBytes, randomUUID } from "node:crypto";
test("batch uploads pause, resume saved parts, flag duplicates and accept drops", async ({
  page,
  context,
}, testInfo) => {
  test.skip(
    process.env.PRIVATEFLIX_PROCESSING_TEST !== "1",
    "Isolated services required",
  );
  test.setTimeout(120000);
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
  const suffix = randomUUID().slice(0, 8),
    names = [
      `Queue first ${suffix}.png`,
      `Queue second ${suffix}.png`,
      `Queue duplicate ${suffix}.png`,
      `Queue dropped ${suffix}.png`,
    ];
  try {
    const owner = await db.user.findFirstOrThrow(),
      original = await db.media.findFirstOrThrow({
        where: {
          ownerId: owner.id,
          type: "IMAGE",
          processingStatus: "READY",
          deletedAt: null,
        },
      });
    const object = await s3.send(
      new GetObjectCommand({
        Bucket: process.env.S3_BUCKET,
        Key: original.storageKey,
      }),
    );
    const bytes = Buffer.from(await object.Body!.transformToByteArray());
    const first = Buffer.alloc(11 * 1024 * 1024);
    bytes.copy(first);
    Buffer.from(suffix).copy(first, bytes.length);
    const second = Buffer.concat([bytes, Buffer.from(`second-${suffix}`)]),
      dropped = Buffer.concat([bytes, Buffer.from(`dropped-${suffix}`)]);
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
    await page
      .getByRole("button", { name: "Batch upload", exact: true })
      .click();
    const workspace = page.getByLabel("Batch upload workspace");
    await expect(
      workspace.getByLabel("Choose multiple videos or photos"),
    ).toBeEnabled({ timeout: 20000 });
    await workspace
      .getByLabel("Choose multiple videos or photos")
      .setInputFiles([
        { name: names[0], mimeType: "image/png", buffer: first },
        { name: names[1], mimeType: "image/png", buffer: second },
        { name: names[2], mimeType: "image/png", buffer: first },
        {
          name: "unsupported.txt",
          mimeType: "text/plain",
          buffer: Buffer.from("unsupported"),
        },
      ]);
    await expect(
      workspace.getByText("This file format is not supported.", {
        exact: true,
      }),
    ).toBeVisible();
    let release!: () => void, reached!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve)),
      secondPart = new Promise<void>((resolve) => (reached = resolve));
    await page.route("**/parts/2", async (route) => {
      reached();
      await gate;
      await route.abort().catch(() => {});
    });
    await workspace
      .getByRole("button", { name: "Start upload queue", exact: true })
      .click();
    await secondPart;
    await workspace
      .getByRole("button", { name: "Pause queue", exact: true })
      .click();
    release();
    await expect(
      workspace.getByRole("status", { name: "Queue status" }),
    ).toContainText("queue paused");
    await page.unroute("**/parts/2");
    const saved = await db.upload.findFirstOrThrow({
      where: { ownerId: owner.id, media: { originalFilename: names[0] } },
    });
    expect(saved.bytesUploaded).toBe(BigInt(8 * 1024 * 1024));
    expect(
      await db.media.count({
        where: { ownerId: owner.id, originalFilename: names[1] },
      }),
    ).toBe(0);
    await workspace
      .getByRole("button", { name: "Start upload queue", exact: true })
      .click();
    const duplicate = workspace
      .getByRole("listitem")
      .filter({ has: page.getByText(names[2], { exact: true }) });
    await expect(
      duplicate.getByRole("button", { name: "Upload duplicate", exact: true }),
    ).toBeVisible({ timeout: 45000 });
    expect(
      await db.media.count({
        where: { ownerId: owner.id, originalFilename: names[2] },
      }),
    ).toBe(0);
    expect(
      await db.upload.count({
        where: { ownerId: owner.id, media: { originalFilename: names[0] } },
      }),
    ).toBe(1);
    await duplicate
      .getByRole("button", { name: "Upload duplicate", exact: true })
      .click();
    await expect(duplicate.getByText(/uploaded/)).toBeVisible({
      timeout: 30000,
    });
    const transfer = await page.evaluateHandle(
      ({ data, name }) => {
        const transfer = new DataTransfer();
        transfer.items.add(
          new File([new Uint8Array(data)], name, { type: "image/png" }),
        );
        return transfer;
      },
      { data: [...dropped], name: names[3] },
    );
    await workspace
      .locator(".upload-dropzone")
      .dispatchEvent("drop", { dataTransfer: transfer });
    await workspace
      .getByRole("button", { name: "Start upload queue", exact: true })
      .click();
    await expect
      .poll(
        () =>
          db.media.count({
            where: {
              ownerId: owner.id,
              originalFilename: { in: names },
              processingStatus: "READY",
            },
          }),
        { timeout: 45000 },
      )
      .toBe(4);
    const record = await db.upload.findUniqueOrThrow({
      where: { id: saved.id },
    });
    expect(record.bytesUploaded).toBe(BigInt(first.length));
    await page.locator(".upload-history summary").click();
    await expect(
      page
        .getByRole("list", { name: "Upload history records" })
        .getByText(names[0], { exact: true }),
    ).toBeVisible({ timeout: 20000 });
    await page.setViewportSize({ width: 375, height: 812 });
    expect(
      await workspace.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
    await workspace.evaluate((element) =>
      element.scrollIntoView({ block: "start" }),
    );
    await page.screenshot({
      path: testInfo.outputPath("upload-queue-mobile.png"),
    });
    await context.clearCookies();
    expect((await page.request.get("/api/media/upload-history")).status()).toBe(
      401,
    );
    expect(errors).toEqual([]);
  } finally {
    const rows = await db.media.findMany({
      where: { originalFilename: { in: names } },
      select: {
        id: true,
        storageKey: true,
        thumbnailStorageKey: true,
        previewStorageKey: true,
      },
    });
    await db.upload.deleteMany({
      where: { mediaId: { in: rows.map((row) => row.id) } },
    });
    await db.media.deleteMany({
      where: { id: { in: rows.map((row) => row.id) } },
    });
    for (const row of rows)
      for (const key of [
        row.storageKey,
        row.thumbnailStorageKey,
        row.previewStorageKey,
      ])
        if (key)
          await s3.send(
            new DeleteObjectCommand({
              Bucket: process.env.S3_BUCKET,
              Key: key,
            }),
          );
    s3.destroy();
    await db.$disconnect();
  }
});
