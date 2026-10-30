import { sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type { MediaAnalysis } from "../../media/analysis.ts";
import { UPLOAD_STATUSES, WORKFLOW_STATUSES, sqlList } from "./values.ts";
import { appUser } from "./identity.ts";
import { committee, screen } from "./campus.ts";

// Schema doc §4.7
export const submission = pgTable(
  "submission",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    referenceCode: varchar("reference_code", { length: 40 }).notNull().unique(),
    committeeId: uuid("committee_id")
      .notNull()
      .references(() => committee.id),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => appUser.id),
    title: varchar("title", { length: 200 }).notNull(),
    description: text("description"),
    workflowStatus: text("workflow_status").notNull(),
    currentVersionId: uuid("current_version_id"),
    // The immutable snapshot that is currently up for (or has received) review. Null until first submitted.
    currentRevisionId: uuid("current_revision_id"),
    // A rejected submission is terminal; a resubmission is a NEW submission pointing back at it.
    resubmissionOfId: uuid("resubmission_of_id"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    check("submission_workflow_status_valid", sql.raw(`"workflow_status" IN (${sqlList(WORKFLOW_STATUSES)})`)),
    // Composite FK (schema doc §4.7 / §8): current version must belong to this submission.
    // Not enforced while current_version_id is NULL (MATCH SIMPLE).
    foreignKey({
      name: "submission_current_version_fk",
      columns: [t.currentVersionId, t.id],
      foreignColumns: [mediaVersion.id, mediaVersion.submissionId],
    }),
    // Same idea for the current revision: it must belong to this submission.
    foreignKey({
      name: "submission_current_revision_fk",
      columns: [t.currentRevisionId, t.id],
      foreignColumns: [submissionRevision.id, submissionRevision.submissionId],
    }),
    foreignKey({
      name: "submission_resubmission_of_fk",
      columns: [t.resubmissionOfId],
      foreignColumns: [t.id],
    }),
    check("submission_resubmission_not_self", sql`${t.resubmissionOfId} IS NULL OR ${t.resubmissionOfId} <> ${t.id}`),
    index("submission_resubmission_of_idx").on(t.resubmissionOfId),
    index("submission_status_updated_idx").on(t.workflowStatus, t.updatedAt.desc()),
    index("submission_committee_created_idx").on(t.committeeId, t.createdAt.desc()),
    index("submission_creator_created_idx").on(t.createdByUserId, t.createdAt.desc()),
  ],
);

// Schema doc §4.8 (immutable: rows are inserted, never updated)
export const mediaVersion = pgTable(
  "media_version",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Annotated to break the submission <-> media_version type cycle (current_version_id).
    submissionId: uuid("submission_id")
      .notNull()
      .references((): AnyPgColumn => submission.id),
    versionNumber: integer("version_number").notNull(),
    objectKey: varchar("object_key", { length: 1024 }).notNull().unique(),
    originalFilename: varchar("original_filename", { length: 255 }).notNull(),
    contentType: varchar("content_type", { length: 150 }).notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    checksumSha256: varchar("checksum_sha256", { length: 64 }),
    // Provider ETag of the FINAL object as validated at finalization (identifies the exact stored bytes).
    storageEtag: varchar("storage_etag", { length: 128 }),
    // What the file was found to be at finalization (dimensions, aspect ratio, duration, codec, and the structural
    // checks). Null for versions recorded before the analysis existed. Immutable like the rest of the row.
    mediaInfo: jsonb("media_info").$type<MediaAnalysis>(),
    uploadedByUserId: uuid("uploaded_by_user_id")
      .notNull()
      .references(() => appUser.id),
    uploadedAt: timestamp("uploaded_at", { withTimezone: true }).notNull().defaultNow(),
    changeNote: text("change_note"),
  },
  (t) => [
    unique("media_version_submission_number_unique").on(t.submissionId, t.versionNumber),
    // Target for composite FKs that must prove "version belongs to submission".
    unique("media_version_id_submission_unique").on(t.id, t.submissionId),
    check("media_version_size_positive", sql`${t.sizeBytes} > 0`),
    check("media_version_info_object", sql`${t.mediaInfo} IS NULL OR jsonb_typeof(${t.mediaInfo}) = 'object'`),
    check("media_version_number_positive", sql`${t.versionNumber} >= 1`),
    index("media_version_submission_number_idx").on(t.submissionId, t.versionNumber.desc()),
  ],
);

