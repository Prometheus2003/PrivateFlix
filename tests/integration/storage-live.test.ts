import { afterAll, describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import { S3Client, DeleteBucketCommand } from "@aws-sdk/client-s3";
vi.mock("server-only", () => ({}));
vi.mock("@/lib/validation/env", () => ({
  getEnv: () => ({
    S3_ENDPOINT: process.env.S3_ENDPOINT,
    S3_REGION: "us-east-1",
    S3_BUCKET: "privateflix-test-storage",
    S3_ACCESS_KEY: process.env.S3_ACCESS_KEY,
    S3_SECRET_KEY: process.env.S3_SECRET_KEY,
  }),
}));
import { createS3StorageAdapter } from "@/lib/storage/s3";
const enabled = process.env.PRIVATEFLIX_STORAGE_TEST === "1";
const adapter = createS3StorageAdapter();
const keys = ["roundtrip", "multipart"];
async function bytes(stream: Readable) {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}
describe.skipIf(!enabled)("live isolated MinIO storage", () => {
  afterAll(async () => {
    if (process.env.S3_ENDPOINT !== "http://127.0.0.1:19000") return;
    await adapter.deleteObjects(keys);
    const client = new S3Client({
      endpoint: process.env.S3_ENDPOINT,
      region: "us-east-1",
      forcePathStyle: true,
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY!,
        secretAccessKey: process.env.S3_SECRET_KEY!,
      },
    });
    try {
      await client.send(
        new DeleteBucketCommand({ Bucket: "privateflix-test-storage" }),
      );
    } finally {
      client.destroy();
    }
  });
  it("round-trips streams, enforces byte ranges, and denies anonymous object/list requests", async () => {
    if (process.env.S3_ENDPOINT !== "http://127.0.0.1:19000")
      throw new Error(
        "Live storage tests require the isolated loopback endpoint",
      );
    const data = Buffer.from("privateflix-private-media");
    await adapter.putObject("roundtrip", Readable.from(data), {
      contentType: "application/octet-stream",
      contentLength: data.length,
    });
    expect(await adapter.healthCheck()).toBe(true);
    expect(await bytes((await adapter.getObject("roundtrip")).stream)).toEqual(
      data,
    );
    const ranged = await adapter.getObject("roundtrip", { start: 2, end: 7 });
    expect(await bytes(ranged.stream)).toEqual(data.subarray(2, 8));
    expect(ranged.metadata.contentLength).toBe(data.length);
    expect(
      (
        await fetch(
          process.env.S3_ENDPOINT + "/privateflix-test-storage/roundtrip",
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(
          process.env.S3_ENDPOINT + "/privateflix-test-storage?list-type=2",
        )
      ).status,
    ).toBe(403);
  });
  it("uploads and completes multipart objects through supported S3 commands", async () => {
    const uploadId = await adapter.createMultipartUpload(
      "multipart",
      "application/octet-stream",
    );
    const first = Buffer.alloc(5 * 1024 * 1024, 1),
      second = Buffer.from("final");
    try {
      const a = await adapter.uploadPart("multipart", uploadId, 1, first);
      const b = await adapter.uploadPart("multipart", uploadId, 2, second);
      await adapter.completeMultipartUpload("multipart", uploadId, [
        { partNumber: 1, etag: a },
        { partNumber: 2, etag: b },
      ]);
      expect((await adapter.getObjectMetadata("multipart")).contentLength).toBe(
        first.length + second.length,
      );
    } catch (error) {
      await adapter.abortMultipartUpload("multipart", uploadId);
      throw error;
    }
  });
  it("aborts multipart uploads and reports missing objects correctly", async () => {
    const uploadId = await adapter.createMultipartUpload(
      "aborted",
      "application/octet-stream",
    );
    await adapter.uploadPart("aborted", uploadId, 1, Buffer.from("unfinished"));
    await adapter.abortMultipartUpload("aborted", uploadId);
    expect(await adapter.objectExists("aborted")).toBe(false);
    expect(await adapter.objectExists("does-not-exist")).toBe(false);
  });
});
