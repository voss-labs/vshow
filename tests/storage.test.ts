// Storage layer: configuration, key policy, file-signature detection, the fail-closed provider, the Neon adapter
// (stubbed client; no network) and the in-memory fake. Live Neon behaviour (CORS, browser uploads, CopyObject on the
// real service) is deliberately NOT covered here and has not been verified.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { StorageConfigError, resolveStorageConfig } from "../app/storage/config.server.ts";
import { MEDIA_TYPES, detectMime, extensionFor, sanitizeFilename } from "../app/storage/file-types.ts";
import { finalKey, isStagingKey, stagingKey } from "../app/storage/keys.server.ts";
import { createNeonStorage, createS3Client, type S3Like } from "../app/storage/neon.server.ts";
import { StorageUnavailableError } from "../app/storage/object-storage.server.ts";
import { createStorage } from "../app/storage/provider.server.ts";
import { createUnconfiguredStorage } from "../app/storage/unconfigured.server.ts";
import { DEFAULT_MEDIA_POLICY, resolveMediaPolicy } from "../app/submissions/media-policy.server.ts";
import { captureLogs, runNode } from "./helpers.ts";
import { createMemoryStorage } from "./support/memory-storage.ts";

const SECRET = "nsk_live_TheSecretValue0123456789";
const KEYID = "nak_live_TheKeyId0123456789";
const VALID = {
  NEON_STORAGE_ENDPOINT: "https://br-test.storage.c-1.ap-southeast-1.aws.neon.tech",
  NEON_STORAGE_REGION: "ap-southeast-1",
  NEON_STORAGE_BUCKET: "vshow-media-dev",
  NEON_STORAGE_ACCESS_KEY_ID: KEYID,
  NEON_STORAGE_SECRET_ACCESS_KEY: SECRET,
};
const SUB = "11111111-1111-4111-8111-111111111111";
const VER = "22222222-2222-4222-8222-222222222222";

const bytes = (...v: number[]) => Uint8Array.from(v);
const ascii = (s: string) => Uint8Array.from(Buffer.from(s, "latin1"));
const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4);
const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0x10);
const WEBP = Uint8Array.from([...ascii("RIFF"), 0, 0, 0, 0, ...ascii("WEBP"), 1, 2]);
const MP4 = Uint8Array.from([0, 0, 0, 0x18, ...ascii("ftyp"), ...ascii("isom"), 0, 0, 2, 0]);

describe("storage configuration", () => {
  it("is null (storage simply unavailable) when no variable is set", () => {
    assert.equal(resolveStorageConfig({}), null);
    assert.equal(resolveStorageConfig({ NEON_STORAGE_BUCKET: "  " }), null);
  });

  it("accepts a complete configuration and normalises the endpoint", () => {
    const c = resolveStorageConfig(VALID);
    assert.equal(c?.bucket, "vshow-media-dev");
    assert.equal(c?.region, "ap-southeast-1");
    assert.equal(c?.endpoint, VALID.NEON_STORAGE_ENDPOINT);
  });

  it("refuses a partial configuration, naming only the variable", () => {
    for (const name of Object.keys(VALID)) {
      const env: Record<string, string> = { ...VALID };
      delete env[name];
      assert.throws(
        () => resolveStorageConfig(env),
        (e: unknown) => {
          assert.ok(e instanceof StorageConfigError);
          assert.match(e.message, new RegExp(name));
          assert.ok(!e.message.includes(SECRET) && !e.message.includes(KEYID));
          return true;
        },
      );
    }
  });

  it("refuses placeholders, non-https endpoints, endpoints with paths, and database URLs used as credentials", () => {
    const bad = (patch: Record<string, string>, re: RegExp) =>
      assert.throws(
        () => resolveStorageConfig({ ...VALID, ...patch }),
        (e: unknown) => re.test((e as Error).message),
      );
    bad({ NEON_STORAGE_SECRET_ACCESS_KEY: "change-me" }, /placeholder/);
    bad({ NEON_STORAGE_ENDPOINT: "http://example.neon.tech" }, /https/);
    bad({ NEON_STORAGE_ENDPOINT: "https://x.neon.tech/bucket" }, /origin only/);
    bad({ NEON_STORAGE_ENDPOINT: "not a url" }, /valid URL/);
    bad({ NEON_STORAGE_REGION: "Asia" }, /malformed/);
    bad({ NEON_STORAGE_BUCKET: "Bad_Bucket!" }, /malformed/);
    bad({ NEON_STORAGE_ACCESS_KEY_ID: "postgresql://u:p@h/db" }, /not a database URL/);
  });
});

