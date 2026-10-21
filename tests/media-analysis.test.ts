import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  analyzeJpeg,
  analyzeMp4,
  analyzePng,
  analyzeWebp,
  describeAspect,
  failedChecks,
  type MediaAnalysis,
} from "../app/media/analysis.ts";
import { analyzeStoredMedia } from "../app/media/analyze.server.ts";
import { buildJpeg, buildMp4, buildPng, buildWebp } from "./support/media-builders.ts";
import { createMemoryStorage } from "./support/memory-storage.ts";

const limits = { maxPixels: 100_000_000 };
const png = (b: Uint8Array) => analyzePng(b, b.subarray(Math.max(0, b.length - 65536)), limits);
const jpeg = (b: Uint8Array) => analyzeJpeg(b, b.subarray(Math.max(0, b.length - 65536)), limits);
const webp = (b: Uint8Array) => analyzeWebp(b, b.length, limits);
const mp4 = (b: Uint8Array) => analyzeMp4(async (s, e) => b.slice(s, e + 1), b.length, limits);

const codes = (a: MediaAnalysis, level?: string) =>
  a.checks.filter((c) => !level || c.level === level).map((c) => c.code);

describe("aspect ratio", () => {
  it("labels common ratios and orientation", () => {
    assert.deepEqual(describeAspect(1920, 1080), { w: 16, h: 9, label: "16:9", orientation: "landscape" });
    assert.equal(describeAspect(1366, 768).label, "16:9");
    assert.equal(describeAspect(1080, 1920).label, "9:16");
    assert.equal(describeAspect(1080, 1920).orientation, "portrait");
    assert.equal(describeAspect(1000, 1000).orientation, "square");
  });
  it("has no label for an unusual ratio but still reduces it", () => {
    const a = describeAspect(1000, 333);
    assert.equal(a.label, null);
    assert.equal(a.orientation, "landscape");
  });
});

describe("PNG", () => {
  it("describes a valid file", () => {
    const a = png(buildPng({ width: 1920, height: 1080 }));
    assert.equal(a.format, "PNG");
    assert.equal(a.width, 1920);
    assert.equal(a.height, 1080);
    assert.equal(a.aspect.label, "16:9");
    assert.equal(a.megapixels, 2.07);
    assert.deepEqual(failedChecks(a), []);
    assert.ok(codes(a, "pass").includes("structure_ok"));
    assert.ok(codes(a, "pass").includes("no_hidden_data"));
  });
  it("flags transparency, animation, low resolution and trailing data", () => {
    assert.equal(png(buildPng({ width: 1920, height: 1080, colorType: 6 })).hasAlpha, true);
    assert.equal(png(buildPng({ width: 1920, height: 1080, transparency: true })).hasAlpha, true);
    assert.ok(codes(png(buildPng({ width: 1920, height: 1080, animated: true })), "warn").includes("animated"));
    assert.ok(codes(png(buildPng({ width: 320, height: 180 })), "warn").includes("low_resolution"));
    const t = png(buildPng({ width: 1920, height: 1080, trailing: new Uint8Array(40).fill(1) }));
    assert.ok(codes(t, "warn").includes("trailing_data"));
    assert.deepEqual(failedChecks(t), [], "trailing data is a warning, not a rejection");
  });
  it("flags script-like content hidden after the image", () => {
    const hidden = Uint8Array.from(Buffer.from("<script>alert(1)</script>"));
    const a = png(buildPng({ width: 1920, height: 1080, trailing: hidden }));
    assert.ok(codes(a, "warn").includes("active_content"));
  });
  it("rejects truncated, zero-sized and oversized-pixel files", () => {
    assert.ok(codes(png(buildPng({ width: 1920, height: 1080, truncated: true })), "fail").includes("truncated_file"));
    assert.ok(codes(png(buildPng({ width: 0, height: 10 })), "fail").includes("invalid_dimensions"));
    assert.ok(codes(png(buildPng({ width: 20000, height: 20000 })), "fail").includes("too_many_pixels"));
    assert.ok(
      codes(png(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2])), "fail").includes(
        "unreadable_image",
      ),
    );
  });
  it("honours a configured pixel limit", () => {
    const b = buildPng({ width: 4000, height: 3000 });
    assert.deepEqual(failedChecks(analyzePng(b, b, { maxPixels: 20_000_000 })), []);
    assert.deepEqual(
      failedChecks(analyzePng(b, b, { maxPixels: 10_000_000 })).map((c) => c.code),
      ["too_many_pixels"],
    );
  });
});

