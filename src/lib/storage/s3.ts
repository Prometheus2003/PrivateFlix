/**
 * MinIO/S3-compatible storage adapter implementation.
 *
 * @module lib/storage/s3
 * @security
 *   - Connects to private MinIO bucket — NO anonymous/public access
 *   - NEVER creates presigned URLs for media objects
 *   - All operations use server-side credentials (never client-visible)
 *   - Streams objects without loading full files into memory
 */
import { Client as MinioClient } from "minio";
import { Readable } from "node:stream";
import type {
  StorageAdapter,
  ByteRange,
  ObjectMetadata,
  PutObjectOptions,
  PartInfo,
  GetObjectResult,
} from "./adapter";

// ─── Configuration ──────────────────────────────────────────

interface S3Config {
  endpoint: string;
  port: number;
  useSSL: boolean;
  accessKey: string;
  secretKey: string;
  bucket: string;
  region: string;
}

function parseS3Config(): S3Config {
  const endpoint = process.env.S3_ENDPOINT ?? "http://localhost:9000";
  const url = new URL(endpoint);

  return {
    endpoint: url.hostname,
    port: url.port ? parseInt(url.port, 10) : url.protocol === "https:" ? 443 : 9000,
    useSSL: url.protocol === "https:",
    accessKey: process.env.S3_ACCESS_KEY ?? "minioadmin",
    secretKey: process.env.S3_SECRET_KEY ?? "minioadmin",
    bucket: process.env.S3_BUCKET ?? "privateflix-media",
    region: process.env.S3_REGION ?? "us-east-1",
  };
}

// ─── Singleton Client ───────────────────────────────────────

let client: MinioClient | null = null;
let config: S3Config | null = null;

function getClient(): MinioClient {
  if (!client) {
    config = parseS3Config();
    client = new MinioClient({
      endPoint: config.endpoint,
      port: config.port,
      useSSL: config.useSSL,
      accessKey: config.accessKey,
      secretKey: config.secretKey,
      region: config.region,
    });
  }
  return client;
}

function getBucket(): string {
  if (!config) {
    config = parseS3Config();
  }
  return config.bucket;
}

// ─── Implementation ─────────────────────────────────────────

/**
 * Ensure the private bucket exists. Creates it if missing.
 * Sets the bucket policy to DENY all public access.
 *
 * @security This must run at startup before any uploads.
 */
async function ensureBucket(): Promise<void> {
  const mc = getClient();
  const bucket = getBucket();

  const exists = await mc.bucketExists(bucket);
  if (!exists) {
    await mc.makeBucket(bucket, config?.region ?? "us-east-1");
    console.log(`[STORAGE] Created private bucket: ${bucket}`);
  }

  // Set private-only policy (deny anonymous access)
  const privatePolicy = JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "DenyPublicAccess",
        Effect: "Deny",
        Principal: "*",
        Action: ["s3:GetObject"],
        Resource: [`arn:aws:s3:::${bucket}/*`],
        Condition: {
          StringNotEquals: {
            "aws:PrincipalType": "IAMUser",
          },
        },
      },
    ],
  });

  try {
    await mc.setBucketPolicy(bucket, privatePolicy);
  } catch {
    // Some S3-compatible stores may not support bucket policies
    // MinIO supports them, but we log and continue if it fails
    console.warn("[STORAGE] Could not set bucket policy (may not be supported by backend)");
  }
}

// ─── StorageAdapter Implementation ──────────────────────────

