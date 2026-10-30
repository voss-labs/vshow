// Media upload, finalization, cleanup and download against a real migrated database and the in-memory object store.
// What this proves is the SERVER side of the design: authorization before storage, validation of the bytes that are
// actually recorded, immutability of finalized media, and safe cleanup. It does NOT prove that Neon Object Storage
// accepts these operations or that a real browser can upload (those checks are deferred).
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { StorageUnavailableError } from "../app/storage/object-storage.server.ts";
import { createUnconfiguredStorage } from "../app/storage/unconfigured.server.ts";
import { WorkflowError, type WorkflowErrorCode } from "../app/submissions/errors.ts";
import { isHandoffEligible } from "../app/submissions/queries.server.ts";
import { decide } from "../app/submissions/reviews.server.ts";
import { createDraft, saveDraft, submitForReview } from "../app/submissions/submissions.server.ts";
import {
  MAX_OPEN_RESERVATIONS,
  createMediaDownloadUrl,
  deleteUnreferenced,
  finalizeUpload,
  initUpload,
  sweepAbandonedUploads,
} from "../app/submissions/uploads.server.ts";
import type { MediaAnalysis } from "../app/media/analysis.ts";
import { buildJpeg, buildPng } from "./support/media-builders.ts";
import { HTML, JPEG, MP4, PNG, PNG2, createWorkflowHarness, type PersonKey } from "./support/workflow-harness.ts";

const h = await createWorkflowHarness("vshow_test_wfup");
const opts = { skip: h.skipReason || false };
after(async () => {
  if (!h.skipReason) await h.close();
});

const NOW = new Date("2030-01-01T00:00:00Z");
const win = (screenId: string) => ({ screenId, startAt: "2030-02-01T10:00", endAt: "2030-02-01T12:00" });

async function expectCode(p: Promise<unknown>, code: WorkflowErrorCode) {
  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof WorkflowError, `expected WorkflowError(${code}), got ${String(e)}`);
    assert.equal(e.code, code);
    return true;
  });
}
const newDraft = async (who: PersonKey = "convener") =>
  createDraft(h.deps, await h.actor(who), { committeeId: h.ids.media, title: "Poster" });
const init = async (who: PersonKey, id: string, bytes = PNG, type = "image/png") =>
  initUpload(h.deps, await h.actor(who), id, { filename: "a.png", contentType: type, sizeBytes: bytes.length });
const versions = (id: string) =>
  h.q<{ id: string; version_number: number; object_key: string; storage_etag: string | null; size_bytes: number }>(
    "select id, version_number, object_key, storage_etag, size_bytes from media_version where submission_id=$1 order by version_number",
    [id],
  );
const reservation = async (id: string) =>
  (
    await h.q<{ status: string; failure_reason: string | null }>(
      "select status, failure_reason from upload_reservation where id=$1",
      [id],
    )
  )[0];
async function withMedia(who: PersonKey = "convener", bytes = PNG, type = "image/png") {
  const s = await newDraft(who);
  const i = await init(who, s.id, bytes, type);
  h.storage.upload(i.upload, bytes);
  const v = await finalizeUpload(h.deps, await h.actor(who), s.id, i.reservationId);
  return { id: s.id, ...v, reservationId: i.reservationId, upload: i.upload };
}
async function submittedWithMedia(who: PersonKey = "convener") {
  const m = await withMedia(who);
  const a = await h.actor(who);
  await saveDraft(h.deps, a, m.id, { title: "Poster", windows: [win(h.ids.lobby)] });
  const r = await submitForReview(h.deps, a, m.id, NOW);
  return { ...m, revisionId: r.revisionId };
}

