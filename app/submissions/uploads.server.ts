// Media upload lifecycle. The browser uploads straight to object storage; the server only authorizes, reserves,
// validates and records. Nothing large ever passes through a Vshow request.
//
//   1 initUpload      authorize -> reserve (version id, STAGING key, FINAL key) -> short-lived upload URL for STAGING
//   2 (browser)       PUT bytes to the staging key
//   3 finalizeUpload  authorize -> COPY staging -> final -> validate the FINAL object -> record it, atomically
//
// Why the final object is validated, not the staging one: an upload URL stays usable until it expires, so whoever
// holds it could replace the staging object after it was inspected. No URL is ever created for a final key, so the
// object that was copied there can no longer be changed by anyone holding an upload URL, and what is validated
// (size, declared type, file signature, ETag) is exactly what is recorded. The design never relies on conditional
// copy (If-Match) or on write-once semantics of the store.
//
// Finalization runs in one transaction that holds the submission's row lock (and the reservation's), so two
// finalizations of the same reservation cannot interleave, and a failed validation records NO media version.
import { and, count, eq, lt, sql } from "drizzle-orm";
import type { CurrentUser } from "../auth/authorize.server.ts";
import { mediaVersion, submission, submissionRevision, uploadReservation } from "../db/schema/submissions.ts";
import type { WorkflowStatus } from "../db/schema/values.ts";
import { analyzeStoredMedia } from "../media/analyze.server.ts";
import { failedChecks } from "../media/analysis.ts";
import { SIGNATURE_BYTES, detectMime, extensionFor, isAllowedMime, sanitizeFilename } from "../storage/file-types.ts";
import { finalKey, stagingKey } from "../storage/keys.server.ts";
import { StorageUnavailableError, type UploadTarget } from "../storage/object-storage.server.ts";
import { loadForConvener, loadForReviewer, type SubmissionRow, type WorkflowDeps, isUuid } from "./access.server.ts";
import { writeAudit } from "./audit.server.ts";
import { loadForManager } from "./manager.server.ts";
import { WorkflowError, notFound, type FieldIssue } from "./errors.ts";
import { assertTransition, isEditable } from "./policy.ts";
import { issuesOf, uploadInitSchema } from "./schemas.ts";

/** Open (unexpired, unfinished) reservations allowed per submission at once. */
export const MAX_OPEN_RESERVATIONS = 3;
/** The reservation outlives the upload URL a little, so a slow upload can still be finalized. */
const RESERVATION_GRACE_SECONDS = 300;

const mimeOf = (contentType: string | null | undefined) => (contentType ?? "").split(";")[0].trim().toLowerCase();

/** Maps the storage layer's "unavailable" into the workflow's fixed, safe error. */
async function withStorage<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof StorageUnavailableError) throw new WorkflowError("storage_unavailable");
    throw err;
  }
}

// --- 1. reserve ---------------------------------------------------------------------------------------------------

export interface UploadInit {
  reservationId: string;
  upload: UploadTarget;
  maxBytes: number;
}

export async function initUpload(
  deps: WorkflowDeps,
  actor: CurrentUser,
  submissionId: string,
  input: unknown,
  now: Date = new Date(),
): Promise<UploadInit> {
  const parsed = uploadInitSchema.safeParse(input);
  if (!parsed.success) throw new WorkflowError("validation_failed", issuesOf(parsed.error));
  const contentType = mimeOf(parsed.data.contentType);
  const issues: FieldIssue[] = [];
  if (!isAllowedMime(contentType)) issues.push({ path: "contentType", code: "unsupported_type" });
  if (parsed.data.sizeBytes > deps.media.maxBytes) issues.push({ path: "sizeBytes", code: "too_large" });
  if (issues.length) throw new WorkflowError("validation_failed", issues);

  const filename = sanitizeFilename(parsed.data.filename);
  const db = deps.database.get();

  // Authorization and the reservation happen first; storage is only touched once the caller is known to be allowed.
  const reservation = await db.transaction(async (tx) => {
    const row = await loadForConvener(tx, actor, submissionId, true);
    // Only an authorized caller learns anything about storage; with none configured nothing is written (this
    // transaction rolls back) and storage is never contacted.
    if (!deps.storage.configured) throw new WorkflowError("storage_unavailable");
    if (!isEditable(row.workflowStatus as WorkflowStatus)) throw new WorkflowError("invalid_state");
    await tx
      .update(uploadReservation)
      .set({ status: "EXPIRED" })
      .where(
        and(
          eq(uploadReservation.submissionId, row.id),
          eq(uploadReservation.status, "PENDING"),
          lt(uploadReservation.expiresAt, now),
        ),
      );
    const [{ open }] = await tx
      .select({ open: count() })
      .from(uploadReservation)
      .where(and(eq(uploadReservation.submissionId, row.id), eq(uploadReservation.status, "PENDING")));
    if (open >= MAX_OPEN_RESERVATIONS) throw new WorkflowError("too_many_uploads");

    const id = crypto.randomUUID();
    const [created] = await tx
      .insert(uploadReservation)
      .values({
        id,
        submissionId: row.id,
        stagingKey: stagingKey(row.id, id),
        finalKey: finalKey(row.id, id, contentType),
        declaredContentType: contentType,
        declaredSizeBytes: parsed.data.sizeBytes,
        originalFilename: filename,
        reservedByUserId: actor.id,
        expiresAt: new Date(now.getTime() + (deps.media.uploadUrlTtlSeconds + RESERVATION_GRACE_SECONDS) * 1000),
        createdAt: now,
      })
      .returning();
    return created;
  });

  try {
    const upload = await withStorage(() =>
      deps.storage.createUploadTarget({
        key: reservation.stagingKey,
        contentType,
        sizeBytes: reservation.declaredSizeBytes,
        ttlSeconds: deps.media.uploadUrlTtlSeconds,
      }),
    );
    deps.logger.info("upload reserved", {
      submissionId,
      reservationId: reservation.id,
      sizeBytes: reservation.declaredSizeBytes,
      contentType,
    });
    return { reservationId: reservation.id, upload, maxBytes: deps.media.maxBytes };
  } catch (err) {
    await db
      .update(uploadReservation)
      .set({ status: "REJECTED", failureReason: "target_failed" })
      .where(eq(uploadReservation.id, reservation.id));
    throw err;
  }
}

