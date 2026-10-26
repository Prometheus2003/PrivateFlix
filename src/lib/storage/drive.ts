import "server-only";
import { createHash } from "node:crypto";
import { Readable, addAbortSignal } from "node:stream";
import type { ReadableStream } from "node:stream/web";
import type {
  StorageAdapter,
  ObjectMetadata,
  ByteRange,
  PutObjectOptions,
  PartInfo,
} from "./adapter";
import { DriveClient, DriveError, type DriveFile } from "./drive-client";

export interface DriveObjectRecord {
  fileId: string;
  verifiedMd5: string | null;
  verifiedSize: number | null;
  revisionId: string | null;
}
export interface DriveObjectRegistry {
  find(key: string): Promise<DriveObjectRecord | null>;
  reserve(key: string, candidate: string): Promise<DriveObjectRecord>;
  verify(
    key: string,
    fileId: string,
    md5: string,
    size: number,
    revisionId: string,
  ): Promise<void>;
  stagingRemoved(key: string): Promise<void>;
  pending(): Promise<Array<{ key: string } & DriveObjectRecord>>;
  remove(key: string): Promise<void>;
}
function metadata(file: DriveFile): ObjectMetadata {
  const length = Number(file.size);
  if (!Number.isSafeInteger(length) || length <= 0)
    throw new Error("Invalid Drive object size");
  return {
    contentType: file.mimeType,
    contentLength: length,
    etag: file.md5Checksum,
    lastModified: file.modifiedTime ? new Date(file.modifiedTime) : undefined,
  };
}

/** S3 is temporary upload staging. Completed objects and playback live in Drive.
 * Durable preallocated Drive IDs make retries safe after a lost upload response.
 */