describe("reserving an upload", () => {
  it(
    "returns a short-lived URL for a STAGING key only, never the final key or one built from the filename",
    opts,
    async () => {
      const s = await newDraft();
      h.resetStorageCalls();
      const i = await initUpload(h.deps, await h.actor("convener"), s.id, {
        filename: "../../evil name.png",
        contentType: "image/png",
        sizeBytes: PNG.length,
      });
      const [r] = await h.q<{ staging_key: string; final_key: string; original_filename: string }>(
        "select staging_key, final_key, original_filename from upload_reservation where id=$1",
        [i.reservationId],
      );
      assert.equal(r.staging_key, `staging/${s.id}/${i.reservationId}`);
      assert.equal(r.final_key, `media/${s.id}/${i.reservationId}.png`);
      assert.equal(r.original_filename, "evil name.png", "display name is sanitized");
      assert.ok(!r.staging_key.includes("evil") && !r.final_key.includes("evil"), "a filename never reaches a key");
      assert.deepEqual(
        h.storage.calls,
        [{ method: "createUploadTarget", key: r.staging_key }],
        "an upload URL exists ONLY for the staging key",
      );
      assert.equal(i.upload.method, "PUT");
      assert.equal(i.maxBytes, 100 * 1024 * 1024);
    },
  );

  it("unauthorized callers never reach storage and leave no reservation behind", opts, async () => {
    const s = await newDraft();
    h.resetStorageCalls();
    for (const who of [
      "convenerOther",
      "lapsed",
      "member",
      "reviewer",
      "manager",
      "admin",
      "unassigned",
    ] as PersonKey[]) {
      await expectCode(init(who, s.id), "not_found");
    }
    assert.deepEqual(h.storage.calls, []);
    assert.equal((await h.q("select 1 from upload_reservation where submission_id=$1", [s.id])).length, 0);
  });

  it("rejects unsupported types and oversized files BEFORE touching storage", opts, async () => {
    const s = await newDraft();
    const a = await h.actor("convener");
    h.resetStorageCalls();
    for (const type of ["image/gif", "application/pdf", "text/html", "video/quicktime", "image/svg+xml"]) {
      await expectCode(
        initUpload(h.deps, a, s.id, { filename: "x", contentType: type, sizeBytes: 10 }),
        "validation_failed",
      );
    }
    await expectCode(
      initUpload(h.deps, a, s.id, { filename: "x", contentType: "image/png", sizeBytes: 100 * 1024 * 1024 + 1 }),
      "validation_failed",
    );
    await initUpload(h.deps, a, s.id, {
      filename: "x",
      contentType: "IMAGE/PNG; charset=binary",
      sizeBytes: 100 * 1024 * 1024,
    }); // limit is inclusive; type is normalized
    h.setMedia({ maxBytes: 1024 }); // configurable
    await expectCode(
      initUpload(h.deps, a, s.id, { filename: "x", contentType: "image/png", sizeBytes: 2048 }),
      "validation_failed",
    );
    h.setMedia({ maxBytes: 100 * 1024 * 1024 });
    assert.equal(h.storage.calls.length, 1, "only the one valid request created an upload target");
  });

  it("fails closed when storage is not configured: no reservation is written", opts, async () => {
    const s = await newDraft();
    const unconfigured = { ...h.deps, storage: createUnconfiguredStorage() };
    await expectCode(
      initUpload(unconfigured, await h.actor("convener"), s.id, {
        filename: "a.png",
        contentType: "image/png",
        sizeBytes: 16,
      }),
      "storage_unavailable",
    );
    assert.equal((await h.q("select 1 from upload_reservation where submission_id=$1", [s.id])).length, 0);
  });

  it("a storage failure while creating the target closes the reservation", opts, async () => {
    const s = await newDraft();
    h.storage.failNext("createUploadTarget", new StorageUnavailableError());
    await expectCode(init("convener", s.id), "storage_unavailable");
    const rows = await h.q<{ status: string; failure_reason: string }>(
      "select status, failure_reason from upload_reservation where submission_id=$1",
      [s.id],
    );
    assert.deepEqual(rows, [{ status: "REJECTED", failure_reason: "target_failed" }]);
  });

  it("limits the number of open reservations per submission, and expired ones stop counting", opts, async () => {
    const s = await newDraft();
    const a = await h.actor("convener");
    const open = () => initUpload(h.deps, a, s.id, { filename: "a.png", contentType: "image/png", sizeBytes: 16 }, NOW);
    for (let i = 0; i < MAX_OPEN_RESERVATIONS; i++) await open();
    await expectCode(open(), "too_many_uploads");
    const later = new Date(NOW.getTime() + 3600_000); // past every reservation's expiry
    await initUpload(h.deps, a, s.id, { filename: "a.png", contentType: "image/png", sizeBytes: 16 }, later);
  });
});

