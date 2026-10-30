import { Form, Link, data, useActionData, useNavigation } from "react-router";
import type { Route } from "./+types/submissions.$id";
import { assertSameOrigin, requireRole } from "../auth/authorize.server";
import { AppShell } from "../components/app-header";
import { MediaDetails } from "../components/media-details";
import { MediaPreview } from "../components/media-preview";
import { Notice, PageHeader, Section } from "../components/ui";
import { UploadPanel } from "../components/upload-panel";
import { WindowsEditor } from "../components/windows-editor";
import {
  AuditList,
  DecisionList,
  ErrorNotice,
  RevisionList,
  LiveBadge,
  StatusBadge,
  SubmitButton,
  VersionList,
  WindowsTable,
} from "../components/workflow-ui";
import { getRequestScope } from "../server/request-scope.server";
import { actionFailure, loaderFailure, type ActionFailure } from "../submissions/http.server";
import { getSubmissionForConvener, listActiveScreens } from "../submissions/queries.server";
import { saveDraft, submitForReview } from "../submissions/submissions.server";
import { formatCampus } from "../submissions/time";

export function meta(_args: Route.MetaArgs) {
  return [{ title: "Submission · Vshow" }];
}

export async function loader({ request, context, params }: Route.LoaderArgs) {
  const scope = getRequestScope(context);
  const user = await requireRole(scope, request, ["CONVENER"]);
  const db = scope.database.get();
  try {
    const submission = await getSubmissionForConvener(db, user, params.id);
    return {
      roles: user.roles,
      submission,
      screens: await listActiveScreens(db),
      limits: { maxBytes: scope.media.maxBytes, maxWindows: scope.media.maxWindows },
      storageReady: scope.storage.configured,
    };
  } catch (e) {
    return loaderFailure(e);
  }
}

export async function action({ request, context, params }: Route.ActionArgs) {
  const scope = getRequestScope(context);
  const user = await requireRole(scope, request, ["CONVENER"]);
  assertSameOrigin(request, scope.auth.config().baseURL);
  const form = await request.formData();
  const intent = form.get("intent");
  try {
    if (intent === "save") {
      let windows: unknown = [];
      try {
        windows = JSON.parse(String(form.get("windows") ?? "[]"));
      } catch {
        throw data(
          { ok: false, error: { code: "validation_failed", message: "The windows could not be read.", issues: [] } },
          { status: 422 },
        );
      }
      const result = await saveDraft(scope, user, params.id, {
        title: form.get("title"),
        description: form.get("description") ?? "",
        windows,
      });
      return { ok: true as const, saved: result.changed, withdrawn: result.approvalInvalidated };
    }
    if (intent === "submit") {
      await submitForReview(scope, user, params.id);
      return { ok: true as const, submitted: true };
    }
    throw data(null, { status: 400 });
  } catch (e) {
    return actionFailure(e);
  }
}

type ActionResult = ActionFailure | { ok: true; saved?: boolean; withdrawn?: boolean; submitted?: boolean };

