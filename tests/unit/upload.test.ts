import { describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
vi.mock("@/lib/validation/env", () => ({
  getEnv: () => ({
    ALLOWED_VIDEO_TYPES: "mp4,webm,mkv,mov,avi",
    ALLOWED_IMAGE_TYPES: "jpg,jpeg,png,webp,gif,heic",
    MAX_UPLOAD_SIZE: 1048576,
  }),
}));
import {
  validateUpload,
  validateFileSize,
  validateMagicBytes,
} from "@/lib/media/validator";
import { validatedUploadStream } from "@/lib/media/upload-stream";
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  Buffer.alloc(2048),
]);
async function consume(stream: Readable) {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}
describe("upload validation and bounded streaming", () => {
  it.each([NaN, Infinity, 1.5, -1, 0, 1048577])(
    "rejects invalid size %s",
    (size) => expect(validateFileSize(size).valid).toBe(false),
  );
  it("requires a signature and matching extension and MIME", () => {
    expect(validateUpload("photo.png", "image/png", png.length).valid).toBe(
      false,
    );
    expect(
      validateUpload("photo.jpg", "image/png", png.length, png).valid,
    ).toBe(false);
    expect(
      validateUpload(
        "photo.png",
        "image/png",
        png.length,
        Buffer.from("<html>bad</html>"),
      ).valid,
    ).toBe(false);
  });
  it("distinguishes RIFF media subtypes", () => {
    const webp = Buffer.from("RIFF1234WEBP");
    expect(validateMagicBytes(webp, "image/webp").valid).toBe(true);
    expect(validateMagicBytes(webp, "video/x-msvideo").valid).toBe(false);
    expect(
      validateMagicBytes(Buffer.from("RIFF1234WAVE"), "image/webp").valid,
    ).toBe(false);
  });
  it("distinguishes HEIC from MP4", () => {
    const header = Buffer.from("0000ftypheic0000");
    expect(validateMagicBytes(header, "image/heic").valid).toBe(true);
    expect(validateMagicBytes(header, "video/mp4").valid).toBe(false);
  });
  it("rejects truncated PNG and fake GIF signatures", () => {
    expect(
      validateMagicBytes(
        Buffer.from([137, 80, 78, 71, 0, 0, 0, 0]),
        "image/png",
      ).valid,
    ).toBe(false);
    expect(validateMagicBytes(Buffer.from("GIF8bad!"), "image/gif").valid).toBe(
      false,
    );
  });
  it("preserves every byte across fragmented headers and computes checksum", async () => {
    const source = Readable.from([
      png.subarray(0, 3),
      png.subarray(3, 50),
      png.subarray(50),
    ]);
    const upload = validatedUploadStream(
      source,
      "photo.png",
      "image/png",
      png.length,
      new AbortController().signal,
    );
    expect(await consume(upload.stream)).toEqual(png);
    expect(upload.result()).toEqual({
      bytes: png.length,
      checksum: createHash("sha256").update(png).digest("hex"),
    });
  });
  it.each([png.length - 1, png.length + 1])(
    "rejects false declared length %s",
    async (length) => {
      const upload = validatedUploadStream(
        Readable.from(png),
        "photo.png",
        "image/png",
        length,
        new AbortController().signal,
      );
      await expect(consume(upload.stream)).rejects.toThrow();
      expect(() => upload.result()).toThrow();
    },
  );
  it("rejects unknown content before yielding any bytes", async () => {
    const upload = validatedUploadStream(
      Readable.from(Buffer.alloc(1024)),
      "photo.png",
      "image/png",
      1024,
      new AbortController().signal,
    );
    let bytes = 0;
    await expect(
      (async () => {
        for await (const chunk of upload.stream) bytes += chunk.length;
      })(),
    ).rejects.toThrow("signature");
    expect(bytes).toBe(0);
  });
  it("cancels the source when the request is aborted", async () => {
    const controller = new AbortController();
    const source = new Readable({ read() {} });
    const upload = validatedUploadStream(
      source,
      "photo.png",
      "image/png",
      1024,
      controller.signal,
    );
    const pending = consume(upload.stream);
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(source.destroyed).toBe(true);
  });
});