describe("JPEG", () => {
  it("describes a valid file", () => {
    const a = jpeg(buildJpeg({ width: 1080, height: 1920 }));
    assert.equal(a.format, "JPEG");
    assert.equal(a.aspect.label, "9:16");
    assert.deepEqual(failedChecks(a), []);
  });
  it("swaps the displayed dimensions for a rotated EXIF orientation", () => {
    const a = jpeg(buildJpeg({ width: 1920, height: 1080, orientation: 6 }));
    assert.equal(a.width, 1080);
    assert.equal(a.height, 1920);
    assert.ok(codes(a, "info").includes("orientation_applied"));
    assert.equal(jpeg(buildJpeg({ width: 1920, height: 1080, orientation: 1 })).width, 1920);
  });
  it("warns about GPS location, CMYK, trailing data", () => {
    assert.ok(codes(jpeg(buildJpeg({ width: 1920, height: 1080, gps: true })), "warn").includes("location_metadata"));
    assert.ok(
      codes(jpeg(buildJpeg({ width: 1920, height: 1080, components: 4, adobe: true })), "warn").includes("cmyk_color"),
    );
    assert.ok(
      codes(jpeg(buildJpeg({ width: 1920, height: 1080, trailing: new Uint8Array(30).fill(2) })), "warn").includes(
        "trailing_data",
      ),
    );
  });
  it("rejects files without a frame, truncated files and pixel bombs", () => {
    assert.ok(
      codes(jpeg(buildJpeg({ width: 1920, height: 1080, noFrame: true })), "fail").includes("unreadable_image"),
    );
    assert.ok(
      codes(jpeg(buildJpeg({ width: 1920, height: 1080, truncated: true })), "fail").includes("truncated_file"),
    );
    assert.ok(codes(jpeg(buildJpeg({ width: 60000, height: 60000 })), "fail").includes("too_many_pixels"));
  });
});

describe("WebP", () => {
  it("reads all three layouts", () => {
    for (const layout of ["VP8X", "VP8L", "VP8 "] as const) {
      const a = webp(buildWebp({ width: 1920, height: 1080, layout }));
      assert.equal(a.format, "WebP", layout);
      assert.equal(a.width, 1920, layout);
      assert.equal(a.height, 1080, layout);
      assert.deepEqual(failedChecks(a), [], layout);
    }
  });
  it("detects alpha and animation", () => {
    assert.equal(webp(buildWebp({ width: 1920, height: 1080, alpha: true })).hasAlpha, true);
    assert.equal(webp(buildWebp({ width: 1920, height: 1080, animated: true })).animated, true);
  });
  it("rejects truncated and malformed files", () => {
    assert.ok(
      codes(webp(buildWebp({ width: 1920, height: 1080, truncated: true })), "fail").includes("truncated_file"),
    );
    assert.ok(codes(webp(new Uint8Array(40)), "fail").includes("unreadable_image"));
  });
});

