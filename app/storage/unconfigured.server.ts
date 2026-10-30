// Fail-closed provider used when storage is not (correctly) configured. Every operation refuses with a fixed,
// non-sensitive error; nothing falls back to any other storage and nothing is ever written.
import { StorageUnavailableError, type ObjectStorage } from "./object-storage.server.ts";

export function createUnconfiguredStorage(onUse?: (reason: string) => void, reason = "not configured"): ObjectStorage {
  const refuse = (): never => {
    onUse?.(reason);
    throw new StorageUnavailableError();
  };
  return {
    configured: false,
    createUploadTarget: async () => refuse(),
    inspectObject: async () => refuse(),
    readHead: async () => refuse(),
    readRange: async () => refuse(),
    copyObject: async () => refuse(),
    createDownloadUrl: async () => refuse(),
    deleteObject: async () => refuse(),
  };
}
