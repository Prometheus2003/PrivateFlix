import { sha256 } from "@noble/hashes/sha2.js";
export const HASH_CHUNK_SIZE = 8 * 1024 * 1024;
export const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
export async function hashFile(
  file: Blob,
  signal: AbortSignal,
  progress: (percent: number) => void,
) {
  const hash = sha256.create();
  try {
    for (let offset = 0; offset < file.size; offset += HASH_CHUNK_SIZE) {
      signal.throwIfAborted();
      hash.update(
        new Uint8Array(
          await file.slice(offset, offset + HASH_CHUNK_SIZE).arrayBuffer(),
        ),
      );
      progress(
        Math.min(
          100,
          Math.round(((offset + HASH_CHUNK_SIZE) / file.size) * 100),
        ),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    signal.throwIfAborted();
    return hex(hash.digest());
  } finally {
    hash.destroy();
  }
}
export function hashPart(bytes: Uint8Array) {
  return hex(sha256(bytes));
}
