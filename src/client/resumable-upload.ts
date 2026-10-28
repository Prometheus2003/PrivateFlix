import { z } from "zod";
import { ownerApi, ownerJson } from "./api";
import { hashFile, hashPart } from "./hash-file";
export const uploadMimeTypes: Record<string, string> = {
  mp4: "video/mp4",
  webm: "video/webm",
  mkv: "video/x-matroska",
  mov: "video/quicktime",
  avi: "video/x-msvideo",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  heic: "image/heic",
};
export interface ResumableUpload {
  id: string;
  totalBytes: number;
  bytesUploaded: number;
  expectedChecksum: string;
  completionStarted: boolean;
  media: { originalFilename: string; mimeType: string };
}
export class DuplicateUploadError extends Error {}
export function validateUploadFile(file: File, maxBytes: number) {
  if (!file.size || file.size > maxBytes)
    throw new Error(
      `File size must be between 1 byte and ${(maxBytes / 1024 ** 3).toFixed(1)} GiB.`,
    );
  if (!uploadMimeTypes[file.name.split(".").pop()?.toLowerCase() ?? ""])
    throw new Error("This file format is not supported.");
}
export async function uploadResumable(
  file: File,
  options: {
    signal: AbortSignal;
    resume?: ResumableUpload | null;
    checkDuplicates?: boolean;
    allowDuplicate?: boolean;
    onStarted?: (upload: ResumableUpload) => void;
    onProgress: (stage: string, percent: number, uploadedBytes: number) => void;
  },
) {
  const { signal, onProgress } = options;
  const request = (path: string, init: RequestInit = {}, timeout = 60000) =>
    ownerApi(path, {
      ...init,
      signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]),
    });
  const mime = uploadMimeTypes[file.name.split(".").pop()?.toLowerCase() ?? ""];
  if (!mime || !file.size)
    throw new Error("Choose a supported nonempty photo or video.");
  onProgress("Checking your file", 0, 0);
  const checksum = await hashFile(file, signal, (percent) =>
    onProgress("Checking your file", percent, 0),
  );
  let resume = options.resume;
  if (
    resume &&
    (resume.totalBytes !== file.size || resume.expectedChecksum !== checksum)
  )
    throw new Error(
      "This file does not match the paused upload. Select the original file.",
    );
  if (!resume && options.checkDuplicates) {
    const pending = z
      .object({
        uploads: z.array(
          z.object({
            id: z.string().uuid(),
            totalBytes: z.number(),
            bytesUploaded: z.number(),
            expectedChecksum: z.string(),
            completionStarted: z.boolean(),
            media: z.object({
              originalFilename: z.string(),
              mimeType: z.string(),
            }),
          }),
        ),
      })
      .parse(await request("/api/media/uploads"));
    const matches = pending.uploads.filter(
      (item) =>
        item.expectedChecksum === checksum &&
        item.totalBytes === file.size &&
        item.media.originalFilename === file.name,
    );
    if (matches.length > 1)
      throw new Error(
        "Multiple matching paused uploads exist. Choose one in In progress below.",
      );
    resume = matches[0];
    if (!resume && !options.allowDuplicate) {
      const check = z
        .object({ duplicate: z.boolean() })
        .parse(
          await request(
            "/api/media/duplicates",
            ownerJson("POST", { checksum, totalBytes: file.size }),
          ),
        );
      if (check.duplicate)
        throw new DuplicateUploadError(
          "An identical original already exists in your library.",
        );
    }
  }
  const started = resume
    ? { uploadId: resume.id, partSize: 8 * 1024 * 1024 }
    : z
        .object({
          uploadId: z.string().uuid(),
          partSize: z.literal(8 * 1024 * 1024),
        })
        .parse(
          await request(
            "/api/media/upload/start",
            ownerJson("POST", {
              filename: file.name,
              mime,
              totalBytes: file.size,
              checksum,
            }),
          ),
        );
  options.onStarted?.({
    id: started.uploadId,
    totalBytes: file.size,
    bytesUploaded: resume?.bytesUploaded ?? 0,
    expectedChecksum: checksum,
    completionStarted: resume?.completionStarted ?? false,
    media: { originalFilename: file.name, mimeType: mime },
  });
  const base = `/api/media/upload/${started.uploadId}`,
    receipts = new Map<number, string>();
  for (let page = 1; page <= 100; page++) {
    const saved = z
      .object({
        upload: z.object({
          parts: z.array(
            z.object({ partNumber: z.number().int(), checksum: z.string() }),
          ),
        }),
        hasMore: z.boolean(),
      })
      .parse(await request(`${base}?page=${page}`));
    saved.upload.parts.forEach((part) =>
      receipts.set(part.partNumber, part.checksum),
    );
    if (!saved.hasMore) break;
    if (page === 100) throw new Error("Saved upload has too many parts.");
  }
  onProgress("Uploading securely", 0, 0);
  for (
    let offset = 0, part = 1;
    offset < file.size;
    offset += started.partSize, part++
  ) {
    signal.throwIfAborted();
    const bytes = new Uint8Array(
        await file.slice(offset, offset + started.partSize).arrayBuffer(),
      ),
      digest = hashPart(bytes);
    if (receipts.has(part) && receipts.get(part) !== digest)
      throw new Error("The saved upload does not match this file.");
    if (!receipts.has(part))
      await request(
        `${base}/parts/${part}`,
        {
          method: "PUT",
          body: bytes,
          headers: {
            "Content-Type": "application/octet-stream",
            "X-Part-Sha256": digest,
          },
        },
        120000,
      );
    const uploaded = Math.min(file.size, offset + bytes.length);
    onProgress(
      "Uploading securely",
      Math.round((uploaded / file.size) * 100),
      uploaded,
    );
  }
  onProgress("Verifying upload", 100, file.size);
  await request(`${base}/complete`, { method: "POST" }, 10 * 60 * 1000);
}
