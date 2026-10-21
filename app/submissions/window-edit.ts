// Pure helpers behind the window editor (kept out of the .tsx so they can be unit-tested in Node).
import { toCampusInputValue } from "./time.ts";
import { ALL_DAY_END, ALL_DAY_START, ALL_SCREENS } from "./windows.ts";

export interface EditableWindow {
  /** A screen id, or ALL_SCREENS. */
  screenId: string;
  startAt: string;
  endAt: string;
  note: string;
  /** Whole days (00:00 to 23:59); the pickers then choose dates only. */
  allDay: boolean;
}

const isAllDayTimes = (w: { startAt: string; endAt: string }) =>
  w.startAt.endsWith(`T${ALL_DAY_START}`) && w.endAt.endsWith(`T${ALL_DAY_END}`);

export const toAllDay = (w: { startAt: string; endAt: string }) => {
  const first = w.startAt.slice(0, 10);
  const last = w.endAt.slice(0, 10) || first;
  return { startAt: first ? `${first}T${ALL_DAY_START}` : "", endAt: last ? `${last}T${ALL_DAY_END}` : "" };
};

export const toEditable = (
  initial: Array<{ screenId: string; startAt: string | null; endAt: string | null; note: string | null }>,
): EditableWindow[] =>
  initial
    .map((w) => ({
      screenId: w.screenId,
      startAt: w.startAt ? toCampusInputValue(w.startAt) : "",
      endAt: w.endAt ? toCampusInputValue(w.endAt) : "",
      note: w.note ?? "",
      allDay: false,
    }))
    .map((w) => ({ ...w, allDay: isAllDayTimes(w) }));

/**
 * The server stores "all screens" as one window per screen. When loading, windows that share their times and note and
 * together cover every screen are shown again as a single "All screens" window.
 */
export function collapseAllScreens(rows: EditableWindow[], screens: Array<{ id: string }>): EditableWindow[] {
  if (screens.length < 2) return rows;
  const out: EditableWindow[] = [];
  const groups = new Map<string, EditableWindow[]>();
  for (const r of rows) {
    const key = JSON.stringify([r.startAt, r.endAt, r.note]);
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const done = new Set<string>();
  for (const r of rows) {
    const key = JSON.stringify([r.startAt, r.endAt, r.note]);
    const g = groups.get(key)!;
    const covers = screens.every((s) => g.some((x) => x.screenId === s.id)) && g.length === screens.length;
    if (!covers) out.push(r);
    else if (!done.has(key)) {
      done.add(key);
      out.push({ ...r, screenId: ALL_SCREENS });
    }
  }
  return out;
}
