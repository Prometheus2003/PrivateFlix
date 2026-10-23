import { describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  setupToken: "a".repeat(64) as string | undefined,
}));
vi.mock("@/lib/validation/env", () => ({
  getEnv: () => ({
    APP_URL: "https://privateflix.test",
    SETUP_TOKEN: state.setupToken,
  }),
}));
import {
  assertSameOrigin,
  assertSetupToken,
  readAuthBody,
} from "@/lib/auth/http";
function request(body: string, headers: Record<string, string> = {}) {
  return new Request("https://privateflix.test/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}
describe("authentication request boundaries", () => {
  it.each([
    undefined,
    "null",
    "http://privateflix.test",
    "https://evil.test",
    "https://privateflix.test.evil.test",
  ])("rejects invalid Origin %s", (origin) => {
    expect(() =>
      assertSameOrigin(request("{}", origin ? { origin } : {})),
    ).toThrow();
  });
  it("accepts only the canonical origin", () => {
    expect(() =>
      assertSameOrigin(request("{}", { origin: "https://privateflix.test" })),
    ).not.toThrow();
  });
  it("rejects cross-site fetch metadata even with canonical origin", () => {
    expect(() =>
      assertSameOrigin(
        request("{}", {
          origin: "https://privateflix.test",
          "sec-fetch-site": "cross-site",
        }),
      ),
    ).toThrow();
  });
  it("fails closed when setup is not configured", () => {
    state.setupToken = undefined;
    try {
      expect(() =>
        assertSetupToken(request("{}", { "x-setup-token": "a".repeat(64) })),
      ).toThrow();
    } finally {
      state.setupToken = "a".repeat(64);
    }
  });
  it("accepts the configured setup token", () => {
    expect(() =>
      assertSetupToken(request("{}", { "x-setup-token": "a".repeat(64) })),
    ).not.toThrow();
  });
  it.each(["", "b".repeat(64), "a".repeat(65)])(
    "rejects invalid setup token",
    (token) => {
      expect(() =>
        assertSetupToken(request("{}", { "x-setup-token": token })),
      ).toThrow();
    },
  );
  it("parses bounded JSON", async () => {
    expect(await readAuthBody(request('{"login":"owner"}'))).toEqual({
      login: "owner",
    });
  });
  it("rejects malformed JSON", async () => {
    await expect(readAuthBody(request("{"))).rejects.toMatchObject({
      status: 400,
    });
  });
  it("rejects bodies larger than 8 KiB despite a lying Content-Length", async () => {
    await expect(
      readAuthBody(
        request(JSON.stringify({ padding: "x".repeat(8192) }), {
          "content-length": "1",
        }),
      ),
    ).rejects.toMatchObject({ status: 413 });
  });
  it("rejects form bodies and compressed input", async () => {
    await expect(
      readAuthBody(
        request("x=1", { "content-type": "application/x-www-form-urlencoded" }),
      ),
    ).rejects.toMatchObject({ status: 415 });
    await expect(
      readAuthBody(request("{}", { "content-encoding": "gzip" })),
    ).rejects.toMatchObject({ status: 415 });
  });
});