describe("finalizing an upload", () => {
  it(
    "copies to the final key, validates THAT object, records it, makes it current, and removes staging",
    opts,
    async () => {
      const s = await newDraft();
      const i = await init("convener", s.id);
      h.storage.upload(i.upload, PNG);
      const v = await finalizeUpload(h.deps, await h.actor("convener"), s.id, i.reservationId);
      assert.deepEqual([v.versionNumber, v.alreadyFinalized], [1, false]);
      const [row] = await versions(s.id);
      assert.equal(row.object_key, `media/${s.id}/${i.reservationId}.png`);
      assert.equal(row.id, i.reservationId, "the reserved id became the version id");
      assert.equal(Number(row.size_bytes), PNG.length);
      const info = await h.storage.inspectObject(row.object_key);
      assert.equal(row.storage_etag, info?.etag, "the recorded ETag is the ETag of the stored final object");
      assert.deepEqual([...h.storage.get(row.object_key)!.bytes], [...PNG]);
      assert.ok(!h.storage.has(`staging/${s.id}/${i.reservationId}`), "the staging object is removed");
      assert.equal(
        (await h.q<{ v: string }>("select current_version_id v from submission where id=$1", [s.id]))[0].v,
        row.id,
      );
      assert.equal((await reservation(i.reservationId)).status, "FINALIZED");
      assert.ok(
        (await h.q<{ action: string }>("select action from audit_event where submission_id=$1", [s.id])).some(
          (r) => r.action === "MEDIA_VERSION_UPLOADED",
        ),
      );
    },
  );

  it("accepts each allowed type by its real signature (JPEG, PNG, MP4)", opts, async () => {
    await withMedia("convener", JPEG, "image/jpeg");
    await withMedia("convener", PNG, "image/png");
    await withMedia("convener", MP4, "video/mp4");
  });

  it("numbers versions 1, 2, 3 and keeps every earlier version", opts, async () => {
    const s = await newDraft();
    for (const bytes of [PNG, PNG2, PNG]) {
      const i = await init("convener", s.id, bytes);
      h.storage.upload(i.upload, bytes);
      await finalizeUpload(h.deps, await h.actor("convener"), s.id, i.reservationId);
    }
    assert.deepEqual(
      (await versions(s.id)).map((v) => v.version_number),
      [1, 2, 3],
    );
    for (const v of await versions(s.id)) assert.ok(h.storage.has(v.object_key), "no earlier version is removed");
  });

  const rejected = async (
    name: string,
    prepare: (s: { id: string; i: Awaited<ReturnType<typeof init>> }) => void,
    reason: string,
  ) =>
    it(`${name}: nothing is recorded and the objects are removed (${reason})`, opts, async () => {
      const s = await newDraft();
      const i = await init("convener", s.id);
      prepare({ id: s.id, i });
      await assert.rejects(finalizeUpload(h.deps, await h.actor("convener"), s.id, i.reservationId), (e: unknown) => {
        assert.ok(e instanceof WorkflowError && e.code === "upload_rejected");
        assert.deepEqual(e.issues, [{ path: "file", code: reason }]);
        return true;
      });
      assert.deepEqual(await versions(s.id), [], "no media version");
      assert.equal(
        (await h.q<{ v: string | null }>("select current_version_id v from submission where id=$1", [s.id]))[0].v,
        null,
      );
      assert.deepEqual(await reservation(i.reservationId), { status: "REJECTED", failure_reason: reason });
      assert.ok(
        !h.storage.has(`staging/${s.id}/${i.reservationId}`) && !h.storage.has(`media/${s.id}/${i.reservationId}.png`),
      );
      assert.ok(
        !(await h.q<{ action: string }>("select action from audit_event where submission_id=$1", [s.id])).some(
          (r) => r.action === "MEDIA_VERSION_UPLOADED",
        ),
      );
    });
  rejected(
    "wrong size (shorter than declared)",
    ({ id, i }) => h.storage.put(`staging/${id}/${i.reservationId}`, PNG.slice(0, 10), "image/png"),
    "size_mismatch",
  );
  rejected(
    "wrong size (longer than declared)",
    ({ id, i }) => h.storage.put(`staging/${id}/${i.reservationId}`, new Uint8Array([...PNG, 1]), "image/png"),
    "size_mismatch",
  );
  rejected(
    "not an image: HTML bytes labelled image/png",
    ({ id, i }) =>
      h.storage.put(
        `staging/${id}/${i.reservationId}`,
        new Uint8Array(PNG.length).map((_, n) => HTML[n % HTML.length]),
        "image/png",
      ),
    "signature_mismatch",
  );
  rejected(
    "a JPEG uploaded under a PNG reservation",
    ({ id, i }) =>
      h.storage.put(
        `staging/${id}/${i.reservationId}`,
        Uint8Array.from({ length: PNG.length }, (_, n) => JPEG[n] ?? 0),
        "image/png",
      ),
    "signature_mismatch",
  );
  rejected(
    "a final object whose stored content type differs from the declared one (leftover of an earlier attempt)",
    ({ id, i }) => {
      h.storage.put(`staging/${id}/${i.reservationId}`, PNG, "image/png");
      h.storage.put(`media/${id}/${i.reservationId}.png`, PNG, "text/html");
    },
    "type_mismatch",
  );

  it(
    "a file larger than the configured maximum is rejected even if the reservation was made earlier",
    opts,
    async () => {
      const s = await newDraft();
      const i = await init("convener", s.id);
      h.storage.upload(i.upload, PNG);
      h.setMedia({ maxBytes: 8 }); // limit lowered after the reservation
      try {
        await expectCode(finalizeUpload(h.deps, await h.actor("convener"), s.id, i.reservationId), "upload_rejected");
      } finally {
        h.setMedia({ maxBytes: 100 * 1024 * 1024 });
      }
      assert.deepEqual(await versions(s.id), []);
    },
  );

  it(
    "finalizing before the upload exists records nothing and leaves the reservation open for a retry",
    opts,
    async () => {
      const s = await newDraft();
      const i = await init("convener", s.id);
      await expectCode(finalizeUpload(h.deps, await h.actor("convener"), s.id, i.reservationId), "upload_missing");
      assert.deepEqual(await versions(s.id), []);
      assert.equal((await reservation(i.reservationId)).status, "PENDING");
      h.storage.upload(i.upload, PNG);
      await finalizeUpload(h.deps, await h.actor("convener"), s.id, i.reservationId);
      assert.equal((await versions(s.id)).length, 1);
    },
  );

  it("an expired reservation cannot be finalized", opts, async () => {
    const s = await newDraft();
    const a = await h.actor("convener");
    const i = await initUpload(
      h.deps,
      a,
      s.id,
      { filename: "a.png", contentType: "image/png", sizeBytes: PNG.length },
      NOW,
    );
    h.storage.put(`staging/${s.id}/${i.reservationId}`, PNG, "image/png");
    await expectCode(
      finalizeUpload(h.deps, a, s.id, i.reservationId, new Date(NOW.getTime() + 24 * 3600_000)),
      "upload_closed",
    );
    assert.deepEqual(await versions(s.id), []);
    assert.equal((await reservation(i.reservationId)).status, "EXPIRED");
  });

  it(
    "only the person who reserved the upload may finalize it, and unauthorized callers never reach storage",
    opts,
    async () => {
      const s = await newDraft();
      const i = await init("convener", s.id);
      h.storage.upload(i.upload, PNG);
      h.resetStorageCalls();
      for (const who of ["convener2", "convenerOther", "lapsed", "reviewer", "admin", "unassigned"] as PersonKey[]) {
        await expectCode(finalizeUpload(h.deps, await h.actor(who), s.id, i.reservationId), "not_found");
      }
      await expectCode(finalizeUpload(h.deps, await h.actor("convener"), s.id, "not-a-uuid"), "not_found");
      assert.deepEqual(h.storage.calls, [], "storage was not touched by any unauthorized finalize");
      assert.deepEqual(await versions(s.id), []);
    },
  );

  it("a reservation of another submission cannot be finalized through this one", opts, async () => {
    const a = await newDraft();
    const b = await newDraft();
    const i = await init("convener", a.id);
    h.storage.upload(i.upload, PNG);
    await expectCode(finalizeUpload(h.deps, await h.actor("convener"), b.id, i.reservationId), "not_found");
  });

  it("finalizing is refused once the submission is pending review or rejected", opts, async () => {
    const s = await newDraft();
    const a = await h.actor("convener");
    const i = await init("convener", s.id);
    h.storage.upload(i.upload, PNG);
    // get the submission into PENDING_REVIEW with other media
    const other = await submittedWithMedia();
    const j = await initUpload(h.deps, a, other.id, {
      filename: "x",
      contentType: "image/png",
      sizeBytes: PNG.length,
    }).catch((e) => e);
    assert.ok(j instanceof WorkflowError && j.code === "invalid_state");
    // and an old, still-open reservation cannot be finalized into a pending submission
    const pending = await newDraft();
    const k = await init("convener", pending.id);
    h.storage.upload(k.upload, PNG);
    await saveDraft(h.deps, a, pending.id, { title: "P", windows: [win(h.ids.lobby)] });
    const firstUpload = await init("convener", pending.id);
    h.storage.upload(firstUpload.upload, PNG);
    await finalizeUpload(h.deps, a, pending.id, firstUpload.reservationId);
    await submitForReview(h.deps, a, pending.id, NOW);
    await expectCode(finalizeUpload(h.deps, a, pending.id, k.reservationId), "invalid_state");
    assert.equal((await versions(pending.id)).length, 1);
  });
});