export default function SubmissionPage({ loaderData }: Route.ComponentProps) {
  const { submission: s, screens, limits, roles, storageReady } = loaderData;
  const currentVersion = s.versions.find((v) => v.isCurrent);
  const result = useActionData<ActionResult>();
  const nav = useNavigation();
  const busy = nav.state !== "idle";
  const feedback = s.decisions.find((d) => d.comment && (s.status === "CHANGES_REQUESTED" || s.status === "REJECTED"));

  return (
    <AppShell roles={roles}>
      <PageHeader
        back={{ to: "/submissions", label: "my submissions" }}
        breadcrumb={
          <>
            <Link to="/submissions" className="link-quiet">
              My submissions
            </Link>{" "}
            / <span className="tabular">{s.referenceCode}</span>
          </>
        }
        title={s.title}
        badge={
          <>
            <StatusBadge status={s.status} /> <LiveBadge live={s.liveOnScreens} />
          </>
        }
        description={
          <>
            {s.committee.name} · created by {s.createdByName} ·{" "}
            <span className="tabular">{formatCampus(s.createdAt)}</span>
            {s.resubmissionOf && (
              <span className="mt-1 block">
                A resubmission of{" "}
                <Link className="link" to={`/submissions/${s.resubmissionOf.id}`}>
                  {s.resubmissionOf.referenceCode}
                </Link>
                . It has its own media and review history.
              </span>
            )}
            {s.resubmittedAs.length > 0 && (
              <span className="mt-1 block">
                Resubmitted as{" "}
                {s.resubmittedAs.map((r) => (
                  <Link key={r.id} className="link mr-3" to={`/submissions/${r.id}`}>
                    {r.referenceCode}
                  </Link>
                ))}
              </span>
            )}
          </>
        }
      />

      <div className="space-y-4 empty:hidden">
        {result && result.ok === false && <ErrorNotice error={result.error} />}
        {result && result.ok && result.submitted && (
          <Notice tone="ok" title="Submitted for review">
            You can’t edit it while it is being reviewed.
          </Notice>
        )}
        {result && result.ok && result.saved === true && !result.withdrawn && (
          <Notice tone="ok" title="Changes saved" />
        )}
        {result && result.ok && result.saved === false && <Notice tone="neutral" title="Nothing had changed" />}
        {result && result.ok && result.withdrawn && (
          <Notice tone="warn" title="Approval withdrawn">
            This submission was approved. Your change withdrew that approval: submit it again for a fresh review.
          </Notice>
        )}
        {feedback && (
          <Notice
            tone={s.status === "REJECTED" ? "danger" : "warn"}
            title={`${s.status === "REJECTED" ? "Why it was rejected" : "Changes requested"} · ${feedback.reviewerName}`}
          >
            <p className="whitespace-pre-wrap">{feedback.comment}</p>
            {s.status === "REJECTED" && (
              <p className="mt-2 text-dim">
                A rejected submission is closed and can’t be edited. A new, linked application can be started from it
                later.
              </p>
            )}
          </Notice>
        )}
        {s.status === "PENDING_REVIEW" && (
          <Notice tone="info" title="Waiting for Corporate Communication">
            It can’t be edited while it is pending.
          </Notice>
        )}
        {s.status === "APPROVED" && (
          <Notice tone="ok" title="Approved">
            Changing the title, description, windows or media withdraws the approval and needs a new review.
          </Notice>
        )}
      </div>

      <div className="mt-10 space-y-14">
        <Section id="details" title="Details and display windows">
          {s.canEdit ? (
            <Form method="post" className="space-y-6">
              <input type="hidden" name="intent" value="save" />
              <div>
                <label htmlFor="title" className="label">
                  Title
                </label>
                <input id="title" name="title" required maxLength={200} defaultValue={s.title} className="field" />
              </div>
              <div>
                <label htmlFor="description" className="label">
                  Description
                </label>
                <textarea
                  id="description"
                  name="description"
                  rows={4}
                  maxLength={5000}
                  defaultValue={s.description ?? ""}
                  className="field"
                />
              </div>
              <div>
                <p className="label">Requested display windows</p>
                <WindowsEditor screens={screens} initial={s.windows} maxWindows={limits.maxWindows} />
              </div>
              <SubmitButton className="btn btn-ghost" pending="Saving…">
                Save changes
              </SubmitButton>
            </Form>
          ) : (
            <div className="space-y-6">
              {s.description && <p className="max-w-170 whitespace-pre-wrap">{s.description}</p>}
              <WindowsTable windows={s.windows} />
            </div>
          )}
        </Section>

        <Section id="media" title="Media">
          <div className="space-y-6">
            {currentVersion && <MediaPreview key={currentVersion.id} submissionId={s.id} version={currentVersion} />}
            {currentVersion && <MediaDetails info={currentVersion.info} sizeBytes={currentVersion.sizeBytes} />}
            <VersionList submissionId={s.id} versions={s.versions} />
            {s.canEdit &&
              (storageReady ? (
                <UploadPanel submissionId={s.id} maxBytes={limits.maxBytes} disabled={busy} />
              ) : (
                <Notice tone="warn" title="Media storage unavailable">
                  New media can’t be uploaded right now.
                </Notice>
              ))}
          </div>
        </Section>

        {s.canSubmit && (
          <Section
            id="submit"
            title="Send for review"
            description="Needs uploaded media and at least one display window starting in the future. Save your changes first."
          >
            <Form method="post">
              <input type="hidden" name="intent" value="submit" />
              <SubmitButton className="btn btn-lg" pending="Submitting…">
                Submit for review
              </SubmitButton>
            </Form>
          </Section>
        )}

        <Section id="history" title="Review history">
          <div className="space-y-8">
            <DecisionList decisions={s.decisions} />
            <RevisionList revisions={s.revisions} />
          </div>
        </Section>

        <Section id="activity" title="Activity">
          <AuditList events={s.audit} />
        </Section>
      </div>
    </AppShell>
  );
}
