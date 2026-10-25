import { expect, test } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { createHash, randomBytes } from "node:crypto";
test("processed thumbnails render privately on desktop and mobile", async ({
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
    expect(errors).toEqual([]);
    const src = await images.first().getAttribute("src");
    await context.clearCookies();
    expect((await page.request.get(src!)).status()).toBe(401);
  } finally {
    await db.$disconnect();
  }
});
