import type { StorageAdapter } from "./adapter";

/** Route by persisted key, never by current default; older media stays accessible. */
export function routedStorage(
  s3: StorageAdapter,
  drive: () => StorageAdapter,
): StorageAdapter {
  const pick = (key: string) => (key.startsWith("drive/") ? drive() : s3);
  return {
    putObject: (key, body, options) => pick(key).putObject(key, body, options),
    getObject: (key, range) => pick(key).getObject(key, range),
    getObjectMetadata: (key) => pick(key).getObjectMetadata(key),
    deleteObject: (key) => pick(key).deleteObject(key),
    deleteObjects: async (keys) => {
      for (const key of keys) await pick(key).deleteObject(key);
    },
    objectExists: (key) => pick(key).objectExists(key),
    createMultipartUpload: (key, type) =>
      pick(key).createMultipartUpload(key, type),
    uploadPart: (key, id, part, body) =>
      pick(key).uploadPart(key, id, part, body),
    completeMultipartUpload: (key, id, parts) =>
      pick(key).completeMultipartUpload(key, id, parts),
    abortMultipartUpload: (key, id) => pick(key).abortMultipartUpload(key, id),
    healthCheck: () => s3.healthCheck(),
  };
}
