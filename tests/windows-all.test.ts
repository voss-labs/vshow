// "All screens" and "All day" windows: the pure helpers and the editor's collapse of stored per-screen rows.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { collapseAllScreens, type EditableWindow } from "../app/submissions/window-edit.ts";
import { ALL_SCREENS, expandAllScreens } from "../app/submissions/windows.ts";

const row = (
  screenId: string,
  startAt = "2030-02-01T00:00",
  endAt = "2030-02-01T23:59",
  note = "",
): EditableWindow => ({
  screenId,
  startAt,
  endAt,
  note,
  allDay: false,
});

describe("expandAllScreens", () => {
  it("replaces an all-screens window with one per active screen and leaves others alone", () => {
    const out = expandAllScreens(
      [
        { screenId: ALL_SCREENS, note: "a" },
        { screenId: "x", note: "b" },
      ],
      ["s1", "s2"],
    );
    assert.deepEqual(out, [
      { screenId: "s1", note: "a" },
      { screenId: "s2", note: "a" },
      { screenId: "x", note: "b" },
    ]);
  });
});

describe("collapseAllScreens", () => {
  const screens = [{ id: "s1" }, { id: "s2" }];
  it("shows a window that covers every screen as one All screens window", () => {
    const out = collapseAllScreens([row("s1"), row("s2")], screens);
    assert.equal(out.length, 1);
    assert.equal(out[0].screenId, ALL_SCREENS);
  });
  it("keeps partial coverage, different times and single-screen setups as they are", () => {
    assert.equal(collapseAllScreens([row("s1")], screens).length, 1);
    assert.equal(collapseAllScreens([row("s1")], screens)[0].screenId, "s1");
    assert.equal(collapseAllScreens([row("s1"), row("s2", "2030-02-02T00:00")], screens).length, 2);
    assert.equal(collapseAllScreens([row("s1")], [{ id: "s1" }])[0].screenId, "s1");
  });
});
