import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, open, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Writable, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import type { StorageAdapter } from "@/lib/storage/adapter";

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const driveChecksum = z.string().regex(/^[0-9a-f]{32}$/);
const key = z
  .string()
  .min(1)
  .max(1024)
  .regex(/^[\x21-\x7e]+$/);
const entrySchema = z
  .object({
    mediaId: z.uuid(),
    part: z.enum(["original", "thumbnail", "preview"]),
    key,
    bytes: z.number().int().positive().safe(),
    sha256,
    contentType: z
      .string()
      .max(127)
      .regex(/^[\w.+-]+\/[\w.+-]+$/),
  })
  .strict();
const markerSchema = z
  .object({
    version: z.literal(1),
    snapshotId: z.uuid(),
    ownerId: z.uuid(),
    entries: z.number().int().nonnegative().safe(),
    manifestSha256: sha256,
  })
  .strict();
const maxLine = 4096;

export class BackupError extends Error {}

export type MediaEntry = z.infer<typeof entrySchema>;
export type MediaSnapshot = z.infer<typeof markerSchema>;
export type MediaReference = Pick<MediaEntry, "mediaId" | "part" | "key"> & {
  bytes?: bigint;
  sha256?: string;
};

function blobPath(folder: string, index: number) {
  return join(
    folder,
    "objects",
    String(Math.floor(index / 1000)),
    `${index}.blob`,
  );
}

async function regularFile(path: string) {
  const info = await lstat(path);
  if (!info.isFile()) throw new BackupError("Expected a regular archive file");
  return info;
}

async function directory(path: string) {
  if (!(await lstat(path)).isDirectory())
    throw new BackupError("Expected an archive directory");
}

