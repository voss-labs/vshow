// Small presentational pieces shared by the convener and reviewer pages. No data access here.
import { describeIssue } from "../submissions/issues.ts";
import { formatCampus, toCampusInputValue } from "../submissions/time.ts";
import type { AuditView, DecisionView, RevisionView, VersionView, WindowView } from "../submissions/queries.server.ts";
import { useNavigation } from "react-router";
import { Notice, Spinner } from "./ui.tsx";

/** Submit button that disables itself and shows progress while the router is navigating/submitting. */
export function SubmitButton({
  children,
  pending = "Saving…",
  className = "btn",
  name,
  value,
}: {
  children: React.ReactNode;
  pending?: string;
  className?: string;
  name?: string;
  value?: string;
}) {
  const busy = useNavigation().state !== "idle";
  return (
    <button type="submit" name={name} value={value} disabled={busy} className={className} aria-busy={busy}>
      {busy && <Spinner />}
      {busy ? pending : children}
    </button>
  );
}

const STATUS: Record<string, { label: string; tone: "ok" | "warn" | "danger" | "info" | "neutral"; icon: string }> = {
  DRAFT: { label: "Draft", tone: "neutral", icon: "○" },
  PENDING_REVIEW: { label: "Pending review", tone: "info", icon: "◔" },
  CHANGES_REQUESTED: { label: "Changes requested", tone: "warn", icon: "!" },
  APPROVED: { label: "Approved", tone: "ok", icon: "✓" },
  REJECTED: { label: "Rejected", tone: "danger", icon: "✕" },
  CANCELLED: { label: "Cancelled", tone: "neutral", icon: "–" },
};

/** Shown once the Server Room Manager has put the approved media on the screens. */
export function LiveBadge({ live }: { live: { at: string; byName: string } | null }) {
  if (!live) return null;
  return (
    <span className="badge" data-tone="ok" title={`Put on screens by ${live.byName}, ${formatCampus(live.at)}`}>
      <span aria-hidden="true">●</span>
      Live on screens
    </span>
  );
}

/** Status is always text plus an icon, never color alone. */
export function StatusBadge({ status }: { status: string }) {
  const s = STATUS[status] ?? STATUS.DRAFT;
  return (
    <span className="badge" data-tone={s.tone === "neutral" ? undefined : s.tone}>
      <span aria-hidden="true">{s.icon}</span>
      {STATUS[status]?.label ?? status}
    </span>
  );
}

