import { beforeEach, afterAll, describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, writeFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
vi.mock("server-only", () => ({}));
vi.mock("@/lib/validation/env", () => ({
  getEnv: () => ({ FFMPEG_TIMEOUT: 10, MAX_UPLOAD_SIZE: 1048576 }),
}));
const state = vi.hoisted(() => ({
  bytes: Buffer.from("fixture-original"),
  fail: false,
  afterWrite: async () => {},
}));
vi.mock("@/lib/storage", () => ({
  storage: {
    getObject: vi.fn(async () => ({
      stream: Readable.from(state.bytes),
      metadata: { contentLength: state.bytes.length },
    })),
    putObject: vi.fn(async (_key: string, stream: Readable) => {
      for await (const chunk of stream) void chunk;
      await state.afterWrite();
    }),
    deleteObject: vi.fn(async () => {}),
  },
}));
vi.mock("@/lib/media/processor-tools", () => ({
  probeMedia: vi.fn(async () => {
    if (state.fail) throw new Error("Decoder failure");
    return {
      streamIndex: 0,
      width: 320,
      height: 240,
      duration: null,
      codec: "png",
      bitrate: null,
    };
  }),
  createThumbnail: vi.fn(async (_input: string, output: string) => {
    await writeFile(output, Buffer.from([255, 216, 255, 217]));
  }),
}));
import { prisma } from "@/lib/db/prisma";
import { processMediaJob } from "@/lib/media/process-job";
import { storage } from "@/lib/storage";
import { probeMedia } from "@/lib/media/processor-tools";
let workspace: string, ownerId: string;
const enabled = process.env.PRIVATEFLIX_SECURITY_TEST === "1";
describe.skipIf(!enabled)("processing leases and state transitions", () => {
  beforeEach(async () => {
    if (
      new URL(process.env.DATABASE_URL!).pathname !==
      "/privateflix_security_test"
    )
      throw new Error("Test database required");
    if (workspace) await rm(workspace, { recursive: true, force: true });
    workspace = await mkdtemp(join(tmpdir(), "privateflix-processing-unit-"));
    await prisma.auditEvent.deleteMany();
    await prisma.user.deleteMany();
    ownerId = (
      await prisma.user.create({
        data: {
          email: "processor@example.test",
          username: "processor",
          passwordHash: "unused",
        },
      })
    ).id;
    state.fail = false;
    state.afterWrite = async () => {};
    vi.clearAllMocks();
  });
  afterAll(async () => {
    if (workspace) await rm(workspace, { recursive: true, force: true });
    await prisma.$disconnect();
  });
  async function fixture(
    checksum = createHash("sha256").update(state.bytes).digest("hex"),
  ) {
    const media = await prisma.media.create({
      data: {
        ownerId,
        title: "Fixture",
        type: "IMAGE",
        originalFilename: "fixture.png",
        mimeType: "image/png",
        storageKey: randomUUID() + "/original",
        fileSize: state.bytes.length,
        checksum,
        processingStatus: "UPLOADED",
      },
    });
    const job = await prisma.processingJob.create({
      data: { mediaId: media.id, type: "METADATA" },
    });
    return { media, job };
  }
  it("publishes once under concurrent delivery and removes temporary files", async () => {
    const { media, job } = await fixture();
    await Promise.all([
      processMediaJob(job.id, workspace),
      processMediaJob(job.id, workspace),
    ]);
    await processMediaJob(job.id, workspace);
    expect(
      await prisma.media.findUnique({ where: { id: media.id } }),
    ).toMatchObject({ processingStatus: "READY", width: 320, height: 240 });
    expect(
      await prisma.processingJob.findUnique({ where: { id: job.id } }),
    ).toMatchObject({ status: "COMPLETED", attempts: 1, leaseToken: null });
    expect(storage.putObject).toHaveBeenCalledTimes(1);
    expect(await readdir(workspace)).toEqual([]);
  });
  it("retries decoder failures then fails without deleting the original", async () => {
    const { media, job } = await fixture();
    state.fail = true;
    for (let i = 0; i < 4; i++) await processMediaJob(job.id, workspace);
    expect(
      await prisma.processingJob.findUnique({ where: { id: job.id } }),
    ).toMatchObject({ status: "FAILED", attempts: 3 });
    expect(
      await prisma.media.findUnique({ where: { id: media.id } }),
    ).toMatchObject({ processingStatus: "FAILED" });
    expect(storage.deleteObject).not.toHaveBeenCalled();
    expect(storage.putObject).not.toHaveBeenCalled();
  });
  it("rejects checksum changes before invoking FFmpeg", async () => {
    const { job } = await fixture("0".repeat(64));
    await processMediaJob(job.id, workspace);
    expect(probeMedia).not.toHaveBeenCalled();
    expect(
      await prisma.processingJob.findUnique({ where: { id: job.id } }),
    ).toMatchObject({ status: "QUEUED", attempts: 1 });
  });
  it("recovers expired leases but leaves current leases alone", async () => {
    const { job } = await fixture();
    await prisma.processingJob.update({
      where: { id: job.id },
      data: {
        status: "PROCESSING",
        leaseToken: randomUUID(),
        leaseExpiresAt: new Date(Date.now() + 60000),
      },
    });
    await processMediaJob(job.id, workspace);
    expect(probeMedia).not.toHaveBeenCalled();
    await prisma.processingJob.update({
      where: { id: job.id },
      data: { leaseExpiresAt: new Date(0) },
    });
    await processMediaJob(job.id, workspace);
    expect(probeMedia).toHaveBeenCalledOnce();
  });
  it("skips deleted media", async () => {
    const { media, job } = await fixture();
    await prisma.media.update({
      where: { id: media.id },
      data: { deletedAt: new Date() },
    });
    await processMediaJob(job.id, workspace);
    expect(storage.getObject).not.toHaveBeenCalled();
  });
  it("cannot publish after losing its lease and removes the unclaimed thumbnail", async () => {
    const { media, job } = await fixture();
    state.afterWrite = async () => {
      await prisma.processingJob.update({
        where: { id: job.id },
        data: { leaseToken: randomUUID() },
      });
    };
    await processMediaJob(job.id, workspace);
    expect(
      await prisma.media.findUnique({ where: { id: media.id } }),
    ).toMatchObject({
      processingStatus: "PROCESSING",
      thumbnailStorageKey: null,
    });
    expect(storage.deleteObject).toHaveBeenCalledOnce();
    expect(vi.mocked(storage.deleteObject).mock.calls[0][0]).toContain(
      "thumbnail-",
    );
  });
});
