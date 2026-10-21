// Turns a validation issue (a field path plus a machine code, never the submitted value) into a plain sentence for
// the page. Pure and client-safe. Unknown codes fall back to the path and the code so nothing is ever hidden.
const WINDOW_PATH = /^windows\.(\d+)(?:\.(\w+))?$/;

export function describeIssue(path: string, code: string): string {
  const match = WINDOW_PATH.exec(path);
  const window = match ? `Window ${Number(match[1]) + 1}` : null;
  const field = match?.[2] === "startAt" ? "start" : match?.[2] === "endAt" ? "end" : "time";

  switch (code) {
    case "start_not_in_future":
      return `${window ?? "A window"}: the start time has already passed. Choose a start in the future (India time).`;
    case "end_not_after_start":
      return `${window ?? "A window"}: the end must be after the start.`;
    case "invalid_datetime":
      return `${window ?? "A window"}: the ${field} is not a valid date and time.`;
    case "screen_unavailable":
      return `${window ?? "A window"}: that screen is not available. Choose another screen.`;
    case "incomplete_window":
      return `${window ?? "A window"}: both a start and an end are required.`;
    case "too_many_windows":
      return "There are too many display windows. Remove some and try again.";
    case "window_required":
      return "Add at least one display window before submitting.";
    case "media_required":
      return "Upload the media before submitting.";
    case "unsupported_type":
      return "That file type is not accepted. Use a JPEG, PNG, WebP or MP4 file.";
    case "too_large":
      return "That file is larger than the allowed size.";
    case "unreadable_image":
      return "The image could not be read. Its header is damaged.";
    case "unreadable_video":
      return "The video could not be read. Its index is missing or damaged.";
    case "no_video_track":
      return "The file contains no video.";
    case "truncated_file":
      return "The file is incomplete (cut short). Upload it again.";
    case "invalid_dimensions":
      return "The file reports a width or height of zero.";
    case "too_many_pixels":
      return "The picture is larger (in pixels) than the allowed limit. Resize it and upload again.";
    case "size_mismatch":
    case "type_mismatch":
    case "signature_mismatch":
      return "The uploaded file did not pass validation and was not saved.";
    case "must_match_original":
      return "A resubmission must belong to the same committee as the original.";
    case "required":
      return path === "comment"
        ? "A comment or reason is required for this decision."
        : `${path || "This field"} is required.`;
    default:
      return `${path || "form"}: ${code.replaceAll("_", " ")}`;
  }
}
