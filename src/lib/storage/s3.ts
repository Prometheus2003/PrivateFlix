import { isDeepStrictEqual } from "node:util";
import "server-only";
import {
  S3Client,
  HeadBucketCommand,
  CreateBucketCommand,
  PutBucketPolicyCommand,
  GetBucketPolicyCommand,
  HeadObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  type BucketLocationConstraint,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { Readable } from "node:stream";
import { getEnv } from "@/lib/validation/env";
import type { StorageAdapter, ObjectMetadata } from "./adapter";

function missing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (("name" in error &&
      ["NotFound", "NoSuchKey", "NoSuchBucket"].includes(String(error.name))) ||
      ("$metadata" in error &&
        typeof error.$metadata === "object" &&
        error.$metadata !== null &&
        "httpStatusCode" in error.$metadata &&
        error.$metadata.httpStatusCode === 404))
  );
}
export function privateBucketPolicy(bucket: string) {
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "DenyAnonymousAccess",
        Effect: "Deny",
        Principal: { AWS: ["*"] },
        Action: ["s3:*"],
        Resource: ["arn:aws:s3:::" + bucket, "arn:aws:s3:::" + bucket + "/*"],
        Condition: { StringEquals: { "aws:principaltype": ["Anonymous"] } },
      },
    ],
  };
}
// Resource arrays are unordered sets in bucket policies. MinIO can serialize
// its internal set in a different order on each read. Preserve every other
// field so additional grants, resources, and changed conditions still fail closed.
function normalizePolicyResources(policy: unknown): unknown {
  if (
    typeof policy !== "object" ||
    policy === null ||
    !("Statement" in policy) ||
    !Array.isArray(policy.Statement)
  )
    return policy;
  return {
    ...policy,
    Statement: policy.Statement.map((statement: unknown) => {
      if (
        typeof statement !== "object" ||
        statement === null ||
        !("Resource" in statement) ||
        !Array.isArray(statement.Resource) ||
        !statement.Resource.every((value: unknown) => typeof value === "string")
      )
        return statement;
      return { ...statement, Resource: [...statement.Resource].sort() };
    }),
  };
}
function metadata(result: {
  ContentType?: string;
  ContentLength?: number;
  ETag?: string;
  LastModified?: Date;
}): ObjectMetadata {
  if (!Number.isSafeInteger(result.ContentLength) || result.ContentLength! < 0)
    throw new Error("Storage returned invalid object length");
  return {
    contentType: result.ContentType ?? "application/octet-stream",
    contentLength: result.ContentLength!,
    etag: result.ETag,
    lastModified: result.LastModified,
  };
}

