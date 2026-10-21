// Searchable committee chooser. Type to filter the existing committees; when nothing matches, the list offers to add the
// typed name as a NEW committee, after a confirmation dialog, and that committee is then selected. Nothing is created
// until the surrounding form is saved: the form posts either `committeeId` (existing) or `newCommitteeName` (new), and
// the server creates the committee (or reuses one with the same name) inside the same transaction as the grant.
import { useEffect, useId, useMemo, useRef, useState } from "react";

export interface CommitteeChoice {
  id: string;
  name: string;
}

type Selection = { kind: "existing"; id: string; name: string } | { kind: "new"; name: string };

const NAME_MAX = 120;
const clean = (v: string) => v.trim().replace(/\s+/g, " ");

export function CommitteePicker({
  committees,
  label = "Committee or department",
  required = true,
}: {
  committees: CommitteeChoice[];
  label?: string;
  required?: boolean;
}) {
  const uid = useId();
  const inputId = `${uid}-input`;
  const listId = `${uid}-list`;
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [pendingName, setPendingName] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const confirmButton = useRef<HTMLButtonElement>(null);

  const name = clean(query);
  const options = useMemo(() => {
    const q = name.toLowerCase();
    const matches = committees.filter((c) => c.name.toLowerCase().includes(q));
    const exact = committees.some((c) => c.name.toLowerCase() === q);
    const items: Array<{ key: string; kind: "existing" | "create"; id?: string; name: string }> = matches.map((c) => ({
      key: c.id,
      kind: "existing",
      id: c.id,
      name: c.name,
    }));
    if (name !== "" && !exact && name.length <= NAME_MAX) items.push({ key: "create", kind: "create", name });
    return items;
  }, [committees, name]);

  useEffect(() => setActive(0), [name]);
  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (pendingName !== null && !d.open) d.showModal();
    if (pendingName === null && d.open) d.close();
  }, [pendingName]);

  // Block form submission (with a readable message) while text is typed but nothing is selected.
  useEffect(() => {
    input.current?.setCustomValidity(
      !selection && name !== "" ? "Choose a committee from the list, or add it as a new one." : "",
    );
  }, [selection, name]);

  const choose = (o: (typeof options)[number]) => {
    setOpen(false);
    if (o.kind === "existing") {
      setSelection({ kind: "existing", id: o.id!, name: o.name });
      setQuery("");
    } else {
      setPendingName(o.name);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setActive((a) => Math.min(a + 1, Math.max(0, options.length - 1)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter" && open && options[active]) {
      e.preventDefault(); // pick the highlighted option instead of submitting the form
      choose(options[active]);
    } else if (e.key === "Escape" && open) {
      e.preventDefault();
      setOpen(false);
    }
  };

  return (
    <div>
      {selection ? (
        <>
          <span className="label">{label}</span>
          <input
            type="hidden"
            name={selection.kind === "existing" ? "committeeId" : "newCommitteeName"}
            value={selection.kind === "existing" ? selection.id : selection.name}
          />
          <div className="flex flex-wrap items-center gap-3">
            <span className="badge" data-tone={selection.kind === "new" ? "info" : "neutral"}>
              {selection.name}
              {selection.kind === "new" ? " · new" : ""}
            </span>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => {
                setSelection(null);
                requestAnimationFrame(() => input.current?.focus());
              }}
            >
              Change
            </button>
          </div>
          {selection.kind === "new" && <p className="hint mt-2">This committee will be created when you save.</p>}
        </>
      ) : (
        <div className="relative max-w-md">
          <label htmlFor={inputId} className="label">
            {label}
          </label>
          <input
            ref={input}
            id={inputId}
            role="combobox"
            aria-expanded={open}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={open && options[active] ? `${uid}-opt-${options[active].key}` : undefined}
            className="field w-full"
            value={query}
            required={required}
            maxLength={NAME_MAX}
            autoComplete="off"
            placeholder="Search committees…"
            onChange={(e) => {
              setQuery(e.target.value);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onBlur={() => setOpen(false)}
            onKeyDown={onKeyDown}
          />
          {open && (
            <ul
              id={listId}
              role="listbox"
              aria-label={label}
              className="panel absolute z-20 mt-1 max-h-64 w-full list-none overflow-auto p-1"
            >
              {options.length === 0 && (
                <li className="px-3 py-2 text-sm text-dim" role="presentation">
                  {name === "" ? "No committees yet. Type a name to add one." : "Name is too long."}
                </li>
              )}
              {options.map((o, i) => (
                <li
                  key={o.key}
                  id={`${uid}-opt-${o.key}`}
                  role="option"
                  aria-selected={i === active}
                  className={`cursor-pointer rounded px-3 py-2 ${i === active ? "bg-hover" : ""}`}
                  // mousedown (not click) so the input's blur does not close the list first
                  onMouseDown={(e) => {
                    e.preventDefault();
                    choose(o);
                  }}
                  onMouseEnter={() => setActive(i)}
                >
                  {o.kind === "create" ? (
                    <span>
                      <span aria-hidden="true">+ </span>Add “{o.name}” as a new committee
                    </span>
                  ) : (
                    o.name
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <dialog
        ref={dialog}
        className="panel fixed inset-0 m-auto h-fit w-[calc(100%-2rem)] max-w-md p-6 text-ink backdrop:bg-black/50"
        aria-labelledby={`${uid}-title`}
        onClose={() => setPendingName(null)}
        onCancel={() => setPendingName(null)}
      >
        <h3 id={`${uid}-title`} className="m-0 text-lg font-semibold">
          Create a new committee?
        </h3>
        <p className="mt-3 text-dim">
          “{pendingName}” is not in the list. It will be added as a new committee when you save, and selected here.
        </p>
        <div className="mt-6 flex justify-end gap-3">
          <button type="button" className="btn btn-ghost" onClick={() => setPendingName(null)}>
            Cancel
          </button>
          <button
            ref={confirmButton}
            type="button"
            className="btn"
            autoFocus
            onClick={() => {
              if (pendingName) {
                setSelection({ kind: "new", name: pendingName });
                setQuery("");
              }
              setPendingName(null);
            }}
          >
            Create committee
          </button>
        </div>
      </dialog>
    </div>
  );
}