describe("object-key policy", () => {
  it("builds keys only from UUIDs and a fixed extension; staging and final never coincide", () => {
    assert.equal(stagingKey(SUB, VER), `staging/${SUB}/${VER}`);
    assert.equal(finalKey(SUB, VER, "image/png"), `media/${SUB}/${VER}.png`);
    assert.ok(isStagingKey(stagingKey(SUB, VER)) && !isStagingKey(finalKey(SUB, VER, "video/mp4")));
    assert.notEqual(stagingKey(SUB, VER), finalKey(SUB, VER, "image/png"));
  });

  it("rejects anything that is not a UUID or a supported type (no filename can reach a key)", () => {
    assert.throws(() => stagingKey("../../etc/passwd", VER), /UUID/);
    assert.throws(() => finalKey(SUB, "photo.png", "image/png"), /UUID/);
    assert.throws(() => finalKey(SUB, VER, "application/x-msdownload"), /Unsupported/);
  });
});

describe("file types and signatures", () => {
  it("accepts exactly JPEG, PNG, WebP and MP4", () => {
    assert.deepEqual(MEDIA_TYPES.map((t) => t.mime).sort(), ["image/jpeg", "image/png", "image/webp", "video/mp4"]);
    assert.equal(extensionFor("video/mp4"), "mp4");
    assert.equal(extensionFor("image/gif"), null);
  });

  it("detects each type from the bytes, regardless of any declared type or name", () => {
    assert.equal(detectMime(JPEG), "image/jpeg");
    assert.equal(detectMime(PNG), "image/png");
    assert.equal(detectMime(WEBP), "image/webp");
    assert.equal(detectMime(MP4), "video/mp4");
  });

  it("rejects everything else, including disguised content", () => {
    assert.equal(detectMime(ascii("<html><script>alert(1)</script>")), null);
    assert.equal(detectMime(ascii("GIF89a....")), null);
    assert.equal(detectMime(ascii("MZ\x90\x00 executable")), null);
    assert.equal(detectMime(new Uint8Array()), null);
    assert.equal(detectMime(bytes(0x89, 0x50)), null, "truncated PNG signature");
    assert.equal(
      detectMime(Uint8Array.from([0, 0, 0, 0x14, ...ascii("ftyp"), ...ascii("qt  "), 0, 0, 0, 0])),
      null,
      "QuickTime brand",
    );
    assert.equal(
      detectMime(Uint8Array.from([...ascii("RIFF"), 0, 0, 0, 0, ...ascii("WAVE")])),
      null,
      "RIFF but not WebP",
    );
  });

  it("sanitizes display filenames (no paths, control characters or quotes)", () => {
    assert.equal(sanitizeFilename("../../etc/passwd"), "passwd");
    assert.equal(sanitizeFilename('C:\\evil\\a"b.png'), "ab.png");
    assert.equal(sanitizeFilename("  \u0000\u0007 "), "media");
    assert.equal(sanitizeFilename("x".repeat(500)).length, 200);
    assert.equal(sanitizeFilename("...hidden"), "hidden");
  });
});