// A supplied client is useful for transport contract tests; production always uses
// server-only credentials and path-style S3 requests compatible with MinIO.
export function createS3StorageAdapter(
  suppliedClient?: S3Client,
): StorageAdapter {
  let client: S3Client | undefined = suppliedClient;
  function getClient() {
    if (!client) {
      const env = getEnv();
      client = new S3Client({
        endpoint: env.S3_ENDPOINT,
        region: env.S3_REGION,
        forcePathStyle: true,
        credentials: {
          accessKeyId: env.S3_ACCESS_KEY,
          secretAccessKey: env.S3_SECRET_KEY,
        },
        requestChecksumCalculation: "WHEN_REQUIRED",
        responseChecksumValidation: "WHEN_REQUIRED",
        maxAttempts: 3,
        requestHandler: { connectionTimeout: 5000, requestTimeout: 60000 },
      });
    }
    return client;
  }
  const bucket = () => getEnv().S3_BUCKET;
  let readiness: Promise<void> | undefined;
  async function initialize() {
    const c = getClient();
    const Bucket = bucket();
    try {
      await c.send(new HeadBucketCommand({ Bucket }));
    } catch (error) {
      if (!missing(error)) throw error;
      const region = getEnv().S3_REGION;
      try {
        await c.send(
          new CreateBucketCommand({
            Bucket,
            ...(region === "us-east-1"
              ? {}
              : {
                  CreateBucketConfiguration: {
                    LocationConstraint: region as BucketLocationConstraint,
                  },
                }),
          }),
        );
      } catch (creationError) {
        if (
          !(creationError instanceof Error) ||
          creationError.name !== "BucketAlreadyOwnedByYou"
        )
          throw creationError;
      }
    }
    const policy = privateBucketPolicy(Bucket);
    // Never continue after a policy failure. Replace any legacy public grants.
    await c.send(
      new PutBucketPolicyCommand({ Bucket, Policy: JSON.stringify(policy) }),
    );
    const verified = await c.send(new GetBucketPolicyCommand({ Bucket }));
    if (
      !verified.Policy ||
      !isDeepStrictEqual(
        normalizePolicyResources(JSON.parse(verified.Policy)),
        normalizePolicyResources(policy),
      )
    )
      throw new Error("Private bucket policy verification failed");
  }
  function ready() {
    readiness ??= initialize().catch((error) => {
      readiness = undefined;
      throw error;
    });
    return readiness;
  }
  async function head(key: string) {
    await ready();
    return getClient().send(
      new HeadObjectCommand({ Bucket: bucket(), Key: key }),
    );
  }
  return {
    async putObject(key, body, options) {
      await ready();
      const upload = new Upload({
        client: getClient(),
        queueSize: 2,
        partSize: 8 * 1024 * 1024,
        leavePartsOnError: false,
        params: {
          Bucket: bucket(),
          Key: key,
          Body: body,
          ContentType: options.contentType,
          ContentLength: Buffer.isBuffer(body)
            ? body.length
            : options.contentLength,
          Metadata: options.metadata,
        },
      });
      await upload.done();
    },
    async getObject(key, range) {
      const stat = await head(key);
      const info = metadata(stat);
      if (!stat.ETag) throw new Error("Storage returned no object ETag");
      if (
        range &&
        (!Number.isSafeInteger(range.start) ||
          range.start < 0 ||
          range.start >= info.contentLength ||
          (range.end !== undefined &&
            (!Number.isSafeInteger(range.end) ||
              range.end < range.start ||
              range.end >= info.contentLength)))
      )
        throw new Error("Invalid object range");
      const result = await getClient().send(
        new GetObjectCommand({
          Bucket: bucket(),
          Key: key,
          IfMatch: stat.ETag,
          ...(range
            ? { Range: "bytes=" + range.start + "-" + (range.end ?? "") }
            : {}),
        }),
      );
      if (!(result.Body instanceof Readable))
        throw new Error("Storage did not return a Node stream");
      return { stream: result.Body, metadata: info };
    },
    async getObjectMetadata(key) {
      return metadata(await head(key));
    },
    async deleteObject(key) {
      await ready();
      await getClient().send(
        new DeleteObjectCommand({ Bucket: bucket(), Key: key }),
      );
    },
    async deleteObjects(keys) {
      if (!keys.length) return;
      await ready();
      for (let offset = 0; offset < keys.length; offset += 1000) {
        const result = await getClient().send(
          new DeleteObjectsCommand({
            Bucket: bucket(),
            Delete: {
              Objects: keys
                .slice(offset, offset + 1000)
                .map((Key) => ({ Key })),
              Quiet: true,
            },
          }),
        );
        if (result.Errors?.length)
          throw new Error("Storage failed to delete one or more objects");
      }
    },
    async objectExists(key) {
      await ready(); // Initialization failures must never masquerade as missing objects.
      try {
        await head(key);
        return true;
      } catch (error) {
        if (missing(error)) return false;
        throw error;
      }
    },
    async createMultipartUpload(key, contentType) {
      await ready();
      const result = await getClient().send(
        new CreateMultipartUploadCommand({
          Bucket: bucket(),
          Key: key,
          ContentType: contentType,
        }),
      );
      if (!result.UploadId)
        throw new Error("Storage did not return an upload ID");
      return result.UploadId;
    },
    async uploadPart(key, uploadId, partNumber, body) {
      if (
        !Number.isInteger(partNumber) ||
        partNumber < 1 ||
        partNumber > 10000 ||
        body.length > 64 * 1024 * 1024
      )
        throw new Error("Invalid upload part");
      await ready();
      const result = await getClient().send(
        new UploadPartCommand({
          Bucket: bucket(),
          Key: key,
          UploadId: uploadId,
          PartNumber: partNumber,
          Body: body,
          ContentLength: body.length,
        }),
      );
      if (!result.ETag) throw new Error("Storage did not return a part ETag");
      return result.ETag;
    },
    async completeMultipartUpload(key, uploadId, parts) {
      const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);
      if (
        !sorted.length ||
        sorted.length > 10000 ||
        sorted.some(
          (part, index) => part.partNumber !== index + 1 || !part.etag,
        )
      )
        throw new Error("Invalid upload manifest");
      await ready();
      await getClient().send(
        new CompleteMultipartUploadCommand({
          Bucket: bucket(),
          Key: key,
          UploadId: uploadId,
          MultipartUpload: {
            Parts: sorted.map((part) => ({
              PartNumber: part.partNumber,
              ETag: part.etag,
            })),
          },
        }),
      );
    },
    async abortMultipartUpload(key, uploadId) {
      await ready();
      await getClient().send(
        new AbortMultipartUploadCommand({
          Bucket: bucket(),
          Key: key,
          UploadId: uploadId,
        }),
      );
    },
    async healthCheck() {
      try {
        await ready();
        await getClient().send(new HeadBucketCommand({ Bucket: bucket() }));
        return true;
      } catch {
        return false;
      }
    },
  };
}
