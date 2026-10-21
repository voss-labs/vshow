// Convener-side workflow: create a draft, edit it, submit it for review. Every state change runs in ONE transaction
// that locks the submission row, re-checks authorization and state against the locked row, writes the change, and
// writes its audit event. Either all of it happens or none of it does.
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { CurrentUser } from "../auth/authorize.server.ts";
import { committee } from "../db/schema/campus.ts";
import { screen } from "../db/schema/campus.ts";
import { screenRequest, submission, submissionRevision } from "../db/schema/submissions.ts";
import type { WorkflowStatus } from "../db/schema/values.ts";
import {
  assertCanCreateFor,
  isConvenerFor,
  loadForConvener,
  type SubmissionRow,
  type Tx,
  type WorkflowDeps,
} from "./access.server.ts";
import { writeAudit } from "./audit.server.ts";
import { WorkflowError, notFound, type FieldIssue } from "./errors.ts";
import { assertTransition, isEditable, isSubmittable } from "./policy.ts";
import { createDraftSchema, issuesOf, saveDraftSchema } from "./schemas.ts";
import { campusYear } from "./time.ts";
import {
  ALL_SCREENS,
  assignSlots,
  expandAllScreens,
  futureIssues,
  parseWindows,
  windowsFingerprint,
  type ParsedWindow,
} from "./windows.ts";

const asStatus = (s: string) => s as WorkflowStatus;
const blank = (v: string | null | undefined) => (v && v.trim() ? v.trim() : null);

/** Every window must name an existing, active screen. Unknown and inactive screens are indistinguishable on purpose. */
async function screenIssues(tx: Tx, windows: readonly { screenId: string }[]): Promise<FieldIssue[]> {
  const ids = [...new Set(windows.map((w) => w.screenId).filter((id) => id !== ALL_SCREENS))];
  if (ids.length === 0) return [];
  const usable = new Set(
    (
      await tx
        .select({ id: screen.id })
        .from(screen)
        .where(and(inArray(screen.id, ids), eq(screen.isActive, true)))
    ).map((r) => r.id),
  );
  const issues: FieldIssue[] = [];
  windows.forEach((w, i) => {
    if (w.screenId !== ALL_SCREENS && !usable.has(w.screenId))
      issues.push({ path: `windows.${i}.screenId`, code: "screen_unavailable" });
  });
  return issues;
}

async function workingWindows(tx: Tx, submissionId: string) {
  return tx
    .select()
    .from(screenRequest)
    .where(eq(screenRequest.submissionId, submissionId))
    .orderBy(asc(screenRequest.screenId), asc(screenRequest.slotNumber));
}

// --- create ------------------------------------------------------------------------------------------------------

export async function createDraft(
  deps: WorkflowDeps,
  actor: CurrentUser,
  input: unknown,
  now: Date = new Date(),
): Promise<SubmissionRow> {
  const parsed = createDraftSchema.safeParse(input);
  if (!parsed.success) throw new WorkflowError("validation_failed", issuesOf(parsed.error));
  const { committeeId, title, description, resubmissionOfId } = parsed.data;
  assertCanCreateFor(actor, committeeId);

  const db = deps.database.get();
  return db.transaction(async (tx) => {
    if (resubmissionOfId) {
      // A resubmission is a NEW submission linked to a REJECTED one in the same committee. The rejected submission is
      // only read: its media, reviews and audit history are untouched, and nothing (least of all approval) is copied.
      const [previous] = await tx.select().from(submission).where(eq(submission.id, resubmissionOfId)).for("share");
      if (!previous || !isConvenerFor(actor, previous)) throw notFound();
      if (previous.committeeId !== committeeId)
        throw new WorkflowError("validation_failed", [{ path: "committeeId", code: "must_match_original" }]);
      if (asStatus(previous.workflowStatus) !== "REJECTED") throw new WorkflowError("invalid_state");
    }
    const result = await tx.execute(sql`select vshow_next_reference_code(${campusYear(now)}) as code`);
    const referenceCode = String((result.rows[0] as { code: string }).code);
    const [row] = await tx
      .insert(submission)
      .values({
        referenceCode,
        committeeId,
        createdByUserId: actor.id,
        title,
        description: blank(description),
        workflowStatus: "DRAFT",
        resubmissionOfId: resubmissionOfId ?? null,
      })
      .returning();
    await writeAudit(tx, {
      actorUserId: actor.id,
      action: "SUBMISSION_CREATED",
      entityType: "SUBMISSION",
      entityId: row.id,
      submissionId: row.id,
      metadata: { referenceCode, ...(resubmissionOfId ? { resubmissionOfId } : {}) },
    });
    deps.logger.info("submission created", { submissionId: row.id, referenceCode });
    return row;
  });
}