export class DriveStorageAdapter implements StorageAdapter {
  constructor(
    private readonly staging: StorageAdapter,
    private readonly drive: DriveClient,
    private readonly registry: DriveObjectRegistry,
  ) {}
  private async file(key: string) {
    const record = await this.registry.find(key);
    if (
      !record?.verifiedMd5 ||
      record.verifiedSize === null ||
      !record.revisionId
    )
      return null;
    const file = await this.drive.file(record.fileId);
    if (!file) return null;
    this.assertVerified(record, file);
    return { ...file, headRevisionId: record.revisionId };
  }
  private assertVerified(record: DriveObjectRecord, file: DriveFile) {
    if (
      metadata(file).contentLength !== record.verifiedSize ||
      file.md5Checksum !== record.verifiedMd5
    )
      throw new Error("Drive object changed after verification");
  }
  private async discardStaging(key: string) {
    try {
      await this.staging.deleteObject(key);
      await this.registry.stagingRemoved(key);
    } catch {
      // The verified record is durable; bounded maintenance retries this deletion.
      console.error("[STORAGE] Verified upload staging cleanup pending");
    }
  }
  private async promote(key: string): Promise<void> {
    let record = await this.registry.find(key);
    if (!record)
      record = await this.registry.reserve(key, await this.drive.allocateId());
    const id = record.fileId;
    const existing = await this.drive.file(id);
    if (
      existing &&
      record.verifiedMd5 &&
      record.verifiedSize !== null &&
      record.revisionId
    ) {
      this.assertVerified(record, existing);
      await this.discardStaging(key);
      return;
    }
    const object = await this.staging.getObject(key);
    const hash = createHash("md5");
    let bytes = 0;
    const source = object.stream;
    addAbortSignal(AbortSignal.timeout(12 * 60 * 1000), source);
    const checked = Readable.from(
      (async function* () {
        for await (const chunk of source) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bytes += buffer.length;
          if (bytes > object.metadata.contentLength)
            throw new Error("Staged object length mismatch");
          hash.update(buffer);
          yield buffer;
        }
        if (bytes !== object.metadata.contentLength)
          throw new Error("Staged object length mismatch");
      })(),
    );
    try {
      // A lost final response leaves an unverified Drive object. Compare the
      // durable staged bytes before publishing it or deleting the local copy.
      if (existing) {
        for await (const chunk of checked) void chunk;
        const md5 = hash.digest("hex");
        if (
          metadata(existing).contentLength !== bytes ||
          existing.md5Checksum !== md5 ||
          !existing.headRevisionId
        )
          throw new Error("Drive upload verification failed");
        await this.drive.assertPinnedRevision(
          id,
          existing.headRevisionId,
          md5,
          bytes,
        );
        await this.registry.verify(
          key,
          id,
          md5,
          bytes,
          existing.headRevisionId,
        );
        await this.discardStaging(key);
        return;
      }
      const session = await this.drive.beginUpload(
        id,
        object.metadata.contentType,
        object.metadata.contentLength,
      );
      const init: RequestInit & { duplex: "half" } = {
        method: "PUT",
        duplex: "half",
        body: Readable.toWeb(checked) as globalThis.ReadableStream<Uint8Array>,
        headers: {
          "Content-Type": object.metadata.contentType,
          "Content-Length": String(object.metadata.contentLength),
        },
        signal: AbortSignal.timeout(10 * 60 * 1000),
      };
      const response = await this.drive.request(session, init);
      await response.body?.cancel();
      if (!response.ok) throw new DriveError(response.status);
      const final = await this.drive.file(id);
      const md5 = hash.digest("hex");
      if (
        !final ||
        !final.headRevisionId ||
        metadata(final).contentLength !== bytes ||
        final.md5Checksum !== md5
      )
        throw new Error("Drive upload verification failed");
      await this.drive.assertPinnedRevision(
        id,
        final.headRevisionId,
        md5,
        bytes,
      );
      await this.registry.verify(key, id, md5, bytes, final.headRevisionId);
      await this.discardStaging(key);
    } finally {
      checked.destroy();
      source.destroy();
    }
  }
  async putObject(
    key: string,
    body: Readable | Buffer,
    options: PutObjectOptions,
  ) {
    await this.staging.putObject(key, body, options);
    await this.promote(key);
  }
  async getObjectMetadata(key: string) {
    const file = await this.file(key);
    if (!file) throw new Error("Object not found");
    return metadata(file);
  }
  async getObject(key: string, range?: ByteRange) {
    const file = await this.file(key);
    if (!file) throw new Error("Object not found");
    const meta = metadata(file);
    if (
      range &&
      (!Number.isSafeInteger(range.start) ||
        range.start < 0 ||
        range.start >= meta.contentLength ||
        (range.end !== undefined &&
          (!Number.isSafeInteger(range.end) ||
            range.end < range.start ||
            range.end >= meta.contentLength)))
    )
      throw new Error("Invalid byte range");
    const end = range?.end ?? meta.contentLength - 1;
    const response = await this.drive.download(
      file.id,
      file.headRevisionId!,
      range ? `bytes=${range.start}-${range.end ?? ""}` : undefined,
    );
    const expectedLength = range ? end - range.start + 1 : meta.contentLength;
    if (
      response.headers.get("content-length") !== String(expectedLength) ||
      (range &&
        response.headers.get("content-range") !==
          `bytes ${range.start}-${end}/${meta.contentLength}`)
    ) {
      await response.body?.cancel();
      throw new Error("Invalid Drive download range or length");
    }
    return {
      metadata: meta,
      stream: Readable.fromWeb(response.body as ReadableStream<Uint8Array>),
    };
  }
  async objectExists(key: string) {
    return (await this.file(key)) !== null;
  }
  async deleteObject(key: string) {
    const record = await this.registry.find(key);
    if (record) await this.drive.remove(record.fileId);
    await this.staging.deleteObject(key);
    await this.registry.remove(key);
  }
  async deleteObjects(keys: string[]) {
    for (const key of keys) await this.deleteObject(key);
  }
  createMultipartUpload(key: string, contentType: string) {
    return this.staging.createMultipartUpload(key, contentType);
  }
  uploadPart(key: string, uploadId: string, partNumber: number, body: Buffer) {
    return this.staging.uploadPart(key, uploadId, partNumber, body);
  }
  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: PartInfo[],
  ) {
    if (
      !(await this.staging.objectExists(key)) &&
      !(await this.objectExists(key))
    )
      await this.staging.completeMultipartUpload(key, uploadId, parts);
    await this.promote(key);
  }
  async abortMultipartUpload(key: string, uploadId: string) {
    await this.staging.abortMultipartUpload(key, uploadId);
  }
  async healthCheck() {
    try {
      await this.drive.assertPrivateFolder();
      return await this.staging.healthCheck();
    } catch {
      return false;
    }
  }
  async cleanupStaging() {
    let cleaned = 0;
    for (const record of await this.registry.pending()) {
      try {
        const file = await this.drive.file(record.fileId);
        if (!file) continue;
        this.assertVerified(record, file);
        await this.staging.deleteObject(record.key);
        await this.registry.stagingRemoved(record.key);
        cleaned++;
      } catch {
        // A moved/changed Drive file or one failed delete must not prevent
        // reclaiming other verified local copies in the same bounded pass.
        console.error(
          "[STORAGE] Upload staging reconciliation needs attention",
        );
      }
    }
    return cleaned;
  }
}