// Schema doc §4.9. slot_number distinguishes several requested windows on the same
// screen (schema doc §9, decision 2).
export const screenRequest = pgTable(
  "screen_request",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    submissionId: uuid("submission_id")
      .notNull()
      .references(() => submission.id),
    screenId: uuid("screen_id")
      .notNull()
      .references(() => screen.id),
    slotNumber: integer("slot_number").notNull().default(1),
    preferredStartAt: timestamp("preferred_start_at", { withTimezone: true }),
    preferredEndAt: timestamp("preferred_end_at", { withTimezone: true }),
    requestNote: text("request_note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    unique("screen_request_submission_screen_slot_unique").on(t.submissionId, t.screenId, t.slotNumber),
    check("screen_request_slot_positive", sql`${t.slotNumber} >= 1`),
    check(
      "screen_request_window_valid",
      sql`${t.preferredStartAt} IS NULL OR ${t.preferredEndAt} IS NULL OR ${t.preferredEndAt} > ${t.preferredStartAt}`,
    ),
    index("screen_request_screen_window_idx").on(t.screenId, t.preferredStartAt, t.preferredEndAt),
  ],
);

// Immutable snapshot of everything a reviewer evaluates: title, description, media version, requested windows.
// Created when a convener submits; reviews point at it; approval is only ever valid for the CURRENT revision.
export const submissionRevision = pgTable(
  "submission_revision",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    submissionId: uuid("submission_id")
      .notNull()
      .references((): AnyPgColumn => submission.id),
    revisionNumber: integer("revision_number").notNull(),
    title: varchar("title", { length: 200 }).notNull(),
    description: text("description"),
    mediaVersionId: uuid("media_version_id").notNull(),
    // Frozen copy of the requested windows: [{ screenId, slotNumber, startAt, endAt, note }]
    requestedWindows: jsonb("requested_windows").notNull(),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => appUser.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("submission_revision_number_unique").on(t.submissionId, t.revisionNumber),
    // Targets for composite FKs proving "revision belongs to submission" and "decision's version = revision's version".
    unique("submission_revision_id_submission_unique").on(t.id, t.submissionId),
    unique("submission_revision_id_version_unique").on(t.id, t.mediaVersionId),
    foreignKey({
      name: "submission_revision_version_fk",
      columns: [t.mediaVersionId, t.submissionId],
      foreignColumns: [mediaVersion.id, mediaVersion.submissionId],
    }),
    check("submission_revision_number_positive", sql`${t.revisionNumber} >= 1`),
    check("submission_revision_windows_array", sql`jsonb_typeof(${t.requestedWindows}) = 'array'`),
    index("submission_revision_submission_number_idx").on(t.submissionId, t.revisionNumber.desc()),
  ],
);

// One row per upload the server has authorised. The id becomes the media version's id; the browser may only ever
// write to staging_key, and final_key is where the validated copy will live (never has an upload URL).
export const uploadReservation = pgTable(
  "upload_reservation",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    submissionId: uuid("submission_id")
      .notNull()
      .references(() => submission.id),
    stagingKey: varchar("staging_key", { length: 1024 }).notNull().unique(),
    finalKey: varchar("final_key", { length: 1024 }).notNull().unique(),
    declaredContentType: varchar("declared_content_type", { length: 150 }).notNull(),
    declaredSizeBytes: bigint("declared_size_bytes", { mode: "number" }).notNull(),
    originalFilename: varchar("original_filename", { length: 255 }).notNull(),
    reservedByUserId: uuid("reserved_by_user_id")
      .notNull()
      .references(() => appUser.id),
    status: text("status").notNull().default("PENDING"),
    failureReason: varchar("failure_reason", { length: 100 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    finalizedAt: timestamp("finalized_at", { withTimezone: true }),
  },
  (t) => [
    check("upload_reservation_status_valid", sql.raw(`"status" IN (${sqlList(UPLOAD_STATUSES)})`)),
    check("upload_reservation_size_positive", sql`${t.declaredSizeBytes} > 0`),
    check("upload_reservation_expiry_after_creation", sql`${t.expiresAt} > ${t.createdAt}`),
    index("upload_reservation_submission_status_idx").on(t.submissionId, t.status),
  ],
);

// Per-year counter behind VS-YYYY-NNNNNN reference codes (see vshow_next_reference_code in migration 0004).
export const referenceCounter = pgTable("reference_counter", {
  year: integer("year").primaryKey(),
  lastValue: integer("last_value").notNull().default(0),
});
