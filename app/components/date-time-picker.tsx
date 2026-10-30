// Date + time picker built on the shadcn/ui Calendar and Popover. The value is the same "YYYY-MM-DDTHH:mm"
// campus-time string a datetime-local input produces, so the server contract is unchanged.
import { Calendar } from "~/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "~/components/ui/popover";

const pad = (n: number) => String(n).padStart(2, "0");
const VALUE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

function parse(value: string): { date: Date; time: string } | null {
  const m = VALUE.exec(value);
  if (!m) return null;
  return { date: new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])), time: `${m[4]}:${m[5]}` };
}
const dayString = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const shown = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium" });

export function DateTimePicker({
  id,
  value,
  onChange,
  min,
  clamp = false,
  fixedTime,
}: {
  id: string;
  value: string;
  onChange: (next: string) => void;
  /** Earliest selectable value (same format); earlier days are disabled. */
  min?: string;
  /** Also raise any chosen date-and-time that is before `min` up to `min` (used for "must start in the future"). */
  clamp?: boolean;
  /** Date-only mode: no time input; every chosen day gets this time ("HH:mm"). Used for "all day" windows. */
  fixedTime?: string;
}) {
  const parsed = parse(value);
  const minDay = min ? parse(min)?.date : undefined;
  const time = fixedTime ?? parsed?.time ?? "09:00";
  // The values are fixed-width "YYYY-MM-DDTHH:mm" strings, so plain string comparison orders them correctly.
  const atLeastMin = (v: string) => (clamp && min && v < min ? min : v);

  return (
    <Popover>
      <PopoverTrigger id={id} type="button" className="field text-left">
        {parsed ? (
          fixedTime ? (
            shown.format(parsed.date)
          ) : (
            `${shown.format(parsed.date)}, ${parsed.time}`
          )
        ) : (
          <span className="text-dim">{fixedTime ? "Pick a date…" : "Pick date and time…"}</span>
        )}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto p-0">
        <Calendar
          mode="single"
          selected={parsed?.date}
          defaultMonth={parsed?.date ?? minDay}
          disabled={minDay ? { before: minDay } : undefined}
          onSelect={(d) => d && onChange(atLeastMin(`${dayString(d)}T${time}`))}
        />
        {!fixedTime && (
          <div className="flex items-center gap-2 border-t border-border p-3">
            <label className="label m-0" htmlFor={`${id}-time`}>
              Time
            </label>
            <input
              id={`${id}-time`}
              type="time"
              className="field"
              value={time}
              onChange={(e) => {
                const day = parsed ? dayString(parsed.date) : dayString(minDay ?? new Date());
                if (e.target.value) onChange(atLeastMin(`${day}T${e.target.value}`));
              }}
            />
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
