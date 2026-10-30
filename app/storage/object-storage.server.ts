// The storage seam. Business logic (app/submissions) talks only to this interface; which provider sits behind it
// (Neon Object Storage, an in-memory fake for tests, or the fail-closed "unconfigured" provider) is decided in the
// composition root. Nothing here knows about S3, buckets or credentials.
//
// Security model (see app/submissions/uploads.server.ts for how it is used):
//  - Upload targets exist ONLY for staging keys. A final (approved) key never has an upload URL, so an outstanding
//    or reused upload URL can never overwrite finalized media.
//  - Finalization COPIES staging -> final and then validates the FINAL object, so the bytes that were validated are
//    exactly the bytes that are recorded. It does not rely on conditional (If-Match) copy semantics.
//  - Download URLs are short-lived, created only after an authorization check, and are never logged or stored.

export interface UploadTarget {
  /** Short-lived URL the browser PUTs the file to. Never log or persist it. */
  url: string;
  method: "PUT";
  /** Headers the browser must send exactly as given (e.g. Content-Type). */
  headers: Record<string, string>;
  expiresAt: Date;
}

export interface ObjectInfo {
  size: number;
  contentType: string | null;
  /** Provider ETag without quotes; identifies the stored bytes. */
  etag: string | null;
}

export interface CreateUploadTargetInput {
  key: string;
  contentType: string;
  /** Exact byte length the upload must have (signed into the URL where the provider supports it). */
  sizeBytes: number;
  ttlSeconds: number;
}

export interface CreateDownloadUrlInput {
  /** Name offered to the browser; sanitized by the adapter. Never part of the object key. */
  filename: string;
  contentType: string;
  ttlSeconds: number;
  /**
   * "attachment" (default) makes the browser save the file; "inline" lets it display the file in an <img> or <video>
   * (previews). Either way the content type is the validated one, never anything the uploader chose.
   */
  disposition?: "attachment" | "inline";
}

export interface ObjectStorage {
  /** False for the unconfigured provider; callers use it to fail closed with a clear, fixed message. */
  readonly configured: boolean;
  createUploadTarget(input: CreateUploadTargetInput): Promise<UploadTarget>;
  /** Metadata of an object, or null if it does not exist. */
  inspectObject(key: string): Promise<ObjectInfo | null>;
  /** The first `bytes` bytes of an object (for file-signature checks). */
  readHead(key: string, bytes: number): Promise<Uint8Array>;
  /** Bytes `start`..`endInclusive` of an object (for inspecting structure without reading the whole file). */
  readRange(key: string, start: number, endInclusive: number): Promise<Uint8Array>;
  /** Server-side copy to a NEW key chosen by the server. */
  copyObject(input: { sourceKey: string; destinationKey: string; contentType: string }): Promise<void>;
  createDownloadUrl(key: string, input: CreateDownloadUrlInput): Promise<string>;
  /** Deletes an object. Callers guarantee the key is unreferenced (see uploads.server.ts). */
  deleteObject(key: string): Promise<void>;
}

/** Thrown by the unconfigured provider (and for invalid storage configuration). The message is fixed and safe. */
export class StorageUnavailableError extends Error {
  override name = "StorageUnavailableError";
  constructor(message = "Media storage is not available.") {
    super(message);
  }
}
