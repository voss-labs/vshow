// Inspection of uploaded media (JPEG, PNG, WebP, MP4): what the file is (dimensions, aspect ratio, duration, codec)
// and whether it is structurally sound. Pure and dependency-free: it works on byte arrays only, so it is easy to test,
// and the result type is safe to import in the browser (the pages show it to reviewers).
//
// What this IS: header and structure parsing, enough to describe the media truthfully and to reject files that are
// corrupt, truncated or absurdly large (decompression bombs). What it is NOT: an antivirus. It cannot prove a file is
// harmless; findings such as "data after the end of the image" are warnings for a human, not a clean bill of health.

export type CheckLevel = "pass" | "info" | "warn" | "fail";

export interface MediaCheck {
  /** Stable machine code, e.g. "trailing_data". */
  code: string;
  level: CheckLevel;
  /** A plain sentence for the reviewer. Never contains file content or a file name. */
  message: string;
}

export interface AspectRatio {
  /** Reduced ratio, e.g. 16 and 9 for 1920x1080. */
  w: number;
  h: number;
  /** A familiar name when within ~1.5% of a common ratio ("16:9", "9:16", "4:3"...), otherwise null. */
  label: string | null;
  orientation: "landscape" | "portrait" | "square";
}

export interface VideoDetails {
  durationSeconds: number | null;
  fps: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  hasAudio: boolean;
  /** The index ("moov") is at the start, so playback can begin before the whole file is downloaded. */
  fastStart: boolean;
}

export interface MediaAnalysis {
  version: 1;
  kind: "image" | "video";
  format: "PNG" | "JPEG" | "WebP" | "MP4";
  /** As displayed: the EXIF orientation / video rotation is already applied. */
  width: number;
  height: number;
  megapixels: number;
  aspect: AspectRatio;
  hasAlpha?: boolean;
  animated?: boolean;
  colorMode?: string;
  video?: VideoDetails;
  checks: MediaCheck[];
}

export interface AnalysisLimits {
  /** Largest accepted width x height in pixels (decompression-bomb guard). */
  maxPixels: number;
}

/** Below this on the short side, media will look soft on a campus screen. */
export const LOW_RESOLUTION_SHORT_SIDE = 720;

// --- shared helpers ------------------------------------------------------------------------------------------------

const check = (level: CheckLevel, code: string, message: string): MediaCheck => ({ level, code, message });
const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

const COMMON_RATIOS: Array<[string, number]> = [
  ["16:9", 16 / 9],
  ["9:16", 9 / 16],
  ["4:3", 4 / 3],
  ["3:4", 3 / 4],
  ["3:2", 3 / 2],
  ["2:3", 2 / 3],
  ["1:1", 1],
  ["16:10", 16 / 10],
  ["10:16", 10 / 16],
  ["21:9", 21 / 9],
  ["32:9", 32 / 9],
  ["5:4", 5 / 4],
  ["4:5", 4 / 5],
  ["2:1", 2],
  ["1:2", 0.5],
];

export function describeAspect(width: number, height: number): AspectRatio {
  const d = gcd(width, height) || 1;
  const ratio = width / height;
  const near = COMMON_RATIOS.find(([, r]) => Math.abs(ratio - r) / r <= 0.015);
  return {
    w: width / d,
    h: height / d,
    label: near ? near[0] : null,
    orientation: Math.abs(ratio - 1) <= 0.015 ? "square" : ratio > 1 ? "landscape" : "portrait",
  };
}

const u16be = (b: Uint8Array, p: number) => (b[p] << 8) | b[p + 1];
const u16le = (b: Uint8Array, p: number) => b[p] | (b[p + 1] << 8);
const u24le = (b: Uint8Array, p: number) => b[p] | (b[p + 1] << 8) | (b[p + 2] << 16);
const u32be = (b: Uint8Array, p: number) => ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;
const u32le = (b: Uint8Array, p: number) => (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0;
const i32be = (b: Uint8Array, p: number) => (b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3];
const four = (b: Uint8Array, p: number) => String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]);
const fits = (b: Uint8Array, p: number, n: number) => p >= 0 && p + n <= b.length;

/** Looks for byte patterns that have no business inside an image: a script tag or a Windows/Linux executable header. */
function activeContentSignature(bytes: Uint8Array): string | null {
  const text = new TextDecoder("latin1").decode(bytes).toLowerCase();
  if (text.includes("<script") || text.includes("<?php") || text.includes("javascript:")) return "script";
  if (text.includes("this program cannot be run in dos mode")) return "executable";
  return null;
}

