import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { PrismaClient } from "@prisma/client";
import { Readable } from "node:stream";
import { afterAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createS3StorageAdapter } from "@/lib/storage/s3";

const enabled = process.env.PRIVATEFLIX_BACKUP_TEST === "1";
const digest = (value: Buffer, algorithm = "sha256") =>
  createHash(algorithm).update(value).digest("hex");
const image = Buffer.alloc(9 * 1024 * 1024, 17);
const video = Buffer.from("synthetic retained Drive video revision");
const thumbnail = Buffer.from("synthetic retained Drive thumbnail revision");
const driveFixtures = {
  "file-video": [video, "video/mp4"],
  "file-thumb": [thumbnail, "image/jpeg"],
} as const;
const restoreBucket = "privateflix-restore-backup-fixture";
const existingBucket = "privateflix-restore-existing-fixture";
let directory = "";

describe.skipIf(!enabled)(
  "media backup and recovery CLI on disposable services",
  () => {
    afterAll(async () => {
      if (
        directory &&
        dirname(directory) === resolve(tmpdir()) &&
        basename(directory).startsWith("privateflix-backup-test-")
      )
        await rm(directory, { recursive: true, force: true });
    });

    it("restores both providers to private S3 and rejects incomplete, corrupt and mismatched backups", async () => {
      const database = new URL(process.env.DATABASE_URL!);
      const pg = process.env.PRIVATEFLIX_BACKUP_TEST_PG!;
      const endpoint = process.env.S3_ENDPOINT!;
      if (
        database.pathname !== "/privateflix_security_test" ||
        database.host !== "127.0.0.1:55434" ||
        !/^privateflix-processing-test-[0-9a-f]{12}-pg$/.test(pg) ||
        endpoint !== "http://127.0.0.1:19000" ||
        process.env.S3_BUCKET !== "privateflix-processing-test"
      )
        throw new Error("Disposable backup test services required");
      const destination = new URL(database);
      destination.pathname = "/privateflix_restore_fixture";
      const source = new PrismaClient({ datasourceUrl: database.href });
      const target = new PrismaClient({ datasourceUrl: destination.href });
      const s3 = new S3Client({
        endpoint,
        forcePathStyle: true,
        region: "us-east-1",
        credentials: {
          accessKeyId: process.env.S3_ACCESS_KEY!,
          secretAccessKey: process.env.S3_SECRET_KEY!,
        },
      });
      directory = await mkdtemp(
        join(resolve(tmpdir()), "privateflix-backup-test-"),
      );
      const archive = join(directory, "snapshot");
      const config = async (name: string, values: Record<string, string>) => {
        const file = join(directory, name + ".env");
        await writeFile(
          file,
          Object.entries(values)
            .map(([k, v]) => k + "=" + v)
            .join("\n"),
          { mode: 0o600 },
        );
        return file;
      };
      const base = {
        APP_URL: "https://privateflix.test",
        S3_ENDPOINT: endpoint,
        S3_ACCESS_KEY: process.env.S3_ACCESS_KEY!,
        S3_SECRET_KEY: process.env.S3_SECRET_KEY!,
        REDIS_URL: process.env.REDIS_URL!,
        SESSION_SECRET: process.env.SESSION_SECRET!,
      };
      const sourceEnv = await config("source", {
        ...base,
        DATABASE_URL: database.href,
        S3_BUCKET: "privateflix-processing-test",
        GOOGLE_DRIVE_CLIENT_ID: "synthetic",
        GOOGLE_DRIVE_CLIENT_SECRET: "synthetic",
        GOOGLE_DRIVE_REFRESH_TOKEN: "synthetic",
        GOOGLE_DRIVE_FOLDER_ID: "fixture-folder",
      });
      const targetEnv = await config("target", {
        ...base,
        DATABASE_URL: destination.href,
        S3_BUCKET: restoreBucket,
      });
      const existingEnv = await config("existing", {
        ...base,
        DATABASE_URL: destination.href,
        S3_BUCKET: existingBucket,
      });
      const preload = join(directory, "drive-fixture.cjs");
      await writeFile(
        preload,
        `
      const fixtures = ${JSON.stringify(
        Object.fromEntries(
          Object.entries(driveFixtures).map(([id, [bytes, type]]) => [
            id,
            { body: bytes.toString("base64"), type, md5: digest(bytes, "md5") },
          ]),
        ),
      )};
      globalThis.fetch = async (url, options) => {
        const target = new URL(url);
        if (target.href === "https://oauth2.googleapis.com/token" && options.method === "POST")
          return Response.json({ access_token: "synthetic", expires_in: 3600 });
        if (options.method && options.method !== "GET")
          throw new Error("Backup tried to write to Drive");
        const match = /^\\/drive\\/v3\\/files\\/(file-video|file-thumb)(\\/revisions\\/retained)?$/.exec(target.pathname);
        if (target.origin !== "https://www.googleapis.com" || !match)
          throw new Error("Unexpected Drive request or revision");
        const fixture = fixtures[match[1]];
        const body = Buffer.from(fixture.body, "base64");
        if (match[2]) {
          if (match[1] === "file-thumb" && process.env.BACKUP_TEST_CORRUPT_DRIVE === "1") body[0] ^= 1;
          return new Response(body, { headers: { "content-length": String(body.length) } });
        }
        return Response.json({
          id: match[1], size: String(body.length), mimeType: fixture.type,
          md5Checksum: fixture.md5, headRevisionId: "new-head", parents: ["fixture-folder"],
        });
      };
    `,
      );
      const cli = (args: string[], success = true, corruptDrive = false) => {
        const result = spawnSync(
          process.execPath,
          ["scripts/run-media-backup.mjs", ...args],
          {
            encoding: "utf8",
            env: {
              ...process.env,
              NODE_OPTIONS: `--require="${preload.replaceAll("\\", "/")}"`,
              BACKUP_TEST_CORRUPT_DRIVE: corruptDrive ? "1" : "0",
            },
            timeout: 30000,
            windowsHide: true,
          },
        );
        expect(result.error).toBeUndefined();
        expect(result.status, result.stdout + result.stderr).toBe(
          success ? 0 : 1,
        );
        return result.stdout + result.stderr;
      };
      const docker = (...args: string[]) =>
        execFileSync(process.env.DOCKER_BIN!, ["exec", pg, ...args], {
          windowsHide: true,
          stdio: "pipe",
        });

      try {
        const owner = await source.user.create({
          data: {
            username: "backup-fixture",
            email: "backup@example.test",
            passwordHash: "synthetic",
          },
        });
        const fields = {
          ownerId: owner.id,
          title: "Synthetic file",
          originalFilename: "fixture",
          uploadedAt: new Date(),
        };
        const local = await source.media.create({
          data: {
            ...fields,
            type: "IMAGE",
            mimeType: "image/png",
            storageKey: "image/synthetic.png",
            fileSize: image.length,
            checksum: digest(image),
            processingStatus: "READY",
          },
        });
        const remote = await source.media.create({
          data: {
            ...fields,
            type: "VIDEO",
            mimeType: "video/mp4",
            storageKey: "drive/video/synthetic.mp4",
            thumbnailStorageKey: "drive/video/synthetic-thumb.jpg",
            fileSize: video.length,
            checksum: digest(video),
            processingStatus: "FAILED",
          },
        });
        const abandoned = await source.media.create({
          data: {
            ...fields,
            uploadedAt: null,
            type: "VIDEO",
            mimeType: "video/mp4",
            storageKey: "drive/video/abandoned",
            thumbnailStorageKey: "drive/video/stale",
            processingStatus: "UPLOADING",
          },
        });
        expect(cli(["export", archive, sourceEnv], false)).toContain(
          "Finish or cancel",
        );
        await source.media.update({
          where: { id: abandoned.id },
          data: { processingStatus: "FAILED" },
        });
        await source.processingJob.create({
          data: { mediaId: abandoned.id, type: "CLEANUP" },
        });
        const abandonedUpload = await source.upload.create({
          data: {
            mediaId: abandoned.id,
            ownerId: owner.id,
            status: "FAILED",
            storageUploadId: "old-multipart-handle",
          },
        });
        await source.favorite.create({
          data: { userId: owner.id, mediaId: local.id },
        });
        await source.session.create({
          data: {
            userId: owner.id,
            tokenHash: digest(Buffer.from("synthetic")),
            expiresAt: new Date(),
          },
        });
        await source.driveObject.createMany({
          data: [
            {
              key: remote.storageKey,
              fileId: "file-video",
              verifiedMd5: digest(video, "md5"),
              verifiedSize: video.length,
              revisionId: "retained",
            },
            {
              key: remote.thumbnailStorageKey!,
              fileId: "file-thumb",
              verifiedMd5: digest(thumbnail, "md5"),
              verifiedSize: thumbnail.length,
              revisionId: "retained",
            },
          ],
        });
        const sourceStorage = createS3StorageAdapter();
        await sourceStorage.putObject(local.storageKey, Readable.from(image), {
          contentType: "image/png",
          contentLength: image.length,
        });
        const incomplete = join(directory, "incomplete");
        expect(cli(["export", incomplete, sourceEnv], false, true)).toContain(
          "Drive object checksum differs",
        );
        expect(cli(["verify", incomplete], false)).toContain(
          "could not verify",
        );
        expect(cli(["export", archive, sourceEnv])).toContain("Exported 3");
        expect(cli(["verify", archive])).toContain("Verified 3");
        expect(cli(["restore", archive, sourceEnv], false)).toContain(
          "requires a dedicated",
        );

        docker(
          "pg_dump",
          "-U",
          "privateflix",
          "-d",
          "privateflix_security_test",
          "-Fc",
          "-f",
          "/tmp/media-fixture.dump",
        );
        docker(
          "pg_restore",
          "-U",
          "privateflix",
          "-d",
          "privateflix_restore_fixture",
          "--single-transaction",
          "/tmp/media-fixture.dump",
        );
        const firstBlob = join(archive, "objects", "0", "0.blob");
        const original = await readFile(firstBlob);
        const modified = Buffer.from(original);
        modified[0] ^= 1;
        await writeFile(firstBlob, modified);
        expect(cli(["restore", archive, targetEnv], false)).toContain(
          "checksum check failed",
        );
        await writeFile(firstBlob, original);
        await target.media.update({
          where: { id: local.id },
          data: { fileSize: image.length + 1 },
        });
        expect(cli(["restore", archive, targetEnv], false)).toContain(
          "inventory differ",
        );
        await expect(
          s3.send(new HeadBucketCommand({ Bucket: restoreBucket })),
        ).rejects.toMatchObject({
          $metadata: { httpStatusCode: 404 },
        });
        await target.media.update({
          where: { id: local.id },
          data: { fileSize: image.length },
        });
        await s3.send(new CreateBucketCommand({ Bucket: existingBucket }));
        expect(cli(["restore", archive, existingEnv], false)).toContain(
          "new private restore bucket",
        );

        expect(cli(["restore", archive, targetEnv])).toContain(
          "Restored and verified 3",
        );
        expect(await target.session.count()).toBe(0);
        expect(await target.driveObject.count()).toBe(0);
        expect(await target.processingJob.count()).toBe(0);
        expect(await target.favorite.count()).toBe(1);
        const restoredUpload = await target.upload.findUniqueOrThrow({
          where: { id: abandonedUpload.id },
        });
        expect(restoredUpload.status).toBe("FAILED");
        expect(restoredUpload.storageUploadId).toBeNull();
        expect(await source.driveObject.count()).toBe(2);
        expect(await source.session.count()).toBe(1);
        const localRestored = await target.media.findUniqueOrThrow({
          where: { id: local.id },
        });
        const remoteRestored = await target.media.findUniqueOrThrow({
          where: { id: remote.id },
        });
        const abandonedRestored = await target.media.findUniqueOrThrow({
          where: { id: abandoned.id },
        });
        expect(abandonedRestored.thumbnailStorageKey).toBeNull();
        expect(remoteRestored.processingStatus).toBe("FAILED");
        for (const [key, expected] of [
          [localRestored.storageKey, image],
          [remoteRestored.storageKey, video],
          [remoteRestored.thumbnailStorageKey!, thumbnail],
        ] as const) {
          expect(key).toMatch(/^recovery\//);
          const object = await s3.send(
            new GetObjectCommand({ Bucket: restoreBucket, Key: key }),
          );
          expect(
            digest(Buffer.from(await object.Body!.transformToByteArray())),
          ).toBe(digest(expected));
          expect(
            (await fetch(`${endpoint}/${restoreBucket}/${key}`)).status,
          ).toBe(403);
        }
        const stillLocal = await source.media.findUniqueOrThrow({
          where: { id: local.id },
        });
        expect(stillLocal.storageKey).toBe(local.storageKey);
      } finally {
        s3.destroy();
        await Promise.all([source.$disconnect(), target.$disconnect()]);
      }
    }, 120000);
  },
);