describe("MP4", () => {
  it("describes a valid streamable file", async () => {
    const a = await mp4(buildMp4({ width: 1920, height: 1080, durationSeconds: 12, fps: 30, audio: true }));
    assert.equal(a.kind, "video");
    assert.equal(a.width, 1920);
    assert.equal(a.height, 1080);
    assert.equal(a.aspect.label, "16:9");
    assert.equal(a.video?.durationSeconds, 12);
    assert.equal(a.video?.fps, 30);
    assert.equal(a.video?.hasAudio, true);
    assert.equal(a.video?.videoCodec, "H.264");
    assert.deepEqual(failedChecks(a), []);
    assert.ok(codes(a, "pass").includes("streamable"));
  });
  it("applies rotation, notes missing audio, warns on late moov and uncommon codecs", async () => {
    const rotated = await mp4(buildMp4({ width: 1920, height: 1080, rotation: 90 }));
    assert.equal(rotated.width, 1080);
    assert.equal(rotated.height, 1920);
    assert.ok(codes(rotated, "info").includes("no_audio"));
    assert.ok(
      codes(await mp4(buildMp4({ width: 1920, height: 1080, fastStart: false })), "warn").includes("not_streamable"),
    );
    assert.ok(
      codes(await mp4(buildMp4({ width: 1920, height: 1080, videoCodec: "hvc1" })), "warn").includes(
        "uncommon_video_codec",
      ),
    );
  });
  it("rejects files without moov or video track and truncated files", async () => {
    assert.ok(
      codes(await mp4(buildMp4({ width: 1920, height: 1080, noMoov: true })), "fail").includes("unreadable_video"),
    );
    assert.ok(
      codes(await mp4(buildMp4({ width: 1920, height: 1080, noVideoTrack: true })), "fail").includes("no_video_track"),
    );
    const whole = buildMp4({ width: 1920, height: 1080 });
    assert.ok(failedChecks(await mp4(whole.slice(0, 60))).length > 0);
  });
});

describe("analyzeStoredMedia", () => {
  it("reads images and videos through ranged reads", async () => {
    const storage = createMemoryStorage();
    storage.put("a", buildPng({ width: 1920, height: 1080 }), "image/png");
    storage.put("v", buildMp4({ width: 1280, height: 720 }), "video/mp4");
    const pngBytes = buildPng({ width: 1920, height: 1080 });
    assert.equal((await analyzeStoredMedia(storage, "a", "image/png", pngBytes.length, limits)).width, 1920);
    const mp4Bytes = buildMp4({ width: 1280, height: 720 });
    assert.equal((await analyzeStoredMedia(storage, "v", "video/mp4", mp4Bytes.length, limits)).height, 720);
  });
  it("handles an image larger than the head window (tail read separately)", async () => {
    const storage = createMemoryStorage();
    const big = buildPng({ width: 3840, height: 2160, dataBytes: 1_200_000, trailing: new Uint8Array(100).fill(3) });
    storage.put("big", big, "image/png");
    const a = await analyzeStoredMedia(storage, "big", "image/png", big.length, limits);
    assert.equal(a.width, 3840);
    assert.ok(codes(a, "warn").includes("trailing_data"));
  });
});

describe("fuzz", () => {
  it("never throws on truncated or corrupted input", async () => {
    let seed = 12345;
    const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const samples = [
      buildPng({ width: 1920, height: 1080, colorType: 6 }),
      buildJpeg({ width: 1920, height: 1080, orientation: 6, gps: true }),
      buildWebp({ width: 1920, height: 1080 }),
      buildMp4({ width: 1920, height: 1080, audio: true }),
    ];
    for (const [idx, base] of samples.entries()) {
      for (let n = 0; n < 150; n++) {
        const b = base.slice(0, Math.floor(rand() * (base.length + 1)));
        for (let k = 0; k < 4 && b.length; k++) b[Math.floor(rand() * b.length)] = Math.floor(rand() * 256);
        const run = () => (idx === 0 ? png(b) : idx === 1 ? jpeg(b) : idx === 2 ? webp(b) : mp4(b));
        const a = await run();
        assert.ok(a.checks.length > 0);
      }
    }
  });
});
