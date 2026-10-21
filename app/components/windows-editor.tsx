// Editor for the requested display windows. Rows may overlap freely (including the same screen at the same time);
// the server validates the timestamps and screens. Times are entered and shown in campus time (Asia/Kolkata).
import { useEffect, useId, useState } from "react";
import { formatCampus, parseCampusDateTime, toCampusInputValue } from "../submissions/time.ts";
import { ALL_DAY_END, ALL_DAY_START, ALL_SCREENS } from "../submissions/windows.ts";
import { collapseAllScreens, toAllDay, toEditable, type EditableWindow } from "../submissions/window-edit.ts";
import { DateTimePicker } from "./date-time-picker.tsx";

/** The picker offers nothing earlier than this many minutes from now, leaving time to finish and submit. */
const EARLIEST_START_MINUTES = 10;

export function WindowsEditor({
  screens,
  initial,
  name = "windows",
  maxWindows,
}: {
  screens: Array<{ id: string; name: string }>;
  initial: Array<{ screenId: string; startAt: string | null; endAt: string | null; note: string | null }>;
  name?: string;
  maxWindows: number;
}) {
  const [rows, setRows] = useState<EditableWindow[]>(() => collapseAllScreens(toEditable(initial), screens));
  // Rows are sent to the server with the all-day times filled in; "all day" itself is just 00:00 to 23:59.
  const sent = rows.map((r) => ({ screenId: r.screenId, startAt: r.startAt, endAt: r.endAt, note: r.note }));
  const update = (i: number, patch: Partial<EditableWindow>) =>
    setRows((r) => r.map((row, n) => (n === i ? { ...row, ...patch } : row)));
  const uid = useId();

  // "Now" is read only in the browser (after the first render), so the server-rendered page and the first client
  // render are identical. A window must start in the future when the submission is sent, so the picker will not offer
  // anything earlier than a few minutes from now, and a start that has since passed is flagged here instead of only
  // being refused later by the server (which still enforces the rule).
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const tomorrow = now
    ? `${toCampusInputValue(new Date(now.getTime() + 24 * 3_600_000)).slice(0, 10)}T${ALL_DAY_START}`
    : undefined;
  const earliestStart = now ? toCampusInputValue(new Date(now.getTime() + EARLIEST_START_MINUTES * 60_000)) : undefined;
  const startHasPassed = (startAt: string) => {
    const start = parseCampusDateTime(startAt);
    return Boolean(now && start && start.getTime() <= now.getTime());
  };

  return (
    <div>
      {/* The server receives the rows as JSON; it re-validates every value. */}
      <input type="hidden" name={name} value={JSON.stringify(sent)} />
      {rows.length === 0 && (
        <p className="mb-4 text-dim">No display windows yet. Add at least one before submitting.</p>
      )}
      <ul className="m-0 list-none space-y-4 p-0">
        {rows.map((row, i) => (
          <li key={i} className="panel">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="mono text-xs font-medium tracking-widest text-dim uppercase">Window {i + 1}</h3>
              <button type="button" className="btn-text" onClick={() => setRows((r) => r.filter((_, n) => n !== i))}>
                Remove<span className="sr-only"> window {i + 1}</span>
              </button>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="label" htmlFor={`${uid}-screen-${i}`}>
                  Screen
                </label>
                <select
                  id={`${uid}-screen-${i}`}
                  className="field"
                  value={row.screenId}
                  onChange={(e) => update(i, { screenId: e.target.value })}
                >
                  <option value="">Choose a screen…</option>
                  {screens.length > 1 && <option value={ALL_SCREENS}>All screens ({screens.length})</option>}
                  {screens.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label" htmlFor={`${uid}-note-${i}`}>
                  Note (optional)
                </label>
                <input
                  id={`${uid}-note-${i}`}
                  className="field"
                  value={row.note}
                  maxLength={500}
                  onChange={(e) => update(i, { note: e.target.value })}
                />
              </div>
              <div className="sm:col-span-2">
                <label className="flex items-center gap-3">
                  <input
                    type="checkbox"
                    checked={row.allDay}
                    onChange={(e) =>
                      update(
                        i,
                        e.target.checked
                          ? { allDay: true, ...toAllDay(row) }
                          : {
                              allDay: false,
                              startAt: row.startAt ? `${row.startAt.slice(0, 10)}T09:00` : "",
                              endAt: row.endAt ? `${row.endAt.slice(0, 10)}T18:00` : "",
                            },
                      )
                    }
                  />
                  <span>
                    <span className="font-medium">All day</span>
                    <span className="text-sm text-dim"> · show for the whole day, from 00:00 to 23:59</span>
                  </span>
                </label>
              </div>
              <div>
                <label className="label" htmlFor={`${uid}-from-${i}`}>
                  {row.allDay ? "First day (IST)" : "From (IST)"}
                </label>
                <DateTimePicker
                  id={`${uid}-from-${i}`}
                  value={row.startAt}
                  min={row.allDay ? tomorrow : earliestStart}
                  clamp
                  fixedTime={row.allDay ? ALL_DAY_START : undefined}
                  onChange={(startAt) => update(i, { startAt })}
                />
                {row.allDay && <p className="hint">All-day requests start tomorrow or later.</p>}
                {startHasPassed(row.startAt) && now && (
                  <p className="hint text-warn" role="status">
                    This start has already passed (it is {formatCampus(now)} now). Pick a later time, or the submission
                    will be refused.
                  </p>
                )}
              </div>
              <div>
                <label className="label" htmlFor={`${uid}-until-${i}`}>
                  {row.allDay ? "Last day (IST)" : "Until (IST)"}
                </label>
                <DateTimePicker
                  id={`${uid}-until-${i}`}
                  value={row.endAt}
                  min={row.allDay ? row.startAt.slice(0, 10) + "T" + ALL_DAY_END : row.startAt}
                  fixedTime={row.allDay ? ALL_DAY_END : undefined}
                  onChange={(endAt) => update(i, { endAt })}
                />
              </div>
            </div>
          </li>
        ))}
      </ul>
      <button
        type="button"
        className="btn btn-ghost mt-4"
        disabled={rows.length >= maxWindows}
        onClick={() =>
          setRows((r) => [...r, { screenId: screens[0]?.id ?? "", startAt: "", endAt: "", note: "", allDay: false }])
        }
      >
        + Add a window
      </button>
      <p className="hint">
        Up to {maxWindows} windows. Windows may overlap; the Server Room Manager arranges overlapping media later.
        Requested times are preferences, not bookings.
      </p>
    </div>
  );
}