// --- edit --------------------------------------------------------------------------------------------------------

export interface SaveResult {
  submission: SubmissionRow;
  changed: boolean;
  /** True when this edit withdrew an existing approval (the submission went back to DRAFT). */
  approvalInvalidated: boolean;
}

/**
 * Saves title, description and requested windows. Allowed in DRAFT, CHANGES_REQUESTED and APPROVED; never while the
 * submission is pending review or rejected. Editing an APPROVED submission withdraws the approval (back to DRAFT).
 * Windows may overlap one another freely; they must be valid (end after start) and name active screens. Whether they
 * are in the future is checked at submission, so a draft can be prepared ahead of time.
 */
export async function saveDraft(
  deps: WorkflowDeps,
  actor: CurrentUser,
  submissionId: string,
  input: unknown,
): Promise<SaveResult> {
  const parsed = saveDraftSchema.safeParse(input);
  if (!parsed.success) throw new WorkflowError("validation_failed", issuesOf(parsed.error));
  const { windows: windowInputs, title, description } = parsed.data;
  const { windows: entered, issues } = parseWindows(windowInputs, { maxWindows: deps.media.maxWindows });
  if (issues.length) throw new WorkflowError("validation_failed", issues);

  const db = deps.database.get();
  return db.transaction(async (tx) => {
    const row = await loadForConvener(tx, actor, submissionId, true);
    const status = asStatus(row.workflowStatus);
    if (!isEditable(status)) throw new WorkflowError("invalid_state");
    const bad = await screenIssues(tx, entered);
    if (bad.length) throw new WorkflowError("validation_failed", bad);
    let windows = entered;
    if (entered.some((w) => w.screenId === ALL_SCREENS)) {
      const active = (
        await tx.select({ id: screen.id }).from(screen).where(eq(screen.isActive, true)).orderBy(asc(screen.code))
      ).map((r) => r.id);
      if (active.length === 0) {
        throw new WorkflowError("validation_failed", [{ path: "windows", code: "screen_unavailable" }]);
      }
      windows = expandAllScreens(entered, active);
    }

    const existing = await workingWindows(tx, row.id);
    const changedFields: string[] = [];
    if (row.title !== title) changedFields.push("title");
    if (blank(row.description) !== blank(description)) changedFields.push("description");
    if (windowsFingerprint(existing.map(toParsed)) !== windowsFingerprint(windows)) changedFields.push("windows");
    if (changedFields.length === 0) return { submission: row, changed: false, approvalInvalidated: false };

    let nextStatus = status;
    if (status === "APPROVED") {
      // Approval-relevant content changed: the approval no longer covers what is on file.
      assertTransition("APPROVED", "DRAFT");
      nextStatus = "DRAFT";
    }
    if (changedFields.includes("windows")) {
      await tx.delete(screenRequest).where(eq(screenRequest.submissionId, row.id));
      const slotted = assignSlots(windows);
      if (slotted.length) {
        await tx.insert(screenRequest).values(
          slotted.map((w) => ({
            submissionId: row.id,
            screenId: w.screenId,
            slotNumber: w.slotNumber,
            preferredStartAt: w.startAt,
            preferredEndAt: w.endAt,
            requestNote: w.note,
          })),
        );
      }
    }
    const [updated] = await tx
      .update(submission)
      .set({ title, description: blank(description), workflowStatus: nextStatus })
      .where(eq(submission.id, row.id))
      .returning();
    if (nextStatus !== status) {
      await writeAudit(tx, {
        actorUserId: actor.id,
        action: "APPROVAL_INVALIDATED",
        entityType: "SUBMISSION",
        entityId: row.id,
        submissionId: row.id,
        metadata: { reason: "content_changed", changed: changedFields },
      });
    }
    await writeAudit(tx, {
      actorUserId: actor.id,
      action: "SUBMISSION_UPDATED",
      entityType: "SUBMISSION",
      entityId: row.id,
      submissionId: row.id,
      metadata: { changed: changedFields },
    });
    return { submission: updated, changed: true, approvalInvalidated: nextStatus !== status };
  });
}

