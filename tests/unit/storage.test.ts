import { beforeEach, describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import {
  S3Client,
  HeadBucketCommand,
  PutBucketPolicyCommand,
  GetBucketPolicyCommand,
  HeadObjectCommand,
  GetObjectCommand,
  DeleteObjectsCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
} from "@aws-sdk/client-s3";
vi.mock("server-only", () => ({}));
vi.mock("@/lib/validation/env", () => ({
  getEnv: () => ({ S3_BUCKET: "privateflix-test", S3_REGION: "us-east-1" }),
}));
import { createS3StorageAdapter, privateBucketPolicy } from "@/lib/storage/s3";
const client = new S3Client({
  region: "us-east-1",
  credentials: { accessKeyId: "test", secretAccessKey: "test" },
});
const send = vi.spyOn(client, "send");
beforeEach(() => {
  send.mockReset();
  send.mockImplementation(async (command) => {
    if (command instanceof GetBucketPolicyCommand)
      return {
        $metadata: {},
        Policy: JSON.stringify(privateBucketPolicy("privateflix-test")),
      };
    if (command instanceof HeadObjectCommand)
      return {
        $metadata: {},
        ContentLength: 10,
        ContentType: "video/mp4",
        ETag: '"etag"',
      };
    if (command instanceof GetObjectCommand)
      return { $metadata: {}, Body: Readable.from(Buffer.from("0123456789")) };
    if (command instanceof CreateMultipartUploadCommand)
      return { $metadata: {}, UploadId: "upload" };
    if (command instanceof UploadPartCommand)
      return { $metadata: {}, ETag: '"part"' };
    return { $metadata: {} };
  });
});
describe("S3 adapter transport contract", () => {
  it("does not read objects when private-policy application fails", async () => {
    send.mockImplementation(async (command) => {
      if (command instanceof PutBucketPolicyCommand)
        throw new Error("AccessDenied");
      return { $metadata: {} };
    });
    await expect(
      createS3StorageAdapter(client).getObject("key"),
    ).rejects.toThrow("AccessDenied");
    expect(
      send.mock.calls.some(([command]) => command instanceof GetObjectCommand),
    ).toBe(false);
  });
  it("does not accept an unverified policy", async () => {
    send.mockImplementation(async (command) =>
      command instanceof GetBucketPolicyCommand
        ? { $metadata: {}, Policy: '{"Statement":[]}' }
        : { $metadata: {} },
    );
    await expect(
      createS3StorageAdapter(client).getObject("key"),
    ).rejects.toThrow("policy verification");
  });
  it("initializes once under concurrent operations", async () => {
    const adapter = createS3StorageAdapter(client);
    await Promise.all([
      adapter.getObjectMetadata("a"),
      adapter.getObjectMetadata("b"),
    ]);
    expect(
      send.mock.calls.filter(
        ([command]) => command instanceof PutBucketPolicyCommand,
      ),
    ).toHaveLength(1);
    expect(
      send.mock.calls.filter(
        ([command]) => command instanceof HeadBucketCommand,
      ),
    ).toHaveLength(1);
  });
  it("retries failed initialization on the next operation", async () => {
    const adapter = createS3StorageAdapter(client);
    send.mockRejectedValueOnce(new Error("Unavailable"));
    await expect(adapter.getObjectMetadata("a")).rejects.toThrow();
    expect((await adapter.getObjectMetadata("a")).contentLength).toBe(10);
  });
  it("streams ranged objects with an ETag precondition and full metadata", async () => {
    const result = await createS3StorageAdapter(client).getObject("key", {
      start: 2,
      end: 5,
    });
    expect(result.stream).toBeInstanceOf(Readable);
    expect(result.metadata.contentLength).toBe(10);
    const command = send.mock.calls.find(
      ([command]) => command instanceof GetObjectCommand,
    )?.[0];
    expect(command?.input).toMatchObject({
      Range: "bytes=2-5",
      IfMatch: '"etag"',
    });
    result.stream.destroy();
  });
  it.each([
    { start: -1 },
    { start: 10 },
    { start: 5, end: 4 },
    { start: 0, end: 10 },
    { start: 0.5 },
  ])("rejects invalid byte range", async (range) => {
    await expect(
      createS3StorageAdapter(client).getObject("key", range),
    ).rejects.toThrow("range");
  });
  it("distinguishes missing objects from access errors", async () => {
    const adapter = createS3StorageAdapter(client);
    await adapter.getObjectMetadata("key");
    send.mockRejectedValueOnce(
      Object.assign(new Error("missing"), { name: "NoSuchKey" }),
    );
    expect(await adapter.objectExists("missing")).toBe(false);
    send.mockRejectedValueOnce(
      Object.assign(new Error("forbidden"), { name: "AccessDenied" }),
    );
    await expect(adapter.objectExists("private")).rejects.toThrow("forbidden");
  });
  it("detects per-object errors in successful bulk-delete responses", async () => {
    const adapter = createS3StorageAdapter(client);
    await adapter.getObjectMetadata("key");
    send.mockImplementationOnce(async () => ({
      $metadata: {},
      Errors: [{ Key: "key", Code: "AccessDenied" }],
    }));
    await expect(adapter.deleteObjects(["key"])).rejects.toThrow("delete");
  });
  it("batches deletion at the S3 limit", async () => {
    await createS3StorageAdapter(client).deleteObjects(
      Array.from({ length: 1001 }, (_, i) => String(i)),
    );
    const commands = send.mock.calls
      .filter(([c]) => c instanceof DeleteObjectsCommand)
      .map(([c]) => c as DeleteObjectsCommand);
    expect(commands.map((c) => c.input.Delete?.Objects?.length)).toEqual([
      1000, 1,
    ]);
  });
  it("uses public multipart commands with ordered parts", async () => {
    const adapter = createS3StorageAdapter(client);
    expect(await adapter.createMultipartUpload("key", "video/mp4")).toBe(
      "upload",
    );
    expect(
      await adapter.uploadPart("key", "upload", 1, Buffer.from("part")),
    ).toBe('"part"');
    await adapter.completeMultipartUpload("key", "upload", [
      { partNumber: 2, etag: "b" },
      { partNumber: 1, etag: "a" },
    ]);
    const command = send.mock.calls.find(
      ([c]) => c instanceof CompleteMultipartUploadCommand,
    )?.[0] as CompleteMultipartUploadCommand;
    expect(
      command.input.MultipartUpload?.Parts?.map((p) => p.PartNumber),
    ).toEqual([1, 2]);
  });
  it("rejects duplicate, missing, and empty multipart manifests", async () => {
    const adapter = createS3StorageAdapter(client);
    for (const parts of [
      [],
      [{ partNumber: 2, etag: "b" }],
      [
        { partNumber: 1, etag: "a" },
        { partNumber: 1, etag: "b" },
      ],
    ])
      await expect(
        adapter.completeMultipartUpload("key", "upload", parts),
      ).rejects.toThrow("manifest");
    await expect(
      adapter.uploadPart("key", "upload", 0, Buffer.alloc(1)),
    ).rejects.toThrow("part");
  });
});
