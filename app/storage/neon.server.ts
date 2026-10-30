// Neon Object Storage adapter (S3-compatible API through the AWS SDK). The ONLY file that imports the SDK.
//
// Compatibility settings follow Neon's documentation: path-style addressing, SigV4, and
// requestChecksumCalculation/responseChecksumValidation = WHEN_REQUIRED (newer SDK defaults add checksum
// headers that S3-compatible stores reject). Live browser uploads and the exact behaviour of CopyObject on Neon
// have NOT been verified end to end yet; this adapter is exercised in tests with a stubbed client only.
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { NeonStorageConfig } from "./config.server.ts";
import { sanitizeFilename } from "./file-types.ts";
import type {
  CreateDownloadUrlInput,
  CreateUploadTargetInput,
  ObjectInfo,
  ObjectStorage,
  UploadTarget,
} from "./object-storage.server.ts";

/** The slice of S3Client this adapter uses; tests replace `send` so no network is ever involved. */
export type S3Like = Pick<S3Client, "send" | "config">;

export function createS3Client(config: NeonStorageConfig): S3Client {
  return new S3Client({
    region: config.region,
    endpoint: config.endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    maxAttempts: 1, // no automatic retries (Vshow never retries a write without an idempotency strategy)
    // Finalization talks to storage while holding database row locks, so a stalled connection must not hold them
    // indefinitely: fail the request (the transaction rolls back and the upload can be finalized again later).
    requestHandler: { connectionTimeout: 5_000, requestTimeout: 60_000 },
  });
}

const stripQuotes = (v: string | undefined) => (v ? v.replace(/^"|"$/g, "") : null);
const isNotFound = (err: unknown) => {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === "NotFound" || e?.name === "NoSuchKey" || e?.$metadata?.httpStatusCode === 404;
};

/** ASCII-only, quote-free filename for Content-Disposition. */
const dispositionName = (name: string) =>
  sanitizeFilename(name)
    .replace(/[^\x20-\x7e]/g, "_")
    .replace(/[\\"]/g, "_");

export function createNeonStorage(config: NeonStorageConfig, client: S3Like = createS3Client(config)): ObjectStorage {
  const Bucket = config.bucket;
  // The presigner needs a full client (it only signs locally, no network); `send` is what tests stub.
  const presignClient = client as S3Client;

  return {
    configured: true,

    async createUploadTarget({
      key,
      contentType,
      sizeBytes,
      ttlSeconds,
    }: CreateUploadTargetInput): Promise<UploadTarget> {
      // Content-Type and Content-Length are SIGNED, so a request with a different type or length does not match
      // the signature. (This is a defence in depth: finalization re-checks the stored size and signature anyway.)
      const url = await getSignedUrl(
        presignClient,
        new PutObjectCommand({ Bucket, Key: key, ContentType: contentType, ContentLength: sizeBytes }),
        { expiresIn: ttlSeconds, signableHeaders: new Set(["content-type", "content-length"]) },
      );
      return {
        url,
        method: "PUT",
        headers: { "Content-Type": contentType },
        expiresAt: new Date(Date.now() + ttlSeconds * 1000),
      };
    },

    async inspectObject(key: string): Promise<ObjectInfo | null> {
      try {
        const out = await client.send(new HeadObjectCommand({ Bucket, Key: key }));
        return {
          size: Number(out.ContentLength ?? 0),
          contentType: out.ContentType ?? null,
          etag: stripQuotes(out.ETag),
        };
      } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
      }
    },

    async readHead(key: string, bytes: number): Promise<Uint8Array> {
      const out = await client.send(
        new GetObjectCommand({ Bucket, Key: key, Range: `bytes=0-${Math.max(0, bytes - 1)}` }),
      );
      if (!out.Body) return new Uint8Array();
      const all = await out.Body.transformToByteArray();
      return all.subarray(0, bytes); // a store that ignores Range must not make us keep the whole object
    },

    async readRange(key: string, start: number, endInclusive: number): Promise<Uint8Array> {
      const out = await client.send(
        new GetObjectCommand({ Bucket, Key: key, Range: `bytes=${start}-${endInclusive}` }),
      );
      if (!out.Body) return new Uint8Array();
      const all = await out.Body.transformToByteArray();
      return all.subarray(0, endInclusive - start + 1); // a store that ignores Range must not make us keep more
    },

    async copyObject({ sourceKey, destinationKey, contentType }): Promise<void> {
      const source = [Bucket, ...sourceKey.split("/")].map(encodeURIComponent).join("/");
      await client.send(
        new CopyObjectCommand({
          Bucket,
          Key: destinationKey,
          CopySource: source,
          ContentType: contentType,
          MetadataDirective: "REPLACE",
        }),
      );
    },

    async createDownloadUrl(
      key: string,
      { filename, contentType, ttlSeconds, disposition = "attachment" }: CreateDownloadUrlInput,
    ): Promise<string> {
      return getSignedUrl(
        presignClient,
        new GetObjectCommand({
          Bucket,
          Key: key,
          ResponseContentDisposition: `${disposition}; filename="${dispositionName(filename)}"`,
          ResponseContentType: contentType,
        }),
        { expiresIn: ttlSeconds },
      );
    },

    async deleteObject(key: string): Promise<void> {
      await client.send(new DeleteObjectCommand({ Bucket, Key: key }));
    },
  };
}
