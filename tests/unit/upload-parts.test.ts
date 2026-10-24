import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/validation/env", () => ({
  getEnv: () => ({
    MAX_UPLOAD_SIZE: 10 * 1024 ** 3,
    ALLOWED_IMAGE_TYPES: "png,jpg",
    ALLOWED_VIDEO_TYPES: "mp4",
  }),
}));
import {
  readUploadPart,
  uploadPartLength,
  UPLOAD_PART_SIZE,
} from "@/lib/media/upload-parts";

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
function body(chunks: Uint8Array[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}
function input(bytes = png) {
  return {
    totalBytes: bytes.length,
    partNumber: 1,
    checksum: createHash("sha256").update(bytes).digest("hex"),
    filename: "photo.png",
    mime: "image/png",
  };
}
describe("resumable upload chunk boundaries and integrity", () => {
  it("handles exact multiples and the last partial chunk without overlap", () => {
    expect(uploadPartLength(UPLOAD_PART_SIZE * 2, 2)).toBe(UPLOAD_PART_SIZE);
    expect(uploadPartLength(UPLOAD_PART_SIZE * 2 + 7, 3)).toBe(7);
    expect(uploadPartLength(10 * 1024 ** 3, 1280)).toBe(UPLOAD_PART_SIZE);
  });
  it.each([0, -1, 1.5, NaN, Infinity, 10001])(
    "rejects part number %s",
    (part) => {
      expect(() => uploadPartLength(100, part)).toThrow();
    },
  );
  it.each([0, -1, 1.5, NaN, Infinity, 10 * 1024 ** 3 + 1])(
    "rejects total size %s",
    (size) => {
      expect(() => uploadPartLength(size, 1)).toThrow();
    },
  );
  it("rejects a part beyond the end", () => {
    expect(() => uploadPartLength(UPLOAD_PART_SIZE, 2)).toThrow();
  });
  it("reassembles fragmented content and verifies its checksum", async () => {
    const result = await readUploadPart(
      body([png.subarray(0, 3), png.subarray(3)]),
      input(),
      new AbortController().signal,
    );
    expect(result.body).toEqual(png);
    expect(result.checksum).toBe(input().checksum);
  });
  it.each([7, 9])("rejects false part length %s", async (length) => {
    await expect(
      readUploadPart(
        body([Buffer.alloc(length)]),
        input(),
        new AbortController().signal,
      ),
    ).rejects.toThrow(/size/);
  });
  it("rejects changed content even if length and signature match", async () => {
    await expect(
      readUploadPart(
        body([png]),
        { ...input(), checksum: "0".repeat(64) },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/checksum/);
  });
  it("rejects forged first-part signatures", async () => {
    const fake = Buffer.alloc(8);
    await expect(
      readUploadPart(body([fake]), input(fake), new AbortController().signal),
    ).rejects.toThrow(/signature/);
  });
  it("accepts arbitrary tail bytes without treating them as a file header", async () => {
    const tail = Buffer.from("tail");
    const result = await readUploadPart(
      body([tail]),
      {
        ...input(tail),
        totalBytes: UPLOAD_PART_SIZE + tail.length,
        partNumber: 2,
      },
      new AbortController().signal,
    );
    expect(result.body).toEqual(tail);
  });
  it("cancels a stalled body when the deadline expires", async () => {
    const cancel = vi.fn();
    const controller = new AbortController();
    const promise = readUploadPart(
      new ReadableStream({ cancel }),
      input(),
      controller.signal,
    );
    controller.abort();
    await expect(promise).rejects.toThrow();
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("rejects an already aborted request without reading bytes", async () => {
    await expect(
      readUploadPart(body([png]), input(), AbortSignal.abort()),
    ).rejects.toThrow();
  });
});
