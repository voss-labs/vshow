import { Form } from "react-router";
import type { Route } from "./+types/unclaimed";
import { requireUnassigned } from "../auth/authorize.server";
import { PublicHeader } from "../components/app-header";
import { getRequestScope } from "../server/request-scope.server";

export function meta(_args: Route.MetaArgs) {
  return [{ title: "Access not set up · Vshow" }];
}

// The explicit dead end for a verified VOSS identity that Vshow knows nothing about. No role is granted here.
export async function loader({ request, context }: Route.LoaderArgs) {
  const user = await requireUnassigned(getRequestScope(context), request);
  return { displayName: user.displayName, email: user.email };
}

export default function Unclaimed({ loaderData }: Route.ComponentProps) {
  return (
    <>
      <PublicHeader action={<span />} />
      <main id="main" tabIndex={-1} className="container-voss page outline-none">
        <div className="mx-auto max-w-lg pt-10 md:pt-20">
          <p className="eyebrow eyebrow-brand mb-3">Waiting for approval</p>
          <h1 className="page-title">Your access request is pending</h1>
          <p className="mt-4 text-dim">
            You are signed in as <strong className="text-ink">{loaderData.displayName}</strong> (
            <span className="break-all">{loaderData.email}</span>), but you have not been given access yet. Your request
            is waiting with Corporate Communication, who decide who can use Vshow. Sign in again once they have approved
            it.
          </p>
          <Form method="post" action="/logout" className="mt-8">
            <button type="submit" className="btn btn-ghost">
              Sign out
            </button>
          </Form>
        </div>
      </main>
    </>
  );
}