describe("unconfigured provider and lazy selection", () => {
  it("refuses every operation with the same fixed error", async () => {
    const s = createUnconfiguredStorage();
    assert.equal(s.configured, false);
    const calls = [
      () => s.createUploadTarget({ key: "k", contentType: "image/png", sizeBytes: 1, ttlSeconds: 60 }),
      () => s.inspectObject("k"),
      () => s.readHead("k", 4),
      () => s.copyObject({ sourceKey: "a", destinationKey: "b", contentType: "image/png" }),
      () => s.createDownloadUrl("k", { filename: "f", contentType: "image/png", ttlSeconds: 60 }),
      () => s.deleteObject("k"),
    ];
    for (const call of calls) {
      await assert.rejects(
        call(),
        (e: unknown) => e instanceof StorageUnavailableError && e.message === "Media storage is not available.",
      );
    }
  });

  it("is chosen when nothing is configured; building it never throws or contacts anything", async () => {
    const log = captureLogs();
    const s = createStorage({}, log.logger);
    assert.equal(s.configured, false);
    await assert.rejects(s.inspectObject("k"), StorageUnavailableError);
    assert.ok(log.records().some((r) => r.msg === "media storage is not configured"));
  });

  it("falls back to fail-closed (never to another store) on an invalid configuration, logging only the variable name", async () => {
    const log = captureLogs();
    const s = createStorage({ ...VALID, NEON_STORAGE_BUCKET: "" }, log.logger);
    assert.equal(s.configured, false);
    await assert.rejects(
      s.createDownloadUrl("k", { filename: "f", contentType: "image/png", ttlSeconds: 60 }),
      StorageUnavailableError,
    );
    const rec = log.records().find((r) => r.msg === "media storage is not configured correctly");
    assert.match(String(rec?.reason), /NEON_STORAGE_BUCKET is not set/);
    assert.ok(!log.text().includes(SECRET) && !log.text().includes(KEYID));
  });

  it("is a configured Neon adapter for a complete valid configuration", () => {
    assert.equal(createStorage(VALID, captureLogs().logger).configured, true);
  });
});

