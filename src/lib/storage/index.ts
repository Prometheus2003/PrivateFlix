import "server-only";
/**
 * Singleton storage adapter instance.
 * Import this to use storage throughout the application.
 *
 * @module lib/storage/index
 * @security Never import in client-side code.
 */
import type { StorageAdapter } from "./adapter";
import { createS3StorageAdapter } from "./s3";

/**
 * Global storage adapter instance.
 * Uses MinIO/S3-compatible backend via the adapter pattern.
 */
const globalForStorage = globalThis as unknown as {
  storage: StorageAdapter | undefined;
};

export const storage: StorageAdapter =
  globalForStorage.storage ?? createS3StorageAdapter();

if (process.env.NODE_ENV !== "production") {
  globalForStorage.storage = storage;
}
