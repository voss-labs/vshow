import { useState } from "react";
import { Form, data, useActionData } from "react-router";
import type { Route } from "./+types/requests";
import { grantAccess, listAccessRequests, listCommitteeOptions, type CommitteeOption } from "../admin/access.server";
import { assertSameOrigin, requireRole } from "../auth/authorize.server";
import { ROLE_LABEL } from "../auth/landing";
import { AppShell } from "../components/app-header";
import { CommitteePicker } from "../components/committee-picker";
import { EmptyState, Notice, PageHeader } from "../components/ui";
import { ErrorNotice, SubmitButton } from "../components/workflow-ui";
import { getRequestScope } from "../server/request-scope.server";
import { actionFailure, loaderFailure, type ActionFailure } from "../submissions/http.server";

export function meta(_args: Route.MetaArgs) {
  return [{ title: "Access requests · Vshow" }];
}

const DECIDERS = ["REVIEWER", "ADMIN"] as const;
const ROLE_CHOICES = ["CONVENER", "REVIEWER", "SERVER_ROOM_MANAGER"] as const;
const ROLE_HELP: Record<(typeof ROLE_CHOICES)[number], string> = {
  CONVENER: "Posts media for a committee or department (including College Management).",
  REVIEWER: "Corporate Communication: reviews and approves submissions.",
  SERVER_ROOM_MANAGER: "Puts approved media on the screens.",
};

export async function loader({ request, context }: Route.LoaderArgs) {
  const scope = getRequestScope(context);
  const user = await requireRole(scope, request, DECIDERS);
  try {
    const db = scope.database.get();
    const [requests, committees] = await Promise.all([listAccessRequests(db, user), listCommitteeOptions(db, user)]);
    return {
      roles: user.roles,
      requests: requests.map((r) => ({ ...r, requestedAt: r.requestedAt.toISOString() })),
      committees,
    };
  } catch (e) {
    return loaderFailure(e);
  }
}

export async function action({ request, context }: Route.ActionArgs) {
  const scope = getRequestScope(context);
  const user = await requireRole(scope, request, DECIDERS);
  assertSameOrigin(request, scope.auth.config().baseURL);
  const form = await request.formData();
  try {
    if (form.get("intent") !== "grant") throw data(null, { status: 400 });
    const userId = String(form.get("userId") ?? "");
    await grantAccess(scope, user, userId, {
      role: form.get("role"),
      committeeId: form.get("committeeId"),
      newCommitteeName: form.get("newCommitteeName"),
    });
    return { ok: true as const, userId };
  } catch (e) {
    if (e instanceof Response) throw e;
    return actionFailure(e);
  }
}

function RequestRow({
  r,
  committees,
}: {
  r: { id: string; displayName: string; email: string; requestedAt: string };
  committees: CommitteeOption[];
}) {
  const [role, setRole] = useState<(typeof ROLE_CHOICES)[number]>("CONVENER");
  return (
    <li className="row-item">
      <Form method="post" className="space-y-5">
        <input type="hidden" name="intent" value="grant" />
        <input type="hidden" name="userId" value={r.id} />
        <div>
          <p className="m-0 font-medium">{r.displayName}</p>
          <p className="m-0 break-all text-sm text-dim">
            {r.email} · signed in {new Date(r.requestedAt).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" })}
          </p>
        </div>
        <fieldset className="m-0 border-0 p-0">
          <legend className="label">Give access as</legend>
          <div className="space-y-2">
            {ROLE_CHOICES.map((code) => (
              <label key={code} className="flex items-start gap-3">
                <input
                  type="radio"
                  name="role"
                  value={code}
                  checked={role === code}
                  onChange={() => setRole(code)}
                  className="mt-1"
                />
                <span>
                  <span className="block font-medium">{ROLE_LABEL[code]}</span>
                  <span className="text-sm text-dim">{ROLE_HELP[code]}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        {role === "CONVENER" && <CommitteePicker committees={committees} />}
        <SubmitButton>Give access</SubmitButton>
      </Form>
    </li>
  );
}

export default function Requests({ loaderData }: Route.ComponentProps) {
  const result = useActionData<ActionFailure | { ok: true; userId: string }>();
  const failure = result && "error" in result ? result : undefined;
  return (
    <AppShell roles={loaderData.roles}>
      <PageHeader
        eyebrow="Corporate Communication"
        title="Access requests"
        description="People who signed in with a campus account but cannot use Vshow yet. Choose what each person may do. Administrator access can only be given by an administrator."
      />
      <ErrorNotice error={failure?.error} />
      {result && "ok" in result && (
        <div className="mb-6">
          <Notice tone="ok">Access given. They can use Vshow the next time they open it.</Notice>
        </div>
      )}
      {loaderData.requests.length === 0 ? (
        <EmptyState title="No one is waiting for access." />
      ) : (
        <ul className="rows m-0 list-none p-0" aria-label="People waiting for access">
          {loaderData.requests.map((r) => (
            <RequestRow key={r.id} r={r} committees={loaderData.committees} />
          ))}
        </ul>
      )}
    </AppShell>
  );
}
