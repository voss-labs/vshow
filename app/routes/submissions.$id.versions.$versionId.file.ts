// GET /submissions/:id/versions/:versionId/file — authorizes, then redirects to a short-lived signed URL that makes the
// browser SAVE the file. (For viewing it in the page, see the preview route.) Who may fetch which version is decided in
// createMediaDownloadUrl; the signed URL is only ever sent in the Location header: `no-store`, `no-referrer`, never logged.
import type { Route } from "./+types/submissions.$id.versions.$versionId.file";
import { requireRole } from "../auth/authorize.server";
import { getRequestScope } from "../server/request-scope.server";
import { redirectToMedia } from "../submissions/media-redirect.server";

export async function loader({ request, context, params }: Route.LoaderArgs) {
  const scope = getRequestScope(context);
  const user = await requireRole(scope, request, ["CONVENER", "REVIEWER", "SERVER_ROOM_MANAGER"]);
  return redirectToMedia(scope, user, params, { inline: false });
}
