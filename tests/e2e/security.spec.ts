import { expect, test } from "@playwright/test";
test("pages carry nonce CSP, frame protection and no-store", async ({
  page,
  request,
}) => {
  const first = await request.get("/");
  const second = await request.get("/");
  expect(first.headers()["content-security-policy"]).toContain("'nonce-");
  expect(first.headers()["content-security-policy"]).not.toBe(
    second.headers()["content-security-policy"],
  );
  expect(first.headers()["x-frame-options"]).toBe("DENY");
  expect(first.headers()["x-content-type-options"]).toBe("nosniff");
  expect(first.headers()["x-robots-tag"]).toContain("noindex");
  expect(first.headers()["cache-control"]).toContain("no-store");
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.goto("/");
  expect(
    errors.filter((error) => error.includes("Content Security Policy")),
  ).toEqual([]);
});
test("auth mutations reject cross-origin and absent origin", async ({
  request,
}) => {
  for (const route of ["setup", "login", "logout"]) {
    const origins: Record<string, string>[] = [
      { Origin: "https://evil.test" },
      {},
    ];
    for (const headers of origins) {
      const response = await request.post("/api/auth/" + route, {
        headers,
        data: {},
      });
      expect(response.status()).toBe(403);
      expect(response.headers()["cache-control"]).toContain("no-store");
    }
  }
});
test("setup requires the server-held bootstrap token", async ({ request }) => {
  const response = await request.post("/api/auth/setup", {
    headers: { Origin: "https://localhost:3319" },
    data: {},
  });
  expect([403, 503]).toContain(response.status());
});
import { PrismaClient } from "@prisma/client";
test("owner setup, cookies, session lookup and reauthenticated logout over HTTP", async ({
  request,
}) => {
  test.skip(
    process.env.PRIVATEFLIX_SECURITY_TEST !== "1",
    "Requires explicitly enabled isolated database",
  );
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
    const password = "Browser-Test-Password-2048!";
    const response = await request.post("/api/auth/setup", {
      headers: {
        Origin: "https://localhost:3319",
        "X-Setup-Token": process.env.SETUP_TOKEN!,
      },
      data: {
        email: "browser@example.test",
        username: "browser",
        password,
        confirmPassword: password,
      },
    });
    expect(response.status()).toBe(201);
    const cookie = response.headers()["set-cookie"];
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=lax");
    expect(cookie).toContain("Path=/");
    if (process.env.PRIVATEFLIX_E2E_MODE !== "development")
      expect(cookie).toContain("Secure");
    const token = /privateflix_session=([^;]+)/.exec(cookie)?.[1];
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    const headers = {
      Cookie: "privateflix_session=" + token,
      Origin: "https://localhost:3319",
    };
    const session = await request.get("/api/auth/session", { headers });
    expect(session.status()).toBe(200);
    expect((await session.json()).user.username).toBe("browser");
    const listed = await request.get("/api/auth/sessions", { headers });
    expect(listed.status()).toBe(200);
    expect((await listed.json()).sessions).toHaveLength(1);
    const ended = await request.post("/api/auth/logout-all", {
      headers,
      data: { currentPassword: password },
    });
    expect(ended.status()).toBe(200);
    expect((await request.get("/api/auth/session", { headers })).status()).toBe(
      401,
    );
  } finally {
    await db.$disconnect();
  }
});
