import { Form, Link, redirect, useActionData } from "react-router";
import type { Route } from "./+types/review.$id";
import { assertSameOrigin, requireRole } from "../auth/authorize.server";
import { AppShell } from "../components/app-header";
import { MediaDetails } from "../components/media-details";
import { MediaPreview } from "../components/media-preview";
import { Notice, PageHeader, Section } from "../components/ui";
import {
  AuditList,
  DecisionList,
  ErrorNotice,
  LiveBadge,
  RevisionList,
  StatusBadge,
  SubmitButton,
  VersionList,
  WindowsTable,
} from "../components/workflow-ui";
import { getRequestScope } from "../server/request-scope.server";
import { actionFailure, loaderFailure, type ActionFailure } from "../submissions/http.server";
import { getSubmissionForReviewer } from "../submissions/queries.server";
import { decide } from "../submissions/reviews.server";
import { formatCampus } from "../submissions/time";

export function meta(_args: Route.MetaArgs) {
  return [{ title: "Review · Vshow" }];
}

export async function loader({ request, context, params }: Route.LoaderArgs) {
  const scope = getRequestScope(context);
  const user = await requireRole(scope, request, ["REVIEWER"]);
  try {
    return { roles: user.roles, submission: await getSubmissionForReviewer(scope.database.get(), user, params.id) };
  } catch (e) {
    return loaderFailure(e);
  }
}

export async function action({ request, context, params }: Route.ActionArgs) {
  const scope = getRequestScope(context);
  const user = await requireRole(scope, request, ["REVIEWER"]);
  assertSameOrigin(request, scope.auth.config().baseURL);
  const form = await request.formData();
  try {
    await decide(scope, user, params.id, {
      revisionId: form.get("revisionId"),
      decision: form.get("decision"),
      comment: form.get("comment") ?? undefined,
    });
    return redirect("/review");
  } catch (e) {
    if (e instanceof Response) throw e;
    return actionFailure(e);
  }
}

const DECISIONS = [
  { value: "APPROVED", label: "Approve this revision", hint: "Clears this exact revision for manager handoff." },
  {
    value: "CHANGES_REQUESTED",
    label: "Request changes",
    hint: "A comment is required. The convener can upload a new version.",
  },
  { value: "REJECTED", label: "Reject", hint: "A reason is required. A rejected submission is closed." },
];

export default function ReviewPage({ loaderData }: Route.ComponentProps) {
  const { submission: s, roles } = loaderData;
  const failure = useActionData<ActionFailure>();
  const rev = s.currentRevision;
  // The exact media version this revision (and so any decision) applies to.
  const reviewedVersion = rev ? s.versions.find((v) => v.id === rev.mediaVersionId) : undefined;
  return (
    <AppShell roles={roles}>
      <PageHeader
        back={{ to: "/review", label: "review queue" }}
        breadcrumb={
          <>
            <Link to="/review" className="link-quiet">
              Review queue
            </Link>{" "}
            / <span className="tabular">{s.referenceCode}</span>
          </>
        }
        title={rev?.title ?? s.title}
        badge={
          <>
            <StatusBadge status={s.status} /> <LiveBadge live={s.liveOnScreens} />
          </>
        }
        description={
          <>
            {s.committee.name} · submitted by {s.createdByName}
            {s.submittedAt ? <span className="tabular"> · {formatCampus(s.submittedAt)}</span> : ""}
            {s.resubmissionOf && (
              <span className="mt-1 block">
                A resubmission of{" "}
                <Link className="link" to={`/review/${s.resubmissionOf.id}`}>
                  {s.resubmissionOf.referenceCode}
                </Link>{" "}
                (a previously rejected application). It starts with no approval of its own.
              </span>
            )}
          </>
        }
      />

      <div className="grid gap-14 lg:grid-cols-[minmax(0,1fr)_380px] lg:gap-16">
        <div className="min-w-0 space-y-14">
          {rev ? (
            <Section
              id="revision"
              title={`Revision ${rev.revisionNumber} ${s.status === "PENDING_REVIEW" ? "· up for review" : "· latest"}`}
              description="This is exactly what a decision applies to."
            >
              <div className="space-y-8">
                {rev.description && <p className="max-w-170 whitespace-pre-wrap">{rev.description}</p>}
                <div>
                  <h3 className="eyebrow mb-3">Requested display windows</h3>
                  <WindowsTable windows={rev.windows} />
                </div>
                <div>
                  <h3 className="eyebrow mb-3">Media</h3>
                  {reviewedVersion && (
                    <div className="mb-8">
                      <MediaPreview key={reviewedVersion.id} submissionId={s.id} version={reviewedVersion} />
                    </div>
                  )}
                  {reviewedVersion && (
                    <div className="mb-8">
                      <MediaDetails info={reviewedVersion.info} sizeBytes={reviewedVersion.sizeBytes} />
                    </div>
                  )}
                  <VersionList submissionId={s.id} versions={s.versions.filter((v) => v.id === rev.mediaVersionId)} />
                </div>
              </div>
            </Section>
          ) : (
            <Notice tone="neutral">No revision has been submitted.</Notice>
          )}

          <Section id="history" title="Earlier revisions and decisions">
            <div className="space-y-8">
              <DecisionList decisions={s.decisions} />
              <RevisionList revisions={s.revisions.filter((r) => !r.isCurrent)} />
            </div>
          </Section>

          <Section id="activity" title="Activity">
            <AuditList events={s.audit} />
          </Section>
        </div>

        <aside className="min-w-0 lg:sticky lg:top-24 lg:self-start" aria-label="Decision">
          {s.canDecide && rev ? (
            <div className="panel">
              <h2 className="text-xl font-semibold tracking-tight">Your decision</h2>
              <ErrorNotice error={failure?.error} />
              <Form method="post" className="mt-5 space-y-5">
                <input type="hidden" name="revisionId" value={rev.id} />
                <fieldset className="m-0 space-y-2 border-0 p-0">
                  <legend className="sr-only">Decision</legend>
                  {DECISIONS.map((d, i) => (
                    <label key={d.value} className="choice">
                      <input type="radio" name="decision" value={d.value} required={i === 0} />
                      <span>
                        <span className="block font-medium">{d.label}</span>
                        <span className="block text-sm text-dim">{d.hint}</span>
                      </span>
                    </label>
                  ))}
                </fieldset>
                <div>
                  <label htmlFor="comment" className="label">
                    Comment or reason
                  </label>
                  <textarea id="comment" name="comment" rows={4} maxLength={2000} className="field" />
                  <p className="hint">Up to 2,000 characters. Shown to the convener.</p>
                </div>
                <SubmitButton className="btn w-full" pending="Recording…">
                  Record decision
                </SubmitButton>
              </Form>
            </div>
          ) : (
            s.status === "PENDING_REVIEW" && (
              <Notice tone="warn" title="You can’t decide on this one">
                You created this submission. Another reviewer must review it.
              </Notice>
            )
          )}
        </aside>
      </div>
    </AppShell>
  );
}