function toParsed(r: typeof screenRequest.$inferSelect): ParsedWindow {
  return {
    screenId: r.screenId,
    startAt: r.preferredStartAt ?? new Date(0),
    endAt: r.preferredEndAt ?? new Date(0),
    note: r.requestNote,
  };
}

// --- submit ------------------------------------------------------------------------------------------------------

export interface SubmitResult {
  submission: SubmissionRow;
  revisionId: string;
  revisionNumber: number;
}

/**
 * Submits the current media version and the requested windows for review. Creates a new immutable revision (a frozen
 * snapshot of title, description, media version and windows), moves the submission to PENDING_REVIEW and records the
 * audit event, all in one transaction. The previous revision and its decisions stay exactly as they were.
 */
export async function submitForReview(
  deps: WorkflowDeps,
  actor: CurrentUser,
  submissionId: string,
  now: Date = new Date(),
): Promise<SubmitResult> {
  const db = deps.database.get();
  return db.transaction(async (tx) => {
    const row = await loadForConvener(tx, actor, submissionId, true);
    const status = asStatus(row.workflowStatus);
    if (!isSubmittable(status)) throw new WorkflowError("invalid_state");
    assertTransition(status, "PENDING_REVIEW");

    const issues: FieldIssue[] = [];
    if (!row.currentVersionId) issues.push({ path: "media", code: "media_required" });
    const rows = await workingWindows(tx, row.id);
    if (rows.length === 0) issues.push({ path: "windows", code: "window_required" });
    if (rows.length > deps.media.maxWindows) issues.push({ path: "windows", code: "too_many_windows" });
    const windows = rows.map(toParsed);
    rows.forEach((r, i) => {
      if (!r.preferredStartAt || !r.preferredEndAt) issues.push({ path: `windows.${i}`, code: "incomplete_window" });
    });
    issues.push(...(await screenIssues(tx, windows)), ...futureIssues(windows, now));
    if (issues.length) throw new WorkflowError("validation_failed", issues);

    const [latest] = await tx
      .select({ n: submissionRevision.revisionNumber })
      .from(submissionRevision)
      .where(eq(submissionRevision.submissionId, row.id))
      .orderBy(desc(submissionRevision.revisionNumber))
      .limit(1);
    const revisionNumber = (latest?.n ?? 0) + 1;
    const [revision] = await tx
      .insert(submissionRevision)
      .values({
        submissionId: row.id,
        revisionNumber,
        title: row.title,
        description: row.description,
        mediaVersionId: row.currentVersionId!,
        requestedWindows: rows.map((r) => ({
          screenId: r.screenId,
          slotNumber: r.slotNumber,
          startAt: r.preferredStartAt!.toISOString(),
          endAt: r.preferredEndAt!.toISOString(),
          note: r.requestNote,
        })),
        createdByUserId: actor.id,
      })
      .returning({ id: submissionRevision.id });
    const [updated] = await tx
      .update(submission)
      .set({ currentRevisionId: revision.id, workflowStatus: "PENDING_REVIEW", submittedAt: row.submittedAt ?? now })
      .where(eq(submission.id, row.id))
      .returning();
    await writeAudit(tx, {
      actorUserId: actor.id,
      action: "SUBMISSION_SUBMITTED",
      entityType: "SUBMISSION",
      entityId: row.id,
      submissionId: row.id,
      metadata: { revisionNumber, revisionId: revision.id, windowCount: rows.length },
    });
    deps.logger.info("submission submitted", { submissionId: row.id, revisionNumber });
    return { submission: updated, revisionId: revision.id, revisionNumber };
  });
}

/** Committee id -> name/code for the committees a convener may create submissions for. */
export async function listManageableCommittees(deps: WorkflowDeps, actor: CurrentUser) {
  if (!actor.roles.includes("CONVENER") || actor.memberships.length === 0) return [];
  const ids = [...new Set(actor.memberships.map((m) => m.committeeId))];
  return deps.database
    .get()
    .select({ id: committee.id, code: committee.code, name: committee.name })
    .from(committee)
    .where(and(inArray(committee.id, ids), eq(committee.isActive, true)))
    .orderBy(asc(committee.name));
}
