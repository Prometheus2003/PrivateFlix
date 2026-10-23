import { spawnSync } from "node:child_process";
import {
  GET as sessions,
  DELETE as revoke,
} from "@/app/api/auth/sessions/route";
import { beforeEach, afterAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { PrismaClient } from "@prisma/client";
vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({
  token: "",
  config: {
    APP_URL: "https://privateflix.test",
    SETUP_TOKEN: "a".repeat(64),
    NODE_ENV: "production",
    SESSION_IDLE_TIMEOUT: 60,
    SESSION_ABSOLUTE_TIMEOUT: 3600,
    RATE_LIMIT_MAX: 5,
    RATE_LIMIT_WINDOW: 900,
  },
}));
vi.mock("@/lib/validation/env", () => ({ getEnv: () => state.config }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    set: (_name: string, value: string) => {
      state.token = value;
    },
    delete: () => {
      state.token = "";
    },
  }),
}));
import { POST as setup } from "@/app/api/auth/setup/route";
import { POST as login } from "@/app/api/auth/login/route";
import { POST as changePassword } from "@/app/api/auth/change-password/route";
import { POST as logoutAll } from "@/app/api/auth/logout-all/route";
import { POST as logout } from "@/app/api/auth/logout/route";
import { validateSession, hashSessionToken } from "@/lib/auth/session";
import { consumeAuthAttempt } from "@/lib/auth/rate-limiter";
import { prisma } from "@/lib/db/prisma";

const enabled = process.env.PRIVATEFLIX_SECURITY_TEST === "1";
const db = new PrismaClient();
const password = "Test-Owner-Password-2048!";
function request(
  route: string,
  body: unknown,
  token = "",
  extra: Record<string, string> = {},
) {
  return new NextRequest("https://privateflix.test/api/auth/" + route, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://privateflix.test",
      "x-setup-token": "a".repeat(64),
      ...(token ? { cookie: "privateflix_session=" + token } : {}),
      ...extra,
    },
    body: JSON.stringify(body),
  });
}
async function owner() {
  const response = await setup(
    request("setup", {
      email: "owner@example.test",
      username: "owner",
      password,
      confirmPassword: password,
    }),
  );
  expect(response.status).toBe(201);
  return state.token;
}

