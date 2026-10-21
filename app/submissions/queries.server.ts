// Read models for the pages. Each function authorizes against the actual submission (loadForConvener /
// loadForReviewer) before it reads anything else about it, so nothing is fetched for a caller who may not see it.
import { and, asc, desc, eq, inArray, ne } from "drizzle-orm";
import type { MediaAnalysis } from "../media/analysis.ts";
import type { CurrentUser } from "../auth/authorize.server.ts";
import type { Db } from "../db/client.server.ts";
import { committee, screen } from "../db/schema/campus.ts";
import { appUser } from "../db/schema/identity.ts";
import { mediaVersion, screenRequest, submission, submissionRevision } from "../db/schema/submissions.ts";
import type { WorkflowStatus } from "../db/schema/values.ts";
import { auditEvent, reviewDecision, scheduleEntry } from "../db/schema/workflow.ts";
import { loadForConvener, loadForReviewer, type SubmissionRow, type Tx } from "./access.server.ts";
import { isEditable, isSubmittable } from "./policy.ts";

export interface WindowView {
  screenId: string;
  screenName: string;
  slotNumber: number;
  startAt: string | null;
  endAt: string | null;
  note: string | null;
}

export interface DecisionView {
  id: string;
  decision: string;
  comment: string | null;
  createdAt: string;
  reviewerName: string;
  revisionNumber: number;
}

export interface VersionView {
  id: string;
  versionNumber: number;
  originalFilename: string;
  contentType: string;
  sizeBytes: number;
  uploadedAt: string;
  uploadedByName: string;
  changeNote: string | null;
  isCurrent: boolean;
  /** What the file was found to be at upload (dimensions, aspect ratio, checks). Null for older versions. */
  info: MediaAnalysis | null;
}

export interface RevisionView {
  id: string;
  revisionNumber: number;
  title: string;
  description: string | null;
  mediaVersionId: string;
  windows: WindowView[];
  createdAt: string;
  isCurrent: boolean;
}

export interface AuditView {
  id: string;
  action: string;
  actorName: string | null;
  createdAt: string;
  metadata: unknown;
}

interface Head {
  id: string;
  referenceCode: string;
  title: string;
  description: string | null;
  status: WorkflowStatus;
  committee: { id: string; code: string; name: string };
  createdByName: string;
  createdAt: string;
  submittedAt: string | null;
  currentVersionId: string | null;
  currentRevisionId: string | null;
  resubmissionOf: { id: string; referenceCode: string } | null;
  resubmittedAs: Array<{ id: string; referenceCode: string }>;
  /** Set once the Server Room Manager has put the approved media on the screens. */
  liveOnScreens: { at: string; byName: string } | null;
}

export interface ConvenerSubmissionView extends Head {
  canEdit: boolean;
  canSubmit: boolean;
  /** Windows as currently saved (the editable working copy, not a review snapshot). */
  windows: WindowView[];
  versions: VersionView[];
  revisions: RevisionView[];
  decisions: DecisionView[];
  audit: AuditView[];
}