/** Adds the checks that apply to every kind of media, and assembles the result. */
function finish(
  base: Omit<MediaAnalysis, "megapixels" | "aspect" | "checks" | "version">,
  checks: MediaCheck[],
  limits: AnalysisLimits,
): MediaAnalysis {
  const { width, height } = base;
  const noun = base.kind === "video" ? "Video" : "Image";
  if (!(width > 0 && height > 0)) {
    checks.push(check("fail", "invalid_dimensions", `The ${noun.toLowerCase()} reports a width or height of zero.`));
    return { version: 1, ...base, megapixels: 0, aspect: describeAspect(1, 1), checks };
  }
  const pixels = width * height;
  const megapixels = Math.round((pixels / 1_000_000) * 100) / 100;
  if (pixels > limits.maxPixels) {
    checks.push(
      check(
        "fail",
        "too_many_pixels",
        `${noun} is ${megapixels} megapixels, above the ${Math.round(limits.maxPixels / 1_000_000)} megapixel limit.`,
      ),
    );
  } else {
    checks.push(check("pass", "within_pixel_limit", `${noun} size is within the allowed limit.`));
  }
  const aspect = describeAspect(width, height);
  checks.push(
    aspect.label
      ? check("pass", "aspect_ratio", `Aspect ratio ${aspect.label} (${aspect.orientation}).`)
      : check(
          "info",
          "unusual_aspect_ratio",
          `Unusual aspect ratio ${aspect.w}:${aspect.h}. It may be letterboxed or cropped on a screen.`,
        ),
  );
  if (Math.min(width, height) < LOW_RESOLUTION_SHORT_SIDE) {
    checks.push(
      check("warn", "low_resolution", `Low resolution (${width} × ${height}). It may look soft on a large screen.`),
    );
  } else {
    checks.push(check("pass", "resolution_ok", "Resolution is suitable for a screen."));
  }
  return { version: 1, ...base, megapixels, aspect, checks };
}

/** An analysis that exists only to report why the file was rejected (no dimensions are known). */
function failure(
  kind: "image" | "video",
  format: MediaAnalysis["format"],
  code: string,
  message: string,
): MediaAnalysis {
  return {
    version: 1,
    kind,
    format,
    width: 0,
    height: 0,
    megapixels: 0,
    aspect: describeAspect(1, 1),
    checks: [check("fail", code, message)],
  };
}

// --- PNG -----------------------------------------------------------------------------------------------------------

const PNG_COLOR: Record<number, string> = {
  0: "Grayscale",
  2: "RGB",
  3: "Palette",
  4: "Grayscale + alpha",
  6: "RGB + alpha",
};

export function analyzePng(head: Uint8Array, tail: Uint8Array, limits: AnalysisLimits): MediaAnalysis {
  const checks: MediaCheck[] = [];
  if (!fits(head, 0, 33) || four(head, 12) !== "IHDR" || u32be(head, 8) !== 13) {
    return failure("image", "PNG", "unreadable_image", "The PNG header is damaged, so the image cannot be read.");
  }
  const width = u32be(head, 16);
  const height = u32be(head, 20);
  const colorType = head[25];
  let alpha = colorType === 4 || colorType === 6;
  let animated = false;

  // Walk the chunks up to the first image data chunk (headers only).
  let pos = 8;
  while (fits(head, pos, 12)) {
    const len = u32be(head, pos);
    const type = four(head, pos + 4);
    if (type === "tRNS") alpha = true;
    if (type === "acTL") animated = true;
    if (type === "IDAT") break;
    pos += 12 + len;
  }

  // The file must end with IEND; anything after it is data that is not part of the image.
  const iend = [0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82];
  let endAt = -1;
  for (let i = tail.length - 12; i >= 0; i--) {
    if (iend.every((v, k) => tail[i + k] === v)) {
      endAt = i + 12;
      break;
    }
  }
  if (endAt < 0) {
    return failure(
      "image",
      "PNG",
      "truncated_file",
      "The PNG is cut short (no end marker), so the file is incomplete.",
    );
  }
  checks.push(check("pass", "structure_ok", "PNG structure is complete."));
  const trailing = tail.length - endAt;
  if (trailing > 0) {
    checks.push(
      check(
        "warn",
        "trailing_data",
        `${trailing} byte${trailing === 1 ? "" : "s"} follow the end of the image. Normal images have none: this can hide extra content.`,
      ),
    );
  } else {
    checks.push(check("pass", "no_hidden_data", "Nothing follows the end of the image."));
  }
  if (animated) checks.push(check("warn", "animated", "Animated PNG: only the first frame may show on some players."));
  const signature = activeContentSignature(tail);
  if (signature)
    checks.push(
      check(
        "warn",
        "active_content",
        `The file tail contains ${signature}-like text, which does not belong in an image.`,
      ),
    );
  return finish(
    { kind: "image", format: "PNG", width, height, hasAlpha: alpha, animated, colorMode: PNG_COLOR[colorType] },
    checks,
    limits,
  );
}

