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
import { getEnv } from "@/lib/validation/env";
import { DriveClient } from "./drive-client";
import { DriveStorageAdapter } from "./drive";
import { routedStorage } from "./routed";
import { driveObjectRegistry } from "./drive-registry";

function createStorage(): StorageAdapter {
  const s3 = createS3StorageAdapter();
  let drive: DriveStorageAdapter | undefined;
  const getDrive = () => {
    if (drive) return drive;
    const env = getEnv();
    const {
      GOOGLE_DRIVE_CLIENT_ID: clientId,
      GOOGLE_DRIVE_CLIENT_SECRET: clientSecret,
      GOOGLE_DRIVE_REFRESH_TOKEN: refreshToken,
      GOOGLE_DRIVE_FOLDER_ID: folderId,
    } = env;
    if (!clientId || !clientSecret || !refreshToken || !folderId)
      throw new Error("Google Drive storage is not connected");
    drive = new DriveStorageAdapter(
      s3,
      new DriveClient({ clientId, clientSecret, refreshToken, folderId }),
      driveObjectRegistry,
    );
    return drive;
  };
  const routed = routedStorage(s3, getDrive);
  return {
    ...routed,
    healthCheck: () =>
      getEnv().STORAGE_PROVIDER === "google-drive"
        ? getDrive().healthCheck()
        : s3.healthCheck(),
    cleanupStaging: () =>
      getEnv().GOOGLE_DRIVE_REFRESH_TOKEN
        ? getDrive().cleanupStaging()
        : Promise.resolve(0),
  };
}

/**
 * Global storage adapter instance.
 * Uses MinIO/S3-compatible backend via the adapter pattern.
 */
const globalForStorage = globalThis as unknown as {
  storage: StorageAdapter | undefined;
};

export const storage: StorageAdapter =
  globalForStorage.storage ?? createStorage();

if (process.env.NODE_ENV !== "production") {
  globalForStorage.storage = storage;
}
