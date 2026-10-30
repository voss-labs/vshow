// Input schemas shared by routes and services (Zod is browser-safe; only the boundary that parses requests is
// server-only). Limits live here so the UI and the server agree. Failures are reduced to path + code before they
// leave the server, never echoing what was submitted.
import { z } from "zod";
import { ALL_SCREENS } from "./windows.ts";
import { REVIEW_DECISIONS } from "../db/schema/values.ts";
import type { FieldIssue } from "./errors.ts";

export const TITLE_MAX = 200;
export const DESCRIPTION_MAX = 5000;
export const COMMENT_MAX = 2000;
export const NOTE_MAX = 500;
/** Hard ceiling on windows accepted in one request, before the configurable policy limit is applied. */
export const WINDOWS_HARD_CAP = 100;

export const titleSchema = z.string().trim().min(1).max(TITLE_MAX);
export const descriptionSchema = z.string().trim().max(DESCRIPTION_MAX);

export const windowSchema = z.object({
  screenId: z.union([z.uuid(), z.literal(ALL_SCREENS)]),
  startAt: z.string().min(1).max(40),
  endAt: z.string().min(1).max(40),
  note: z.string().trim().max(NOTE_MAX).nullish(),
});

export const createDraftSchema = z.object({
  committeeId: z.uuid(),
  title: titleSchema,
  description: descriptionSchema.default(""),
  /** Present when this draft is a resubmission of a REJECTED submission. */
  resubmissionOfId: z.uuid().optional(),
});

export const saveDraftSchema = z.object({
  title: titleSchema,
  description: descriptionSchema.default(""),
  windows: z.array(windowSchema).max(WINDOWS_HARD_CAP).default([]),
});

export const uploadInitSchema = z.object({
  filename: z.string().min(1).max(255),
  contentType: z.string().min(1).max(150),
  sizeBytes: z.number().int().positive(),
});

export const decisionSchema = z.object({
  revisionId: z.uuid(),
  decision: z.enum(REVIEW_DECISIONS),
  comment: z.string().trim().max(COMMENT_MAX).optional(),
});

export type CreateDraftInput = z.infer<typeof createDraftSchema>;
export type SaveDraftInput = z.infer<typeof saveDraftSchema>;
export type UploadInitInput = z.infer<typeof uploadInitSchema>;
export type DecisionInput = z.infer<typeof decisionSchema>;

export const issuesOf = (error: z.ZodError): FieldIssue[] =>
  error.issues.slice(0, 20).map((i) => ({ path: i.path.map(String).join("."), code: i.code }));