// --- JPEG ----------------------------------------------------------------------------------------------------------

export function analyzeJpeg(head: Uint8Array, tail: Uint8Array, limits: AnalysisLimits): MediaAnalysis {
  const checks: MediaCheck[] = [];
  let width = 0;
  let height = 0;
  let components = 0;
  let progressive = false;
  let orientation = 1;
  let gps = false;
  let adobeTransform: number | null = null;
  let foundSof = false;

  let pos = 2; // after SOI
  while (fits(head, pos, 2)) {
    if (head[pos] !== 0xff) break; // not at a marker: the structure is not what we expect
    while (head[pos] === 0xff && pos < head.length) pos++; // fill bytes
    const marker = head[pos++];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue; // no length
    if (marker === 0xd9 || marker === 0xda) break; // end of image / start of scan data
    if (!fits(head, pos, 2)) break;
    const len = u16be(head, pos);
    if (len < 2 || !fits(head, pos, len)) break;
    const seg = pos + 2;
    const segEnd = pos + len;

    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof && segEnd - seg >= 6) {
      height = u16be(head, seg + 1);
      width = u16be(head, seg + 3);
      components = head[seg + 5];
      progressive = marker === 0xc2 || marker === 0xc6 || marker === 0xca || marker === 0xce;
      foundSof = true;
    } else if (marker === 0xe1 && four(head, seg) === "Exif") {
      const tiff = seg + 6;
      const le = head[tiff] === 0x49; // "II" little-endian, "MM" big-endian
      const r16 = (p: number) => (le ? u16le(head, p) : u16be(head, p));
      const r32 = (p: number) => (le ? u32le(head, p) : u32be(head, p));
      if (fits(head, tiff, 8)) {
        const ifd = tiff + r32(tiff + 4);
        if (fits(head, ifd, 2)) {
          const count = Math.min(r16(ifd), 64);
          for (let i = 0; i < count && fits(head, ifd + 2 + i * 12, 12); i++) {
            const entry = ifd + 2 + i * 12;
            const tag = r16(entry);
            if (tag === 0x0112) orientation = r16(entry + 8);
            if (tag === 0x8825) gps = true;
          }
        }
      }
    } else if (marker === 0xee && four(head, seg) === "Adob" && segEnd - seg >= 12) {
      adobeTransform = head[seg + 11];
    }
    pos = segEnd;
  }

  if (!foundSof) {
    return failure("image", "JPEG", "unreadable_image", "The JPEG header is damaged, so the image cannot be read.");
  }

  // The image must end with an end-of-image marker (FFD9); bytes after it are not part of the picture.
  let eoi = -1;
  for (let i = tail.length - 2; i >= 0; i--) {
    if (tail[i] === 0xff && tail[i + 1] === 0xd9) {
      eoi = i + 2;
      break;
    }
  }
  if (eoi < 0) {
    return failure(
      "image",
      "JPEG",
      "truncated_file",
      "The JPEG is cut short (no end marker), so the file is incomplete.",
    );
  }
  checks.push(check("pass", "structure_ok", "JPEG structure is complete."));
  const trailing = tail.length - eoi;
  if (trailing > 0) {
    checks.push(
      check(
        "warn",
        "trailing_data",
        `${trailing} byte${trailing === 1 ? "" : "s"} follow the end of the image. Some cameras add a preview here, but it can also hide extra content.`,
      ),
    );
  } else {
    checks.push(check("pass", "no_hidden_data", "Nothing follows the end of the image."));
  }
  if (gps) {
    checks.push(
      check(
        "warn",
        "location_metadata",
        "The photo carries GPS location metadata. Remove it before it is shown publicly.",
      ),
    );
  } else {
    checks.push(check("pass", "no_location_metadata", "No GPS location metadata."));
  }
  const cmyk = components === 4;
  if (cmyk)
    checks.push(check("warn", "cmyk_color", "CMYK colour: many players show wrong colours. Convert it to RGB."));
  const signature = activeContentSignature(tail);
  if (signature)
    checks.push(
      check(
        "warn",
        "active_content",
        `The file tail contains ${signature}-like text, which does not belong in an image.`,
      ),
    );

  const swap = orientation >= 5 && orientation <= 8; // rotated 90 degrees: the picture is shown with width and height swapped
  if (swap)
    checks.push(
      check(
        "info",
        "orientation_applied",
        "The photo is stored sideways and shown rotated; the dimensions below are as displayed.",
      ),
    );
  return finish(
    {
      kind: "image",
      format: "JPEG",
      width: swap ? height : width,
      height: swap ? width : height,
      hasAlpha: false,
      animated: false,
      colorMode: cmyk ? (adobeTransform !== null ? "CMYK (Adobe)" : "CMYK") : components === 1 ? "Grayscale" : "RGB",
    },
    progressive ? [...checks, check("info", "progressive", "Progressive JPEG.")] : checks,
    limits,
  );
}