// --- 3. finalize --------------------------------------------------------------------------------------------------

export interface FinalizedVersion {
  versionId: string;
  versionNumber: number;
  /** True when this call returned an already-finalized upload (a safe retry). */
  alreadyFinalized: boolean;
  approvalInvalidated: boolean;
}

type Outcome =
  | { kind: "ok"; result: FinalizedVersion; cleanup: string[] }
  | { kind: "again"; result: FinalizedVersion }
  | { kind: "missing" }
  | { kind: "expired"; cleanup: string[] }
  | { kind: "rejected"; reason: string; codes: string[]; cleanup: string[] };

export async function finalizeUpload(
  deps: WorkflowDeps,
  actor: CurrentUser,
  submissionId: string,
  reservationId: string,
  now: Date = new Date(),
): Promise<FinalizedVersion> {
  if (!isUuid(reservationId)) throw notFound();
  const db = deps.database.get();
  const storage = deps.storage;

  const outcome: Outcome = await withStorage(() =>
    db.transaction(async (tx): Promise<Outcome> => {
      // Authorization first: nothing below runs, and storage is never touched, for a caller who may not do this.
      const row = await loadForConvener(tx, actor, submissionId, true);
      const [res] = await tx
        .select()
        .from(uploadReservation)
        .where(and(eq(uploadReservation.id, reservationId), eq(uploadReservation.submissionId, row.id)))
        .for("update");
      if (!res || res.reservedByUserId !== actor.id) throw notFound();

      if (res.status === "FINALIZED") {
        const [v] = await tx.select().from(mediaVersion).where(eq(mediaVersion.id, res.id));
        if (!v) throw new WorkflowError("integrity_mismatch");
        return {
          kind: "again",
          result: {
            versionId: v.id,
            versionNumber: v.versionNumber,
            alreadyFinalized: true,
            approvalInvalidated: false,
          },
        };
      }
      if (res.status !== "PENDING") throw new WorkflowError("upload_closed");
      if (!isEditable(row.workflowStatus as WorkflowStatus)) throw new WorkflowError("invalid_state");
      if (res.expiresAt.getTime() < now.getTime()) {
        await tx.update(uploadReservation).set({ status: "EXPIRED" }).where(eq(uploadReservation.id, res.id));
        return { kind: "expired", cleanup: [res.stagingKey] };
      }

      const reject = async (reason: string, codes: string[] = [reason]): Promise<Outcome> => {
        await tx
          .update(uploadReservation)
          .set({ status: "REJECTED", failureReason: reason })
          .where(eq(uploadReservation.id, res.id));
        deps.logger.warn("upload rejected", { submissionId: row.id, reservationId: res.id, reason });
        return { kind: "rejected", reason, codes, cleanup: [res.stagingKey, res.finalKey] };
      };

      // Cheap pre-checks on the staging object (it may be replaced later; they only avoid pointless copies).
      const staged = await storage.inspectObject(res.stagingKey);
      if (!staged) return { kind: "missing" };
      if (staged.size !== res.declaredSizeBytes || staged.size > deps.media.maxBytes) return reject("size_mismatch");

      // Copy to the final key (which has no upload URL), reusing a leftover from an earlier attempt of THIS
      // reservation if there is one; then validate what is actually there.
      let final = await storage.inspectObject(res.finalKey);
      if (!final) {
        await storage.copyObject({
          sourceKey: res.stagingKey,
          destinationKey: res.finalKey,
          contentType: res.declaredContentType,
        });
        final = await storage.inspectObject(res.finalKey);
      }
      if (!final) throw new WorkflowError("integrity_mismatch");
      if (final.size !== res.declaredSizeBytes || final.size > deps.media.maxBytes) return reject("size_mismatch");
      if (mimeOf(final.contentType) !== res.declaredContentType) return reject("type_mismatch");
      const head = await storage.readHead(res.finalKey, SIGNATURE_BYTES);
      if (detectMime(head) !== res.declaredContentType) return reject("signature_mismatch");

      // Describe the file and check its structure (dimensions, aspect ratio, truncation, hidden data, decompression
      // bombs...). A file that fails a hard check is not recorded. Everything else is kept for the reviewer to see.
      const analysis = await analyzeStoredMedia(storage, res.finalKey, res.declaredContentType, final.size, {
        maxPixels: deps.media.maxPixels,
      });
      const failed = failedChecks(analysis);
      if (failed.length > 0)
        return reject(
          failed[0].code,
          failed.map((c) => c.code),
        );

      // Valid. Record the version, make it current, and audit it, still under the same locks.
      const [latest] = await tx
        .select({ n: sql<number>`coalesce(max(${mediaVersion.versionNumber}), 0)::int` })
        .from(mediaVersion)
        .where(eq(mediaVersion.submissionId, row.id));
      const versionNumber = latest.n + 1;
      await tx.insert(mediaVersion).values({
        id: res.id,
        submissionId: row.id,
        versionNumber,
        objectKey: res.finalKey,
        originalFilename: res.originalFilename,
        contentType: res.declaredContentType,
        sizeBytes: final.size,
        storageEtag: final.etag,
        mediaInfo: analysis,
        uploadedByUserId: actor.id,
        uploadedAt: now,
      });
      const invalidates = (row.workflowStatus as WorkflowStatus) === "APPROVED";
      if (invalidates) assertTransition("APPROVED", "DRAFT");
      await tx
        .update(submission)
        .set({ currentVersionId: res.id, ...(invalidates ? { workflowStatus: "DRAFT" } : {}) })
        .where(eq(submission.id, row.id));
      await tx
        .update(uploadReservation)
        .set({ status: "FINALIZED", finalizedAt: now })
        .where(eq(uploadReservation.id, res.id));
      if (invalidates) {
        await writeAudit(tx, {
          actorUserId: actor.id,
          action: "APPROVAL_INVALIDATED",
          entityType: "SUBMISSION",
          entityId: row.id,
          submissionId: row.id,
          metadata: { reason: "media_replaced", versionNumber },
        });
      }
      await writeAudit(tx, {
        actorUserId: actor.id,
        action: "MEDIA_VERSION_UPLOADED",
        entityType: "MEDIA_VERSION",
        entityId: res.id,
        submissionId: row.id,
        metadata: { versionNumber, contentType: res.declaredContentType, sizeBytes: final.size },
      });
      return {
        kind: "ok",
        result: { versionId: res.id, versionNumber, alreadyFinalized: false, approvalInvalidated: invalidates },
        cleanup: [res.stagingKey],
      };
    }),
  );

  switch (outcome.kind) {
    case "ok":
      await deleteUnreferenced(deps, outcome.cleanup);
      return outcome.result;
    case "again": {
      // A crash after the commit may have left the staging object behind. It is never referenced, so removing it is
      // always safe; the final object is not touched.
      const [r] = await db
        .select({ k: uploadReservation.stagingKey })
        .from(uploadReservation)
        .where(eq(uploadReservation.id, reservationId));
      if (r && deps.storage.configured) await deleteUnreferenced(deps, [r.k]);
      return outcome.result;
    }
    case "missing":
      throw new WorkflowError("upload_missing");
    case "expired":
      await deleteUnreferenced(deps, outcome.cleanup);
      throw new WorkflowError("upload_closed");
    case "rejected":
      await deleteUnreferenced(deps, outcome.cleanup);
      throw new WorkflowError(
        "upload_rejected",
        outcome.codes.map((code) => ({ path: "file", code })),
      );
  }
}

