// GET /submissions/:id/versions/:versionId/preview — the same authorization as the download route, but the signed URL
// makes the browser DISPLAY the file (Content-Disposition: inline with the validated content type), so it can be used as
// the `src` of an <img> or <video> on an authorized page. The page never contains the signed URL: it points at this
// route, which checks who is asking on every request and redirects (`no-store`, `no-referrer`) to a short-lived URL.
import type { Route } from "./+types/submissions.$id.versions.$versionId.preview";
import { requireRole } from "../auth/authorize.server";
import { getRequestScope } from "../server/request-scope.server";
import { redirectToMedia } from "../submissions/media-redirect.server";

export async function loader({ request, context, params }: Route.LoaderArgs) {
  const scope = getRequestScope(context);
  const user = await requireRole(scope, request, ["CONVENER", "REVIEWER", "SERVER_ROOM_MANAGER"]);
  return redirectToMedia(scope, user, params, { inline: true });
}
