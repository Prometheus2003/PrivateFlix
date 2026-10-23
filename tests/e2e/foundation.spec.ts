import { expect, test } from "@playwright/test";

test("starter renders without browser runtime errors", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(page).toHaveTitle("PrivateFlix");
  await expect(page.getByRole("main")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  expect(errors).toEqual([]);
});

test("database health succeeds with test database", async ({ request }) => {
  const response = await request.get("/api/system/health");
  expect(response.status()).toBe(200);
  expect((await response.json()).status).toBe("healthy");
  expect(response.headers()["cache-control"]).toContain("no-store");
});

for (const token of [undefined, "not-a-valid-session"]) {
  test(`private session rejects ${token ? "invalid" : "missing"} cookie`, async ({
    request,
  }) => {
    const response = await request.get("/api/auth/session", {
      headers: token ? { Cookie: `privateflix_session=${token}` } : {},
    });
    expect(response.status()).toBe(401);
    expect(response.headers()["cache-control"]).toContain("no-store");
    const body = await response.json();
    expect(body).not.toHaveProperty("user");
    expect(body).not.toHaveProperty("session");
  });
}

for (const route of ["change-password", "logout-all"]) {
  test(`anonymous ${route} is rejected`, async ({ request }) => {
    const response = await request.post(`/api/auth/${route}`, {
      headers: { Origin: "https://localhost:3319" },
      data: {},
    });
    expect(response.status()).toBe(401);
    expect(response.headers()["cache-control"]).toContain("no-store");
  });
}

test("authentication endpoints do not allow GET mutations", async ({
  request,
}) => {
  for (const route of [
    "setup",
    "login",
    "logout",
    "logout-all",
    "change-password",
  ]) {
    expect((await request.get(`/api/auth/${route}`)).status()).toBe(405);
  }
});
