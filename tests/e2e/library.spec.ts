import { expect, test } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { createHash, randomBytes, randomUUID } from "node:crypto";

test("owner searches, favorites and organizes media into private collections on desktop and mobile", async ({
  page,
  context,
}, testInfo) => {
  test.skip(
    process.env.PRIVATEFLIX_SECURITY_TEST !== "1" ||
      process.env.PRIVATEFLIX_PROCESSING_TEST === "1",
    "Requires its own disposable database fixture",
  );
  test.setTimeout(60000);
  page.setDefaultTimeout(10000);
  if (
    new URL(process.env.DATABASE_URL!).pathname !== "/privateflix_security_test"
  )
    throw new Error("Refusing to modify a non-test database");
  const db = new PrismaClient();
  try {
    await db.auditEvent.deleteMany();
    await db.user.deleteMany();
    await db.appSetting.deleteMany();
    await db.authThrottle.deleteMany();
    const owner = await db.user.create({
      data: {
        email: "library-browser@example.test",
        username: "library-browser",
        passwordHash: "unused",
      },
      select: { id: true },
    });
    const token = randomBytes(32).toString("hex");
    await db.session.create({
      data: {
        userId: owner.id,
        tokenHash: createHash("sha256").update(token).digest("hex"),
        expiresAt: new Date(Date.now() + 3600000),
      },
    });
    const fixtures = [
      {
        id: randomUUID(),
        title: "Summer walk.mp4",
        type: "VIDEO" as const,
        mimeType: "video/mp4",
        createdAt: new Date("2026-10-01T00:00:00Z"),
      },
      {
        id: randomUUID(),
        title: "Mountain light.png",
        type: "IMAGE" as const,
        mimeType: "image/png",
        createdAt: new Date("2026-10-02T00:00:00Z"),
      },
      {
        id: randomUUID(),
        title: "Winter walk.mp4",
        type: "VIDEO" as const,
        mimeType: "video/mp4",
        createdAt: new Date("2026-10-03T00:00:00Z"),
      },
    ];
    await db.media.createMany({
      data: fixtures.map((value) => ({
        ...value,
        ownerId: owner.id,
        originalFilename: value.title,
        storageKey: `browser-fixture/${value.id}`,
        fileSize: BigInt(1024),
        processingStatus: "PENDING",
      })),
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
    // The local HTTP runner models the canonical HTTPS origin behind the reverse proxy.
    await page.route("**/api/**", async (route) => {
      const headers = { ...(await route.request().allHeaders()) };
      if (!["GET", "HEAD"].includes(route.request().method())) {
        headers.origin = "https://localhost:3319";
        headers["sec-fetch-site"] = "same-origin";
      }
      await route.fulfill({ response: await route.fetch({ headers }) });
    });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("/");
    const library = page.getByRole("region", {
      name: "Your media",
      exact: true,
    });
    await expect(
      page.getByRole("heading", { name: "Your media", exact: true }),
    ).toBeVisible({ timeout: 20000 });
    await expect(library.getByRole("article")).toHaveCount(3, {
      timeout: 20000,
    });
    const search = page.getByLabel("Search your library", { exact: true });
    await search.fill("Summer");
    await expect(library.getByRole("article")).toHaveCount(1);
    await expect(
      library.getByRole("heading", { name: "Summer walk.mp4", exact: true }),
    ).toBeVisible();
    await search.fill("no-matching-fixture");
    await expect(library.getByRole("article")).toHaveCount(0);
    await search.clear();
    await expect(library.getByRole("article")).toHaveCount(3);
    await page.getByLabel("Media type", { exact: true }).selectOption("IMAGE");
    await expect(library.getByRole("article")).toHaveCount(1);
    await expect(
      library.getByRole("heading", { name: "Mountain light.png", exact: true }),
    ).toBeVisible();
    await page.getByLabel("Media type", { exact: true }).selectOption("all");
    await page.getByLabel("Sort media", { exact: true }).selectOption("oldest");
    await expect(library.getByRole("article").first()).toContainText(
      "Summer walk.mp4",
    );
    await page.getByRole("button", { name: "List view", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "List view", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "Grid view", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Grid view", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await page
      .getByRole("button", {
        name: "Add to favorites: Summer walk.mp4",
        exact: true,
      })
      .click();
    await page.getByRole("button", { name: "Favorites", exact: true }).click();
    await expect(library.getByRole("article")).toHaveCount(1);
    await expect(
      library.getByRole("heading", { name: "Summer walk.mp4", exact: true }),
    ).toBeVisible();
    await page.reload();
    await expect(
      page.getByRole("button", {
        name: "Remove from favorites: Summer walk.mp4",
        exact: true,
      }),
    ).toBeVisible();
    await page.getByRole("button", { name: "All media", exact: true }).click();
    await page.route("**/api/media/*/favorite", (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: "Could not save this favorite. Try again.",
        }),
      }),
    );
    const failedFavorite = page.getByRole("button", {
      name: "Add to favorites: Winter walk.mp4",
      exact: true,
    });
    await failedFavorite.click();
    await expect(
      page.getByRole("status", { name: "Library updates", exact: true }),
    ).toContainText("Could not save this favorite. Try again.");
    await expect(failedFavorite).toHaveAttribute("aria-pressed", "false");
    await expect(failedFavorite).toBeEnabled();
    expect(
      await db.favorite.count({
        where: { userId: owner.id, mediaId: fixtures[2].id },
      }),
    ).toBe(0);
    await page.unroute("**/api/media/*/favorite");
    await page
      .getByRole("button", { name: "New collection", exact: true })
      .click();
    const createDialog = page.getByRole("dialog", {
      name: "New collection",
      exact: true,
    });
    await expect(createDialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(createDialog).not.toBeVisible();
    await expect(
      page.getByRole("button", { name: "New collection", exact: true }),
    ).toBeFocused();
    await page
      .getByRole("button", { name: "New collection", exact: true })
      .click();
    await createDialog
      .getByLabel("Collection name", { exact: true })
      .fill("Weekend memories");
    await createDialog
      .getByLabel("Description (optional)", { exact: true })
      .fill("A private test collection");
    await createDialog
      .getByRole("button", { name: "Create collection", exact: true })
      .click();
    await expect(createDialog).not.toBeVisible();
    await library.getByLabel("Collection", { exact: true }).selectOption("");
    await expect(library.getByRole("article")).toHaveCount(3);
    await page
      .getByRole("button", {
        name: "Add to collection: Summer walk.mp4",
        exact: true,
      })
      .click();
    const addDialog = page.getByRole("dialog", {
      name: "Add to collection",
      exact: true,
    });
    const group = await db.collection.findFirstOrThrow({
      where: { ownerId: owner.id, name: "Weekend memories" },
    });
    await addDialog
      .getByLabel("Collection", { exact: true })
      .selectOption(group.id);
    await addDialog
      .getByRole("button", { name: "Add to collection", exact: true })
      .click();
    await expect(addDialog).not.toBeVisible();
    await library
      .getByLabel("Collection", { exact: true })
      .selectOption(group.id);
    await expect(library.getByRole("article")).toHaveCount(1);
    await expect(
      library.getByRole("heading", { name: "Summer walk.mp4", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Rename collection", exact: true })
      .click();
    const editDialog = page.getByRole("dialog", {
      name: "Edit collection",
      exact: true,
    });
    await editDialog
      .getByLabel("Collection name", { exact: true })
      .fill("Weekend favorites");
    await editDialog
      .getByLabel("Description (optional)", { exact: true })
      .fill("Renamed without changing the original");
    await editDialog
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await expect(editDialog).not.toBeVisible();
    await expect(
      library.getByRole("heading", { name: "Weekend favorites", exact: true }),
    ).toBeVisible();
    expect(
      (await db.collection.findUniqueOrThrow({ where: { id: group.id } })).name,
    ).toBe("Weekend favorites");
    expect(
      await db.collectionItem.count({
        where: { collectionId: group.id, mediaId: fixtures[0].id },
      }),
    ).toBe(1);
    await page.screenshot({
      path: testInfo.outputPath("library-desktop.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await library.scrollIntoViewIfNeeded();
    const mobileHeading = await library
      .getByRole("heading", { name: "Weekend favorites", exact: true })
      .boundingBox();
    expect(mobileHeading?.width).toBeGreaterThan(200);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath("library-mobile.png"),
      fullPage: true,
    });
    for (const viewport of [
      { width: 375, height: 812 },
      { width: 844, height: 390 },
    ]) {
      await page.setViewportSize(viewport);
      await page
        .getByRole("button", { name: "List view", exact: true })
        .click();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "Grid view", exact: true }).click();
    await page
      .getByRole("button", {
        name: "Remove from collection: Summer walk.mp4",
        exact: true,
      })
      .click();
    await expect(library.getByRole("article")).toHaveCount(0);
    expect(
      await db.media.count({ where: { ownerId: owner.id, deletedAt: null } }),
    ).toBe(3);
    await page
      .getByRole("button", { name: "Delete collection", exact: true })
      .click();
    const removeDialog = page.getByRole("dialog");
    await expect(removeDialog).toBeVisible();
    await removeDialog
      .getByRole("button", { name: "Delete collection", exact: true })
      .click();
    await expect(removeDialog).not.toBeVisible();
    await expect(library.getByRole("article")).toHaveCount(3);
    expect(await db.collection.count({ where: { id: group.id } })).toBe(0);
    expect(await db.media.count({ where: { ownerId: owner.id } })).toBe(3);
    expect(errors).toEqual([]);
    await context.clearCookies();
    expect((await page.request.get("/api/collections")).status()).toBe(401);
    expect((await page.request.get("/api/media?favorite=true")).status()).toBe(
      401,
    );
  } finally {
    await db.$disconnect();
  }
});
