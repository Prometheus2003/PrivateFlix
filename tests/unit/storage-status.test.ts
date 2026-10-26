import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({
  authenticated: true,
  broken: false,
  config: {
    STORAGE_PROVIDER: "s3",
    MAX_UPLOAD_SIZE: 10737418240,
    GOOGLE_DRIVE_CLIENT_ID: "",
    GOOGLE_DRIVE_CLIENT_SECRET: "",
    GOOGLE_DRIVE_REFRESH_TOKEN: "",
    GOOGLE_DRIVE_FOLDER_ID: "",
  },
}));
vi.mock("@/lib/auth/require-auth", () => ({
  requireAuth: vi.fn(async () => {
    if (!state.authenticated)
      throw new Response(JSON.stringify({ error: "Authentication required" }), {
        status: 401,
        headers: { "Cache-Control": "private, no-store" },
      });
    return { user: { id: "owner" } };
  }),
}));
vi.mock("@/lib/validation/env", () => ({
  getEnv: vi.fn(() => {
    if (state.broken) throw new Error("sensitive-configuration-value");
    return state.config;
  }),
}));
import { GET } from "@/app/api/system/storage/route";
import { getEnv } from "@/lib/validation/env";

const request = () =>
  new NextRequest("http://localhost:3000/api/system/storage");
beforeEach(() => {
  vi.clearAllMocks();
  state.authenticated = true;
  state.broken = false;
  state.config = {
    STORAGE_PROVIDER: "s3",
    MAX_UPLOAD_SIZE: 10737418240,
    GOOGLE_DRIVE_CLIENT_ID: "",
    GOOGLE_DRIVE_CLIENT_SECRET: "",
    GOOGLE_DRIVE_REFRESH_TOKEN: "",
    GOOGLE_DRIVE_FOLDER_ID: "",
  };
});

describe("owner storage configuration status", () => {
  it("requires authentication before reading any configuration", async () => {
    state.authenticated = false;
    const response = await GET(request());
    expect(response.status).toBe(401);
    expect(getEnv).not.toHaveBeenCalled();
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
  it("reports the default destination without claiming Drive is connected", async () => {
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({
      uploadDestination: "s3",
      driveConfigured: false,
      connectionStatus: "not-checked",
      maxUploadBytes: 10737418240,
    });
  });
  it("returns only safe flags and limits for a configured Drive account", async () => {
    state.config = {
      ...state.config,
      STORAGE_PROVIDER: "google-drive",
      GOOGLE_DRIVE_CLIENT_ID: "private-client",
      GOOGLE_DRIVE_CLIENT_SECRET: "private-secret",
      GOOGLE_DRIVE_REFRESH_TOKEN: "private-refresh",
      GOOGLE_DRIVE_FOLDER_ID: "private-folder",
    };
    const response = await GET(request());
    expect(await response.json()).toEqual({
      uploadDestination: "google-drive",
      driveConfigured: true,
      connectionStatus: "not-checked",
      maxUploadBytes: 10737418240,
    });
  });
  it("treats a partial credential set as not configured", async () => {
    state.config.GOOGLE_DRIVE_CLIENT_ID = "partial-client";
    expect((await (await GET(request())).json()).driveConfigured).toBe(false);
  });
  it("never exposes environment errors or configuration values", async () => {
    state.broken = true;
    const logger = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await GET(request());
      expect(response.status).toBe(500);
      expect(await response.text()).not.toContain(
        "sensitive-configuration-value",
      );
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    } finally {
      logger.mockRestore();
    }
  });
});