export interface ReviewerSubmissionView extends Head {
  canDecide: boolean;
  /** The revision under review and its frozen windows: exactly what a decision will apply to. */
  currentRevision: RevisionView | null;
  versions: VersionView[];
  revisions: RevisionView[];
  decisions: DecisionView[];
  audit: AuditView[];
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

/** Active (SCHEDULED) entries for the approved media version of a submission, one per screen. */
export async function activeScheduleEntries(db: Db | Tx, row: SubmissionRow) {
  if (!row.currentVersionId) return [];
  return db
    .select({ e: scheduleEntry, by: appUser.displayName, screenName: screen.name })
    .from(scheduleEntry)
    .innerJoin(appUser, eq(appUser.id, scheduleEntry.updatedByUserId))
    .innerJoin(screen, eq(screen.id, scheduleEntry.screenId))
    .where(
      and(
        eq(scheduleEntry.submissionId, row.id),
        eq(scheduleEntry.mediaVersionId, row.currentVersionId),
        eq(scheduleEntry.status, "SCHEDULED"),
      ),
    )
    .orderBy(asc(screen.name));
}

async function liveOnScreensOf(db: Db, row: SubmissionRow): Promise<Head["liveOnScreens"]> {
  if (row.workflowStatus !== "APPROVED") return null;
  const entries = await activeScheduleEntries(db, row);
  const first = entries[0];
  if (!first) return null;
  const at = entries.reduce((m, x) => (x.e.updatedAt > m ? x.e.updatedAt : m), first.e.updatedAt);
  return { at: at.toISOString(), byName: first.by };
}

export async function head(db: Db, row: SubmissionRow): Promise<Head> {
  const [[com], [creator], previous, children, liveOnScreens] = await Promise.all([
    db
      .select({ id: committee.id, code: committee.code, name: committee.name })
      .from(committee)
      .where(eq(committee.id, row.committeeId)),
    db.select({ name: appUser.displayName }).from(appUser).where(eq(appUser.id, row.createdByUserId)),
    row.resubmissionOfId
      ? db
          .select({ id: submission.id, referenceCode: submission.referenceCode })
          .from(submission)
          .where(eq(submission.id, row.resubmissionOfId))
      : Promise.resolve([]),
    db
      .select({ id: submission.id, referenceCode: submission.referenceCode })
      .from(submission)
      .where(eq(submission.resubmissionOfId, row.id)),
    liveOnScreensOf(db, row),
  ]);
  return {
    id: row.id,
    referenceCode: row.referenceCode,
    title: row.title,
    description: row.description,
    status: row.workflowStatus as WorkflowStatus,
    committee: com,
    createdByName: creator?.name ?? "Unknown",
    createdAt: row.createdAt.toISOString(),
    submittedAt: iso(row.submittedAt),
    currentVersionId: row.currentVersionId,
    currentRevisionId: row.currentRevisionId,
    resubmissionOf: previous[0] ?? null,
    resubmittedAs: children,
    liveOnScreens,
  };
}

export async function versionsOf(db: Db, row: SubmissionRow, onlyIds?: string[]): Promise<VersionView[]> {
  const rows = await db
    .select({ v: mediaVersion, uploader: appUser.displayName })
    .from(mediaVersion)
    .innerJoin(appUser, eq(appUser.id, mediaVersion.uploadedByUserId))
    .where(
      onlyIds
        ? and(
            eq(mediaVersion.submissionId, row.id),
            inArray(mediaVersion.id, onlyIds.length ? onlyIds : ["00000000-0000-0000-0000-000000000000"]),
          )
        : eq(mediaVersion.submissionId, row.id),
    )
    .orderBy(desc(mediaVersion.versionNumber));
  return rows.map(({ v, uploader }) => ({
    id: v.id,
    versionNumber: v.versionNumber,
    originalFilename: v.originalFilename,
    contentType: v.contentType,
    sizeBytes: v.sizeBytes,
    uploadedAt: v.uploadedAt.toISOString(),
    uploadedByName: uploader,
    changeNote: v.changeNote,
    isCurrent: v.id === row.currentVersionId,
    info: v.mediaInfo ?? null,
  }));
}

interface FrozenWindow {
  screenId: string;
  slotNumber: number;
  startAt: string | null;
  endAt: string | null;
  note: string | null;
}

export async function revisionsOf(db: Db, row: SubmissionRow): Promise<RevisionView[]> {
  const revs = await db
    .select()
    .from(submissionRevision)
    .where(eq(submissionRevision.submissionId, row.id))
    .orderBy(desc(submissionRevision.revisionNumber));
  const screenIds = [...new Set(revs.flatMap((r) => (r.requestedWindows as FrozenWindow[]).map((w) => w.screenId)))];
  const names = new Map(
    screenIds.length
      ? (await db.select({ id: screen.id, name: screen.name }).from(screen).where(inArray(screen.id, screenIds))).map(
          (s) => [s.id, s.name],
        )
      : [],
  );
  return revs.map((r) => ({
    id: r.id,
    revisionNumber: r.revisionNumber,
    title: r.title,
    description: r.description,
    mediaVersionId: r.mediaVersionId,
    createdAt: r.createdAt.toISOString(),
    isCurrent: r.id === row.currentRevisionId,
    windows: (r.requestedWindows as FrozenWindow[]).map((w) => ({
      screenId: w.screenId,
      screenName: names.get(w.screenId) ?? "Unknown screen",
      slotNumber: w.slotNumber,
      startAt: w.startAt,
      endAt: w.endAt,
      note: w.note,
    })),
  }));
}

async function decisionsOf(db: Db, row: SubmissionRow): Promise<DecisionView[]> {
  const rows = await db
    .select({ d: reviewDecision, reviewer: appUser.displayName, revisionNumber: submissionRevision.revisionNumber })
    .from(reviewDecision)
    .innerJoin(appUser, eq(appUser.id, reviewDecision.reviewerUserId))
    .innerJoin(submissionRevision, eq(submissionRevision.id, reviewDecision.revisionId))
    .where(eq(reviewDecision.submissionId, row.id))
    .orderBy(desc(reviewDecision.createdAt));
  return rows.map(({ d, reviewer, revisionNumber }) => ({
    id: d.id,
    decision: d.decision,
    comment: d.comment,
    createdAt: d.createdAt.toISOString(),
    reviewerName: reviewer,
    revisionNumber,
  }));
}

async function auditOf(db: Db, row: SubmissionRow): Promise<AuditView[]> {
  const rows = await db
    .select({ a: auditEvent, actor: appUser.displayName })
    .from(auditEvent)
    .leftJoin(appUser, eq(appUser.id, auditEvent.actorUserId))
    .where(eq(auditEvent.submissionId, row.id))
    .orderBy(desc(auditEvent.createdAt))
    .limit(100);
  return rows.map(({ a, actor }) => ({
    id: a.id,
    action: a.action,
    actorName: actor,
    createdAt: a.createdAt.toISOString(),
    metadata: a.metadata,
  }));
}

export async function getSubmissionForConvener(
  db: Db,
  actor: CurrentUser,
  id: string,
): Promise<ConvenerSubmissionView> {
  const row = await loadForConvener(db, actor, id);
  const status = row.workflowStatus as WorkflowStatus;
  const windows = await db
    .select({ r: screenRequest, screenName: screen.name })
    .from(screenRequest)
    .innerJoin(screen, eq(screen.id, screenRequest.screenId))
    .where(eq(screenRequest.submissionId, row.id))
    .orderBy(asc(screenRequest.preferredStartAt), asc(screen.name), asc(screenRequest.slotNumber));
  const [h, versions, revisions, decisions, audit] = await Promise.all([
    head(db, row),
    versionsOf(db, row),
    revisionsOf(db, row),
    decisionsOf(db, row),
    auditOf(db, row),
  ]);
  return {
    ...h,
    canEdit: isEditable(status),
    canSubmit: isSubmittable(status),
    windows: windows.map(({ r, screenName }) => ({
      screenId: r.screenId,
      screenName,
      slotNumber: r.slotNumber,
      startAt: iso(r.preferredStartAt),
      endAt: iso(r.preferredEndAt),
      note: r.requestNote,
    })),
    versions,
    revisions,
    decisions,
    audit,
  };
}

export async function getSubmissionForReviewer(
  db: Db,
  actor: CurrentUser,
  id: string,
): Promise<ReviewerSubmissionView> {
  const row = await loadForReviewer(db, actor, id);
  const [h, revisions, decisions, audit] = await Promise.all([
    head(db, row),
    revisionsOf(db, row),
    decisionsOf(db, row),
    auditOf(db, row),
  ]);
  // Reviewers only see media that was actually submitted (part of some revision), never an unsubmitted replacement.
  const versions = await versionsOf(db, row, [...new Set(revisions.map((r) => r.mediaVersionId))]);
  const status = row.workflowStatus as WorkflowStatus;
  return {
    ...h,
    canDecide: status === "PENDING_REVIEW" && row.createdByUserId !== actor.id && Boolean(row.currentRevisionId),
    currentRevision: revisions.find((r) => r.isCurrent) ?? null,
    versions,
    revisions,
    decisions,
    audit,
  };
}

export interface ListItem {
  id: string;
  referenceCode: string;
  title: string;
  status: WorkflowStatus;
  committeeCode: string;
  committeeName: string;
  submittedAt: string | null;
  updatedAt: string;
  createdByName: string;
}

const listSelect = {
  id: submission.id,
  referenceCode: submission.referenceCode,
  title: submission.title,
  status: submission.workflowStatus,
  committeeCode: committee.code,
  committeeName: committee.name,
  submittedAt: submission.submittedAt,
  updatedAt: submission.updatedAt,
  createdByName: appUser.displayName,
};
const toItem = (r: {
  id: string;
  referenceCode: string;
  title: string;
  status: string;
  committeeCode: string;
  committeeName: string;
  submittedAt: Date | null;
  updatedAt: Date;
  createdByName: string;
}): ListItem => ({
  ...r,
  status: r.status as WorkflowStatus,
  submittedAt: iso(r.submittedAt),
  updatedAt: r.updatedAt.toISOString(),
});

/** Submissions of the committees this convener actively belongs to (and only if they hold the CONVENER role). */
export async function listConvenerSubmissions(db: Db, actor: CurrentUser): Promise<ListItem[]> {
  if (!actor.roles.includes("CONVENER") || actor.memberships.length === 0) return [];
  const rows = await db
    .select(listSelect)
    .from(submission)
    .innerJoin(committee, eq(committee.id, submission.committeeId))
    .innerJoin(appUser, eq(appUser.id, submission.createdByUserId))
    .where(inArray(submission.committeeId, [...new Set(actor.memberships.map((m) => m.committeeId))]))
    .orderBy(desc(submission.updatedAt))
    .limit(200);
  return rows.map(toItem);
}

/** Reviewer queue: everything awaiting review (oldest first), plus recently decided ones. Never drafts. */
export async function listReviewQueue(
  db: Db,
  actor: CurrentUser,
): Promise<{ pending: ListItem[]; decided: ListItem[] }> {
  if (!actor.roles.includes("REVIEWER")) return { pending: [], decided: [] };
  const base = () =>
    db
      .select(listSelect)
      .from(submission)
      .innerJoin(committee, eq(committee.id, submission.committeeId))
      .innerJoin(appUser, eq(appUser.id, submission.createdByUserId));
  const [pending, decided] = await Promise.all([
    base().where(eq(submission.workflowStatus, "PENDING_REVIEW")).orderBy(asc(submission.submittedAt)).limit(200),
    base()
      .where(and(ne(submission.workflowStatus, "PENDING_REVIEW"), ne(submission.workflowStatus, "DRAFT")))
      .orderBy(desc(submission.updatedAt))
      .limit(50),
  ]);
  return { pending: pending.map(toItem), decided: decided.map(toItem) };
}

export async function listActiveScreens(db: Db) {
  return db
    .select({ id: screen.id, name: screen.name, code: screen.code, location: screen.locationDescription })
    .from(screen)
    .where(eq(screen.isActive, true))
    .orderBy(asc(screen.name));
}

/**
 * Handoff eligibility, derived (never stored): the submission is APPROVED and the latest decision on its CURRENT
 * revision is an approval. An approval of any older revision never counts, so replacing media or editing details
 * after approval removes eligibility until the new revision is approved. (The manager queue built on top of this
 * is a later phase.)
 */
export async function isHandoffEligible(db: Db | Tx, submissionId: string): Promise<boolean> {
  const [row] = await db.select().from(submission).where(eq(submission.id, submissionId));
  if (!row || row.workflowStatus !== "APPROVED" || !row.currentRevisionId) return false;
  const [latest] = await db
    .select({ decision: reviewDecision.decision })
    .from(reviewDecision)
    .where(eq(reviewDecision.revisionId, row.currentRevisionId))
    .orderBy(desc(reviewDecision.createdAt))
    .limit(1);
  return latest?.decision === "APPROVED";
}