describe("Neon adapter (stubbed client, no network)", () => {
  const config = resolveStorageConfig(VALID)!;
  const make = () => {
    const client = createS3Client(config);
    const sent: Array<{ name: string; input: Record<string, unknown> }> = [];
    let respond: (name: string, input: Record<string, unknown>) => unknown = () => ({});
    (client as unknown as { send: unknown }).send = async (cmd: {
      constructor: { name: string };
      input: Record<string, unknown>;
    }) => {
      sent.push({ name: cmd.constructor.name, input: cmd.input });
      return respond(cmd.constructor.name, cmd.input);
    };
    return {
      storage: createNeonStorage(config, client as unknown as S3Like),
      sent,
      on: (f: typeof respond) => (respond = f),
    };
  };

  it("presigns a PUT for the staging key with Content-Type and Content-Length signed, and no secret in the URL", async () => {
    const { storage } = make();
    const target = await storage.createUploadTarget({
      key: stagingKey(SUB, VER),
      contentType: "image/png",
      sizeBytes: 1234,
      ttlSeconds: 600,
    });
    const url = new URL(target.url);
    assert.equal(url.origin, VALID.NEON_STORAGE_ENDPOINT);
    assert.equal(url.pathname, `/vshow-media-dev/staging/${SUB}/${VER}`, "path-style addressing");
    assert.equal(target.method, "PUT");
    assert.deepEqual(target.headers, { "Content-Type": "image/png" });
    assert.equal(url.searchParams.get("X-Amz-Expires"), "600");
    const signed = (url.searchParams.get("X-Amz-SignedHeaders") ?? "").split(";");
    assert.ok(
      signed.includes("content-type") && signed.includes("content-length") && signed.includes("host"),
      signed.join(","),
    );
    assert.ok(!target.url.includes(SECRET), "the secret never appears in a URL");
    assert.ok(target.expiresAt.getTime() > Date.now());
  });

  it("presigns a download with a sanitized attachment filename", async () => {
    const { storage } = make();
    const u = new URL(
      await storage.createDownloadUrl(finalKey(SUB, VER, "image/png"), {
        filename: 'evil"\r\nname.png',
        contentType: "image/png",
        ttlSeconds: 120,
      }),
    );
    const cd = u.searchParams.get("response-content-disposition") ?? "";
    assert.match(cd, /^attachment; filename="[^"\r\n]+"$/);
    assert.equal(u.searchParams.get("X-Amz-Expires"), "120");
    assert.equal(u.pathname, `/vshow-media-dev/media/${SUB}/${VER}.png`);
  });

  it("presigns an inline (preview) URL when asked, an attachment by default, with the validated content type", async () => {
    const { storage } = make();
    const key = finalKey(SUB, VER, "image/png");
    const url = async (disposition?: "inline" | "attachment") =>
      new URL(
        await storage.createDownloadUrl(key, {
          filename: "x.png",
          contentType: "image/png",
          ttlSeconds: 900,
          disposition,
        }),
      );
    assert.match(
      String((await url()).searchParams.get("response-content-disposition")),
      /^attachment; filename="x\.png"$/,
    );
    const inline = await url("inline");
    assert.equal(inline.searchParams.get("response-content-disposition"), 'inline; filename="x.png"');
    assert.equal(inline.searchParams.get("response-content-type"), "image/png");
    assert.equal(inline.searchParams.get("X-Amz-Expires"), "900");
    assert.equal(inline.pathname, `/vshow-media-dev/media/${SUB}/${VER}.png`);
  });

  it("inspect returns metadata, or null for a missing object, and rethrows other errors", async () => {
    const { storage, on } = make();
    on(() => ({ ContentLength: 10, ContentType: "image/png", ETag: '"abc"' }));
    assert.deepEqual(await storage.inspectObject("k"), { size: 10, contentType: "image/png", etag: "abc" });
    on(() => {
      throw Object.assign(new Error("nope"), { name: "NotFound", $metadata: { httpStatusCode: 404 } });
    });
    assert.equal(await storage.inspectObject("k"), null);
    on(() => {
      throw Object.assign(new Error("denied"), { name: "AccessDenied", $metadata: { httpStatusCode: 403 } });
    });
    await assert.rejects(storage.inspectObject("k"), /denied/);
  });

  it("reads only the requested leading bytes using a Range request", async () => {
    const { storage, sent, on } = make();
    on(() => ({ Body: { transformToByteArray: async () => new Uint8Array(100).fill(7) } }));
    const head = await storage.readHead("k", 32);
    assert.equal(head.length, 32, "a store that ignores Range cannot make us keep more");
    assert.equal(sent.at(-1)?.input.Range, "bytes=0-31");
  });

  it("copies to a new key with replaced metadata and an encoded source", async () => {
    const { storage, sent } = make();
    await storage.copyObject({
      sourceKey: stagingKey(SUB, VER),
      destinationKey: finalKey(SUB, VER, "video/mp4"),
      contentType: "video/mp4",
    });
    const s = sent.at(-1)!;
    assert.equal(s.name, "CopyObjectCommand");
    assert.equal(s.input.Bucket, "vshow-media-dev");
    assert.equal(s.input.Key, `media/${SUB}/${VER}.mp4`);
    assert.equal(s.input.CopySource, `vshow-media-dev/staging/${SUB}/${VER}`);
    assert.equal(s.input.ContentType, "video/mp4");
    assert.equal(s.input.MetadataDirective, "REPLACE");
    assert.ok(!("CopySourceIfMatch" in s.input), "no reliance on conditional copy");
  });

  it("deletes exactly the key it is given", async () => {
    const { storage, sent } = make();
    await storage.deleteObject("staging/x/y");
    assert.deepEqual([sent.at(-1)?.name, sent.at(-1)?.input.Key], ["DeleteObjectCommand", "staging/x/y"]);
  });
});