describe.skipIf(!enabled)("security with isolated PostgreSQL", () => {
  beforeEach(async () => {
    if (
      new URL(process.env.DATABASE_URL!).pathname !==
      "/privateflix_security_test"
    )
      throw new Error("Refusing to modify a non-test database");
    await db.auditEvent.deleteMany();
    await db.user.deleteMany();
    await db.appSetting.deleteMany();
    await db.authThrottle.deleteMany();
    state.token = "";
  });
  afterAll(async () => {
    await db.$disconnect();
    await prisma.$disconnect();
  });
  it("rejects cross-origin setup before database writes", async () => {
    expect(
      (
        await setup(
          request("setup", {}, "", { origin: "https://attacker.test" }),
        )
      ).status,
    ).toBe(403);
    expect(await db.user.count()).toBe(0);
  });
  it("requires the server setup secret", async () => {
    expect(
      (
        await setup(
          request("setup", {}, "", { "x-setup-token": "b".repeat(64) }),
        )
      ).status,
    ).toBe(403);
  });
  it("serializes concurrent setup and enforces one owner in the database", async () => {
    const body = {
      email: "owner@example.test",
      username: "owner",
      password,
      confirmPassword: password,
    };
    const responses = await Promise.all([
      setup(request("setup", body)),
      setup(
        request("setup", {
          ...body,
          email: "other@example.test",
          username: "other",
        }),
      ),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([201, 403]);
    expect(await db.user.count()).toBe(1);
    await expect(
      db.user.create({
        data: {
          email: "third@example.test",
          username: "third",
          passwordHash: "unused",
        },
      }),
    ).rejects.toThrow();
    await expect(
      db.user.create({
        data: {
          ownerSlot: 2,
          email: "third@example.test",
          username: "third",
          passwordHash: "unused",
        },
      }),
    ).rejects.toThrow();
  });
  it("stores only a token hash and rejects malformed, idle, absolute-expired and revoked sessions", async () => {
    const token = await owner();
    const stored = await db.session.findFirstOrThrow();
    expect(stored.tokenHash).toBe(hashSessionToken(token));
    expect(stored.tokenHash).not.toBe(token);
    expect(await validateSession(token)).not.toBeNull();
    expect(await validateSession("bad")).toBeNull();
    await db.session.update({
      where: { id: stored.id },
      data: { lastActivityAt: new Date(Date.now() - 61000) },
    });
    expect(await validateSession(token)).toBeNull();
    await db.session.update({
      where: { id: stored.id },
      data: { lastActivityAt: new Date(), expiresAt: new Date(Date.now() - 1) },
    });
    expect(await validateSession(token)).toBeNull();
    await db.session.update({
      where: { id: stored.id },
      data: { expiresAt: new Date(Date.now() + 60000), revokedAt: new Date() },
    });
    expect(await validateSession(token)).toBeNull();
  });
  it("returns the same error for unknown login and wrong password", async () => {
    await owner();
    const a = await login(request("login", { login: "unknown", password }));
    const b = await login(
      request("login", { login: "owner", password: "wrong" }),
    );
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(await a.json()).toEqual(await b.json());
  });
  it("rotates the incoming session on login", async () => {
    const old = await owner();
    expect(
      (await login(request("login", { login: "owner", password }, old))).status,
    ).toBe(200);
    expect(state.token).not.toBe(old);
    expect(await validateSession(old)).toBeNull();
    expect(await validateSession(state.token)).not.toBeNull();
  });
  it("atomically changes the password, revokes old sessions and issues a replacement", async () => {
    const old = await owner();
    await login(request("login", { login: "owner", password }));
    const second = state.token;
    const next = "New-Owner-Password-4096!";
    expect(
      (
        await changePassword(
          request(
            "change-password",
            {
              currentPassword: password,
              newPassword: next,
              confirmNewPassword: next,
            },
            old,
          ),
        )
      ).status,
    ).toBe(200);
    expect(await validateSession(old)).toBeNull();
    expect(await validateSession(second)).toBeNull();
    expect(await validateSession(state.token)).not.toBeNull();
    expect(
      (await login(request("login", { login: "owner", password }))).status,
    ).toBe(401);
    expect(
      (await login(request("login", { login: "owner", password: next })))
        .status,
    ).toBe(200);
  });
  it("does not alter credentials or sessions when current password is wrong", async () => {
    const token = await owner();
    expect(
      (
        await changePassword(
          request(
            "change-password",
            {
              currentPassword: "wrong",
              newPassword: "Changed-Password-2048!",
              confirmNewPassword: "Changed-Password-2048!",
            },
            token,
          ),
        )
      ).status,
    ).toBe(401);
    expect(await validateSession(token)).not.toBeNull();
  });
  it("requires reauthentication to revoke every session", async () => {
    const token = await owner();
    expect(
      (
        await logoutAll(
          request("logout-all", { currentPassword: "wrong" }, token),
        )
      ).status,
    ).toBe(401);
    expect(await validateSession(token)).not.toBeNull();
    expect(
      (
        await logoutAll(
          request("logout-all", { currentPassword: password }, token),
        )
      ).status,
    ).toBe(200);
    expect(await validateSession(token)).toBeNull();
  });
  it("cross-origin logout cannot clear or revoke a session", async () => {
    const token = await owner();
    expect(
      (
        await logout(
          request("logout", {}, token, { origin: "https://attacker.test" }),
        )
      ).status,
    ).toBe(403);
    expect(state.token).toBe(token);
    expect(await validateSession(token)).not.toBeNull();
  });
  it("reserves rate limits atomically under concurrency and persists state", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => consumeAuthAttempt("login")),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(5);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(5);
    expect(
      (await db.authThrottle.findUniqueOrThrow({ where: { scope: "login" } }))
        .attempts,
    ).toBe(5);
    await expect(consumeAuthAttempt("login")).rejects.toMatchObject({
      status: 429,
    });
  });
  it("changing forwarded IP headers cannot bypass login throttling", async () => {
    await owner();
    for (let i = 0; i < 5; i++)
      expect(
        (
          await login(
            request("login", { login: "owner", password: "wrong" }, "", {
              "x-forwarded-for": "192.0.2." + i,
            }),
          )
        ).status,
      ).toBe(401);
    expect(
      (
        await login(
          request("login", { login: "owner", password }, "", {
            "x-forwarded-for": "192.0.2.99",
          }),
        )
      ).status,
    ).toBe(429);
  });
  it("lists only safe session fields and reauthenticates single-session revocation", async () => {
    const token = await owner();
    await login(request("login", { login: "owner", password }));
    const target = state.token;
    const response = await sessions(request("sessions", {}, token));
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.sessions).toHaveLength(2);
    expect(JSON.stringify(data)).not.toContain("tokenHash");
    const session = await db.session.findUniqueOrThrow({
      where: { tokenHash: hashSessionToken(target) },
    });
    expect(
      (
        await revoke(
          request(
            "sessions",
            { sessionId: session.id, currentPassword: "wrong" },
            token,
          ),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await revoke(
          request(
            "sessions",
            { sessionId: session.id, currentPassword: password },
            token,
          ),
        )
      ).status,
    ).toBe(200);
    expect(await validateSession(target)).toBeNull();
    expect(await validateSession(token)).not.toBeNull();
  });
  it("offline recovery changes credentials and revokes every existing session", async () => {
    const token = await owner();
    const recovered = "Recovered-Owner-Password-8192!";
    const result = spawnSync(
      process.execPath,
      ["scripts/recover-owner.mjs", "--stdin"],
      {
        input: JSON.stringify({
          password: recovered,
          confirmPassword: recovered,
        }),
        encoding: "utf8",
        timeout: 30000,
        env: process.env,
      },
    );
    expect(result.stdout + result.stderr).not.toContain(recovered);
    expect(result.status).toBe(0);
    expect(await validateSession(token)).toBeNull();
    expect(
      (await login(request("login", { login: "owner", password }))).status,
    ).toBe(401);
    expect(
      (await login(request("login", { login: "owner", password: recovered })))
        .status,
    ).toBe(200);
    expect(
      await db.auditEvent.count({ where: { action: "password_reset" } }),
    ).toBe(1);
  });
});