describe("file analysis at finalize", () => {
  const info = async (id: string) =>
    (
      await h.q<{ media_info: MediaAnalysis | null }>("select media_info from media_version where submission_id=$1", [
        id,
      ])
    )[0].media_info!;
  const codesOf = (i: MediaAnalysis, level: string) => i.checks.filter((c) => c.level === level).map((c) => c.code);

  it("records dimensions, aspect ratio and checks with the version", opts, async () => {
    const m = await withMedia();
    const i = await info(m.id);
    assert.equal(i.width, 1920);
    assert.equal(i.height, 1080);
    assert.equal(i.aspect.label, "16:9");
    assert.equal(i.format, "PNG");
  });

  it("records video details for an MP4 and the displayed size for a rotated JPEG", opts, async () => {
    const v = await info((await withMedia("convener", MP4, "video/mp4")).id);
    assert.equal(v.kind, "video");
    assert.equal(v.video?.durationSeconds, 12);
    assert.equal(v.video?.hasAudio, true);
    const bytes = buildJpeg({ width: 1920, height: 1080, orientation: 6 });
    const j = await info((await withMedia("convener", bytes, "image/jpeg")).id);
    assert.equal(j.width, 1080);
    assert.equal(j.height, 1920);
  });

  it("rejects a decompression-bomb image and a truncated image: nothing recorded, objects removed", opts, async () => {
    for (const [bytes, code] of [
      [buildPng({ width: 20000, height: 20000 }), "too_many_pixels"],
      [buildPng({ width: 1920, height: 1080, truncated: true }), "truncated_file"],
    ] as const) {
      const s = await newDraft();
      const i = await init("convener", s.id, bytes);
      h.storage.upload(i.upload, bytes);
      await assert.rejects(finalizeUpload(h.deps, await h.actor("convener"), s.id, i.reservationId), (e: unknown) => {
        assert.ok(e instanceof WorkflowError && e.code === "upload_rejected");
        assert.ok(e.issues.some((x) => x.code === code));
        return true;
      });
      assert.deepEqual(await versions(s.id), []);
      assert.equal((await reservation(i.reservationId)).status, "REJECTED");
      assert.ok(
        !h.storage.has(`staging/${s.id}/${i.reservationId}`) && !h.storage.has(`media/${s.id}/${i.reservationId}.png`),
      );
    }
  });

  it("accepts files with warnings (trailing data, GPS) and stores the warnings", opts, async () => {
    const a = await info(
      (await withMedia("convener", buildPng({ width: 1920, height: 1080, trailing: new Uint8Array(40).fill(1) }))).id,
    );
    assert.ok(codesOf(a, "warn").includes("trailing_data"));
    const b = await info(
      (await withMedia("convener", buildJpeg({ width: 1920, height: 1080, gps: true }), "image/jpeg")).id,
    );
    assert.ok(codesOf(b, "warn").includes("location_metadata"));
  });

  it("uses the configured pixel limit", opts, async () => {
    h.setMedia({ maxPixels: 1_000_000 });
    try {
      const bytes = buildPng({ width: 2000, height: 1000 });
      const s = await newDraft();
      const i = await init("convener", s.id, bytes);
      h.storage.upload(i.upload, bytes);
      await expectCode(finalizeUpload(h.deps, await h.actor("convener"), s.id, i.reservationId), "upload_rejected");
    } finally {
      h.setMedia({ maxPixels: 100_000_000 });
    }
  });
});