// --- WebP ----------------------------------------------------------------------------------------------------------

export function analyzeWebp(head: Uint8Array, size: number, limits: AnalysisLimits): MediaAnalysis {
  const checks: MediaCheck[] = [];
  const fail = (code: string, message: string) => failure("image", "WebP", code, message);
  if (!fits(head, 0, 30) || four(head, 0) !== "RIFF" || four(head, 8) !== "WEBP") {
    return fail("unreadable_image", "The WebP header is damaged, so the image cannot be read.");
  }
  const riffEnd = u32le(head, 4) + 8;
  if (riffEnd > size) return fail("truncated_file", "The WebP is cut short, so the file is incomplete.");

  const type = four(head, 12);
  let width: number;
  let height: number;
  let alpha = false;
  let animated = false;
  if (type === "VP8X") {
    const flags = head[20];
    animated = (flags & 0x02) !== 0;
    alpha = (flags & 0x10) !== 0;
    width = u24le(head, 24) + 1;
    height = u24le(head, 27) + 1;
  } else if (type === "VP8 ") {
    if (!(head[23] === 0x9d && head[24] === 0x01 && head[25] === 0x2a)) {
      return fail("unreadable_image", "The WebP image data header is damaged.");
    }
    width = u16le(head, 26) & 0x3fff;
    height = u16le(head, 28) & 0x3fff;
  } else if (type === "VP8L") {
    if (head[20] !== 0x2f) return fail("unreadable_image", "The WebP image data header is damaged.");
    const bits = u32le(head, 21);
    width = (bits & 0x3fff) + 1;
    height = ((bits >>> 14) & 0x3fff) + 1;
    alpha = ((bits >>> 28) & 1) === 1;
  } else {
    return fail("unreadable_image", "This WebP layout is not recognised.");
  }
  checks.push(check("pass", "structure_ok", "WebP structure is complete."));
  const trailing = size - riffEnd;
  if (trailing > 0) {
    checks.push(
      check(
        "warn",
        "trailing_data",
        `${trailing} byte${trailing === 1 ? "" : "s"} follow the end of the image. Normal images have none.`,
      ),
    );
  } else {
    checks.push(check("pass", "no_hidden_data", "Nothing follows the end of the image."));
  }
  if (animated) checks.push(check("warn", "animated", "Animated WebP: only the first frame may show on some players."));
  return finish(
    { kind: "image", format: "WebP", width, height, hasAlpha: alpha, animated, colorMode: "RGB" },
    checks,
    limits,
  );
}

// --- MP4 -----------------------------------------------------------------------------------------------------------

export type ReadRange = (start: number, endInclusive: number) => Promise<Uint8Array>;

interface Box {
  type: string;
  /** Offset of the box header in the buffer it was read from. */
  start: number;
  /** Offset of the first payload byte. */
  data: number;
  /** Offset just past the box. */
  end: number;
}

/** Children of a container box inside `buf[from, to)`. Bounds-checked: a damaged size ends the walk. */
function children(buf: Uint8Array, from: number, to: number): Box[] {
  const out: Box[] = [];
  let pos = from;
  while (pos + 8 <= to && out.length < 512) {
    let size = u32be(buf, pos);
    const type = four(buf, pos + 4);
    let header = 8;
    if (size === 1) {
      if (pos + 16 > to) break;
      size = u32be(buf, pos + 8) * 2 ** 32 + u32be(buf, pos + 12);
      header = 16;
    } else if (size === 0) {
      size = to - pos;
    }
    if (size < header || pos + size > to) break;
    out.push({ type, start: pos, data: pos + header, end: pos + size });
    pos += size;
  }
  return out;
}
const find = (list: Box[], type: string) => list.find((b) => b.type === type);

