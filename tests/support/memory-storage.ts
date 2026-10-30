// In-memory ObjectStorage for automated tests. It models the properties the workflow relies on, including the
// dangerous one: an upload URL stays usable until it expires, so a reused URL CAN overwrite its (staging) key.
// Also records every call so tests can prove that unauthorized requests never reached storage.
import { createHash, randomUUID } from "node:crypto";
import {
  StorageUnavailableError,
  type CreateDownloadUrlInput,
  type CreateUploadTargetInput,
  type ObjectInfo,
  type ObjectStorage,
  type UploadTarget,
} from "../../app/storage/object-storage.server.ts";

interface Stored {
  bytes: Uint8Array;
  contentType: string;
}

export type StorageMethod =
  | "createUploadTarget"
  | "inspectObject"
  | "readHead"
  | "readRange"
  | "copyObject"
  | "createDownloadUrl"
  | "deleteObject";

export interface MemoryStorage extends ObjectStorage {
  /** Every method call in order (method + key), for "never reached storage" assertions. */
  readonly calls: Array<{ method: StorageMethod; key: string }>;
  /** What a browser does with an upload target: writes the bytes to the key the URL was signed for. */
  upload(target: UploadTarget, bytes: Uint8Array, contentType?: string): void;
  /** Direct write, bypassing the URL (test setup). */
  put(key: string, bytes: Uint8Array, contentType: string): void;
  get(key: string): Stored | undefined;
  has(key: string): boolean;
  keys(): string[];
  /** Make the next call of `method` throw, to test failure paths. */
  failNext(method: StorageMethod, error?: Error): void;
  /** Resolve the key a download URL was created for. */
  keyOfDownloadUrl(url: string): string | undefined;
  /** The options a download URL was created with (disposition, content type, lifetime). */
  optionsOfDownloadUrl(url: string): CreateDownloadUrlInput | undefined;
}

const etagOf = (bytes: Uint8Array) => createHash("md5").update(bytes).digest("hex");

export function createMemoryStorage(): MemoryStorage {
  const objects = new Map<string, Stored>();
  const targets = new Map<string, { key: string; contentType: string; sizeBytes: number; expiresAt: number }>();
  const downloads = new Map<string, string>();
  const downloadOptions = new Map<string, CreateDownloadUrlInput>();
  const failures = new Map<StorageMethod, Error>();
  const calls: MemoryStorage["calls"] = [];

  const enter = (method: StorageMethod, key: string) => {
    calls.push({ method, key });
    const f = failures.get(method);
    if (f) {
      failures.delete(method);
      throw f;
    }
  };

  return {
    configured: true,
    calls,

    async createUploadTarget({
      key,
      contentType,
      sizeBytes,
      ttlSeconds,
    }: CreateUploadTargetInput): Promise<UploadTarget> {
      enter("createUploadTarget", key);
      const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
      const url = `memory://upload/${randomUUID()}`;
      targets.set(url, { key, contentType, sizeBytes, expiresAt: expiresAt.getTime() });
      return { url, method: "PUT", headers: { "Content-Type": contentType }, expiresAt };
    },

    upload(target, bytes, contentType) {
      const t = targets.get(target.url);
      if (!t) throw new Error("unknown upload target");
      if (Date.now() > t.expiresAt) throw new Error("upload target expired");
      // Like the real store: the signed type and length must match, but the URL can be used again.
      if (bytes.length !== t.sizeBytes) throw new Error("length does not match the signed Content-Length");
      if ((contentType ?? t.contentType) !== t.contentType)
        throw new Error("Content-Type does not match the signature");
      objects.set(t.key, { bytes: new Uint8Array(bytes), contentType: t.contentType });
    },

    put(key, bytes, contentType) {
      objects.set(key, { bytes: new Uint8Array(bytes), contentType });
    },
    get: (key) => objects.get(key),
    has: (key) => objects.has(key),
    keys: () => [...objects.keys()],

    async inspectObject(key): Promise<ObjectInfo | null> {
      enter("inspectObject", key);
      const o = objects.get(key);
      return o ? { size: o.bytes.length, contentType: o.contentType, etag: etagOf(o.bytes) } : null;
    },

    async readHead(key, bytes) {
      enter("readHead", key);
      const o = objects.get(key);
      if (!o) throw new Error("NoSuchKey");
      return o.bytes.slice(0, bytes);
    },

    async readRange(key, start, endInclusive) {
      enter("readRange", key);
      const o = objects.get(key);
      if (!o) throw new Error("NoSuchKey");
      return o.bytes.slice(start, endInclusive + 1);
    },

    async copyObject({ sourceKey, destinationKey, contentType }) {
      enter("copyObject", destinationKey);
      const o = objects.get(sourceKey);
      if (!o) throw new Error("NoSuchKey");
      // Never overwrite: destination keys are always fresh. A collision is a bug worth failing loudly on.
      if (objects.has(destinationKey)) throw new Error("destination already exists");
      objects.set(destinationKey, { bytes: new Uint8Array(o.bytes), contentType });
    },

    async createDownloadUrl(key: string, input: CreateDownloadUrlInput) {
      enter("createDownloadUrl", key);
      const url = `memory://download/${randomUUID()}`;
      downloads.set(url, key);
      downloadOptions.set(url, input);
      return url;
    },

    async deleteObject(key) {
      enter("deleteObject", key);
      objects.delete(key);
    },

    failNext(method, error = new StorageUnavailableError()) {
      failures.set(method, error);
    },
    keyOfDownloadUrl: (url) => downloads.get(url),
    optionsOfDownloadUrl: (url) => downloadOptions.get(url),
  };
}