export const formatBytes = (n: number) =>
  n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MiB` : n >= 1024 ? `${(n / 1024).toFixed(0)} KiB` : `${n} B`;

export function ErrorNotice({
  error,
}: {
  error?: { message: string; issues?: Array<{ path: string; code: string }> };
}) {
  if (!error) return null;
  return (
    <div className="mb-6">
      <Notice tone="danger" title={error.message} role="alert">
        {error.issues && error.issues.length > 0 && (
          <ul className="mt-1 list-disc pl-5">
            {error.issues.map((i, n) => (
              <li key={`${i.path}-${i.code}-${n}`}>{describeIssue(i.path, i.code)}</li>
            ))}
          </ul>
        )}
      </Notice>
    </div>
  );
}

const Muted = ({ children }: { children: React.ReactNode }) => <p className="text-dim">{children}</p>;

const dayFormat = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium" });

/** From/Until cells; a window from 00:00 to 23:59 is shown as whole days. */
function WindowTimes({ startAt, endAt }: { startAt: string | null; endAt: string | null }) {
  const allDay =
    startAt !== null &&
    endAt !== null &&
    toCampusInputValue(startAt).endsWith("T00:00") &&
    toCampusInputValue(endAt).endsWith("T23:59");
  if (allDay) {
    return (
      <>
        <td className="tabular">{dayFormat.format(new Date(startAt))} · all day</td>
        <td className="tabular">{dayFormat.format(new Date(endAt))} · all day</td>
      </>
    );
  }
  return (
    <>
      <td className="tabular">{startAt ? formatCampus(startAt) : "—"}</td>
      <td className="tabular">{endAt ? formatCampus(endAt) : "—"}</td>
    </>
  );
}

export function WindowsTable({ windows }: { windows: WindowView[] }) {
  if (windows.length === 0) return <Muted>No display windows requested.</Muted>;
  return (
    <div className="table-wrap" tabIndex={0} role="region" aria-label="Requested display windows">
      <table className="vtable">
        <thead>
          <tr>
            <th scope="col">Screen</th>
            <th scope="col">From (IST)</th>
            <th scope="col">Until (IST)</th>
            <th scope="col">Note</th>
          </tr>
        </thead>
        <tbody>
          {windows.map((w, i) => (
            <tr key={`${w.screenId}-${w.slotNumber}-${i}`}>
              <td className="font-medium">
                {w.screenName}
                {w.slotNumber > 1 ? <span className="mono text-dim"> #{w.slotNumber}</span> : null}
              </td>
              <WindowTimes startAt={w.startAt} endAt={w.endAt} />
              <td className="text-dim">{w.note ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function VersionList({ submissionId, versions }: { submissionId: string; versions: VersionView[] }) {
  if (versions.length === 0) return <Muted>No media uploaded yet.</Muted>;
  return (
    <ul className="m-0 list-none border-t border-line p-0">
      {versions.map((v) => (
        <li
          key={v.id}
          className="grid items-baseline gap-x-6 gap-y-1 border-b border-line py-4 sm:grid-cols-[120px_1fr_auto]"
        >
          <div className="flex items-center gap-2">
            <span className="mono text-sm font-medium">v{v.versionNumber}</span>
            {v.isCurrent && (
              <span className="badge" data-tone="ok">
                Current
              </span>
            )}
          </div>
          <div className="min-w-0">
            <p className="break-all font-medium">{v.originalFilename}</p>
            <p className="tabular mt-0.5 text-sm text-dim">
              {v.contentType} · {formatBytes(v.sizeBytes)} · {formatCampus(v.uploadedAt)}
            </p>
          </div>
          <a className="link" href={`/submissions/${submissionId}/versions/${v.id}/file`}>
            Download<span className="sr-only"> version {v.versionNumber}</span> ↗
          </a>
        </li>
      ))}
    </ul>
  );
}

const DECISION_TONE: Record<string, "ok" | "warn" | "danger"> = {
  APPROVED: "ok",
  CHANGES_REQUESTED: "warn",
  REJECTED: "danger",
};
const DECISION_LABEL: Record<string, string> = {
  APPROVED: "Approved",
  CHANGES_REQUESTED: "Changes requested",
  REJECTED: "Rejected",
};

export function DecisionList({ decisions }: { decisions: DecisionView[] }) {
  if (decisions.length === 0) return <Muted>No review decisions yet.</Muted>;
  return (
    <ul className="m-0 list-none border-t border-line p-0">
      {decisions.map((d) => (
        <li key={d.id} className="border-b border-line py-4">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="badge" data-tone={DECISION_TONE[d.decision]}>
              {DECISION_LABEL[d.decision] ?? d.decision.replaceAll("_", " ").toLowerCase()}
            </span>
            <span className="text-sm text-dim">
              Revision {d.revisionNumber} · {d.reviewerName} ·{" "}
              <span className="tabular">{formatCampus(d.createdAt)}</span>
            </span>
          </div>
          {d.comment && <p className="mt-3 max-w-170 whitespace-pre-wrap">{d.comment}</p>}
        </li>
      ))}
    </ul>
  );
}

export function AuditList({ events }: { events: AuditView[] }) {
  if (events.length === 0) return <Muted>No activity recorded.</Muted>;
  return (
    <ol className="timeline">
      {events.map((e) => (
        <li key={e.id}>
          <time className="mono tabular text-xs text-dim">{formatCampus(e.createdAt)}</time>
          <span>
            <span className="capitalize">{e.action.replaceAll("_", " ").toLowerCase()}</span>
            {e.actorName ? <span className="text-dim"> · {e.actorName}</span> : null}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** One-line history of submitted revisions. */
export function RevisionList({ revisions }: { revisions: RevisionView[] }) {
  if (revisions.length === 0) return null;
  return (
    <ol className="timeline">
      {revisions.map((r) => (
        <li key={r.id}>
          <time className="mono tabular text-xs text-dim">{formatCampus(r.createdAt)}</time>
          <span>
            <span className="font-medium">Revision {r.revisionNumber}</span>
            {r.isCurrent && <span className="badge ml-2">Current</span>}
            <span className="text-dim">
              {" "}
              · “{r.title}” · {r.windows.length} window{r.windows.length === 1 ? "" : "s"}
            </span>
          </span>
        </li>
      ))}
    </ol>
  );
}