interface Track {
  handler: string | null;
  codec: string | null;
  width: number;
  height: number;
  rotation: number;
  timescale: number;
  duration: number;
  samples: number;
}

function parseTrack(buf: Uint8Array, trak: Box): Track {
  const t: Track = {
    handler: null,
    codec: null,
    width: 0,
    height: 0,
    rotation: 0,
    timescale: 0,
    duration: 0,
    samples: 0,
  };
  const kids = children(buf, trak.data, trak.end);
  const tkhd = find(kids, "tkhd");
  if (tkhd) {
    const v = buf[tkhd.data];
    const matrix = tkhd.data + (v === 1 ? 52 : 40);
    const wh = matrix + 36;
    if (fits(buf, wh, 8)) {
      t.width = u32be(buf, wh) / 65536;
      t.height = u32be(buf, wh + 4) / 65536;
      const [a, b, c, d] = [
        i32be(buf, matrix),
        i32be(buf, matrix + 4),
        i32be(buf, matrix + 12),
        i32be(buf, matrix + 16),
      ];
      const one = 0x10000;
      if (a === 0 && b === one && c === -one && d === 0) t.rotation = 90;
      else if (a === -one && b === 0 && c === 0 && d === -one) t.rotation = 180;
      else if (a === 0 && b === -one && c === one && d === 0) t.rotation = 270;
    }
  }
  const mdia = find(kids, "mdia");
  if (!mdia) return t;
  const mk = children(buf, mdia.data, mdia.end);
  const hdlr = find(mk, "hdlr");
  if (hdlr && fits(buf, hdlr.data, 12)) t.handler = four(buf, hdlr.data + 8);
  const mdhd = find(mk, "mdhd");
  if (mdhd && fits(buf, mdhd.data, 20)) {
    const v = buf[mdhd.data];
    t.timescale = u32be(buf, mdhd.data + (v === 1 ? 20 : 12));
    t.duration =
      v === 1 ? u32be(buf, mdhd.data + 24) * 2 ** 32 + u32be(buf, mdhd.data + 28) : u32be(buf, mdhd.data + 16);
  }
  const minf = find(mk, "minf");
  const stbl = minf ? find(children(buf, minf.data, minf.end), "stbl") : undefined;
  if (stbl) {
    const sk = children(buf, stbl.data, stbl.end);
    const stsd = find(sk, "stsd");
    if (stsd && fits(buf, stsd.data, 16)) t.codec = four(buf, stsd.data + 12);
    const stts = find(sk, "stts");
    if (stts && fits(buf, stts.data, 8)) {
      const n = Math.min(u32be(buf, stts.data + 4), 100_000);
      for (let i = 0; i < n && fits(buf, stts.data + 8 + i * 8, 8); i++) t.samples += u32be(buf, stts.data + 8 + i * 8);
    }
  }
  return t;
}

const VIDEO_CODEC_NAME: Record<string, string> = {
  avc1: "H.264",
  avc3: "H.264",
  hvc1: "H.265 (HEVC)",
  hev1: "H.265 (HEVC)",
  vp09: "VP9",
  av01: "AV1",
  mp4v: "MPEG-4 Visual",
};
const AUDIO_CODEC_NAME: Record<string, string> = {
  mp4a: "AAC",
  "ac-3": "AC-3",
  "ec-3": "E-AC-3",
  opus: "Opus",
  alac: "ALAC",
};

const MAX_MOOV_BYTES = 16 * 1024 * 1024;

