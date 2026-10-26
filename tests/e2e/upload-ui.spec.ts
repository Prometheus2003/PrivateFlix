import { expect, test } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { createHash } from "node:crypto";

test("owner sets up, pauses and resumes a browser upload, then signs out", async ({
  page,
}) => {
  test.skip(
    process.env.PRIVATEFLIX_SECURITY_TEST !== "1" ||
      process.env.PRIVATEFLIX_STORAGE_TEST !== "1",
    "Requires disposable services",
  );
  if (
    new URL(process.env.DATABASE_URL!).pathname !== "/privateflix_security_test"
  )
    throw new Error("Not a test database");
  const db = new PrismaClient();
  try {
    await db.auditEvent.deleteMany();
    await db.user.deleteMany();
    await db.appSetting.deleteMany();
    await db.authThrottle.deleteMany();
    // The local runner is HTTP; model the canonical HTTPS origin seen behind Caddy.
    await page.route("**/api/**", async (route) => {
      const headers = { ...(await route.request().allHeaders()) };
      if (route.request().method() !== "GET") {
        headers.origin = "https://localhost:3319";
        headers["sec-fetch-site"] = "same-origin";
      }
      await route.fulfill({ response: await route.fetch({ headers }) });
    });
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "Create your private library" }),
    ).toBeVisible();
    await page
      .getByLabel("Email", { exact: true })
      .fill("browser-owner@example.test");
    await page.getByLabel("Username", { exact: true }).fill("browser-owner");
    await page.getByLabel("Setup token").fill(process.env.SETUP_TOKEN!);
    await page
      .getByLabel("Password", { exact: true })
      .fill("Browser-test!2026-safe");
    await page
      .getByLabel("Confirm password", { exact: true })
      .fill("Browser-test!2026-safe");
    await page.getByRole("button", { name: "Create library" }).click();
    await expect(
      page.getByRole("heading", { name: "My library." }),
    ).toBeVisible();
    const bytes = Buffer.alloc(11 * 1024 * 1024);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
    const file = {
      name: "A quiet afternoon.png",
      mimeType: "image/png",
      buffer: bytes,
    };
    let release!: () => void, reached!: () => void;
    const secondPart = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/parts/2", async (route) => {
      reached();
      await gate;
      await route.abort().catch(() => {});
    });
    await page.getByLabel("Choose a video or photo").setInputFiles(file);
    await page
      .getByRole("button", { name: "Upload file", exact: true })
      .click();
    await secondPart;
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    release();
    await expect(
      page.getByRole("status", { name: "Upload status" }),
    ).toContainText("Upload paused");
    await page.unroute("**/parts/2");
    const pending = await db.upload.findFirstOrThrow({
      where: { status: "UPLOADING" },
    });
    expect(pending.bytesUploaded).toBe(BigInt(8 * 1024 * 1024));
    await page.reload();
    await page.getByRole("button", { name: "Resume", exact: true }).click();
    await page.getByLabel("Choose a video or photo").setInputFiles(file);
    await page
      .getByRole("button", { name: "Resume upload", exact: true })
      .click();
    await expect(
      page.getByRole("status", { name: "Upload status" }),
    ).toContainText("Upload saved privately", { timeout: 30000 });
    await expect(page.getByRole("heading", { name: file.name })).toBeVisible();
    const abandoned = await page.request.post("/api/media/upload/start", {
      headers: { Origin: "https://localhost:3319" },
      data: {
        filename: "cancel-me.png",
        mime: "image/png",
        totalBytes: 8,
        checksum: createHash("sha256")
          .update(bytes.subarray(0, 8))
          .digest("hex"),
      },
    });
    expect(abandoned.status()).toBe(201);
    const abandonedId = (await abandoned.json()).uploadId;
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByRole("button", { name: "Keep upload" }).click();
    expect(
      (await db.upload.findUniqueOrThrow({ where: { id: abandonedId } }))
        .status,
    ).toBe("UPLOADING");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await page
      .getByRole("button", { name: "Cancel upload", exact: true })
      .click();
    await expect(
      page.getByRole("status", { name: "Upload status" }),
    ).toContainText("Upload cancelled");
    await expect(
      page.getByRole("heading", { name: "cancel-me.png", exact: true }),
    ).toHaveCount(0);
    expect(
      (await db.upload.findUniqueOrThrow({ where: { id: abandonedId } }))
        .status,
    ).toBe("CANCELLED");
    expect(
      (await db.upload.findUniqueOrThrow({ where: { id: pending.id } })).status,
    ).toBe("UPLOADED");
    await page.screenshot({
      path: "test-results/library-desktop.png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(
      page.getByRole("heading", { name: "My library." }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: "test-results/library-mobile.png",
      fullPage: true,
    });
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(
      page.getByRole("heading", { name: "Sign in to your library" }),
    ).toBeVisible();
    await expect(page.getByRole("heading", { name: file.name })).toHaveCount(0);
    await page.getByLabel("Email or username").fill("browser-owner");
    await page
      .getByLabel("Password", { exact: true })
      .fill("Browser-test!2026-safe");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByRole("heading", { name: file.name })).toBeVisible();
  } finally {
    await db.$disconnect();
  }
});
