import { Form, Link, redirect, useActionData } from "react-router";
import type { Route } from "./+types/manager.$id";
import { assertSameOrigin, requireRole } from "../auth/authorize.server";
import { AppShell } from "../components/app-header";
import { MediaDetails } from "../components/media-details";
import { MediaPreview } from "../components/media-preview";
import { Notice, PageHeader, Section } from "../components/ui";
import { ErrorNotice, SubmitButton, VersionList, WindowsTable } from "../components/workflow-ui";
import { getRequestScope } from "../server/request-scope.server";
import { actionFailure, loaderFailure, type ActionFailure } from "../submissions/http.server";
import { getSubmissionForManager, markDone, undoDone } from "../submissions/manager.server";
import { MANAGER_NOTE_MAX } from "../submissions/policy";
import { formatCampus } from "../submissions/time";

export function meta(_args: Route.MetaArgs) {
  return [{ title: "Server room · Vshow" }];
}

export async function loader({ request, context, params }: Route.LoaderArgs) {
  const scope = getRequestScope(context);
  const user = await requireRole(scope, request, ["SERVER_ROOM_MANAGER"]);
  try {
    return { roles: user.roles, submission: await getSubmissionForManager(scope.database.get(), user, params.id) };
  } catch (e) {
    return loaderFailure(e);
  }
}

export async function action({ request, context, params }: Route.ActionArgs) {
  const scope = getRequestScope(context);
  const user = await requireRole(scope, request, ["SERVER_ROOM_MANAGER"]);
  assertSameOrigin(request, scope.auth.config().baseURL);
  const form = await request.formData();
  try {
    if (form.get("intent") === "undo") await undoDone(scope, user, params.id);
    else await markDone(scope, user, params.id, { note: form.get("note") ?? undefined });
    return redirect(form.get("intent") === "undo" ? `/manager/${params.id}` : "/manager");
  } catch (e) {
    if (e instanceof Response) throw e;
    return actionFailure(e);
  }
}

export default function ManagerSubmission({ loaderData }: Route.ComponentProps) {
  const { submission: s, roles } = loaderData;
  const failure = useActionData<ActionFailure>();
  const rev = s.revision;
  return (
    <AppShell roles={roles}>
      <PageHeader
        back={{ to: "/manager", label: "server room" }}
        breadcrumb={
          <>
            <Link to="/manager" className="link-quiet">
              Server room
            </Link>{" "}
            / <span className="tabular">{s.referenceCode}</span>
          </>
        }
        title={rev?.title ?? s.title}
        description={`${s.committeeName} · submitted by ${s.createdByName}`}
      />

      <div className="grid gap-14 lg:grid-cols-[minmax(0,1fr)_380px] lg:gap-16">
        <div className="min-w-0 space-y-14">
          {rev && rev.description && (
            <Section id="details" title="Details">
              <p className="max-w-170 whitespace-pre-wrap">{rev.description}</p>
            </Section>
          )}
          <Section id="media" title="Approved media" description="Download this exact file and put it on the screens.">
            <div className="space-y-6">
              {s.version && <MediaPreview key={s.version.id} submissionId={s.id} version={s.version} />}
              {s.version && <MediaDetails info={s.version.info} sizeBytes={s.version.sizeBytes} />}
              <VersionList submissionId={s.id} versions={s.version ? [s.version] : []} />
            </div>
          </Section>
          <Section
            id="windows"
            title="Requested screens and windows"
            description="Preferences from the convener, not bookings."
          >
            <WindowsTable windows={rev?.windows ?? []} />
          </Section>
        </div>

        <aside className="min-w-0 lg:sticky lg:top-24 lg:self-start" aria-label="Done">
          <div className="panel">
            <ErrorNotice error={failure?.error} />
            {s.done ? (
              <>
                <h2 className="text-xl font-semibold tracking-tight">Done</h2>
                <p className="mt-2 text-dim">
                  Marked done by {s.done.byName} <span className="tabular">· {formatCampus(s.done.at)}</span>
                </p>
                <p className="mt-2 text-dim">On: {s.done.screens.join(", ")}</p>
                {s.done.note && <p className="mt-2 whitespace-pre-wrap">{s.done.note}</p>}
                <Form method="post" className="mt-5">
                  <input type="hidden" name="intent" value="undo" />
                  <SubmitButton className="btn btn-ghost w-full" pending="Undoing…">
                    Undo (not done after all)
                  </SubmitButton>
                </Form>
              </>
            ) : (
              <>
                <h2 className="text-xl font-semibold tracking-tight">Mark done</h2>
                <p className="mt-2 text-dim">Use this once the media is downloaded and live on the screens.</p>
                <Form method="post" className="mt-5 space-y-5">
                  <div>
                    <label htmlFor="note" className="label">
                      Note (optional)
                    </label>
                    <textarea id="note" name="note" rows={3} maxLength={MANAGER_NOTE_MAX} className="field" />
                    <p className="hint">For example, which screens it was put on.</p>
                  </div>
                  <SubmitButton className="btn w-full" pending="Saving…">
                    Mark done
                  </SubmitButton>
                </Form>
              </>
            )}
          </div>
          {!rev && (
            <Notice tone="warn" title="No approved revision found">
              Ask an administrator to check this submission.
            </Notice>
          )}
        </aside>
      </div>
    </AppShell>
  );
}
