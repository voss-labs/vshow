// Synthetic but structurally valid PNG / JPEG / WebP / MP4 files for tests. They contain no real picture or video data
// (the analyzers read headers and structure only), so they are tiny, deterministic and safe to keep in the repository.
import { crc32 } from "node:zlib";

const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
const ascii = (s: string) => Uint8Array.from(Buffer.from(s, "latin1"));
const be32 = (n: number) => Uint8Array.from([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const be16 = (n: number) => Uint8Array.from([(n >>> 8) & 255, n & 255]);
const le32 = (n: number) => Uint8Array.from([n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]);
const le24 = (n: number) => Uint8Array.from([n & 255, (n >>> 8) & 255, (n >>> 16) & 255]);
const le16 = (n: number) => Uint8Array.from([n & 255, (n >>> 8) & 255]);

// --- PNG -----------------------------------------------------------------------------------------------------------

export interface PngOptions {
  width: number;
  height: number;
  /** 0 gray, 2 RGB, 3 palette, 4 gray+alpha, 6 RGBA. Default 2. */
  colorType?: number;
  /** Add a tRNS chunk (transparency for a palette/RGB image). */
  transparency?: boolean;
  /** Add an acTL chunk (animated PNG). */
  animated?: boolean;
  /** Bytes appended after IEND. */
  trailing?: Uint8Array;
  /** Leave out IEND (a cut-off file). */
  truncated?: boolean;
  /** Bytes of dummy image data (default 16). */
  dataBytes?: number;
}

const pngChunk = (type: string, data: Uint8Array) => {
  const body = concat(ascii(type), data);
  return concat(be32(data.length), body, be32(crc32(body) >>> 0));
};

export function buildPng({
  width,
  height,
  colorType = 2,
  transparency = false,
  animated = false,
  trailing,
  truncated = false,
  dataBytes = 16,
}: PngOptions): Uint8Array {
  const ihdr = concat(be32(width), be32(height), Uint8Array.from([8, colorType, 0, 0, 0]));
  return concat(
    Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    animated ? pngChunk("acTL", concat(be32(2), be32(0))) : new Uint8Array(),
    transparency ? pngChunk("tRNS", Uint8Array.from([0, 0])) : new Uint8Array(),
    pngChunk("IDAT", new Uint8Array(dataBytes).fill(7)),
    truncated ? new Uint8Array() : pngChunk("IEND", new Uint8Array()),
    trailing ?? new Uint8Array(),
  );
}

// --- JPEG ----------------------------------------------------------------------------------------------------------

export interface JpegOptions {
  width: number;
  height: number;
  /** 1 gray, 3 colour, 4 CMYK. Default 3. */
  components?: number;
  progressive?: boolean;
  /** EXIF orientation 1-8 (5-8 are rotated). Omit for no EXIF. */
  orientation?: number;
  /** Include a GPS IFD pointer in the EXIF block. */
  gps?: boolean;
  /** Add an Adobe APP14 segment. */
  adobe?: boolean;
  trailing?: Uint8Array;
  /** Leave out the end-of-image marker. */
  truncated?: boolean;
  /** Leave out the frame header (dimensions). */
  noFrame?: boolean;
  scanBytes?: number;
}

const segment = (marker: number, payload: Uint8Array) =>
  concat(Uint8Array.from([0xff, marker]), be16(payload.length + 2), payload);

export function buildJpeg({
  width,
  height,
  components = 3,
  progressive = false,
  orientation,
  gps = false,
  adobe = false,
  trailing,
  truncated = false,
  noFrame = false,
  scanBytes = 32,
}: JpegOptions): Uint8Array {
  const parts: Uint8Array[] = [Uint8Array.from([0xff, 0xd8])];
  if (orientation !== undefined || gps) {
    const entries: Uint8Array[] = [];
    if (orientation !== undefined) entries.push(concat(le16(0x0112), le16(3), le32(1), le16(orientation), le16(0)));
    if (gps) entries.push(concat(le16(0x8825), le16(4), le32(1), le32(0)));
    const tiff = concat(ascii("II"), le16(42), le32(8), le16(entries.length), ...entries, le32(0));
    parts.push(segment(0xe1, concat(ascii("Exif\0\0"), tiff)));
  }
  if (adobe) parts.push(segment(0xee, concat(ascii("Adobe"), Uint8Array.from([0, 100, 0, 0, 0, 0, 0]))));
  if (!noFrame) {
    const comps = new Uint8Array(components * 3);
    for (let i = 0; i < components; i++) comps.set([i + 1, 0x11, 0], i * 3);
    parts.push(
      segment(
        progressive ? 0xc2 : 0xc0,
        concat(Uint8Array.from([8]), be16(height), be16(width), Uint8Array.from([components]), comps),
      ),
    );
  }
  parts.push(segment(0xda, Uint8Array.from([1, 1, 0, 0, 63, 0])));
  parts.push(new Uint8Array(scanBytes).fill(0x55));
  if (!truncated) parts.push(Uint8Array.from([0xff, 0xd9]));
  if (trailing) parts.push(trailing);
  return concat(...parts);
}

// --- WebP ----------------------------------------------------------------------------------------------------------

export interface WebpOptions {
  width: number;
  height: number;
  /** "VP8X" (extended), "VP8L" (lossless) or "VP8 " (lossy). Default VP8X. */
  layout?: "VP8X" | "VP8L" | "VP8 ";
  animated?: boolean;
  alpha?: boolean;
  trailing?: Uint8Array;
  /** Claim more RIFF bytes than the file holds. */
  truncated?: boolean;
}

export function buildWebp({
  width,
  height,
  layout = "VP8X",
  animated = false,
  alpha = false,
  trailing,
  truncated = false,
}: WebpOptions): Uint8Array {
  let chunk: Uint8Array;
  if (layout === "VP8X") {
    const flags = (animated ? 0x02 : 0) | (alpha ? 0x10 : 0);
    chunk = concat(ascii("VP8X"), le32(10), Uint8Array.from([flags, 0, 0, 0]), le24(width - 1), le24(height - 1));
  } else if (layout === "VP8L") {
    const bits = (width - 1) | ((height - 1) << 14) | ((alpha ? 1 : 0) << 28);
    chunk = concat(ascii("VP8L"), le32(10), Uint8Array.from([0x2f]), le32(bits >>> 0), new Uint8Array(5));
  } else {
    chunk = concat(
      ascii("VP8 "),
      le32(10),
      Uint8Array.from([0x10, 0x02, 0x00, 0x9d, 0x01, 0x2a]),
      le16(width),
      le16(height),
    );
  }
  const body = concat(ascii("WEBP"), chunk, new Uint8Array(8)); // some payload after the header chunk
  const riffSize = truncated ? body.length + 1000 : body.length;
  return concat(ascii("RIFF"), le32(riffSize), body, trailing ?? new Uint8Array());
}

// --- MP4 -----------------------------------------------------------------------------------------------------------

export interface Mp4Options {
  width: number;
  height: number;
  durationSeconds?: number;
  fps?: number;
  /** Sample entry of the video track: avc1 (H.264), hvc1 (HEVC), ... Default avc1. */
  videoCodec?: string;
  audio?: boolean;
  /** 0, 90, 180 or 270 degrees (phone footage is often stored rotated). */
  rotation?: 0 | 90 | 180 | 270;
  /** moov before mdat (streamable). Default true. */
  fastStart?: boolean;
  noVideoTrack?: boolean;
  noMoov?: boolean;
  trailing?: Uint8Array;
}

const box = (type: string, ...payload: Uint8Array[]) => {
  const body = concat(...payload);
  return concat(be32(body.length + 8), ascii(type), body);
};
const fullBox = (type: string, version: number, ...payload: Uint8Array[]) =>
  box(type, Uint8Array.from([version, 0, 0, 0]), ...payload);
const fixed = (n: number) => be32(Math.round(n * 65536));

function matrixFor(rotation: number): Uint8Array {
  const one = 0x10000;
  const m = [one, 0, 0, 0, one, 0, 0, 0, 0x40000000];
  if (rotation === 90) [m[0], m[1], m[3], m[4]] = [0, one, -one, 0];
  if (rotation === 180) [m[0], m[4]] = [-one, -one];
  if (rotation === 270) [m[0], m[1], m[3], m[4]] = [0, -one, one, 0];
  return concat(...m.map((v) => be32(v >>> 0)));
}

function track(
  kind: "vide" | "soun",
  codec: string,
  o: Required<Pick<Mp4Options, "width" | "height" | "rotation">>,
  seconds: number,
  fps: number,
) {
  const timescale = 1000;
  const duration = Math.round(seconds * timescale);
  const samples = kind === "vide" ? Math.round(seconds * fps) : Math.round(seconds * 43);
  const tkhd = fullBox(
    "tkhd",
    0,
    be32(0),
    be32(0),
    be32(kind === "vide" ? 1 : 2),
    be32(0),
    be32(duration),
    new Uint8Array(8),
    be16(0),
    be16(0),
    be16(kind === "soun" ? 0x100 : 0),
    be16(0),
    matrixFor(kind === "vide" ? o.rotation : 0),
    fixed(kind === "vide" ? o.width : 0),
    fixed(kind === "vide" ? o.height : 0),
  );
  const mdhd = fullBox("mdhd", 0, be32(0), be32(0), be32(timescale), be32(duration), be16(0x55c4), be16(0));
  const hdlr = fullBox("hdlr", 0, be32(0), ascii(kind), new Uint8Array(12), ascii("h\0"));
  const stsd = fullBox("stsd", 0, be32(1), box(codec, new Uint8Array(78)));
  const stts = fullBox("stts", 0, be32(1), be32(samples), be32(Math.round(duration / Math.max(1, samples))));
  return box("trak", tkhd, box("mdia", mdhd, hdlr, box("minf", box("stbl", stsd, stts))));
}

export function buildMp4({
  width,
  height,
  durationSeconds = 10,
  fps = 30,
  videoCodec = "avc1",
  audio = false,
  rotation = 0,
  fastStart = true,
  noVideoTrack = false,
  noMoov = false,
  trailing,
}: Mp4Options): Uint8Array {
  const ftyp = box("ftyp", ascii("isom"), be32(512), ascii("isomiso2avc1mp41"));
  const o = { width, height, rotation };
  const mvhd = fullBox(
    "mvhd",
    0,
    be32(0),
    be32(0),
    be32(1000),
    be32(Math.round(durationSeconds * 1000)),
    fixed(1),
    be16(0x100),
    new Uint8Array(10),
    matrixFor(0),
    new Uint8Array(24),
    be32(3),
  );
  const moov = box(
    "moov",
    mvhd,
    noVideoTrack ? new Uint8Array() : track("vide", videoCodec, o, durationSeconds, fps),
    audio ? track("soun", "mp4a", o, durationSeconds, fps) : new Uint8Array(),
  );
  const mdat = box("mdat", new Uint8Array(64).fill(1));
  const parts = noMoov ? [ftyp, mdat] : fastStart ? [ftyp, moov, mdat] : [ftyp, mdat, moov];
  return concat(...parts, trailing ?? new Uint8Array());
}