// --- cleanup ------------------------------------------------------------------------------------------------------

/**
 * Deletes objects ONLY if no media version references the key. Referenced media is history and is never removed here,
 * whatever the caller believes. Failures are logged and swallowed: a leftover object is harmless and the sweeper
 * retries it later.
 */
export async function deleteUnreferenced(deps: WorkflowDeps, keys: readonly string[]): Promise<number> {
  const db = deps.database.get();
  let deleted = 0;
  for (const key of keys) {
    try {
      const [referenced] = await db
        .select({ id: mediaVersion.id })
        .from(mediaVersion)
        .where(eq(mediaVersion.objectKey, key))
        .limit(1);
      if (referenced) {
        deps.logger.warn("refusing to delete referenced media object", { versionId: referenced.id });
        continue;
      }
      await deps.storage.deleteObject(key);
      deleted++;
    } catch (err) {
      deps.logger.warn("could not delete an unreferenced storage object", { err });
    }
  }
  return deleted;
}

/**
 * Closes reservations that were never finalized and removes their objects. Safe to run any time and repeatedly:
 * finalized reservations are never touched, and only unreferenced keys are deleted.
 */
export async function sweepAbandonedUploads(
  deps: WorkflowDeps,
  now: Date = new Date(),
  limit = 100,
): Promise<{ closed: number; deleted: number }> {
  const db = deps.database.get();
  const expired = await db
    .update(uploadReservation)
    .set({ status: "EXPIRED" })
    .where(and(eq(uploadReservation.status, "PENDING"), lt(uploadReservation.expiresAt, now)))
    .returning({ stagingKey: uploadReservation.stagingKey, finalKey: uploadReservation.finalKey });
  const leftovers = await db
    .select({ stagingKey: uploadReservation.stagingKey, finalKey: uploadReservation.finalKey })
    .from(uploadReservation)
    .where(sql`${uploadReservation.status} in ('EXPIRED', 'REJECTED')`)
    .limit(limit);
  const keys = new Set<string>();
  for (const r of [...expired, ...leftovers]) {
    keys.add(r.stagingKey);
    keys.add(r.finalKey);
  }
  const deleted = await withStorage(() => deleteUnreferenced(deps, [...keys]));
  return { closed: expired.length, deleted };
}