describe("finalized media cannot be overwritten or altered", () => {
  it(
    "reusing the upload URL afterwards changes only the (deleted) staging object, never the recorded media",
    opts,
    async () => {
      const m = await withMedia();
      const [v] = await versions(m.id);
      const before = [...h.storage.get(v.object_key)!.bytes];
      // an attacker (or a bug) re-uploads through the SAME url, with different valid bytes of the right length
      h.storage.upload(m.upload, PNG2);
      assert.deepEqual([...h.storage.get(v.object_key)!.bytes], before, "the final object is untouched");
      h.resetStorageCalls();
      const again = await finalizeUpload(h.deps, await h.actor("convener"), m.id, m.reservationId);
      assert.equal(again.alreadyFinalized, true);
      assert.deepEqual(
        h.storage.calls.filter((c) => c.method !== "deleteObject" || c.key !== `staging/${m.id}/${m.reservationId}`),
        [],
        "re-finalizing never inspects, copies or deletes anything but the (unreferenced) staging leftover",
      );
      assert.equal((await versions(m.id)).length, 1);
      assert.deepEqual([...h.storage.get(v.object_key)!.bytes], before);
      assert.equal((await versions(m.id))[0].storage_etag, v.storage_etag);
    },
  );

  it(
    "bytes swapped into staging AFTER inspection are what gets validated (the copy), so invalid bytes are caught",
    opts,
    async () => {
      const s = await newDraft();
      const i = await init("convener", s.id);
      h.storage.upload(i.upload, PNG);
      const staging = `staging/${s.id}/${i.reservationId}`;
      const realInspect = h.storage.inspectObject.bind(h.storage);
      let swapped = false;
      h.storage.inspectObject = async (key: string) => {
        const info = await realInspect(key);
        if (key === staging && !swapped) {
          swapped = true;
          h.storage.put(
            staging,
            new Uint8Array(PNG.length).map((_, n) => HTML[n % HTML.length]),
            "image/png",
          ); // same length, not an image
        }
        return info;
      };
      try {
        await expectCode(finalizeUpload(h.deps, await h.actor("convener"), s.id, i.reservationId), "upload_rejected");
      } finally {
        h.storage.inspectObject = realInspect;
      }
      assert.ok(swapped);
      assert.deepEqual(await versions(s.id), []);
      assert.ok(!h.storage.has(`media/${s.id}/${i.reservationId}.png`), "the bad copy was removed");
    },
  );

  it(
    "if valid bytes are swapped in instead, the recorded size/ETag describe exactly the stored final object",
    opts,
    async () => {
      const s = await newDraft();
      const i = await init("convener", s.id);
      h.storage.upload(i.upload, PNG);
      const staging = `staging/${s.id}/${i.reservationId}`;
      const realInspect = h.storage.inspectObject.bind(h.storage);
      let swapped = false;
      h.storage.inspectObject = async (key: string) => {
        const info = await realInspect(key);
        if (key === staging && !swapped) {
          swapped = true;
          h.storage.put(staging, PNG2, "image/png");
        }
        return info;
      };
      try {
        await finalizeUpload(h.deps, await h.actor("convener"), s.id, i.reservationId);
      } finally {
        h.storage.inspectObject = realInspect;
      }
      const [v] = await versions(s.id);
      const stored = h.storage.get(v.object_key)!;
      assert.deepEqual([...stored.bytes], [...PNG2]);
      assert.equal(
        v.storage_etag,
        (await h.storage.inspectObject(v.object_key))?.etag,
        "what is recorded is what is stored",
      );
    },
  );

  it("two simultaneous finalizations of one reservation record exactly one version", opts, async () => {
    const s = await newDraft();
    const i = await init("convener", s.id);
    h.storage.upload(i.upload, PNG);
    const a = await h.actor("convener");
    const results = await Promise.all([
      finalizeUpload(h.deps, a, s.id, i.reservationId),
      finalizeUpload(h.deps, a, s.id, i.reservationId),
    ]);
    assert.deepEqual(results.map((r) => r.alreadyFinalized).sort(), [false, true]);
    assert.equal((await versions(s.id)).length, 1);
  });

  it(
    "a half-finished earlier attempt (copy done, nothing recorded) is validated and completed, never blindly trusted",
    opts,
    async () => {
      const s = await newDraft();
      const i = await init("convener", s.id);
      h.storage.upload(i.upload, PNG);
      // simulate a crash after the copy: a final object exists, but with INVALID bytes
      h.storage.put(`media/${s.id}/${i.reservationId}.png`, new Uint8Array(PNG.length).fill(7), "image/png");
      await expectCode(finalizeUpload(h.deps, await h.actor("convener"), s.id, i.reservationId), "upload_rejected");
      assert.deepEqual(await versions(s.id), []);
    },
  );

  it("a storage failure mid-finalization changes nothing and can be retried", opts, async () => {
    const s = await newDraft();
    const i = await init("convener", s.id);
    h.storage.upload(i.upload, PNG);
    h.storage.failNext("copyObject", new StorageUnavailableError());
    await expectCode(finalizeUpload(h.deps, await h.actor("convener"), s.id, i.reservationId), "storage_unavailable");
    assert.deepEqual(await versions(s.id), []);
    assert.equal((await reservation(i.reservationId)).status, "PENDING");
    await finalizeUpload(h.deps, await h.actor("convener"), s.id, i.reservationId);
    assert.equal((await versions(s.id)).length, 1);
  });

  it(
    "the database refuses to modify or delete a recorded version, and a finished reservation cannot change",
    opts,
    async () => {
      const m = await withMedia();
      await assert.rejects(h.q("update media_version set size_bytes = 1 where id=$1", [m.versionId]), /append-only/);
      await assert.rejects(h.q("update media_version set object_key = 'x' where id=$1", [m.versionId]), /append-only/);
      await assert.rejects(h.q("delete from media_version where id=$1", [m.versionId]), /append-only/);
      await assert.rejects(
        h.q("update upload_reservation set status='PENDING' where id=$1", [m.reservationId]),
        /cannot change/,
      );
      await assert.rejects(h.q("delete from upload_reservation where id=$1", [m.reservationId]), /cannot be deleted/);
    },
  );
});

