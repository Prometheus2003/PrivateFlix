import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { createHash, randomBytes, randomUUID } from "node:crypto";
test("collection covers, nesting and order persist with accurate private dashboard totals", async ({
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
  const db = new PrismaClient(),
    suffix = randomUUID().slice(0, 6),
    names = [`Family ${suffix}`, `Trips ${suffix}`];
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
    const library = page.getByRole("region", {
        name: "Your media",
        exact: true,
      }),
      overview = page.getByRole("region", {
        name: "Library overview",
        exact: true,
      });
    const expected = await db.media.count({
      where: { ownerId: owner.id, deletedAt: null },
    });
    await expect(
      overview
        .locator("dl > div")
        .filter({ has: page.getByText("Total items", { exact: true }) })
        .locator("dd"),
    ).toHaveText(String(expected), { timeout: 20000 });
    await overview.locator("summary").click();
    await expect(
      overview.getByText("Media uploaded privately", { exact: true }).first(),
    ).toBeVisible();
    await library
      .getByRole("button", { name: "New collection", exact: true })
      .click();
    let dialog = page.getByRole("dialog", {
      name: "New collection",
      exact: true,
    });
    await dialog.getByLabel("Collection name", { exact: true }).fill(names[1]);
    await dialog
      .getByRole("button", { name: "Create collection", exact: true })
      .click();
    await expect(dialog).toHaveCount(0, { timeout: 20000 });
    const trip = await db.collection.findFirstOrThrow({
      where: { ownerId: owner.id, name: names[1] },
    });
    await library
      .getByRole("combobox", { name: "Collection", exact: true })
      .selectOption("");
    const card = library
      .getByRole("article", { name: original.title, exact: true })
      .filter({
        has: page.getByRole("button", { name: "View photo", exact: true }),
      });
    await card
      .getByRole("button", {
        name: `Add to collection: ${original.title}`,
        exact: true,
      })
      .click();
    dialog = page.getByRole("dialog", {
      name: "Add to collection",
      exact: true,
    });
    await dialog
      .getByRole("combobox", { name: "Collection", exact: true })
      .selectOption(trip.id);
    await dialog
      .getByRole("button", { name: "Add to collection", exact: true })
      .click();
    await expect(dialog).toHaveCount(0, { timeout: 20000 });
    await library
      .getByRole("combobox", { name: "Collection", exact: true })
      .selectOption(trip.id);
    await card
      .getByRole("button", {
        name: `Use as collection cover: ${original.title}`,
        exact: true,
      })
      .click();
    await expect(
      library.getByRole("img", { name: `Cover for ${names[1]}`, exact: true }),
    ).toBeVisible({ timeout: 20000 });
    await library
      .getByRole("button", { name: "New collection", exact: true })
      .click();
    dialog = page.getByRole("dialog", { name: "New collection", exact: true });
    await dialog.getByLabel("Collection name", { exact: true }).fill(names[0]);
    await dialog
      .getByRole("button", { name: "Create collection", exact: true })
      .click();
    await expect(dialog).toHaveCount(0, { timeout: 20000 });
    const family = await db.collection.findFirstOrThrow({
      where: { ownerId: owner.id, name: names[0] },
    });
    await library
      .getByRole("button", { name: "Arrange collections", exact: true })
      .click();
    dialog = page.getByRole("dialog", {
      name: "Arrange collections",
      exact: true,
    });
    await dialog
      .getByRole("combobox", { name: "Collection to nest", exact: true })
      .selectOption(trip.id);
    await dialog
      .getByRole("combobox", { name: "Parent collection", exact: true })
      .selectOption(family.id);
    await dialog
      .getByRole("button", { name: `Move ${names[0]} up`, exact: true })
      .click();
    await dialog
      .getByRole("button", { name: "Save organization", exact: true })
      .click();
    await expect(dialog).toHaveCount(0, { timeout: 20000 });
    expect(
      (await db.collection.findUniqueOrThrow({ where: { id: trip.id } }))
        .parentId,
    ).toBe(family.id);
    expect(
      (
        await db.collection.findMany({
          where: { id: { in: [trip.id, family.id] } },
          orderBy: { sortOrder: "asc" },
        })
      ).map((row) => row.id),
    ).toEqual([family.id, trip.id]);
    await page.reload();
    await library.locator(".collection-shelf summary").click();
    const tile = library.getByRole("button", {
      name: `Browse collection: ${names[0]} / ${names[1]}`,
      exact: true,
    });
    await expect(tile).toBeVisible({ timeout: 20000 });
    await expect(tile.locator("img")).toHaveAttribute(
      "src",
      new RegExp(`/api/media/${original.id}/thumbnail$`),
    );
    await tile.click();
    await library
      .getByRole("button", { name: "Clear collection cover", exact: true })
      .click();
    await expect(
      library.getByRole("img", { name: `Cover for ${names[1]}`, exact: true }),
    ).toHaveCount(0, { timeout: 20000 });
    await card
      .getByRole("button", {
        name: `Use as collection cover: ${original.title}`,
        exact: true,
      })
      .click();
    await expect(
      library.getByRole("img", { name: `Cover for ${names[1]}`, exact: true }),
    ).toBeVisible({ timeout: 20000 });
    await page.locator("#collection").scrollIntoViewIfNeeded();
    await page.screenshot({
      path: testInfo.outputPath("phase7-dashboard.png"),
    });
    await library
      .getByRole("button", { name: "Arrange collections", exact: true })
      .click();
    dialog = page.getByRole("dialog", {
      name: "Arrange collections",
      exact: true,
    });
    await dialog
      .getByRole("combobox", { name: "Collection to nest", exact: true })
      .selectOption(family.id);
    expect(
      await dialog
        .getByRole("combobox", { name: "Parent collection", exact: true })
        .locator("option")
        .count(),
    ).toBe(1);
    await page.setViewportSize({ width: 375, height: 812 });
    expect(
      await dialog.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath("collection-layout-mobile.png"),
    });
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await library
      .getByRole("combobox", { name: "Collection", exact: true })
      .selectOption(family.id);
    await library
      .getByRole("button", { name: "Delete collection", exact: true })
      .click();
    dialog = page.getByRole("dialog", {
      name: "Delete collection?",
      exact: true,
    });
    await expect(
      dialog.getByText(
        "Subcollections are kept and become top-level collections.",
        { exact: true },
      ),
    ).toBeVisible();
    await dialog
      .getByRole("button", { name: "Delete collection", exact: true })
      .click();
    await expect(dialog).toHaveCount(0, { timeout: 20000 });
    expect(
      (await db.collection.findUniqueOrThrow({ where: { id: trip.id } }))
        .parentId,
    ).toBeNull();
    expect(
      (await db.media.findUniqueOrThrow({ where: { id: original.id } }))
        .processingStatus,
    ).toBe("READY");
    expect(
      await db.collectionItem.count({
        where: { collectionId: trip.id, mediaId: original.id },
      }),
    ).toBe(1);
    const count = await db.collection.count({ where: { ownerId: owner.id } });
    await expect(
      overview.getByRole("link", { name: `${count} collections`, exact: true }),
    ).toBeVisible({ timeout: 20000 });
    await context.clearCookies();
    expect((await page.request.get("/api/library/summary")).status()).toBe(401);
    expect(errors).toEqual([]);
  } finally {
    await db.collection.deleteMany({ where: { name: { in: names } } });
    await db.$disconnect();
  }
});
