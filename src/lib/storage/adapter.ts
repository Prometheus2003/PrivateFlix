/**
 * Storage adapter interface — the abstraction layer between PrivateFlix and
 * any S3-compatible object store.
 *
 * @module lib/storage/adapter
 * @security
 *   - NEVER expose storage keys, bucket names, or credentials to the client
 *   - All objects are stored in a PRIVATE bucket — no public access
 *   - Keys are opaque server-generated values (never user filenames)
 */
import type { Readable } from "node:stream";

// ─── Types ──────────────────────────────────────────────────

export interface ByteRange {
  start: number;
  end?: number;
}

export interface ObjectMetadata {
  contentType: string;
  contentLength: number;
  etag?: string;
  lastModified?: Date;
}

export interface PutObjectOptions {
  contentType: string;
  contentLength?: number;
  /** Additional metadata headers */
  metadata?: Record<string, string>;
}

export interface PartInfo {
  partNumber: number;
  etag: string;
}

export interface GetObjectResult {
  stream: Readable;
  metadata: ObjectMetadata;
}

// ─── Interface ──────────────────────────────────────────────

/**
 * Storage adapter interface.
 * Implementations must handle all object operations without exposing
 * internal details to callers (which may be API route handlers).
 */
export interface StorageAdapter {
  /**
   * Upload an object from a readable stream.
   * For small files (< ~100MB), use this method.
   */
  putObject(
    key: string,
    body: Readable | Buffer,
    options: PutObjectOptions
  ): Promise<void>;

  /**
   * Get an object as a readable stream, optionally with byte-range.
   * Used for streaming media to authenticated clients.
   */
  getObject(key: string, range?: ByteRange): Promise<GetObjectResult>;

  /**
   * Get metadata for an object without fetching the body.
   */
  getObjectMetadata(key: string): Promise<ObjectMetadata>;

  /**
   * Delete a single object.
   */
  deleteObject(key: string): Promise<void>;

  /**
   * Delete multiple objects in a single operation.
   */
  deleteObjects(keys: string[]): Promise<void>;

  /**
   * Check if an object exists.
   */
  objectExists(key: string): Promise<boolean>;

  // ─── Multipart Upload ──────────────────────────────────

  /**
   * Initiate a multipart upload for large files.
   * Returns an upload ID to be used with uploadPart/completeMultipartUpload.
   */
  createMultipartUpload(
    key: string,
    contentType: string
  ): Promise<string>;

  /**
   * Upload a single part of a multipart upload.
   * Returns the ETag for the part (needed for completeMultipartUpload).
   */
  uploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    body: Buffer
  ): Promise<string>;

  /**
   * Complete a multipart upload by combining all parts.
   */
  completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: PartInfo[]
  ): Promise<void>;

  /**
   * Abort a multipart upload and clean up uploaded parts.
   */
  abortMultipartUpload(key: string, uploadId: string): Promise<void>;

  // ─── Health ────────────────────────────────────────────

  /**
   * Check if the storage backend is reachable and the bucket exists.
   */
  healthCheck(): Promise<boolean>;
}
