import "server-only";
import { getEnv } from "@/lib/validation/env";
import { generateStorageKey } from "./keys";

export function generateUploadKey(
  ...args: Parameters<typeof generateStorageKey>
) {
  const key = generateStorageKey(...args);
  return getEnv().STORAGE_PROVIDER === "google-drive" ? `drive/${key}` : key;
}