export async function analyzeMp4(readRange: ReadRange, size: number, limits: AnalysisLimits): Promise<MediaAnalysis> {
  const fail = (code: string, message: string) => failure("video", "MP4", code, message);

  // 1. Walk the top-level boxes using only their headers (a handful of tiny range reads).
  const top: Array<{ type: string; start: number; size: number }> = [];
  let offset = 0;
  while (offset + 8 <= size && top.length < 64) {
    const header = await readRange(offset, Math.min(offset + 15, size - 1));
    if (header.length < 8) break;
    let boxSize = u32be(header, 0);
    const type = four(header, 4);
    if (boxSize === 1 && header.length >= 16) boxSize = u32be(header, 8) * 2 ** 32 + u32be(header, 12);
    else if (boxSize === 0) boxSize = size - offset;
    if (boxSize < 8) break;
    top.push({ type, start: offset, size: boxSize });
    offset += boxSize;
  }
  const leftover = size - offset;
  if (leftover >= 8) {
    return fail("truncated_file", "The video file is cut short or its structure is damaged, so it is incomplete.");
  }
  const moov = top.find((b) => b.type === "moov");
  const mdat = top.find((b) => b.type === "mdat");
  if (!moov || !mdat)
    return fail("unreadable_video", "The video has no index or no picture data, so it cannot be played.");
  if (moov.size > MAX_MOOV_BYTES)
    return fail("unreadable_video", "The video index is unusually large, so it was not accepted.");

  // 2. Parse the index.
  const buf = await readRange(moov.start, moov.start + moov.size - 1);
  const moovBox = children(buf, 0, buf.length).find((b) => b.type === "moov");
  if (!moovBox) return fail("unreadable_video", "The video index is damaged, so it cannot be read.");
  const kids = children(buf, moovBox.data, moovBox.end);
  const tracks = kids.filter((k) => k.type === "trak").map((k) => parseTrack(buf, k));
  const video = tracks.find((t) => t.handler === "vide");
  if (!video) return fail("no_video_track", "The file contains no video track.");
  const audio = tracks.find((t) => t.handler === "soun");

  let durationSeconds: number | null = null;
  const mvhd = find(kids, "mvhd");
  if (mvhd && fits(buf, mvhd.data, 20)) {
    const v = buf[mvhd.data];
    const timescale = u32be(buf, mvhd.data + (v === 1 ? 20 : 12));
    const duration =
      v === 1 ? u32be(buf, mvhd.data + 24) * 2 ** 32 + u32be(buf, mvhd.data + 28) : u32be(buf, mvhd.data + 16);
    if (timescale > 0 && duration > 0) durationSeconds = duration / timescale;
  }
  if (durationSeconds === null && video.timescale > 0 && video.duration > 0)
    durationSeconds = video.duration / video.timescale;

  const sideways = video.rotation === 90 || video.rotation === 270;
  const width = Math.round(sideways ? video.height : video.width);
  const height = Math.round(sideways ? video.width : video.height);
  const fps =
    video.samples > 0 && video.timescale > 0 && video.duration > 0
      ? Math.round((video.samples / (video.duration / video.timescale)) * 100) / 100
      : null;
  const fastStart = moov.start < mdat.start;
  const codecCode = video.codec ?? "";
  const videoCodec = VIDEO_CODEC_NAME[codecCode] ?? (codecCode || null);
  const audioCodec = audio?.codec ? (AUDIO_CODEC_NAME[audio.codec] ?? audio.codec) : null;

  const checks: MediaCheck[] = [check("pass", "structure_ok", "MP4 structure is complete.")];
  if (leftover > 0) {
    checks.push(
      check(
        "warn",
        "trailing_data",
        `${leftover} stray byte${leftover === 1 ? "" : "s"} follow the last section of the file.`,
      ),
    );
  }
  if (!videoCodec) {
    checks.push(check("warn", "unknown_video_codec", "The video codec could not be identified."));
  } else if (codecCode === "avc1" || codecCode === "avc3") {
    checks.push(check("pass", "video_codec_ok", "H.264 plays on virtually every browser and player."));
  } else {
    checks.push(
      check(
        "warn",
        "uncommon_video_codec",
        `${videoCodec} video may not play in every browser or on every signage player.`,
      ),
    );
  }
  checks.push(
    fastStart
      ? check("pass", "streamable", "The video can start playing before it has fully downloaded.")
      : check(
          "warn",
          "not_streamable",
          "The video index is at the end of the file, so previews start slowly. Re-export it with fast start.",
        ),
  );
  checks.push(
    audio
      ? check("info", "has_audio", "The video has an audio track. Check that sound is wanted on this screen.")
      : check("info", "no_audio", "The video has no audio track."),
  );
  return finish(
    {
      kind: "video",
      format: "MP4",
      width,
      height,
      video: { durationSeconds, fps, videoCodec, audioCodec, hasAudio: Boolean(audio), fastStart },
    },
    checks,
    limits,
  );
}

/** The checks that make the upload fail. A file with any of these is not recorded. */
export const failedChecks = (a: MediaAnalysis) => a.checks.filter((c) => c.level === "fail");
