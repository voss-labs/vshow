import { Form, data, useActionData } from "react-router";
import type { Route } from "./+types/admin.$id";
import { getUserDetail, setMembership, setRole } from "../admin/users.server";
import { assertSameOrigin, requireRole } from "../auth/authorize.server";
import { ROLE_LABEL } from "../auth/landing";
import { AppShell } from "../components/app-header";
import { CommitteePicker } from "../components/committee-picker";
import { Notice, PageHeader, Section } from "../components/ui";
import { ErrorNotice, SubmitButton } from "../components/workflow-ui";
import { ROLE_CODES } from "../db/schema/values";
import { getRequestScope } from "../server/request-scope.server";
import { actionFailure, loaderFailure, type ActionFailure } from "../submissions/http.server";

export function meta(_args: Route.MetaArgs) {
  return [{ title: "User · Vshow" }];
}

export async function loader({ request, context, params }: Route.LoaderArgs) {
  const scope = getRequestScope(context);
  const user = await requireRole(scope, request, ["ADMIN"]);
  try {
    return { roles: user.roles, person: await getUserDetail(scope.database.get(), user, params.id) };
  } catch (e) {
    return loaderFailure(e);
  }
}

export async function action({ request, context, params }: Route.ActionArgs) {
  const scope = getRequestScope(context);
  const user = await requireRole(scope, request, ["ADMIN"]);
  assertSameOrigin(request, scope.auth.config().baseURL);
  const form = await request.formData();
  try {
    switch (form.get("intent")) {
      case "grant-role":
        await setRole(scope, user, params.id, { role: form.get("role"), grant: true });
        break;
      case "revoke-role":
        await setRole(scope, user, params.id, { role: form.get("role"), grant: false });
        break;
      case "set-membership":
        await setMembership(scope, user, params.id, {
          committeeId: form.get("committeeId"),
          newCommitteeName: form.get("newCommitteeName"),
          membershipType: form.get("membershipType"),
          active: true,
        });
        break;
      case "end-membership":
        await setMembership(scope, user, params.id, { committeeId: form.get("committeeId"), active: false });
        break;
      default:
        throw data(null, { status: 400 });
    }
    return { ok: true as const };
  } catch (e) {
    if (e instanceof Response) throw e;
    return actionFailure(e);
  }
}

const MEMBERSHIP_LABEL: Record<string, string> = { CONVENER: "Convener", MEMBER: "Member" };

export default function AdminUser({ loaderData }: Route.ComponentProps) {
  const { person: p, roles } = loaderData;
  const result = useActionData<ActionFailure | { ok: true }>();
  const failure = result && "error" in result ? result : undefined;
  const isConvener = p.roles.includes("CONVENER");
  const hasActiveCommittee = p.memberships.some((m) => m.isActive);

  return (
    <AppShell roles={roles}>
      <PageHeader
        back={{ to: "/admin", label: "users" }}
        title={p.displayName}
        description={<span className="break-all">{p.email}</span>}
      />
      <ErrorNotice error={failure?.error} />
      {!p.isActive && (
        <div className="mb-6">
          <Notice tone="warn">This account is deactivated and cannot sign in.</Notice>
        </div>
      )}
      <div className="space-y-14">
        <Section id="roles" title="Roles">
          <ul className="rows m-0 list-none p-0">
            {ROLE_CODES.map((code) => {
              const held = p.roles.includes(code);
              const locked = held && code === "ADMIN" && p.isSelf;
              return (
                <li key={code} className="row-item flex items-center justify-between gap-4">
                  <span>
                    <span className="block font-medium">{ROLE_LABEL[code]}</span>
                    <span className="text-sm text-dim">{held ? "Assigned" : "Not assigned"}</span>
                  </span>
                  {locked ? (
                    <span className="text-sm text-dim">You can’t remove your own administrator role.</span>
                  ) : (
                    <Form method="post">
                      <input type="hidden" name="intent" value={held ? "revoke-role" : "grant-role"} />
                      <input type="hidden" name="role" value={code} />
                      <SubmitButton className={held ? "btn btn-ghost" : "btn"}>
                        {held ? "Remove" : "Assign"}
                      </SubmitButton>
                    </Form>
                  )}
                </li>
              );
            })}
          </ul>
        </Section>

        <Section id="committees" title="Committees">
          {isConvener && !hasActiveCommittee && (
            <div className="mb-6">
              <Notice tone="info">
                This person is a convener but belongs to no committee, so they can’t create submissions yet.
              </Notice>
            </div>
          )}
          {p.memberships.length > 0 && (
            <ul className="rows m-0 mb-8 list-none p-0">
              {p.memberships.map((m) => (
                <li key={m.committeeId} className="row-item flex items-center justify-between gap-4">
                  <span>
                    <span className="block font-medium">{m.committeeName}</span>
                    <span className="text-sm text-dim">
                      {MEMBERSHIP_LABEL[m.membershipType] ?? m.membershipType}
                      {m.isActive ? "" : " · ended"}
                    </span>
                  </span>
                  {m.isActive ? (
                    <Form method="post">
                      <input type="hidden" name="intent" value="end-membership" />
                      <input type="hidden" name="committeeId" value={m.committeeId} />
                      <SubmitButton className="btn btn-ghost">End membership</SubmitButton>
                    </Form>
                  ) : (
                    <Form method="post">
                      <input type="hidden" name="intent" value="set-membership" />
                      <input type="hidden" name="committeeId" value={m.committeeId} />
                      <input type="hidden" name="membershipType" value={m.membershipType} />
                      <SubmitButton>Reinstate</SubmitButton>
                    </Form>
                  )}
                </li>
              ))}
            </ul>
          )}
          <Form method="post" className="flex flex-wrap items-end gap-4">
            <input type="hidden" name="intent" value="set-membership" />
            <div className="min-w-64 flex-1">
              <CommitteePicker committees={p.availableCommittees} label="Add to committee" />
            </div>
            <div>
              <label htmlFor="membershipType" className="label">
                As
              </label>
              <select id="membershipType" name="membershipType" className="field" defaultValue="CONVENER">
                <option value="CONVENER">Convener</option>
                <option value="MEMBER">Member</option>
              </select>
            </div>
            <SubmitButton>Add</SubmitButton>
          </Form>
        </Section>
      </div>
    </AppShell>
  );
}