describe("replacing media after approval", () => {
  it(
    "creates version 2, withdraws the approval, keeps version 1 and revision 1, and is not handoff-eligible",
    opts,
    async () => {
      const sub = await submittedWithMedia();
      await decide(h.deps, await h.actor("reviewer"), sub.id, { revisionId: sub.revisionId, decision: "APPROVED" });
      assert.equal(await isHandoffEligible(h.deps.database.get(), sub.id), true);
      const i = await init("convener", sub.id, PNG2);
      h.storage.upload(i.upload, PNG2);
      const v2 = await finalizeUpload(h.deps, await h.actor("convener"), sub.id, i.reservationId);
      assert.equal(v2.approvalInvalidated, true);
      assert.equal(v2.versionNumber, 2);
      assert.equal(
        (await h.q<{ s: string }>("select workflow_status s from submission where id=$1", [sub.id]))[0].s,
        "DRAFT",
      );
      assert.equal(await isHandoffEligible(h.deps.database.get(), sub.id), false);
      assert.equal((await versions(sub.id)).length, 2);
      assert.ok(h.storage.has((await versions(sub.id))[0].object_key), "version 1 media is retained");
      const [rev] = await h.q<{ media_version_id: string }>(
        "select media_version_id from submission_revision where id=$1",
        [sub.revisionId],
      );
      assert.equal(rev.media_version_id, sub.versionId, "revision 1 still names version 1");
      // a fresh submission needs a fresh approval, and the old approval cannot be reused for it
      const a = await h.actor("convener");
      const r2 = await submitForReview(h.deps, a, sub.id, NOW);
      await expectCode(
        decide(h.deps, await h.actor("reviewer2"), sub.id, { revisionId: sub.revisionId, decision: "APPROVED" }),
        "stale_revision",
      );
      assert.equal(await isHandoffEligible(h.deps.database.get(), sub.id), false);
      await decide(h.deps, await h.actor("reviewer2"), sub.id, { revisionId: r2.revisionId, decision: "APPROVED" });
      assert.equal(await isHandoffEligible(h.deps.database.get(), sub.id), true);
    },
  );
});

describe("cleaning up failed and abandoned uploads", () => {
  it("closes expired reservations and removes only their unreferenced objects", opts, async () => {
    const s = await newDraft();
    const a = await h.actor("convener");
    const stale = await initUpload(
      h.deps,
      a,
      s.id,
      { filename: "a.png", contentType: "image/png", sizeBytes: PNG.length },
      NOW,
    );
    h.storage.put(`staging/${s.id}/${stale.reservationId}`, PNG, "image/png");
    const live = await init("convener", s.id);
    h.storage.upload(live.upload, PNG); // still within its lifetime at real 'now'
    const done = await withMedia();
    const out = await sweepAbandonedUploads(h.deps, new Date(NOW.getTime() + 24 * 3600_000));
    assert.ok(out.closed >= 1);
    assert.equal((await reservation(stale.reservationId)).status, "EXPIRED");
    assert.ok(!h.storage.has(`staging/${s.id}/${stale.reservationId}`));
    const [v] = await versions(done.id);
    assert.ok(h.storage.has(v.object_key), "finalized media is never swept");
    assert.equal((await reservation(done.reservationId)).status, "FINALIZED");
    // running again is harmless
    await sweepAbandonedUploads(h.deps, new Date(NOW.getTime() + 24 * 3600_000));
    assert.ok(h.storage.has(v.object_key));
    void live;
  });

  it("refuses to delete any object that a media version references, whatever it is asked", opts, async () => {
    const m = await withMedia();
    const [v] = await versions(m.id);
    h.resetStorageCalls();
    const deleted = await deleteUnreferenced(h.deps, [v.object_key]);
    assert.equal(deleted, 0);
    assert.ok(h.storage.has(v.object_key));
    assert.ok(
      !h.storage.calls.some((c) => c.method === "deleteObject"),
      "deleteObject was never called for a referenced key",
    );
    const rows = h.log.records().filter((r) => r.msg === "refusing to delete referenced media object");
    assert.ok(rows.length >= 1);
  });

  it("a storage failure while cleaning up is logged and never fails the workflow", opts, async () => {
    const s = await newDraft();
    const i = await init("convener", s.id);
    h.storage.upload(i.upload, PNG);
    h.storage.failNext("deleteObject", new Error("storage down"));
    const v = await finalizeUpload(h.deps, await h.actor("convener"), s.id, i.reservationId);
    assert.equal(v.versionNumber, 1);
    assert.ok(
      h.storage.has(`staging/${s.id}/${i.reservationId}`),
      "the leftover staging object remains for the sweeper",
    );
    const out = await sweepAbandonedUploads(h.deps, new Date(Date.now() + 24 * 3600_000));
    assert.ok(out.deleted >= 0);
  });
});

