import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { DriveClient } from "@/lib/storage/drive-client";

const config = {
  clientId: "test-client",
  clientSecret: "test-client-secret",
  refreshToken: "test-refresh-secret",
  folderId: "private-folder",
};
const api = "https://www.googleapis.com/drive/v3";
const privateFolder = {
  mimeType: "application/vnd.google-apps.folder",
  trashed: false,
  ownedByMe: true,
};
const owner = { type: "user", role: "owner" };
const file = {
  id: "object-id",
  size: "5",
  mimeType: "video/mp4",
  md5Checksum: "a".repeat(32),
  parents: [config.folderId],
  trashed: false,
  headRevisionId: "revision-1",
};
const json = (value: unknown, status = 200) => Response.json(value, { status });
function mockGoogle(
  handle: (url: URL, init: RequestInit) => Response | Promise<Response>,
) {
  let refreshes = 0;
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    if (url.hostname === "oauth2.googleapis.com") {
      refreshes++;
      return json({
        access_token: `test-access-${refreshes}`,
        expires_in: 3600,
      });
    }
    return handle(url, init ?? {});
  });
  return {
    fetcher,
    client: new DriveClient(config, fetcher),
    refreshes: () => refreshes,
  };
}
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Google Drive token and endpoint boundaries", () => {
  it("coalesces simultaneous refreshes and caches the token", async () => {
    const seen: string[] = [];
    const { client, fetcher, refreshes } = mockGoogle((_url, init) => {
      seen.push(new Headers(init.headers).get("authorization") ?? "");
      return json({ ids: ["allocated-id"] });
    });
    expect(
      await Promise.all([
        client.allocateId(),
        client.allocateId(),
        client.allocateId(),
      ]),
    ).toEqual(["allocated-id", "allocated-id", "allocated-id"]);
    await client.allocateId();
    expect(refreshes()).toBe(1);
    expect(seen).toEqual(Array(4).fill("Bearer test-access-1"));
    const tokenInit = fetcher.mock.calls[0][1]!;
    const body = tokenInit.body as URLSearchParams;
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe(config.refreshToken);
    expect(tokenInit.redirect).toBe("error");
  });
  it("refreshes before expiry and invalidates a token on 401 for the next call", async () => {
    vi.useFakeTimers();
    let rejected = false;
    const { client, refreshes } = mockGoogle(() => {
      if (!rejected) {
        rejected = true;
        return json({}, 401);
      }
      return json({ ids: ["allocated-id"] });
    });
    await expect(client.allocateId()).rejects.toThrow("401");
    await client.allocateId();
    expect(refreshes()).toBe(2);
    vi.setSystemTime(Date.now() + 3600 * 1000);
    await client.allocateId();
    expect(refreshes()).toBe(3);
  });
  it("does not include Google's error body or credentials in an OAuth error", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      json(
        { error_description: `${config.clientSecret} ${config.refreshToken}` },
        400,
      ),
    );
    const client = new DriveClient(config, fetcher);
    const result = client.allocateId().catch((error: unknown) => String(error));
    expect(await result).toContain("400");
    expect(await result).not.toContain(config.clientSecret);
    expect(await result).not.toContain(config.refreshToken);
  });
  it.each([
    "https://evil.example/drive/v3/files",
    "http://www.googleapis.com/drive/v3/files",
    "https://www.googleapis.com.evil.example/drive/v3/files",
    "https://user:secret@www.googleapis.com/drive/v3/files",
  ])("rejects endpoint %s before using credentials", async (url) => {
    const { client, fetcher } = mockGoogle(() => json({}));
    await expect(client.request(url)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("private Drive folder and object boundaries", () => {
  it("accepts only the owner's unshared My Drive folder", async () => {
    const { client } = mockGoogle((url) =>
      url.pathname.endsWith("/permissions")
        ? json({ permissions: [owner] })
        : json(privateFolder),
    );
    await expect(client.assertPrivateFolder()).resolves.toBeUndefined();
  });
  it.each([
    { permissions: [] },
    { permissions: [owner, { type: "anyone", role: "reader" }] },
    { permissions: [owner, { type: "user", role: "writer" }] },
    { permissions: [{ type: "domain", role: "reader" }] },
    { permissions: [owner], nextPageToken: "more-permissions" },
  ])(
    "rejects non-private or incomplete permissions %j",
    async (permissions) => {
      const { client } = mockGoogle((url) =>
        url.pathname.endsWith("/permissions")
          ? json(permissions)
          : json(privateFolder),
      );
      await expect(client.assertPrivateFolder()).rejects.toThrow(
        "must not be shared",
      );
    },
  );
  it.each([
    { ...privateFolder, ownedByMe: false },
    { ...privateFolder, trashed: true },
    { ...privateFolder, mimeType: "video/mp4" },
  ])("rejects invalid storage folder %j", async (folder) => {
    const { client, fetcher } = mockGoogle(() => json(folder));
    await expect(client.assertPrivateFolder()).rejects.toThrow(
      "private My Drive folder",
    );
    expect(
      fetcher.mock.calls.some(([url]) => String(url).includes("/permissions")),
    ).toBe(false);
  });
  it("preserves a stable revision when creating a resumable upload", async () => {
    const { client, fetcher } = mockGoogle((url) => {
      if (url.pathname.endsWith("/permissions"))
        return json({ permissions: [owner] });
      if (url.pathname.startsWith("/upload/"))
        return new Response(null, {
          status: 200,
          headers: {
            location:
              "https://www.googleapis.com/upload/drive/v3/files?upload_id=private-session",
          },
        });
      return json(privateFolder);
    });
    await expect(
      client.beginUpload("object-id", "video/mp4", 5),
    ).resolves.toContain("upload_id=");
    const upload = fetcher.mock.calls.find(([url]) =>
      String(url).includes("/upload/"),
    )!;
    expect(
      new URL(String(upload[0])).searchParams.get("keepRevisionForever"),
    ).toBe("true");
    expect(JSON.parse(String(upload[1]?.body))).toMatchObject({
      id: "object-id",
      parents: [config.folderId],
    });
    expect(new Headers(upload[1]?.headers).get("x-upload-content-length")).toBe(
      "5",
    );
  });
  it("rejects a resumable session pointing outside Google", async () => {
    const { client } = mockGoogle((url) => {
      if (url.pathname.endsWith("/permissions"))
        return json({ permissions: [owner] });
      if (url.pathname.startsWith("/upload/"))
        return new Response(null, {
          headers: { location: "https://evil.example/collect-secret" },
        });
      return json(privateFolder);
    });
    await expect(
      client.beginUpload("object-id", "video/mp4", 5),
    ).rejects.toThrow("Invalid Drive upload session");
  });
  it("does not delete an object moved outside the storage folder", async () => {
    const { client, fetcher } = mockGoogle(() =>
      json({ ...file, parents: ["unrelated-folder"] }),
    );
    await expect(client.remove(file.id)).rejects.toThrow(
      "outside storage folder",
    );
    expect(
      fetcher.mock.calls.some(([, init]) => init?.method === "DELETE"),
    ).toBe(false);
  });
  it("verifies that the retained revision matches the staged bytes", async () => {
    const { client } = mockGoogle((url) => {
      expect(url.pathname).toBe(
        "/drive/v3/files/object-id/revisions/revision-1",
      );
      return json({
        keepForever: true,
        md5Checksum: file.md5Checksum,
        size: file.size,
      });
    });
    await expect(
      client.assertPinnedRevision(file.id, "revision-1", file.md5Checksum, 5),
    ).resolves.toBeUndefined();
  });
  it.each([
    { keepForever: false, md5Checksum: file.md5Checksum, size: "5" },
    { keepForever: true, md5Checksum: "b".repeat(32), size: "5" },
    { keepForever: true, md5Checksum: file.md5Checksum, size: "6" },
    { keepForever: true, size: "5" },
  ])("rejects an unretained or mismatched revision %j", async (revision) => {
    const { client } = mockGoogle(() => json(revision));
    await expect(
      client.assertPinnedRevision(file.id, "revision-1", file.md5Checksum, 5),
    ).rejects.toThrow("Drive revision verification failed");
  });
  it("treats missing or trashed objects as absent and returns the current revision", async () => {
    let state = 0;
    const { client } = mockGoogle(() =>
      state++ === 0
        ? json({}, 404)
        : state === 2
          ? json({ ...file, trashed: true })
          : json(file),
    );
    expect(await client.file(file.id)).toBeNull();
    expect(await client.file(file.id)).toBeNull();
    expect(await client.file(file.id)).toMatchObject({
      headRevisionId: "revision-1",
    });
  });
});

describe("Drive revision streaming", () => {
  it("downloads the pinned revision with the requested byte range", async () => {
    const { client, fetcher } = mockGoogle(
      () =>
        new Response("ab", {
          status: 206,
          headers: { "content-range": "bytes 1-2/5", "content-length": "2" },
        }),
    );
    const response = await client.download(
      "object-id",
      "revision-1",
      "bytes=1-2",
    );
    expect(await response.text()).toBe("ab");
    const request = fetcher.mock.calls[1];
    expect(String(request[0])).toBe(
      `${api}/files/object-id/revisions/revision-1?alt=media`,
    );
    expect(new Headers(request[1]?.headers).get("range")).toBe("bytes=1-2");
    expect(new Headers(request[1]?.headers).get("authorization")).toBe(
      "Bearer test-access-1",
    );
  });
  it("keeps the bearer token on same-origin redirects and strips it for signed Google download URLs", async () => {
    const cancelled = vi.fn();
    const redirectBody = () =>
      new ReadableStream<Uint8Array>({ cancel: cancelled });
    const { client, fetcher } = mockGoogle((url) => {
      if (url.pathname.includes("/revisions/"))
        return new Response(redirectBody(), {
          status: 302,
          headers: {
            location: "https://www.googleapis.com/download/drive/file",
          },
        });
      if (url.hostname === "www.googleapis.com")
        return new Response(redirectBody(), {
          status: 307,
          headers: {
            location:
              "https://doc-0a-example.googleusercontent.com/download?signed=opaque",
          },
        });
      return new Response("ab", { status: 206 });
    });
    const response = await client.download(
      "object-id",
      "revision-1",
      "bytes=1-2",
    );
    expect(await response.text()).toBe("ab");
    const requests = fetcher.mock.calls.slice(1);
    expect(new Headers(requests[1][1]?.headers).get("authorization")).toBe(
      "Bearer test-access-1",
    );
    expect(new Headers(requests[2][1]?.headers).has("authorization")).toBe(
      false,
    );
    expect(new Headers(requests[2][1]?.headers).get("range")).toBe("bytes=1-2");
    expect(cancelled).toHaveBeenCalledTimes(2);
  });
  it.each([
    "https://evil.example/file",
    "http://doc-0a-example.googleusercontent.com/file",
    "https://googleusercontent.com.evil.example/file",
    "https://evilgoogleusercontent.com/file",
    "https://user:secret@doc-0a-example.googleusercontent.com/file",
  ])("does not follow an unsafe media redirect to %s", async (location) => {
    const { client, fetcher } = mockGoogle(
      () => new Response(null, { status: 302, headers: { location } }),
    );
    await expect(client.download("object-id", "revision-1")).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("bounds media redirect loops", async () => {
    const { client, fetcher } = mockGoogle(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://www.googleapis.com/download/loop" },
        }),
    );
    await expect(client.download("object-id", "revision-1")).rejects.toThrow();
    expect(fetcher.mock.calls.length).toBeLessThanOrEqual(5);
  });
  it("rejects an ignored Range response and cancels its body", async () => {
    const cancelled = vi.fn();
    const { client } = mockGoogle(
      () =>
        new Response(new ReadableStream<Uint8Array>({ cancel: cancelled }), {
          status: 200,
        }),
    );
    await expect(
      client.download("object-id", "revision-1", "bytes=1-2"),
    ).rejects.toThrow();
    expect(cancelled).toHaveBeenCalledOnce();
  });
  it("propagates cancellation to the remote body", async () => {
    const cancelled = vi.fn();
    const { client } = mockGoogle(
      () => new Response(new ReadableStream<Uint8Array>({ cancel: cancelled })),
    );
    const response = await client.download("object-id", "revision-1");
    await response.body!.cancel();
    expect(cancelled).toHaveBeenCalledOnce();
  });
  it("aborts a download that does not return headers within sixty seconds", async () => {
    vi.useFakeTimers();
    const { client } = mockGoogle(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal!.addEventListener(
            "abort",
            () => reject(init.signal!.reason),
            { once: true },
          );
        }),
    );
    const assertion = expect(
      client.download("object-id", "revision-1"),
    ).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(60001);
    await assertion;
  });
});
