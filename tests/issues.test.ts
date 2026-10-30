// Validation issues are shown to people as plain sentences. The server still sends only a field path and a code.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { describeIssue } from "../app/submissions/issues.ts";

describe("describeIssue", () => {
  it("names the window (1-based) and says what to do for a start that has passed", () => {
    const text = describeIssue("windows.0.startAt", "start_not_in_future");
    assert.match(text, /^Window 1:/);
    assert.match(text, /already passed/);
    assert.match(describeIssue("windows.4.startAt", "start_not_in_future"), /^Window 5:/);
  });

  it("explains the other window problems", () => {
    assert.match(describeIssue("windows.1.endAt", "end_not_after_start"), /Window 2: the end must be after the start/);
    assert.match(describeIssue("windows.0.startAt", "invalid_datetime"), /the start is not a valid date and time/);
    assert.match(describeIssue("windows.0.endAt", "invalid_datetime"), /the end is not a valid date and time/);
    assert.match(describeIssue("windows.2.screenId", "screen_unavailable"), /Window 3: that screen is not available/);
    assert.match(describeIssue("windows.0", "incomplete_window"), /both a start and an end/);
    assert.match(describeIssue("windows", "too_many_windows"), /too many display windows/);
  });

  it("explains submission and upload problems", () => {
    assert.match(describeIssue("media", "media_required"), /Upload the media/);
    assert.match(describeIssue("windows", "window_required"), /at least one display window/);
    assert.match(describeIssue("contentType", "unsupported_type"), /JPEG, PNG, WebP or MP4/);
    assert.match(describeIssue("sizeBytes", "too_large"), /larger than the allowed size/);
    assert.match(describeIssue("file", "signature_mismatch"), /did not pass validation/);
    assert.match(describeIssue("comment", "required"), /comment or reason is required/);
  });

  it("falls back to the path and code for anything unknown, so nothing is hidden", () => {
    assert.equal(describeIssue("title", "too_big"), "title: too big");
    assert.equal(describeIssue("", "invalid_type"), "form: invalid type");
  });

  it("never echoes a value: its inputs are only a path and a code", () => {
    assert.equal(describeIssue.length, 2);
  });
});