// --- downloads ----------------------------------------------------------------------------------------------------

export interface DownloadPurpose {
  as: "convener" | "reviewer" | "manager";
  /**
   * Serve the file for in-page viewing (an <img> or <video>) instead of as a download. The same people may see the
   * same versions; only the Content-Disposition and the URL lifetime differ.
   */
  inline?: boolean;
}

/**
 * A short-lived download URL for one media version, after checking who is asking and whether that version may be
 * handed to them:
 *  - convener: any version of a submission of their committee;
 *  - reviewer: only versions that were actually SUBMITTED (are part of some revision) of a non-draft submission.
 * The stored size/ETag are compared with the object before a URL is issued, so media that no longer matches what was
 * validated is never served. The URL is returned to the caller and never logged or stored.
 */
export async function createMediaDownloadUrl(
  deps: WorkflowDeps,
  actor: CurrentUser,
  submissionId: string,
  versionId: string,
  { as, inline = false }: DownloadPurpose,
): Promise<string> {
  if (!isUuid(versionId)) throw notFound();
  const db = deps.database.get();
  const sub: SubmissionRow =
    as === "convener"
      ? await loadForConvener(db, actor, submissionId)
      : as === "manager"
        ? await loadForManager(db, actor, submissionId)
        : await loadForReviewer(db, actor, submissionId);
  // A manager may only fetch the exact media version that was approved.
  if (as === "manager" && versionId !== sub.currentVersionId) throw notFound();
  const [version] = await db
    .select()
    .from(mediaVersion)
    .where(and(eq(mediaVersion.id, versionId), eq(mediaVersion.submissionId, sub.id)));
  if (!version) throw notFound();
  if (as === "reviewer") {
    const [submitted] = await db
      .select({ id: submissionRevision.id })
      .from(submissionRevision)
      .where(and(eq(submissionRevision.submissionId, sub.id), eq(submissionRevision.mediaVersionId, version.id)))
      .limit(1);
    if (!submitted) throw notFound();
  }
  return withStorage(async () => {
    const info = await deps.storage.inspectObject(version.objectKey);
    if (!info || info.size !== version.sizeBytes || (version.storageEtag && info.etag !== version.storageEtag)) {
      deps.logger.error("stored media does not match what was recorded", { versionId: version.id });
      throw new WorkflowError("integrity_mismatch");
    }
    const ext = extensionFor(version.contentType) ?? "bin";
    return deps.storage.createDownloadUrl(version.objectKey, {
      // A server-built name: never the uploader's filename.
      filename: `${sub.referenceCode}-v${version.versionNumber}.${ext}`,
      contentType: version.contentType,
      ttlSeconds: inline ? deps.media.previewUrlTtlSeconds : deps.media.downloadUrlTtlSeconds,
      disposition: inline ? "inline" : "attachment",
    });
  });
}
