// Reads just enough of a stored object (a few range requests, never the whole file) to describe it and to check that
// its structure is sound. The parsing itself is in analysis.ts (pure and unit-tested); this file only fetches bytes.
import type { ObjectStorage } from "../storage/object-storage.server.ts";
import {
  analyzeJpeg,
  analyzeMp4,
  analyzePng,
  analyzeWebp,
  type AnalysisLimits,
  type MediaAnalysis,
} from "./analysis.ts";

/** Image headers (EXIF, ICC profile, chunk list) are read from the first MiB; the end marker from the last 64 KiB. */
const IMAGE_HEAD_BYTES = 1024 * 1024;
const IMAGE_TAIL_BYTES = 64 * 1024;

export async function analyzeStoredMedia(
  storage: ObjectStorage,
  key: string,
  contentType: string,
  size: number,
  limits: AnalysisLimits,
): Promise<MediaAnalysis> {
  if (contentType === "video/mp4") return analyzeMp4((start, end) => storage.readRange(key, start, end), size, limits);

  const head = await storage.readRange(key, 0, Math.min(size, IMAGE_HEAD_BYTES) - 1);
  const tail =
    size <= IMAGE_HEAD_BYTES
      ? head.subarray(Math.max(0, size - IMAGE_TAIL_BYTES))
      : await storage.readRange(key, size - IMAGE_TAIL_BYTES, size - 1);

  switch (contentType) {
    case "image/png":
      return analyzePng(head, tail, limits);
    case "image/jpeg":
      return analyzeJpeg(head, tail, limits);
    case "image/webp":
      return analyzeWebp(head, size, limits);
    default:
      throw new Error(`No analyzer for ${contentType}`);
  }
}
