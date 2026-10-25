import { beforeEach, afterAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { Readable } from "node:stream";
import { randomBytes, createHash } from "node:crypto";
vi.mock("server-only", () => ({}));
vi.mock("@/lib/validation/env", () => ({
  getEnv: () => ({
    APP_URL: "https://privateflix.test",
    NODE_ENV: "test",
    SESSION_IDLE_TIMEOUT: 60,
    SESSION_ABSOLUTE_TIMEOUT: 3600,
    ALLOWED_VIDEO_TYPES: "mp4",
    ALLOWED_IMAGE_TYPES: "png",
    MAX_UPLOAD_SIZE: 20 * 1024 ** 2,
  }),
}));
const state = vi.hoisted(() => ({
  parts: new Map<number, Buffer>(),
  object: undefined as Buffer | undefined,
  failPart: false,
  loseComplete: false,
  afterPart: async () => {},
}));
vi.mock("@/lib/storage", () => ({
  storage: {
    createMultipartUpload: vi.fn(async () => "internal-storage-id"),
    uploadPart: vi.fn(
      async (_key: string, _id: string, part: number, bytes: Buffer) => {
        state.parts.set(part, Buffer.from(bytes));
        await state.afterPart();
        if (state.failPart) throw new Error("Lost transport response");
        return '"etag-' + part + '"';
      },
    ),
    completeMultipartUpload: vi.fn(async () => {
      state.object = Buffer.concat(
        [...state.parts.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([, b]) => b),
      );
      if (state.loseComplete) throw new Error("Lost completion response");
    }),
    objectExists: vi.fn(async () => !!state.object),
    getObject: vi.fn(async () => ({
      stream: Readable.from(state.object!),
      metadata: {
        contentLength: state.object!.length,
        contentType: "image/png",
      },
    })),
    abortMultipartUpload: vi.fn(async () => {
      state.parts.clear();
    }),
    deleteObject: vi.fn(async () => {
      state.object = undefined;
    }),
  },
}));
import { prisma } from "@/lib/db/prisma";
import { storage } from "@/lib/storage";
import { startMultipart, mutateMultipart } from "@/lib/media/multipart";
import { UPLOAD_PART_SIZE } from "@/lib/media/upload-parts";
import { runUploadMaintenance } from "@/lib/media/cleanup";
import { GET as pendingUploads } from "@/app/api/media/uploads/route";
const enabled = process.env.PRIVATEFLIX_SECURITY_TEST === "1";
const hash = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
let token = "",
  ownerId = "";
function request(
  method = "POST",
  body?: Buffer,
  headers: Record<string, string> = {},
) {
  return new NextRequest("https://privateflix.test/api/media/upload/start", {
    method,
    headers: {
      origin: "https://privateflix.test",
      cookie: "privateflix_session=" + token,
      ...headers,
    },
    ...(body ? { body: new Uint8Array(body) } : {}),
  });
}
async function start(bytes = png, checksum = hash(bytes)) {
  return startMultipart(
    request(
      "POST",
      Buffer.from(
        JSON.stringify({
          filename: "photo.png",
          mime: "image/png",
          totalBytes: bytes.length,
          checksum,
        }),
      ),
      { "content-type": "application/json" },
    ),
  );
}
async function part(id: string, bytes = png, number = 1) {
  return mutateMultipart(
    request("PUT", bytes, {
      "content-type": "application/octet-stream",
      "content-length": String(bytes.length),
      "x-part-sha256": hash(bytes),
    }),
    id,
    "part",
    String(number),
  );
}
describe.skipIf(!enabled)("resumable upload with isolated PostgreSQL", () => {
  beforeEach(async () => {
    if (
      new URL(process.env.DATABASE_URL!).pathname !==
      "/privateflix_security_test"
    )
      throw new Error("Not a test database");
    await prisma.auditEvent.deleteMany();
    await prisma.user.deleteMany();
    const owner = await prisma.user.create({
      data: {
        email: "multipart@example.test",
        username: "multipart",
        passwordHash: "unused",
      },
    });
    ownerId = owner.id;
    token = randomBytes(32).toString("hex");
    await prisma.session.create({
      data: {
        userId: ownerId,
        tokenHash: hash(Buffer.from(token)),
        expiresAt: new Date(Date.now() + 3600000),
      },
    });
    state.parts.clear();
    state.object = undefined;
    state.failPart = false;
    state.loseComplete = false;
    state.afterPart = async () => {};
    vi.clearAllMocks();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });
  it("requires authentication and same origin", async () => {
    expect(
      (await startMultipart(request("POST", undefined, { cookie: "" }))).status,
    ).toBe(401);
    expect(
      (
        await startMultipart(
          request("POST", undefined, { origin: "https://evil.test" }),
        )
      ).status,
    ).toBe(403);
    expect(storage.createMultipartUpload).not.toHaveBeenCalled();
  });
  it("does not revive an upload expired while storage initialization was pending", async () => {
    vi.mocked(storage.createMultipartUpload).mockImplementationOnce(
      async () => {
        await prisma.upload.updateMany({
          where: { ownerId },
          data: { status: "CANCELLED" },
        });
        return "late-storage-id";
      },
    );
    expect((await start()).status).toBe(409);
    expect((await prisma.upload.findFirstOrThrow()).status).toBe("FAILED");
    expect(storage.abortMultipartUpload).toHaveBeenCalledWith(
      expect.any(String),
      "late-storage-id",
    );
    expect(
      await prisma.processingJob.count({ where: { type: "CLEANUP" } }),
    ).toBe(1);
  });
  it("resumes out of order parts, retries without double counting and completes once", async () => {
    const bytes = Buffer.alloc(UPLOAD_PART_SIZE + 9);
    png.copy(bytes);
    const response = await start(bytes);
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(JSON.stringify(body)).not.toContain("internal-storage-id");
    const id = body.uploadId;
    expect((await part(id, bytes.subarray(UPLOAD_PART_SIZE), 2)).status).toBe(
      200,
    );
    expect((await mutateMultipart(request(), id, "complete")).status).toBe(409);
    expect((await part(id, bytes.subarray(0, UPLOAD_PART_SIZE))).status).toBe(
      200,
    );
    expect((await part(id, bytes.subarray(0, UPLOAD_PART_SIZE))).status).toBe(
      200,
    );
    expect(storage.uploadPart).toHaveBeenCalledTimes(2);
    expect(
      (await prisma.upload.findUniqueOrThrow({ where: { id } })).bytesUploaded,
    ).toBe(BigInt(bytes.length));
    expect((await mutateMultipart(request(), id, "complete")).status).toBe(200);
    expect((await mutateMultipart(request(), id, "complete")).status).toBe(200);
    expect(state.object).toEqual(bytes);
    expect(
      await prisma.processingJob.count({ where: { type: "METADATA" } }),
    ).toBe(1);
    expect((await prisma.media.findFirstOrThrow()).checksum).toBe(hash(bytes));
  });
  it("retries a part whose storage response was lost and refuses changed retry bytes", async () => {
    const bytes = Buffer.concat([png, Buffer.from("a")]);
    const id = (await (await start(bytes)).json()).uploadId;
    state.failPart = true;
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect((await part(id, bytes)).status).toBe(500);
    } finally {
      log.mockRestore();
    }
    state.failPart = false;
    expect(
      (await part(id, Buffer.concat([png, Buffer.from("b")]))).status,
    ).toBe(409);
    expect((await part(id, bytes)).status).toBe(200);
    expect(
      (await prisma.upload.findUniqueOrThrow({ where: { id } })).bytesUploaded,
    ).toBe(BigInt(bytes.length));
  });
  it("recovers completion when storage committed but its response was lost", async () => {
    const id = (await (await start()).json()).uploadId;
    await part(id);
    state.loseComplete = true;
    expect((await mutateMultipart(request(), id, "complete")).status).toBe(200);
  });
  it("rejects a whole-file checksum mismatch, keeps media private, and permits cleanup", async () => {
    const id = (await (await start(png, "0".repeat(64))).json()).uploadId;
    await part(id);
    expect((await mutateMultipart(request(), id, "complete")).status).toBe(400);
    expect(
      (await prisma.upload.findUniqueOrThrow({ where: { id } })).status,
    ).toBe("FAILED");
    expect(
      await prisma.processingJob.count({ where: { type: "METADATA" } }),
    ).toBe(0);
    expect((await mutateMultipart(request(), id, "cancel")).status).toBe(200);
    expect(state.object).toBeUndefined();
  });
  it("serializes concurrent operations before reading another body", async () => {
    const id = (await (await start()).json()).uploadId;
    let release!: () => void, entered!: () => void;
    const began = new Promise<void>((resolve) => {
      entered = resolve;
    });
    state.afterPart = async () => {
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    };
    const pending = part(id);
    await began;
    try {
      expect((await part(id)).status).toBe(409);
      expect((await mutateMultipart(request(), id, "cancel")).status).toBe(409);
    } finally {
      release();
    }
    expect((await pending).status).toBe(200);
  });
  it("cancels idempotently and rejects further writes", async () => {
    const id = (await (await start()).json()).uploadId;
    await part(id);
    expect((await mutateMultipart(request(), id, "cancel")).status).toBe(200);
    expect((await mutateMultipart(request(), id, "cancel")).status).toBe(200);
    expect((await part(id)).status).toBe(409);
    expect(
      await prisma.processingJob.count({ where: { type: "CLEANUP" } }),
    ).toBe(1);
  });
  it("fences a late writer after an expired lease is recovered", async () => {
    const id = (await (await start()).json()).uploadId;
    let release!: () => void, entered!: () => void;
    const began = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let calls = 0;
    state.afterPart = async () => {
      if (++calls === 1) {
        entered();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
    };
    const pending = part(id);
    await began;
    try {
      await prisma.upload.update({
        where: { id },
        data: { operationExpiresAt: new Date(0) },
      });
      expect((await part(id)).status).toBe(200);
    } finally {
      release();
    }
    expect((await pending).status).toBe(409);
    expect(
      (await prisma.upload.findUniqueOrThrow({ where: { id } })).bytesUploaded,
    ).toBe(BigInt(png.length));
    expect((await mutateMultipart(request(), id, "complete")).status).toBe(200);
  });
  it("does not commit a receipt after session revocation", async () => {
    const id = (await (await start()).json()).uploadId;
    state.afterPart = async () => {
      await prisma.session.updateMany({ data: { revokedAt: new Date() } });
    };
    expect((await part(id)).status).toBe(401);
    expect(
      (await prisma.upload.findUniqueOrThrow({ where: { id } })).bytesUploaded,
    ).toBe(BigInt(0));
    expect((await prisma.uploadPart.findFirstOrThrow()).etag).toBeNull();
  });
  it("rejects malformed and unknown identifiers without storage operations", async () => {
    expect((await mutateMultipart(request(), "bad", "cancel")).status).toBe(
      400,
    );
    expect(
      (
        await mutateMultipart(
          request(),
          "00000000-0000-4000-8000-000000000000",
          "cancel",
        )
      ).status,
    ).toBe(404);
    expect(storage.abortMultipartUpload).not.toHaveBeenCalled();
  });
  it("caps simultaneous uploads and releases capacity after cancellation", async () => {
    const id = (await (await start()).json()).uploadId;
    expect((await start()).status).toBe(201);
    expect((await start()).status).toBe(201);
    expect((await start()).status).toBe(429);
    await mutateMultipart(request(), id, "cancel");
    expect((await start()).status).toBe(201);
  });
  it("expires abandoned uploads and cleans their objects after a grace period", async () => {
    const id = (await (await start()).json()).uploadId;
    const now = new Date();
    await prisma.upload.update({
      where: { id },
      data: { updatedAt: new Date(now.getTime() - 25 * 3600000) },
    });
    expect((await runUploadMaintenance(now)).expired).toBe(1);
    expect(
      (await prisma.upload.findUniqueOrThrow({ where: { id } })).status,
    ).toBe("CANCELLED");
    expect(storage.deleteObject).not.toHaveBeenCalled();
    expect(
      (await runUploadMaintenance(new Date(now.getTime() + 31 * 60000)))
        .cleaned,
    ).toBe(1);
    expect(storage.abortMultipartUpload).toHaveBeenCalledOnce();
    expect(storage.deleteObject).toHaveBeenCalledOnce();
    expect(
      (await runUploadMaintenance(new Date(now.getTime() + 32 * 60000)))
        .cleaned,
    ).toBe(0);
  });
  it("preserves active leases and frozen completion manifests during expiry", async () => {
    const first = (await (await start()).json()).uploadId;
    const second = (await (await start()).json()).uploadId;
    const old = new Date(Date.now() - 25 * 3600000);
    await prisma.upload.update({
      where: { id: first },
      data: {
        updatedAt: old,
        operationToken: "00000000-0000-4000-8000-000000000001",
        operationExpiresAt: new Date(Date.now() + 3600000),
      },
    });
    await prisma.upload.update({
      where: { id: second },
      data: { updatedAt: old, completionStarted: true },
    });
    expect((await runUploadMaintenance()).expired).toBe(0);
    expect(await prisma.upload.count({ where: { status: "UPLOADING" } })).toBe(
      2,
    );
  });
  it("does not delete successful media even when a stale cleanup job exists", async () => {
    const started = await (await start()).json();
    await part(started.uploadId);
    await mutateMultipart(request(), started.uploadId, "complete");
    await prisma.processingJob.create({
      data: {
        mediaId: started.mediaId,
        type: "CLEANUP",
        createdAt: new Date(0),
      },
    });
    await runUploadMaintenance();
    expect(storage.deleteObject).not.toHaveBeenCalled();
    expect(state.object).toEqual(png);
  });
  it("retries failed cleanup with a delay and stops at the retry limit", async () => {
    const started = await (await start()).json();
    await mutateMultipart(request(), started.uploadId, "cancel");
    await prisma.processingJob.updateMany({
      where: { type: "CLEANUP" },
      data: { createdAt: new Date(0) },
    });
    vi.mocked(storage.deleteObject).mockRejectedValue(new Error("Unavailable"));
    try {
      const now = Date.now();
      for (let attempt = 0; attempt < 3; attempt++)
        expect(
          (await runUploadMaintenance(new Date(now + attempt * 3600000)))
            .failed,
        ).toBe(1);
      const job = await prisma.processingJob.findFirstOrThrow({
        where: { type: "CLEANUP" },
      });
      expect(job.attempts).toBe(3);
      expect(job.status).toBe("FAILED");
    } finally {
      vi.mocked(storage.deleteObject).mockImplementation(async () => {
        state.object = undefined;
      });
    }
  });
  it("lists resumable uploads only after authentication without storage identifiers", async () => {
    await start();
    expect(
      (await pendingUploads(request("GET", undefined, { cookie: "" }))).status,
    ).toBe(401);
    const response = await pendingUploads(request("GET"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.uploads).toHaveLength(1);
    expect(JSON.stringify(body)).not.toContain("internal-storage-id");
    expect(body.uploads[0]).not.toHaveProperty("operationToken");
  });
});
