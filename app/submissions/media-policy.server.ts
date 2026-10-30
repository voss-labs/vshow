// Tunable limits for media and requested windows. Read from the environment with safe defaults and hard bounds;
// an invalid value is ignored (with a warning from the caller) rather than crashing the server.
type Env = Record<string, string | undefined>;

export interface MediaPolicy {
  /** Largest accepted media file. Default 100 MiB. */
  maxBytes: number;
  /** Largest accepted width x height in pixels (decompression-bomb guard). Default 100 megapixels. */
  maxPixels: number;
  /** Most requested display windows per submission. Default 10. */
  maxWindows: number;
  /** How long a presigned upload URL / an open reservation lives. */
  uploadUrlTtlSeconds: number;
  /** How long a presigned download URL lives. */
  downloadUrlTtlSeconds: number;
  /**
   * How long an inline preview URL lives. Longer than a download because a playing video keeps requesting ranges
   * from the same URL while it buffers and seeks.
   */
  previewUrlTtlSeconds: number;
}

export const DEFAULT_MEDIA_POLICY: MediaPolicy = {
  maxBytes: 100 * 1024 * 1024,
  maxPixels: 100_000_000,
  maxWindows: 10,
  uploadUrlTtlSeconds: 600,
  downloadUrlTtlSeconds: 120,
  previewUrlTtlSeconds: 900,
};

const SPEC: Array<{ env: string; key: keyof MediaPolicy; min: number; max: number }> = [
  { env: "MEDIA_MAX_BYTES", key: "maxBytes", min: 1024, max: 1024 * 1024 * 1024 },
  { env: "MEDIA_MAX_PIXELS", key: "maxPixels", min: 1_000_000, max: 1_000_000_000 },
  { env: "MAX_REQUEST_WINDOWS", key: "maxWindows", min: 1, max: 50 },
  { env: "UPLOAD_URL_TTL_SECONDS", key: "uploadUrlTtlSeconds", min: 60, max: 3600 },
  { env: "DOWNLOAD_URL_TTL_SECONDS", key: "downloadUrlTtlSeconds", min: 30, max: 900 },
  { env: "PREVIEW_URL_TTL_SECONDS", key: "previewUrlTtlSeconds", min: 60, max: 3600 },
];

/** Returns the policy and the names (never values) of any variables that were invalid and defaulted. */
export function resolveMediaPolicy(env: Env): { policy: MediaPolicy; invalid: string[] } {
  const policy = { ...DEFAULT_MEDIA_POLICY };
  const invalid: string[] = [];
  for (const { env: name, key, min, max } of SPEC) {
    const raw = env[name]?.trim();
    if (!raw) continue;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) invalid.push(name);
    else policy[key] = n;
  }
  return { policy, invalid };
}