describe("downloads", () => {
  it(
    "a convener of the committee gets a short-lived URL for the FINAL key; others never reach storage",
    opts,
    async () => {
      const m = await withMedia();
      const [v] = await versions(m.id);
      h.resetStorageCalls();
      const url = await createMediaDownloadUrl(h.deps, await h.actor("convener2"), m.id, v.id, { as: "convener" });
      assert.equal(h.storage.keyOfDownloadUrl(url), v.object_key);
      h.resetStorageCalls();
      for (const who of [
        "convenerOther",
        "lapsed",
        "member",
        "reviewer",
        "manager",
        "admin",
        "unassigned",
      ] as PersonKey[]) {
        await expectCode(
          createMediaDownloadUrl(h.deps, await h.actor(who), m.id, v.id, { as: "convener" }),
          "not_found",
        );
      }
      assert.deepEqual(h.storage.calls, []);
    },
  );

  it("a reviewer may download only submitted versions of non-draft submissions", opts, async () => {
    const draft = await withMedia();
    const [dv] = await versions(draft.id);
    const rv = await h.actor("reviewer");
    await expectCode(createMediaDownloadUrl(h.deps, rv, draft.id, dv.id, { as: "reviewer" }), "not_found"); // draft
    const sub = await submittedWithMedia();
    const [v1] = await versions(sub.id);
    const url = await createMediaDownloadUrl(h.deps, rv, sub.id, v1.id, { as: "reviewer" });
    assert.equal(h.storage.keyOfDownloadUrl(url), v1.object_key);
    // the convener uploads a replacement (approval n/a: still pending). Pending cannot take uploads, so request changes first
    await decide(h.deps, rv, sub.id, { revisionId: sub.revisionId, decision: "CHANGES_REQUESTED", comment: "redo" });
    const i = await init("convener", sub.id, PNG2);
    h.storage.upload(i.upload, PNG2);
    const v2 = await finalizeUpload(h.deps, await h.actor("convener"), sub.id, i.reservationId);
    await expectCode(createMediaDownloadUrl(h.deps, rv, sub.id, v2.versionId, { as: "reviewer" }), "not_found"); // not yet submitted
    await expectCode(
      createMediaDownloadUrl(h.deps, await h.actor("convener"), sub.id, "00000000-0000-4000-8000-000000000000", {
        as: "convener",
      }),
      "not_found",
    );
    await expectCode(
      createMediaDownloadUrl(h.deps, await h.actor("manager"), sub.id, v1.id, { as: "reviewer" }),
      "not_found",
    );
  });

  it(
    "a preview is the same authorization with an inline disposition and the longer preview lifetime",
    opts,
    async () => {
      const m = await withMedia();
      const [v] = await versions(m.id);
      const convener = await h.actor("convener2");
      const download = await createMediaDownloadUrl(h.deps, convener, m.id, v.id, { as: "convener" });
      const preview = await createMediaDownloadUrl(h.deps, convener, m.id, v.id, { as: "convener", inline: true });
      const d = h.storage.optionsOfDownloadUrl(download);
      const p = h.storage.optionsOfDownloadUrl(preview);
      assert.equal(d?.disposition, "attachment");
      assert.equal(d?.ttlSeconds, h.deps.media.downloadUrlTtlSeconds);
      assert.equal(p?.disposition, "inline");
      assert.equal(p?.ttlSeconds, h.deps.media.previewUrlTtlSeconds);
      assert.ok((p?.ttlSeconds ?? 0) > (d?.ttlSeconds ?? 0));
      assert.equal(p?.contentType, "image/png", "the validated type, never the uploader's");
      assert.equal(h.storage.keyOfDownloadUrl(preview), v.object_key, "the FINAL key, never the staging key");
      assert.match(p?.filename ?? "", /^VS-\d{4}-\d{6}-v1\.png$/, "a server-built file name, not the uploader's");
    },
  );

  it("unauthorized callers get 'not found' for a preview too and never reach storage", opts, async () => {
    const m = await withMedia();
    const [v] = await versions(m.id);
    h.resetStorageCalls();
    for (const who of ["convenerOther", "lapsed", "member", "reviewer", "admin", "unassigned"] as PersonKey[]) {
      await expectCode(
        createMediaDownloadUrl(h.deps, await h.actor(who), m.id, v.id, { as: "convener", inline: true }),
        "not_found",
      );
    }
    assert.deepEqual(h.storage.calls, []);
  });

  it("a reviewer can preview only versions that were submitted, never a draft's", opts, async () => {
    const rv = await h.actor("reviewer");
    const draft = await withMedia();
    const [dv] = await versions(draft.id);
    await expectCode(
      createMediaDownloadUrl(h.deps, rv, draft.id, dv.id, { as: "reviewer", inline: true }),
      "not_found",
    );
    const sub = await submittedWithMedia();
    const [v1] = await versions(sub.id);
    const url = await createMediaDownloadUrl(h.deps, rv, sub.id, v1.id, { as: "reviewer", inline: true });
    assert.equal(h.storage.optionsOfDownloadUrl(url)?.disposition, "inline");
    assert.equal(h.storage.keyOfDownloadUrl(url), v1.object_key);
  });

  it("a preview of tampered media is refused like a download, and no URL is created", opts, async () => {
    const m = await withMedia();
    const [v] = await versions(m.id);
    h.storage.put(v.object_key, PNG2, "image/png");
    h.resetStorageCalls();
    await expectCode(
      createMediaDownloadUrl(h.deps, await h.actor("convener"), m.id, v.id, { as: "convener", inline: true }),
      "integrity_mismatch",
    );
    assert.ok(!h.storage.calls.some((c) => c.method === "createDownloadUrl"));
  });

  it("media that no longer matches what was recorded is never served", opts, async () => {
    const m = await withMedia();
    const [v] = await versions(m.id);
    h.storage.put(v.object_key, PNG2, "image/png"); // tampered after the fact
    h.resetStorageCalls();
    await expectCode(
      createMediaDownloadUrl(h.deps, await h.actor("convener"), m.id, v.id, { as: "convener" }),
      "integrity_mismatch",
    );
    assert.ok(!h.storage.calls.some((c) => c.method === "createDownloadUrl"));
  });

  it("an unconfigured store refuses downloads with the fixed message", opts, async () => {
    const m = await withMedia();
    const [v] = await versions(m.id);
    const deps = { ...h.deps, storage: createUnconfiguredStorage() };
    await expectCode(
      createMediaDownloadUrl(deps, await h.actor("convener"), m.id, v.id, { as: "convener" }),
      "storage_unavailable",
    );
  });
});

