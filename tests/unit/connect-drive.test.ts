import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  authorizationDetails,
  callbackCode,
  connectDrive,
  DRIVE_REDIRECT,
  DRIVE_SCOPE,
  updateDriveEnv,
} from "../../scripts/connect-drive.mjs";

const folders: string[] = [];
afterEach(async () => {
  for (const folder of folders.splice(0)) {
    // Each path is the unique system-temp directory created by these tests.
    expect(
      folder.startsWith(join(tmpdir(), "privateflix-drive-connect-")),
    ).toBe(true);
    await rm(folder, { recursive: true, force: true });
  }
});
const desktop = {
  installed: {
    client_id: "test-client.apps.googleusercontent.com",
    client_secret: "test-client-secret",
  },
};
const tokens = {
  access_token: "test-access",
  refresh_token: "test-refresh",
  scope: DRIVE_SCOPE,
};
async function fixture(
  initial = "APP_NAME=PrivateFlix\nSTORAGE_PROVIDER=s3\n",
  credentials: unknown = desktop,
) {
  const folder = await mkdtemp(join(tmpdir(), "privateflix-drive-connect-"));
  folders.push(folder);
  const root = join(folder, "app");
  await mkdir(root);
  const envPath = join(root, ".env");
  const clientPath = join(folder, "client.json");
  await writeFile(envPath, initial);
  await writeFile(clientPath, JSON.stringify(credentials));
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json(tokens))
    .mockResolvedValueOnce(Response.json({ id: "private-folder" }))
    .mockResolvedValueOnce(
      Response.json({ permissions: [{ type: "user", role: "owner" }] }),
    );
  const log = vi.fn();
  const authorize = vi
    .fn<(details: ReturnType<typeof authorizationDetails>) => Promise<string>>()
    .mockResolvedValue("test-code");
  return { root, envPath, clientPath, initial, fetcher, authorize, log };
}
describe("local Drive OAuth connection", () => {
  it("uses unique state, a matching PKCE challenge, offline access and only drive.file", () => {
    const first = authorizationDetails("client-id");
    const second = authorizationDetails("client-id");
    const parameters = new URL(first.url).searchParams;
    expect(first.state).toMatch(/^[a-f0-9]{64}$/);
    expect(first.state).not.toBe(second.state);
    expect(first.verifier).not.toBe(second.verifier);
    expect(parameters.get("code_challenge")).toBe(
      createHash("sha256").update(first.verifier).digest("base64url"),
    );
    expect(parameters.get("code_challenge_method")).toBe("S256");
    expect(parameters.get("redirect_uri")).toBe(DRIVE_REDIRECT);
    expect(parameters.get("access_type")).toBe("offline");
    expect(parameters.get("scope")).toBe(DRIVE_SCOPE);
    expect(first.url).not.toContain(first.verifier);
  });
  it("accepts the authorized callback and does not accept a denial", () => {
    const state = "a".repeat(64);
    expect(
      callbackCode(
        `/callback?state=${state}&code=test-code`,
        "GET",
        "127.0.0.1:53682",
        state,
      ),
    ).toBe("test-code");
    expect(() =>
      callbackCode(
        `/callback?state=${state}&error=access_denied`,
        "GET",
        "127.0.0.1:53682",
        state,
      ),
    ).toThrow("not granted");
  });
  it.each([
    ["/callback?state=wrong&code=test-code", "GET", "127.0.0.1:53682"],
    ["/callback?state=STATE&code=test-code", "POST", "127.0.0.1:53682"],
    ["/callback?state=STATE&code=test-code", "GET", "evil.example"],
    [
      "https://evil.example/callback?state=STATE&code=test-code",
      "GET",
      "127.0.0.1:53682",
    ],
    ["/wrong?state=STATE&code=test-code", "GET", "127.0.0.1:53682"],
    [
      "/callback?state=STATE&state=STATE&code=test-code",
      "GET",
      "127.0.0.1:53682",
    ],
    ["/callback?state=STATE&code=first&code=second", "GET", "127.0.0.1:53682"],
  ])("rejects an untrusted or ambiguous callback %s", (url, method, host) => {
    expect(() =>
      callbackCode(
        url.replaceAll("STATE", "a".repeat(64)),
        method,
        host,
        "a".repeat(64),
      ),
    ).toThrow();
  });
  it("saves a successful private-folder connection without printing credentials", async () => {
    const current = await fixture();
    await connectDrive(current.clientPath, current);
    const content = await readFile(current.envPath, "utf8");
    expect(content).toContain('STORAGE_PROVIDER="google-drive"');
    expect(content).toContain('GOOGLE_DRIVE_FOLDER_ID="private-folder"');
    expect(content).toContain('GOOGLE_DRIVE_REFRESH_TOKEN="test-refresh"');
    expect(content).toContain("APP_NAME=PrivateFlix");
    const tokenCall = current.fetcher.mock.calls[0];
    expect(tokenCall[0]).toBe("https://oauth2.googleapis.com/token");
    const body = tokenCall[1]?.body as URLSearchParams;
    expect(body.get("code")).toBe("test-code");
    expect(body.get("code_verifier")).toBe(
      current.authorize.mock.calls[0]?.[0]?.verifier,
    );
    expect(body.get("redirect_uri")).toBe(DRIVE_REDIRECT);
    for (const call of current.fetcher.mock.calls)
      expect(call[1]?.redirect).toBe("error");
    expect(current.log.mock.calls.flat().join(" ")).not.toMatch(
      /test-access|test-refresh|test-client-secret|test-code/,
    );
    expect(await readdir(current.root)).toEqual([".env"]);
  });
  it("requires an offline refresh token before creating a folder", async () => {
    const current = await fixture();
    current.fetcher
      .mockReset()
      .mockResolvedValueOnce(
        Response.json({ access_token: "test-access", scope: DRIVE_SCOPE }),
      );
    await expect(connectDrive(current.clientPath, current)).rejects.toThrow(
      "Offline Drive access",
    );
    expect(current.fetcher).toHaveBeenCalledTimes(1);
    expect(await readFile(current.envPath, "utf8")).toBe(current.initial);
    expect(await readdir(current.root)).toEqual([".env"]);
  });
  it("allows empty optional settings and removes duplicates when connecting", async () => {
    const current = await fixture(
      'GOOGLE_DRIVE_REFRESH_TOKEN=""\nGOOGLE_DRIVE_FOLDER_ID=\nSTORAGE_PROVIDER=s3\n export STORAGE_PROVIDER=s3\n',
    );
    await connectDrive(current.clientPath, current);
    const content = await readFile(current.envPath, "utf8");
    expect(content.match(/STORAGE_PROVIDER/g)).toHaveLength(1);
    expect(content).toContain('GOOGLE_DRIVE_REFRESH_TOKEN="test-refresh"');
  });
  it("rejects a second simultaneous connection without removing the first lock", async () => {
    const current = await fixture();
    await writeFile(join(current.root, ".env.drive-connect.lock"), "");
    await expect(connectDrive(current.clientPath, current)).rejects.toThrow(
      "Another Drive connection",
    );
    expect(await readdir(current.root)).toContain(".env.drive-connect.lock");
    expect(current.authorize).not.toHaveBeenCalled();
    expect(await readFile(current.envPath, "utf8")).toBe(current.initial);
  });
  it("rejects newline injection in downloaded client credentials", async () => {
    const current = await fixture(undefined, {
      installed: {
        ...desktop.installed,
        client_secret: "secret\nSTORAGE_PROVIDER=evil",
      },
    });
    await expect(connectDrive(current.clientPath, current)).rejects.toThrow(
      "client JSON required",
    );
    expect(current.authorize).not.toHaveBeenCalled();
    expect(await readFile(current.envPath, "utf8")).toBe(current.initial);
  });
  it("refuses to enable a shared folder", async () => {
    const current = await fixture();
    current.fetcher
      .mockReset()
      .mockResolvedValueOnce(Response.json(tokens))
      .mockResolvedValueOnce(Response.json({ id: "private-folder" }))
      .mockResolvedValueOnce(
        Response.json({
          permissions: [
            { type: "user", role: "owner" },
            { type: "anyone", role: "reader" },
          ],
        }),
      );
    await expect(connectDrive(current.clientPath, current)).rejects.toThrow(
      "not private",
    );
    expect(await readFile(current.envPath, "utf8")).toBe(current.initial);
  });
  it("preserves edits made while Google authorization is pending", async () => {
    const current = await fixture();
    current.authorize.mockImplementationOnce(async () => {
      await writeFile(
        current.envPath,
        `${current.initial}APP_ACCENT_COLOR="#abcdef"\n`,
      );
      return "test-code";
    });
    await expect(connectDrive(current.clientPath, current)).rejects.toThrow(
      "changed during authorization",
    );
    expect(await readFile(current.envPath, "utf8")).toBe(
      `${current.initial}APP_ACCENT_COLOR="#abcdef"\n`,
    );
    expect(await readdir(current.root)).toEqual([".env"]);
  });
  it.each([
    "GOOGLE_DRIVE_REFRESH_TOKEN=test-refresh",
    '  export GOOGLE_DRIVE_FOLDER_ID = "old-folder"',
  ])("does not replace an existing Drive connection: %s", async (setting) => {
    const current = await fixture(`APP_NAME=PrivateFlix\n${setting}\n`);
    await expect(connectDrive(current.clientPath, current)).rejects.toThrow(
      "already configured",
    );
    expect(current.authorize).not.toHaveBeenCalled();
    expect(current.fetcher).not.toHaveBeenCalled();
    expect(await readFile(current.envPath, "utf8")).toBe(current.initial);
  });
  it("rejects a credential file inside the repository and a mismatched web redirect", async () => {
    const current = await fixture();
    await expect(
      connectDrive(join(current.root, "oauth.json"), current),
    ).rejects.toThrow("outside the PrivateFlix repository");
    await writeFile(
      current.clientPath,
      JSON.stringify({
        web: {
          ...desktop.installed,
          redirect_uris: ["https://evil.example/callback"],
        },
      }),
    );
    await expect(connectDrive(current.clientPath, current)).rejects.toThrow(
      "exact redirect",
    );
    expect(current.authorize).not.toHaveBeenCalled();
    await expect(
      connectDrive(join(current.root, "..hidden", "oauth.json"), current),
    ).rejects.toThrow("outside the PrivateFlix repository");
  });
  it("does not reflect Google error bodies or replace local settings", async () => {
    const current = await fixture();
    current.fetcher
      .mockReset()
      .mockResolvedValueOnce(
        Response.json({ error: "test-private-credential" }, { status: 400 }),
      );
    const failure = connectDrive(current.clientPath, current);
    await expect(failure).rejects.toThrow("Google request failed (400)");
    await expect(failure).rejects.not.toThrow("test-private-credential");
    expect(await readFile(current.envPath, "utf8")).toBe(current.initial);
  });
  it("eliminates duplicate env assignments while preserving unrelated settings", () => {
    const updated = updateDriveEnv(
      "APP_NAME=PrivateFlix\r\nSTORAGE_PROVIDER=s3\r\n export STORAGE_PROVIDER = s3\r\n",
      { STORAGE_PROVIDER: "google-drive" },
    );
    expect(updated.match(/STORAGE_PROVIDER/g)).toHaveLength(1);
    expect(updated).toContain("APP_NAME=PrivateFlix");
    expect(updated).toContain('STORAGE_PROVIDER="google-drive"');
  });
  it("provides CLI help and a clear missing-argument failure without reading .env", () => {
    const script = resolve("scripts/connect-drive.mjs");
    const help = spawnSync(process.execPath, [script, "--help"], {
      cwd: tmpdir(),
      encoding: "utf8",
    });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("Usage: npm run drive:connect");
    const missing = spawnSync(process.execPath, [script], {
      cwd: tmpdir(),
      encoding: "utf8",
    });
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("Usage: npm run drive:connect");
  });
});
