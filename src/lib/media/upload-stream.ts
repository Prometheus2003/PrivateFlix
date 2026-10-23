import { createHash } from "node:crypto";
import { Readable, addAbortSignal } from "node:stream";
import { validateUpload } from "./validator";
export class UploadValidationError extends Error {}
export function validatedUploadStream(
  source: Readable,
  filename: string,
  mime: string,
  expected: number,
  signal: AbortSignal,
) {
  const hash = createHash("sha256");
  let bytes = 0,
    prefix = Buffer.alloc(0),
    verified = false,
    complete = false;
  source.on("error", () => {}); // The consumer still receives the error; also cover pre-consumption cancellation.
  addAbortSignal(signal, source);
  const stream = Readable.from(
    (async function* () {
      try {
        for await (const value of source) {
          const chunk = Buffer.isBuffer(value)
            ? value
            : Buffer.from(value as Uint8Array);
          bytes += chunk.length;
          if (bytes > expected)
            throw new UploadValidationError("Upload exceeds its declared size");
          hash.update(chunk);
          if (!verified) {
            const take = Math.min(512 - prefix.length, chunk.length);
            prefix = Buffer.concat([prefix, chunk.subarray(0, take)]);
            if (prefix.length === 512 || bytes === expected) {
              const checked = validateUpload(filename, mime, expected, prefix);
              if (!checked.valid)
                throw new UploadValidationError(
                  checked.error ?? "Invalid media",
                );
              verified = true;
              yield prefix;
              prefix = Buffer.alloc(0);
              if (take < chunk.length) yield chunk.subarray(take);
            }
          } else yield chunk;
        }
        if (bytes !== expected || !verified)
          throw new UploadValidationError(
            "Upload ended before its declared size",
          );
        complete = true;
      } finally {
        source.destroy();
      }
    })(),
  );
  stream.on("error", () => {});
  addAbortSignal(signal, stream);
  return {
    stream,
    result: () => {
      if (!complete) throw new UploadValidationError("Upload did not finish");
      return { bytes, checksum: hash.digest("hex") };
    },
  };
}
