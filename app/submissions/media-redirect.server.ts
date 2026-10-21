// Shared by the download and preview routes: authorizes (in each capacity the person holds) and answers with a redirect
// to a short-lived signed URL. The signed URL is only ever in the Location header of the response: `no-store`,
// `no-referrer`, never logged. Authorization per capacity lives in createMediaDownloadUrl:
//  - a convener of the submission's committee may see any version of it;
//  - a reviewer may see only versions that were actually submitted for review (never drafts);
//  - a server room manager may see only the approved version of an approved submission.
import { data, redirect } from "react-router";
import type { CurrentUser } from "../auth/authorize.server.ts";
import type { WorkflowDeps } from "./access.server.ts";
import { WorkflowError } from "./errors.ts";
import { loaderFailure } from "./http.server.ts";
import { createMediaDownloadUrl } from "./uploads.server.ts";

const ROLE_FOR = { convener: "CONVENER", reviewer: "REVIEWER", manager: "SERVER_ROOM_MANAGER" } as const;

export async function redirectToMedia(
  deps: WorkflowDeps,
  user: CurrentUser,
  params: { id: string; versionId: string },
  { inline }: { inline: boolean },
): Promise<Response> {
  const capacities = (["convener", "reviewer", "manager"] as const).filter((as) => user.roles.includes(ROLE_FOR[as]));
  let failure: unknown;
  for (const as of capacities) {
    try {
      const url = await createMediaDownloadUrl(deps, user, params.id, params.versionId, { as, inline });
      return redirect(url, { headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
    } catch (e) {
      // "not found" in one capacity may still be allowed in another; any other failure is final.
      if (e instanceof WorkflowError && e.code === "not_found") failure = e;
      else return loaderFailure(e);
    }
  }
  if (failure) return loaderFailure(failure);
  throw data(null, { status: 404 });
}
