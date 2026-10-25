import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hashFile, HASH_CHUNK_SIZE } from "@/client/hash-file";
describe("bounded browser file hashing", () => {
  it("matches SHA-256 across chunk boundaries without reading the full blob", async () => {
    const bytes = Buffer.alloc(HASH_CHUNK_SIZE + 37, 123);
    const file = new Blob([bytes]);
    file.arrayBuffer = () => {
      throw new Error("Full file read forbidden");
    };
    const updates: number[] = [];
    expect(
      await hashFile(file, new AbortController().signal, (p) =>
        updates.push(p),
      ),
    ).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(updates.at(-1)).toBe(100);
  });
  it("stops hashing when paused", async () => {
    const controller = new AbortController();
    await expect(
      hashFile(
        new Blob([Buffer.alloc(HASH_CHUNK_SIZE + 1)]),
        controller.signal,
        () => controller.abort(),
      ),
    ).rejects.toThrow();
  });
});
