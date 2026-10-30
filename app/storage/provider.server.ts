// Chooses the storage implementation lazily, on first use, so a missing or broken storage configuration never
// affects pages that do not touch media. Anything other than a complete, valid configuration yields the
// fail-closed provider: there is no fallback to any other storage.
import type { Logger } from "../logging/logger.server.ts";
import { StorageConfigError, resolveStorageConfig } from "./config.server.ts";
import { createNeonStorage } from "./neon.server.ts";
import type { ObjectStorage } from "./object-storage.server.ts";
import { createUnconfiguredStorage } from "./unconfigured.server.ts";

type Env = Record<string, string | undefined>;

export function createStorage(env: Env, logger: Logger): ObjectStorage {
  let impl: ObjectStorage | undefined;

  const build = (): ObjectStorage => {
    try {
      const config = resolveStorageConfig(env);
      if (config) return createNeonStorage(config);
      return createUnconfiguredStorage(() => logger.warn("media storage is not configured"), "not configured");
    } catch (err) {
      if (!(err instanceof StorageConfigError)) throw err;
      // The message names only the variable, never its value.
      return createUnconfiguredStorage(
        () => logger.error("media storage is not configured correctly", { reason: err.message }),
        err.message,
      );
    }
  };
  const resolve = () => (impl ??= build());

  return {
    get configured() {
      return resolve().configured;
    },
    createUploadTarget: (input) => resolve().createUploadTarget(input),
    inspectObject: (key) => resolve().inspectObject(key),
    readHead: (key, bytes) => resolve().readHead(key, bytes),
    readRange: (key, start, end) => resolve().readRange(key, start, end),
    copyObject: (input) => resolve().copyObject(input),
    createDownloadUrl: (key, input) => resolve().createDownloadUrl(key, input),
    deleteObject: (key) => resolve().deleteObject(key),
  };
}