describe("in-memory fake", () => {
  const target = async (s: ReturnType<typeof createMemoryStorage>, size = PNG.length, ttl = 600) =>
    s.createUploadTarget({ key: stagingKey(SUB, VER), contentType: "image/png", sizeBytes: size, ttlSeconds: ttl });

  it("stores an upload, inspects it, and reads its head", async () => {
    const s = createMemoryStorage();
    s.upload(await target(s), PNG);
    const info = await s.inspectObject(stagingKey(SUB, VER));
    assert.equal(info?.size, PNG.length);
    assert.deepEqual([...(await s.readHead(stagingKey(SUB, VER), 4))], [...PNG.slice(0, 4)]);
  });

  it("enforces the signed length and type, but a URL can be REUSED (the threat the design must survive)", async () => {
    const s = createMemoryStorage();
    const t = await target(s);
    assert.throws(() => s.upload(t, new Uint8Array(PNG.length + 1)), /length/);
    assert.throws(() => s.upload(t, PNG, "text/html"), /Content-Type/);
    s.upload(t, PNG);
    const other = Uint8Array.from(PNG).fill(9, 8);
    s.upload(t, other); // reuse: overwrites the staging object
    assert.deepEqual([...s.get(stagingKey(SUB, VER))!.bytes], [...other]);
  });

  it("refuses expired targets", async () => {
    const s = createMemoryStorage();
    const t = await target(s, PNG.length, -1);
    assert.throws(() => s.upload(t, PNG), /expired/);
  });

  it("copy never overwrites an existing destination and snapshots the bytes", async () => {
    const s = createMemoryStorage();
    s.put("a", PNG, "image/png");
    await s.copyObject({ sourceKey: "a", destinationKey: "b", contentType: "image/png" });
    s.put("a", JPEG, "image/jpeg"); // later change of the source...
    assert.deepEqual([...s.get("b")!.bytes], [...PNG], "...does not affect the copy");
    await assert.rejects(
      s.copyObject({ sourceKey: "a", destinationKey: "b", contentType: "image/png" }),
      /already exists/,
    );
  });

  it("records every call and can inject failures", async () => {
    const s = createMemoryStorage();
    await s.inspectObject("k");
    s.failNext("deleteObject");
    await assert.rejects(s.deleteObject("k"), StorageUnavailableError);
    await s.deleteObject("k");
    assert.deepEqual(
      s.calls.map((c) => c.method),
      ["inspectObject", "deleteObject", "deleteObject"],
    );
  });
});

describe("media policy", () => {
  it("defaults to 100 MiB and 10 windows", () => {
    assert.equal(DEFAULT_MEDIA_POLICY.maxBytes, 104857600);
    assert.equal(DEFAULT_MEDIA_POLICY.maxWindows, 10);
    assert.deepEqual(resolveMediaPolicy({}), { policy: DEFAULT_MEDIA_POLICY, invalid: [] });
  });

  it("honours valid overrides and ignores invalid ones, reporting only the variable names", () => {
    const { policy, invalid } = resolveMediaPolicy({
      MEDIA_MAX_BYTES: "52428800",
      MAX_REQUEST_WINDOWS: "25",
      UPLOAD_URL_TTL_SECONDS: "5",
      DOWNLOAD_URL_TTL_SECONDS: "abc",
    });
    assert.equal(policy.maxBytes, 52428800);
    assert.equal(policy.maxWindows, 25);
    assert.equal(policy.uploadUrlTtlSeconds, DEFAULT_MEDIA_POLICY.uploadUrlTtlSeconds);
    assert.deepEqual(invalid.sort(), ["DOWNLOAD_URL_TTL_SECONDS", "UPLOAD_URL_TTL_SECONDS"]);
    assert.equal(policy.previewUrlTtlSeconds, 900, "a preview lives longer than a download so video can seek");
    assert.equal(resolveMediaPolicy({ PREVIEW_URL_TTL_SECONDS: "1800" }).policy.previewUrlTtlSeconds, 1800);
    assert.deepEqual(resolveMediaPolicy({ PREVIEW_URL_TTL_SECONDS: "5" }).invalid, ["PREVIEW_URL_TTL_SECONDS"]);
  });
});

describe("manual sweep script", () => {
  it("does nothing without --run (it only explains itself)", () => {
    const r = runNode(["scripts/storage-sweep.ts"], { DATABASE_URL: "", DB_TARGET: "local" });
    assert.equal(r.status, 2);
    assert.match(r.stdout, /--run/);
    assert.equal(r.stderr, "");
  });

  it("with --run but no storage configured it changes nothing and says so", () => {
    const r = runNode(["scripts/storage-sweep.ts", "--run"], {
      DB_TARGET: "local",
      DATABASE_URL: "postgresql://vshow:placeholder-pw@127.0.0.1:1/vshow_test_none",
      NEON_STORAGE_ENDPOINT: "",
      NEON_STORAGE_REGION: "",
      NEON_STORAGE_BUCKET: "",
      NEON_STORAGE_ACCESS_KEY_ID: "",
      NEON_STORAGE_SECRET_ACCESS_KEY: "",
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /not configured/);
    assert.ok(!r.stdout.includes("placeholder-pw") && !r.stderr.includes("placeholder-pw"));
  });
});
