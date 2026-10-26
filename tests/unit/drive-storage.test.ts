import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
vi.mock("server-only", () => ({}));
import { DriveClient } from "@/lib/storage/drive-client";
import {
  DriveStorageAdapter,
  type DriveObjectRecord,
  type DriveObjectRegistry,
} from "@/lib/storage/drive";
import { routedStorage } from "@/lib/storage/routed";
import type {
  StorageAdapter,
  ByteRange,
  PutObjectOptions,
  PartInfo,
} from "@/lib/storage/adapter";

const md5 = (body: Buffer) => createHash("md5").update(body).digest("hex");
const bytes = Buffer.from("0123456789abcdef");
const key = "drive/video/2026/10/opaque/original.mp4";
class MemoryStorage implements StorageAdapter {
  objects = new Map<string, { body: Buffer; type: string }>();
  parts = new Map<number, Buffer>();
  multipartType = "video/mp4";
  failDelete = false;
  async putObject(
    name: string,
    body: Readable | Buffer,
    options: PutObjectOptions,
  ) {
    const chunks: Buffer[] = [];
    for await (const chunk of Buffer.isBuffer(body)
      ? Readable.from([body])
      : body)
      chunks.push(Buffer.from(chunk));
    this.objects.set(name, {
      body: Buffer.concat(chunks),
      type: options.contentType,
    });
  }
  async getObjectMetadata(name: string) {
    const object = this.objects.get(name);
    if (!object) throw new Error("Missing fixture");
    return { contentLength: object.body.length, contentType: object.type };
  }
  async getObject(name: string, range?: ByteRange) {
    const metadata = await this.getObjectMetadata(name);
    const body = this.objects.get(name)!.body;
    return {
      metadata,
      stream: Readable.from([
        range
          ? body.subarray(
              range.start,
              range.end === undefined ? undefined : range.end + 1,
            )
          : body,
      ]),
    };
  }
  async deleteObject(name: string) {
    if (this.failDelete) throw new Error("Fixture deletion failed");
    this.objects.delete(name);
  }
  async deleteObjects(names: string[]) {
    for (const name of names) await this.deleteObject(name);
  }
  async objectExists(name: string) {
    return this.objects.has(name);
  }
  async createMultipartUpload(_key: string, type: string) {
    this.multipartType = type;
    return "staging-upload";
  }
  async uploadPart(_key: string, _id: string, number: number, body: Buffer) {
    this.parts.set(number, body);
    return md5(body);
  }
  async completeMultipartUpload(name: string, _id: string, parts: PartInfo[]) {
    await this.putObject(
      name,
      Buffer.concat(parts.map((p) => this.parts.get(p.partNumber)!)),
      { contentType: this.multipartType },
    );
  }
  async abortMultipartUpload() {
    this.parts.clear();
  }
  async healthCheck() {
    return true;
  }
}
function fixture() {
  const staging = new MemoryStorage();
  const records = new Map<string, DriveObjectRecord & { pending: boolean }>();
  const registry: DriveObjectRegistry = {
    find: async (name) => records.get(name) ?? null,
    reserve: async (name, id) => {
      if (!records.has(name))
        records.set(name, {
          fileId: id,
          verifiedMd5: null,
          verifiedSize: null,
          revisionId: null,
          pending: true,
        });
      return records.get(name)!;
    },
    verify: async (name, fileId, digest, size, revisionId) => {
      records.set(name, {
        fileId,
        verifiedMd5: digest,
        verifiedSize: size,
        revisionId,
        pending: true,
      });
    },
    stagingRemoved: async (name) => {
      records.get(name)!.pending = false;
    },
    pending: async () =>
      [...records]
        .filter(([, record]) => record.pending && record.verifiedMd5)
        .map(([name, record]) => ({ key: name, ...record })),
    remove: async (name) => {
      records.delete(name);
    },
  };
  const driveFiles = new Map<string, { body: Buffer; type: string }>();
  const state = {
    lostResponse: false,
    wrongHash: false,
    badRange: false,
    requests: 0,
  };
  const fetcher: typeof fetch = vi.fn(async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === "oauth2.googleapis.com")
      return Response.json({
        access_token: "fixture-access",
        expires_in: 3600,
      });
    if (url.pathname.endsWith("generateIds"))
      return Response.json({ ids: [`allocated-${++state.requests}`] });
    if (url.pathname.endsWith("/folder/permissions"))
      return Response.json({ permissions: [{ type: "user", role: "owner" }] });
    if (url.pathname.endsWith("/folder"))
      return Response.json({
        mimeType: "application/vnd.google-apps.folder",
        ownedByMe: true,
        trashed: false,
      });
    if (url.pathname === "/upload/drive/v3/files" && init?.method === "POST") {
      const data = JSON.parse(String(init.body)) as { id: string };
      expect(url.searchParams.get("keepRevisionForever")).toBe("true");
      return new Response(null, {
        status: 200,
        headers: {
          Location: `https://www.googleapis.com/upload/session/${data.id}`,
        },
      });
    }
    if (url.pathname.startsWith("/upload/session/")) {
      const id = url.pathname.split("/").at(-1)!;
      const body = Buffer.from(await new Response(init!.body).arrayBuffer());
      driveFiles.set(id, {
        body,
        type: String(new Headers(init!.headers).get("content-type")),
      });
      if (state.lostResponse) {
        state.lostResponse = false;
        throw new Error("Lost Google response");
      }
      return Response.json({ id });
    }
    const id = url.pathname.split("/")[4];
    const object = driveFiles.get(id);
    if (!object) return new Response(null, { status: 404 });
    if (init?.method === "DELETE") {
      driveFiles.delete(id);
      return new Response(null, { status: 204 });
    }
    if (url.pathname.includes("/revisions/")) {
      if (url.searchParams.get("alt") !== "media")
        return Response.json({
          keepForever: true,
          md5Checksum: md5(object.body),
          size: String(object.body.length),
        });
      const range = new Headers(init?.headers).get("range");
      const match = range?.match(/^bytes=(\d+)-(\d*)$/);
      const start = Number(match?.[1] ?? 0),
        end = match?.[2] ? Number(match[2]) : object.body.length - 1;
      const body = object.body.subarray(start, end + 1);
      return new Response(Uint8Array.from(body), {
        status: range ? 206 : 200,
        headers: {
          "content-length": String(body.length),
          ...(range
            ? {
                "content-range": `bytes ${state.badRange ? start + 1 : start}-${end}/${object.body.length}`,
              }
            : {}),
        },
      });
    }
    return Response.json({
      id,
      mimeType: object.type,
      size: String(object.body.length),
      md5Checksum: state.wrongHash ? "incorrect" : md5(object.body),
      headRevisionId: "pinned-revision",
      parents: ["folder"],
      trashed: false,
    });
  });
  const client = new DriveClient(
    {
      clientId: "fixture-client",
      clientSecret: "fixture-secret",
      refreshToken: "fixture-refresh",
      folderId: "folder",
    },
    fetcher,
  );
  const storage = new DriveStorageAdapter(staging, client, registry);
  return {
    storage,
    staging,
    registry,
    records,
    driveFiles,
    client,
    fetcher,
    state,
  };
}
async function read(stream: Readable) {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

describe("Drive-backed storage with private upload staging", () => {
  it("preserves out-of-order multipart uploads, verifies the pinned Drive revision and frees local staging", async () => {
    const f = fixture();
    const id = await f.storage.createMultipartUpload(key, "video/mp4");
    const second = await f.storage.uploadPart(key, id, 2, bytes.subarray(8));
    const first = await f.storage.uploadPart(key, id, 1, bytes.subarray(0, 8));
    await f.storage.completeMultipartUpload(key, id, [
      { partNumber: 1, etag: first },
      { partNumber: 2, etag: second },
    ]);
    expect(await f.storage.objectExists(key)).toBe(true);
    expect(f.staging.objects.size).toBe(0);
    expect(f.records.get(key)).toMatchObject({
      verifiedMd5: md5(bytes),
      verifiedSize: bytes.length,
      revisionId: "pinned-revision",
      pending: false,
    });
    expect(await read((await f.storage.getObject(key)).stream)).toEqual(bytes);
  });
  it("recovers a lost completed PUT response without duplicate files or early publication", async () => {
    const f = fixture();
    f.state.lostResponse = true;
    await expect(
      f.storage.putObject(key, bytes, { contentType: "video/mp4" }),
    ).rejects.toThrow("Lost Google response");
    expect(await f.storage.objectExists(key)).toBe(false);
    await expect(f.storage.getObjectMetadata(key)).rejects.toThrow(
      "Object not found",
    );
    expect(f.staging.objects.has(key)).toBe(true);
    await f.storage.completeMultipartUpload(key, "staging-upload", []);
    expect(f.driveFiles.size).toBe(1);
    expect(f.state.requests).toBe(1);
    expect(await f.storage.objectExists(key)).toBe(true);
    expect(f.staging.objects.has(key)).toBe(false);
  });
  it("keeps staged bytes and refuses publication when an existing Drive upload differs", async () => {
    const f = fixture();
    f.state.lostResponse = true;
    await expect(
      f.storage.putObject(key, bytes, { contentType: "video/mp4" }),
    ).rejects.toThrow();
    f.state.wrongHash = true;
    await expect(
      f.storage.completeMultipartUpload(key, "staging-upload", []),
    ).rejects.toThrow("verification failed");
    expect(await f.storage.objectExists(key)).toBe(false);
    expect(f.staging.objects.has(key)).toBe(true);
  });
  it("reconciles temporary local copies after deletion failures", async () => {
    const f = fixture();
    f.staging.failDelete = true;
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await f.storage.putObject(key, bytes, { contentType: "video/mp4" });
    } finally {
      log.mockRestore();
    }
    expect(await f.storage.objectExists(key)).toBe(true);
    expect(f.records.get(key)?.pending).toBe(true);
    f.staging.failDelete = false;
    expect(await f.storage.cleanupStaging()).toBe(1);
    expect(f.staging.objects.has(key)).toBe(false);
    expect(f.records.get(key)?.pending).toBe(false);
  });
  it("supports exact and open-ended byte ranges and rejects inconsistent cloud responses", async () => {
    const f = fixture();
    await f.storage.putObject(key, bytes, { contentType: "video/mp4" });
    const part = await f.storage.getObject(key, { start: 2, end: 5 });
    expect(await read(part.stream)).toEqual(bytes.subarray(2, 6));
    expect(part.metadata.contentLength).toBe(bytes.length);
    expect(
      await read((await f.storage.getObject(key, { start: 12 })).stream),
    ).toEqual(bytes.subarray(12));
    await expect(f.storage.getObject(key, { start: 16 })).rejects.toThrow(
      "Invalid byte range",
    );
    f.state.badRange = true;
    await expect(
      f.storage.getObject(key, { start: 2, end: 5 }),
    ).rejects.toThrow("Invalid Drive download");
  });
  it("reclaims other temporary copies when one pending Drive object changed", async () => {
    const f = fixture();
    f.staging.failDelete = true;
    const second = key + ".thumbnail";
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await f.storage.putObject(key, bytes, { contentType: "video/mp4" });
      await f.storage.putObject(second, bytes, { contentType: "image/jpeg" });
      f.staging.failDelete = false;
      f.driveFiles.set(f.records.get(key)!.fileId, {
        body: Buffer.from("changed media"),
        type: "video/mp4",
      });
      expect(await f.storage.cleanupStaging()).toBe(1);
      expect(f.staging.objects.has(key)).toBe(true);
      expect(f.records.get(key)?.pending).toBe(true);
      expect(f.staging.objects.has(second)).toBe(false);
    } finally {
      log.mockRestore();
    }
  });
  it("refuses externally modified Drive objects and leaves recovery copies intact", async () => {
    const f = fixture();
    await f.storage.putObject(key, bytes, { contentType: "video/mp4" });
    f.state.wrongHash = true;
    await expect(f.storage.getObject(key)).rejects.toThrow(
      "changed after verification",
    );
  });
  it("routes old media to S3 and derived Drive thumbnails to Drive regardless of the default", async () => {
    const f = fixture();
    const getDrive = vi.fn(() => f.storage);
    const storage = routedStorage(f.staging, getDrive);
    await storage.putObject("image/old.png", bytes, {
      contentType: "image/png",
    });
    expect(getDrive).not.toHaveBeenCalled();
    await storage.putObject(key, bytes, { contentType: "video/mp4" });
    const thumbnail = key.slice(0, key.lastIndexOf("/") + 1) + "thumbnail.jpg";
    await storage.putObject(thumbnail, bytes, { contentType: "image/jpeg" });
    expect(
      await read((await storage.getObject("image/old.png")).stream),
    ).toEqual(bytes);
    expect(f.driveFiles.size).toBe(2);
    await storage.deleteObjects(["image/old.png", key, thumbnail]);
    expect(f.staging.objects.size).toBe(0);
    expect(f.driveFiles.size).toBe(0);
    expect(f.records.size).toBe(0);
  });
});