async function hashBytes(
  source: Readable,
  size: number,
  destination?: Writable,
  expectedDriveChecksum?: string,
) {
  const hash = createHash("sha256");
  const driveHash = expectedDriveChecksum ? createHash("md5") : undefined;
  let bytes = 0;
  const transfer = new AbortController();
  const timeout = setTimeout(() => transfer.abort(), 120000).unref();
  try {
    await pipeline(
      source,
      async function* (chunks: AsyncIterable<Buffer>) {
        for await (const chunk of chunks) {
          timeout.refresh();
          bytes += chunk.length;
          if (bytes > size)
            throw new BackupError("Object exceeds its recorded size");
          hash.update(chunk);
          driveHash?.update(chunk);
          yield chunk;
        }
      },
      destination ??
        new Writable({ write: (_chunk, _encoding, done) => done() }),
      { signal: transfer.signal },
    );
  } catch (error) {
    if (transfer.signal.aborted)
      throw new BackupError("No data moved for two minutes");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  if (bytes !== size) throw new BackupError("Object is shorter than recorded");
  if (driveHash && driveHash.digest("hex") !== expectedDriveChecksum)
    throw new BackupError(
      "Drive object checksum differs from its registered revision",
    );
  return hash.digest("hex");
}

export function matchesReference(reference: MediaReference, entry: MediaEntry) {
  return (
    reference.mediaId === entry.mediaId &&
    reference.part === entry.part &&
    reference.key === entry.key &&
    (reference.bytes === undefined ||
      reference.bytes === BigInt(entry.bytes)) &&
    (reference.sha256 === undefined || reference.sha256 === entry.sha256)
  );
}

export async function exportMedia(
  folder: string,
  ownerId: string,
  references: AsyncIterable<MediaReference>,
  source: Pick<StorageAdapter, "getObject">,
  recheck: (snapshot: MediaSnapshot) => Promise<void>,
) {
  await mkdir(folder, { mode: 0o700 });
  await mkdir(join(folder, "objects"), { mode: 0o700 });
  const manifest = await open(join(folder, "manifest.ndjson"), "wx", 0o600);
  const hash = createHash("sha256");
  let entries = 0;
  try {
    for await (const reference of references) {
      const path = blobPath(folder, entries);
      if (entries % 1000 === 0) await mkdir(dirname(path), { mode: 0o700 });
      const object = await source.getObject(reference.key);
      try {
        const bytes = object.metadata.contentLength;
        const entry = entrySchema.parse({
          mediaId: reference.mediaId,
          part: reference.part,
          key: reference.key,
          bytes,
          contentType: object.metadata.contentType,
          // Validate the metadata before opening a destination.
          sha256: "0".repeat(64),
        });
        if (reference.bytes !== undefined && reference.bytes !== BigInt(bytes))
          throw new BackupError("Storage size differs from the library");
        const registeredChecksum = reference.key.startsWith("drive/")
          ? driveChecksum.parse(object.metadata.etag)
          : undefined;
        entry.sha256 = await hashBytes(
          object.stream,
          bytes,
          createWriteStream(path, { flags: "wx", mode: 0o600, flush: true }),
          registeredChecksum,
        );
        if (!matchesReference(reference, entry))
          throw new BackupError("Storage checksum differs from the library");
        const line = JSON.stringify(entry) + "\n";
        await manifest.writeFile(line);
        hash.update(line);
        entries++;
      } finally {
        object.stream.destroy();
      }
    }
    await manifest.sync();
  } finally {
    await manifest.close();
  }
  const snapshot = markerSchema.parse({
    version: 1,
    snapshotId: randomUUID(),
    ownerId,
    entries,
    manifestSha256: hash.digest("hex"),
  });
  await recheck(snapshot);
  await writeFile(join(folder, "complete.json"), JSON.stringify(snapshot), {
    flag: "wx",
    mode: 0o600,
    flush: true,
  });
  return snapshot;
}

export async function readSnapshot(folder: string) {
  await directory(folder);
  const path = join(folder, "complete.json");
  if ((await regularFile(path)).size > 1024)
    throw new BackupError("Invalid archive completion record");
  return markerSchema.parse(JSON.parse(await readFile(path, "utf8")));
}

export async function* readEntries(folder: string, snapshot: MediaSnapshot) {
  const path = join(folder, "manifest.ndjson");
  await regularFile(path);
  const manifest = createReadStream(path, { highWaterMark: maxLine });
  const hash = createHash("sha256");
  let pending = Buffer.alloc(0);
  let index = 0;
  for await (const chunk of manifest as AsyncIterable<Buffer>) {
    hash.update(chunk);
    pending = Buffer.concat([pending, chunk]);
    let end: number;
    while ((end = pending.indexOf(10)) !== -1) {
      if (end >= maxLine || index >= snapshot.entries)
        throw new BackupError("Invalid manifest size");
      const entry = entrySchema.parse(
        JSON.parse(pending.subarray(0, end).toString("utf8")),
      );
      pending = pending.subarray(end + 1);
      yield { entry, index };
      index++;
    }
    if (pending.length >= maxLine)
      throw new BackupError("Invalid manifest entry size");
  }
  if (
    pending.length ||
    index !== snapshot.entries ||
    hash.digest("hex") !== snapshot.manifestSha256
  )
    throw new BackupError("Manifest integrity check failed");
}

async function readBlob(folder: string, index: number, bytes: number) {
  const path = blobPath(folder, index);
  if (index % 1000 === 0) await directory(dirname(path));
  if ((await regularFile(path)).size !== bytes)
    throw new BackupError("Archive object size check failed");
  return createReadStream(path);
}

export async function verifyMedia(folder: string) {
  const snapshot = await readSnapshot(folder);
  await directory(join(folder, "objects"));
  for await (const { entry, index } of readEntries(folder, snapshot)) {
    if (
      (await hashBytes(
        await readBlob(folder, index, entry.bytes),
        entry.bytes,
      )) !== entry.sha256
    )
      throw new BackupError("Archive object checksum check failed");
  }
  return snapshot;
}

export async function restoreObjects(
  folder: string,
  snapshot: MediaSnapshot,
  target: Pick<StorageAdapter, "healthCheck" | "putObject" | "getObject">,
) {
  if (!(await target.healthCheck()))
    throw new BackupError(
      "Could not create and verify a new private restore bucket",
    );
  for await (const { entry, index } of readEntries(folder, snapshot)) {
    const key = `recovery/${snapshot.snapshotId}/${entry.mediaId}/${entry.part}`;
    const source = await readBlob(folder, index, entry.bytes);
    try {
      await target.putObject(key, source, {
        contentType: entry.contentType,
        contentLength: entry.bytes,
      });
    } finally {
      source.destroy();
    }
    const restored = await target.getObject(key);
    try {
      if (
        restored.metadata.contentLength !== entry.bytes ||
        restored.metadata.contentType !== entry.contentType ||
        (await hashBytes(restored.stream, entry.bytes)) !== entry.sha256
      )
        throw new BackupError("Restored object verification failed");
    } finally {
      restored.stream.destroy();
    }
  }
}