// --- concurrent and interrupted finalization -----------------------------------------------------------------------
const waitForBlockedBackend = async () => {
  for (let i = 0; i < 100; i++) {
    const [{ n }] = await h.q<{ n: number }>(
      "select count(*)::int n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'",
    );
    if (n > 0) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail("the second finalization never blocked on the database lock");
};

describe("concurrent and interrupted finalization", () => {
  it(
    "a second finalization of the same reservation waits for the first and never touches storage meanwhile",
    opts,
    async () => {
      const s = await newDraft();
      const a = await h.actor("convener");
      const i = await init("convener", s.id);
      h.storage.upload(i.upload, PNG);
      const staging = `staging/${s.id}/${i.reservationId}`;
      const final = `media/${s.id}/${i.reservationId}.png`;

      h.resetStorageCalls(); // count only what this scenario does from here
      // Hold the first finalization INSIDE its copy: it has taken the locks and is talking to storage.
      const realCopy = h.storage.copyObject.bind(h.storage);
      let entered!: () => void;
      const enteredCopy = new Promise<void>((r) => (entered = r));
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      h.storage.copyObject = async (input) => {
        entered();
        await gate;
        return realCopy(input);
      };
      try {
        const first = finalizeUpload(h.deps, a, s.id, i.reservationId);
        await enteredCopy;
        h.storage.put(staging, PNG2, "image/png"); // the staging object is replaced while the copy is pending
        const callsBefore = h.storage.calls.length;
        const second = finalizeUpload(h.deps, a, s.id, i.reservationId);
        await waitForBlockedBackend(); // the second request is parked on the database lock
        assert.equal(h.storage.calls.length, callsBefore, "the waiting request performed no storage operation");
        assert.equal(h.storage.has(final), false, "nothing exists at the final key yet");
        release();
        const [r1, r2] = await Promise.all([first, second]);
        assert.deepEqual([r1.alreadyFinalized, r2.alreadyFinalized], [false, true]);
        assert.equal(
          h.storage.calls.filter((c) => c.method === "copyObject").length,
          1,
          "exactly one copy ever happened",
        );
        assert.equal(r1.versionId, r2.versionId);
      } finally {
        h.storage.copyObject = realCopy;
        release();
      }
      const [v] = await versions(s.id);
      assert.equal((await versions(s.id)).length, 1);
      assert.deepEqual(
        [...h.storage.get(final)!.bytes],
        [...PNG2],
        "the recorded object is exactly what was copied and validated",
      );
      assert.equal(v.storage_etag, (await h.storage.inspectObject(final))?.etag);
    },
  );

  it(
    "the database alone allows one media version per reservation, even if two writers bypass the service",
    opts,
    async () => {
      const s = await newDraft();
      const i = await init("convener", s.id);
      const owner = (await h.actor("convener")).id;
      const insert =
        "insert into media_version(id, submission_id, version_number, object_key, original_filename, content_type, size_bytes, uploaded_by_user_id) values ($1,$2,$3,$4,'a.png','image/png',16,$5)";
      const { default: pg } = await import("pg");
      const c1 = new pg.Client({ connectionString: h.dbUrl });
      const c2 = new pg.Client({ connectionString: h.dbUrl });
      await Promise.all([c1.connect(), c2.connect()]);
      try {
        await c1.query("begin");
        await c1.query(insert, [i.reservationId, s.id, 1, `media/${s.id}/${i.reservationId}.png`, owner]);
        await c2.query("begin");
        const racing = c2.query(insert, [i.reservationId, s.id, 2, `media/${s.id}/other.png`, owner]); // same id: blocks on the first
        const settled = racing.then(
          () => "inserted",
          (e: Error) => e.message,
        );
        await waitForBlockedBackend();
        await c1.query("commit");
        assert.match(await settled, /duplicate key|media_version_pkey/);
        await c2.query("rollback");
        // the same version number under a different id is refused as well
        await assert.rejects(
          c2.query(insert, [crypto.randomUUID(), s.id, 1, `media/${s.id}/third.png`, owner]),
          /media_version_submission_number_unique/,
        );
      } finally {
        await c1.end();
        await c2.end();
      }
      assert.equal((await versions(s.id)).length, 1);
    },
  );

  it(
    "a crash after the copy but before the record leaves nothing referenced, and a retry completes without copying again",
    opts,
    async () => {
      const s = await newDraft();
      const a = await h.actor("convener");
      const i = await init("convener", s.id);
      h.storage.upload(i.upload, PNG);
      const final = `media/${s.id}/${i.reservationId}.png`;
      const realHead = h.storage.readHead.bind(h.storage);
      h.storage.readHead = async () => {
        throw new Error("simulated process crash after the copy");
      };
      try {
        await assert.rejects(finalizeUpload(h.deps, a, s.id, i.reservationId), /simulated process crash/);
      } finally {
        h.storage.readHead = realHead;
      }
      assert.deepEqual(await versions(s.id), [], "nothing was recorded");
      assert.equal((await reservation(i.reservationId)).status, "PENDING", "the reservation is still open");
      assert.ok(h.storage.has(final), "the copied object is an unreferenced leftover");
      const leftover = [...h.storage.get(final)!.bytes];

      const copiesBefore = h.storage.calls.filter((c) => c.method === "copyObject").length;
      const done = await finalizeUpload(h.deps, a, s.id, i.reservationId);
      assert.equal(done.alreadyFinalized, false);
      assert.equal(
        h.storage.calls.filter((c) => c.method === "copyObject").length,
        copiesBefore,
        "the leftover was validated and reused, not overwritten",
      );
      assert.deepEqual([...h.storage.get(final)!.bytes], leftover);
      const [v] = await versions(s.id);
      assert.equal(v.object_key, final);

      // once referenced, nothing can change it: a swapped staging object and a replayed finalize are inert
      h.storage.put(`staging/${s.id}/${i.reservationId}`, PNG2, "image/png");
      const again = await finalizeUpload(h.deps, a, s.id, i.reservationId);
      assert.equal(again.alreadyFinalized, true);
      assert.deepEqual([...h.storage.get(final)!.bytes], leftover);
      assert.equal((await versions(s.id)).length, 1);
    },
  );

  it("a leftover final object that is not valid is never recorded, and is removed", opts, async () => {
    const s = await newDraft();
    const a = await h.actor("convener");
    const i = await init("convener", s.id);
    h.storage.upload(i.upload, PNG);
    const final = `media/${s.id}/${i.reservationId}.png`;
    h.storage.put(final, new Uint8Array(PNG.length).fill(1), "image/png"); // e.g. a half-written copy
    await expectCode(finalizeUpload(h.deps, a, s.id, i.reservationId), "upload_rejected");
    assert.deepEqual(await versions(s.id), []);
    assert.ok(!h.storage.has(final));
  });
});