export function createS3StorageAdapter(): StorageAdapter {
  // Ensure bucket exists on first use
  let bucketReady = false;
  const ensureReady = async () => {
    if (!bucketReady) {
      await ensureBucket();
      bucketReady = true;
    }
  };

  return {
    async putObject(
      key: string,
      body: Readable | Buffer,
      options: PutObjectOptions
    ): Promise<void> {
      await ensureReady();
      const mc = getClient();
      const bucket = getBucket();

      const metaHeaders: Record<string, string> = {
        "Content-Type": options.contentType,
        ...(options.metadata ?? {}),
      };

      if (body instanceof Buffer) {
        await mc.putObject(bucket, key, body, body.length, metaHeaders);
      } else {
        await mc.putObject(
          bucket,
          key,
          body,
          options.contentLength ?? undefined,
          metaHeaders
        );
      }
    },

    async getObject(key: string, range?: ByteRange): Promise<GetObjectResult> {
      await ensureReady();
      const mc = getClient();
      const bucket = getBucket();

      // Get metadata first
      const stat = await mc.statObject(bucket, key);
      const metadata: ObjectMetadata = {
        contentType: stat.metaData?.["content-type"] ?? "application/octet-stream",
        contentLength: stat.size,
        etag: stat.etag,
        lastModified: stat.lastModified,
      };

      let stream: Readable;
      if (range) {
        const length = range.end !== undefined
          ? range.end - range.start + 1
          : undefined;
        stream = await mc.getPartialObject(bucket, key, range.start, length);
      } else {
        stream = await mc.getObject(bucket, key);
      }

      return { stream, metadata };
    },

    async getObjectMetadata(key: string): Promise<ObjectMetadata> {
      await ensureReady();
      const mc = getClient();
      const bucket = getBucket();

      const stat = await mc.statObject(bucket, key);
      return {
        contentType: stat.metaData?.["content-type"] ?? "application/octet-stream",
        contentLength: stat.size,
        etag: stat.etag,
        lastModified: stat.lastModified,
      };
    },

    async deleteObject(key: string): Promise<void> {
      await ensureReady();
      const mc = getClient();
      const bucket = getBucket();

      await mc.removeObject(bucket, key);
    },

    async deleteObjects(keys: string[]): Promise<void> {
      await ensureReady();
      const mc = getClient();
      const bucket = getBucket();

      if (keys.length === 0) return;
      await mc.removeObjects(bucket, keys);
    },

    async objectExists(key: string): Promise<boolean> {
      await ensureReady();
      const mc = getClient();
      const bucket = getBucket();

      try {
        await mc.statObject(bucket, key);
        return true;
      } catch {
        return false;
      }
    },

    // ─── Multipart Upload ──────────────────────────────────

    async createMultipartUpload(
      key: string,
      contentType: string
    ): Promise<string> {
      await ensureReady();
      const mc = getClient();
      const bucket = getBucket();

      // MinIO's JS client doesn't expose initiateNewMultipartUpload directly
      // in the public API. We use the internal method available in the client.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const uploadId = await (mc as any).initiateNewMultipartUpload(
        bucket,
        key,
        { "Content-Type": contentType }
      );

      return uploadId as string;
    },

    async uploadPart(
      key: string,
      uploadId: string,
      partNumber: number,
      body: Buffer
    ): Promise<string> {
      await ensureReady();
      const mc = getClient();
      const bucket = getBucket();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await (mc as any).uploadPart(
        { bucketName: bucket, objectName: key, uploadID: uploadId },
        partNumber,
        body,
        body.length,
        ""
      );

      return result?.etag ?? "";
    },

    async completeMultipartUpload(
      key: string,
      uploadId: string,
      parts: PartInfo[]
    ): Promise<void> {
      await ensureReady();
      const mc = getClient();
      const bucket = getBucket();

      const etags = parts.map((p) => ({
        part: p.partNumber,
        etag: p.etag,
      }));

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (mc as any).completeMultipartUpload(
        bucket,
        key,
        uploadId,
        etags
      );
    },

    async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
      await ensureReady();
      const mc = getClient();
      const bucket = getBucket();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (mc as any).abortMultipartUpload(bucket, key, uploadId);
    },

    // ─── Health Check ──────────────────────────────────────

    async healthCheck(): Promise<boolean> {
      try {
        const mc = getClient();
        const bucket = getBucket();
        return await mc.bucketExists(bucket);
      } catch {
        return false;
      }
    },
  };
}
