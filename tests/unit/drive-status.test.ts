import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({ request: vi.fn(), folder: vi.fn() }));
vi.mock("@/lib/storage/drive-client", () => ({
  DriveClient: class {
    request = state.request;
    assertPrivateFolder = state.folder;
  },
}));
vi.mock("@/lib/validation/env", () => ({
  getEnv: () => ({
    GOOGLE_DRIVE_CLIENT_ID: "private-client",
    GOOGLE_DRIVE_CLIENT_SECRET: "private-secret",
    GOOGLE_DRIVE_REFRESH_TOKEN: "private-token",
    GOOGLE_DRIVE_FOLDER_ID: "private-folder",
  }),
}));
beforeEach(() => {
  vi.resetModules();
  state.request.mockReset();
  state.folder.mockReset();
  state.folder.mockResolvedValue(undefined);
  state.request.mockResolvedValue(
    Response.json({ storageQuota: { limit: "5497558138880", usage: "1000" } }),
  );
});
describe("safe live Drive status", () => {
  it("requires a private folder and valid quota before reporting connected", async () => {
    const { checkDriveStatus } = await import("@/lib/storage/drive-status");
    const status = await checkDriveStatus();
    expect(status).toMatchObject({
      connectionStatus: "connected",
      capacityBytes: 5497558138880,
      usedBytes: 1000,
    });
    expect(state.folder).toHaveBeenCalledOnce();
    expect(JSON.stringify(status)).not.toMatch(
      /private-client|private-secret|private-token|private-folder/,
    );
  });
  it("deduplicates concurrent checks and reuses only a bounded result", async () => {
    const { checkDriveStatus } = await import("@/lib/storage/drive-status");
    const results = await Promise.all([
      checkDriveStatus(),
      checkDriveStatus(),
      checkDriveStatus(),
    ]);
    expect(state.request).toHaveBeenCalledOnce();
    expect(results[0]).toEqual(results[2]);
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 31000);
    try {
      await checkDriveStatus();
      expect(state.request).toHaveBeenCalledTimes(2);
    } finally {
      clock.mockRestore();
    }
  });
  it("fails closed for a shared, missing or inaccessible storage folder", async () => {
    state.folder.mockRejectedValue(new Error("private-token"));
    const { checkDriveStatus } = await import("@/lib/storage/drive-status");
    expect(await checkDriveStatus()).toMatchObject({
      connectionStatus: "unavailable",
      capacityBytes: null,
      usedBytes: null,
    });
  });
  it("does not report revoked authorization as connected", async () => {
    state.request.mockResolvedValue(
      new Response("private-token", { status: 401 }),
    );
    const { checkDriveStatus } = await import("@/lib/storage/drive-status");
    expect((await checkDriveStatus()).connectionStatus).toBe("unavailable");
  });
  it("handles unlimited capacity without inventing a quota", async () => {
    state.request.mockResolvedValue(
      Response.json({ storageQuota: { usage: "2000" } }),
    );
    const { checkDriveStatus } = await import("@/lib/storage/drive-status");
    expect(await checkDriveStatus()).toMatchObject({
      connectionStatus: "connected",
      capacityBytes: null,
      usedBytes: 2000,
    });
  });
  it("rejects unsafe or malformed byte values", async () => {
    state.request.mockResolvedValue(
      Response.json({ storageQuota: { limit: "999999999999999999999" } }),
    );
    const { checkDriveStatus } = await import("@/lib/storage/drive-status");
    expect((await checkDriveStatus()).connectionStatus).toBe("unavailable");
  });
});
