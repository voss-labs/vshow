// Requested display windows: parsing and validation. Pure.
//
// Rules (confirmed): both start and end are required; the end must be after the start; the start must be in the
// future at SUBMISSION time (checked separately, so a draft can be saved earlier); at most `maxWindows` per
// submission. Overlapping windows are ALLOWED, including several windows on the same screen at the same time: the
// Server Room Manager arranges overlaps into a playback loop in a later phase. Nothing here compares windows with
// each other.
import type { FieldIssue } from "./errors.ts";
import { parseCampusDateTime } from "./time.ts";

/** A window's screen may be this value: the server expands it to every active screen when the draft is saved. */
export const ALL_SCREENS = "ALL";

/** "All day" windows run from 00:00 on the first day to 23:59 on the last day (campus time). */
export const ALL_DAY_START = "00:00";
export const ALL_DAY_END = "23:59";

export interface WindowInput {
  screenId: string;
  startAt: string;
  endAt: string;
  note?: string | null;
}

export interface ParsedWindow {
  screenId: string;
  startAt: Date;
  endAt: Date;
  note: string | null;
}

export interface SlottedWindow extends ParsedWindow {
  /** 1, 2, 3... per screen, in the order given. Distinguishes several windows on the same screen. */
  slotNumber: number;
}

export function parseWindows(
  inputs: readonly WindowInput[],
  { maxWindows }: { maxWindows: number },
): { windows: ParsedWindow[]; issues: FieldIssue[] } {
  const issues: FieldIssue[] = [];
  if (inputs.length > maxWindows) issues.push({ path: "windows", code: "too_many_windows" });
  const windows: ParsedWindow[] = [];
  inputs.forEach((w, i) => {
    const startAt = parseCampusDateTime(w.startAt);
    const endAt = parseCampusDateTime(w.endAt);
    if (!startAt) issues.push({ path: `windows.${i}.startAt`, code: "invalid_datetime" });
    if (!endAt) issues.push({ path: `windows.${i}.endAt`, code: "invalid_datetime" });
    if (startAt && endAt) {
      if (endAt.getTime() <= startAt.getTime())
        issues.push({ path: `windows.${i}.endAt`, code: "end_not_after_start" });
      else windows.push({ screenId: w.screenId, startAt, endAt, note: w.note?.trim() ? w.note.trim() : null });
    }
  });
  return { windows: issues.length ? [] : windows, issues };
}

/**
 * Replaces each ALL_SCREENS window with one window per active screen (same times and note). Runs after validation, so
 * issue paths still refer to the windows the person entered.
 */
export function expandAllScreens<T extends { screenId: string }>(
  windows: readonly T[],
  activeScreenIds: readonly string[],
): T[] {
  return windows.flatMap((w) =>
    w.screenId === ALL_SCREENS ? activeScreenIds.map((screenId) => ({ ...w, screenId })) : [w],
  );
}

/** Numbers windows per screen (1, 2, ...) in the order given. */
export function assignSlots(windows: readonly ParsedWindow[]): SlottedWindow[] {
  const next = new Map<string, number>();
  return windows.map((w) => {
    const slotNumber = (next.get(w.screenId) ?? 0) + 1;
    next.set(w.screenId, slotNumber);
    return { ...w, slotNumber };
  });
}

/** At submission time every window must start in the future (campus "now" is just the current instant). */
export function futureIssues(windows: readonly { startAt: Date }[], now: Date): FieldIssue[] {
  const issues: FieldIssue[] = [];
  windows.forEach((w, i) => {
    if (w.startAt.getTime() <= now.getTime())
      issues.push({ path: `windows.${i}.startAt`, code: "start_not_in_future" });
  });
  return issues;
}

/** An order-independent fingerprint, to tell whether an edit actually changed the requested windows. */
export function windowsFingerprint(
  windows: readonly { screenId: string; startAt: Date; endAt: Date; note: string | null }[],
): string {
  return windows
    .map((w) => `${w.screenId}|${w.startAt.toISOString()}|${w.endAt.toISOString()}|${w.note ?? ""}`)
    .sort()
    .join("\n");
}
