import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("login", "routes/login.tsx"),
  route("logout", "routes/logout.ts"),
  route("unclaimed", "routes/unclaimed.tsx"),
  route("me", "routes/me.tsx"),
  // Convener workflow: drafts, media upload (direct to object storage), submission for review.
  route("submissions", "routes/submissions._index.tsx"),
  route("submissions/new", "routes/submissions.new.tsx"),
  route("submissions/:id", "routes/submissions.$id.tsx"),
  route("submissions/:id/upload", "routes/submissions.$id.upload.ts"),
  route("submissions/:id/upload/finalize", "routes/submissions.$id.upload.finalize.ts"),
  route("submissions/:id/versions/:versionId/file", "routes/submissions.$id.versions.$versionId.file.ts"),
  route("submissions/:id/versions/:versionId/preview", "routes/submissions.$id.versions.$versionId.preview.ts"),
  // Corporate Communication review (global reviewers).
  route("review", "routes/review._index.tsx"),
  route("review/:id", "routes/review.$id.tsx"),
  // Server Room Manager: approved media to put on the screens, and marking it done.
  route("manager", "routes/manager._index.tsx"),
  route("manager/:id", "routes/manager.$id.tsx"),
  // Access requests: Corporate Communication (and administrators) decide who may use the portal.
  route("requests", "routes/requests.tsx"),
  // Administrator: assign roles and committee memberships (new sign-ups have no role until then).
  route("admin", "routes/admin._index.tsx"),
  route("admin/:id", "routes/admin.$id.tsx"),
  // Local development only: the loader answers 404 unless every dev-auth guard passed at startup.
  route("dev/login", "routes/dev.login.tsx"),
  // Better Auth (OAuth callback). Default-deny allowlist: see app/auth/route-policy.server.ts.
  route("api/auth/*", "routes/api.auth.$.ts"),
] satisfies RouteConfig;
