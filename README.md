# Vshow

Campus digital signage media approval platform: committees submit media, Corporate Communication reviews it, and the Server Room Manager hands approved media to the signage software. Built with React Router (framework mode, SSR), TypeScript, Tailwind CSS, Drizzle ORM and PostgreSQL. Product and data-model specs are in [docs/](docs/).

**New contributor? Start with [ONBOARDING.md](ONBOARDING.md)**: a short setup guide that needs no OAuth credentials.

## Quick start (clone to running app)

Each step is a separate, explicit command. Nothing migrates or seeds automatically.

```bash
git clone <repo-url> && cd vshow
nvm use                 # or fnm use / install Node 24.x (see .nvmrc)
npm ci                  # install exactly what package-lock.json specifies
npm run setup           # create .env, generate secrets, validate tools (safe to re-run)
npm run db:up           # start local PostgreSQL in Docker (127.0.0.1 only)
npm run db:migrate      # create the schema (explicit, never automatic)
npm run db:seed         # OPTIONAL: synthetic development data
npm run dev             # http://localhost:5173
```

Check the database any time with `npm run db:health`.

### Prerequisites

| Tool                                               | Needed for                              |
| -------------------------------------------------- | --------------------------------------- |
| Node.js 24.x and npm 11.8.0 (`packageManager`)     | everything                              |
| Docker with Compose v2 (Docker Desktop on Win/Mac) | local PostgreSQL (not needed with Neon) |
| Git                                                | cloning                                 |

`npm run setup` verifies these and prints a fix for anything missing. Windows, macOS and Linux are supported through Node scripts with no shell dependencies; CI runs on Linux and most development so far has been on Windows.

## Configuration

`npm run setup` creates `.env` from [.env.example](.env.example). It fills only missing or `change-me` values, so re-running never overwrites your settings, and it never prints secrets or full connection strings. `npm run setup:check` validates without writing.

| Variable                                | Purpose                                                              |
| --------------------------------------- | -------------------------------------------------------------------- |
| `APP_ENV`                               | `development` or `test`. Seeding refuses anything else               |
| `DB_TARGET`                             | `local` (Docker) or `neon`. Always explicit                          |
| `POSTGRES_*`                            | Local container credentials (password generated)                     |
| `DATABASE_URL`                          | Runtime connection. Neon: the **pooled** (`-pooler`) string          |
| `DATABASE_URL_DIRECT`                   | Neon only: **direct** string used by `db:migrate`                    |
| `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` | Authentication: see the Authentication section (secret is generated) |

`.env` and `.env.*` are git-ignored (only `.env.example` is tracked) and excluded from Docker build contexts.

## Database

### Local PostgreSQL (default)

| Command                     | Effect                                                                                                                                                                                                                                                           |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run db:up`             | Start Postgres 16 bound to `127.0.0.1`, wait until healthy                                                                                                                                                                                                       |
| `npm run db:down`           | Stop and remove the container; **data is kept** in the Docker volume                                                                                                                                                                                             |
| `npm run db:recreate:local` | Drops and recreates **only** the local `vshow` database (empty), leaving the server, its volume and every other database alone. Type the database name to confirm; `--dry-run` checks without changing; refuses non-local targets; then run `npm run db:migrate` |
| `npm run db:reset:local`    | **Deletes the whole local Postgres volume (every database in it).** Type the database name to confirm; refuses non-local targets                                                                                                                                 |

### Neon (optional, for development only)

```bash
npm run setup -- --db=neon     # then edit .env:
#   DATABASE_URL=<pooled Neon string>          (host contains -pooler, ?sslmode=require)
#   DATABASE_URL_DIRECT=<direct Neon string>   (used for migrations)
```

Use a dedicated Neon **branch** for development, never the production branch. Docker is not required. Seeding is **local-only** and refuses Neon targets. Applying migrations to a remote database needs `--confirm-host=<exact host>` (see below).

### Migrations

Schema source: [app/db/schema/](app/db/schema/) (mirrors [docs/Vshow_Database_Schema_v1.1.md](docs/Vshow_Database_Schema_v1.1.md)). Generated SQL lives in [drizzle/](drizzle/) and is **forward-only history: never edit or delete a migration that has been applied anywhere**; add a new one instead.

| Command                           | Effect                                                                                                  |
| --------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `npm run db:generate`             | Generate a migration from schema changes (no DB access). Review the SQL, then commit it                 |
| `npm run db:check`                | Verify migration files are consistent                                                                   |
| `npm run db:migrate`              | Apply pending migrations to the database in `.env`                                                      |
| `npm run db:migrate -- --dry-run` | Show what would be applied; change nothing                                                              |
| `npm run db:health`               | Connect, run read-only queries, report applied/pending migrations (`-- --direct` for the migration URL) |

`db:migrate` safety rules: `DB_TARGET` must be set; a `neon` target must be a `*.neon.tech` host; a `local` target must pass the **shared local-target guard** (below); non-local targets also need `--confirm-host=<exact host>`; pooled Neon URLs are refused; migrations with `DROP TABLE/COLUMN/SCHEMA`, `TRUNCATE` or `DELETE FROM` need `--allow-destructive`; a modified or missing already-applied migration aborts; a lock prevents concurrent runs. There is no `drizzle-kit push`/`studio` script and `drizzle.config.ts` holds no credentials.

**Per environment** (migrate each database independently and deliberately, never on deploy):

- **Development:** `npm run db:up && npm run db:migrate`.
- **Test:** `npm run test:ci` migrates a throwaway database on local Postgres; CI uses a service container.
- **Preview:** a Neon branch per preview (never the production branch); migrate with its direct URL first.
- **Production:** take a Neon restore point, run `db:migrate -- --dry-run`, review, then `db:migrate -- --confirm-host=<host>` with the production **direct** URL provided through the shell environment, not a file. Fix problems by rolling forward with a new migration.

### Local-target guard (migrate, seed, reset)

A loopback address alone is **not** trusted: an SSH tunnel or port-forward to a real database also looks like `127.0.0.1`. Every command that writes to a local database (`db:migrate` on a local target, `db:seed`, `db:recreate:local`, `db:reset:local`) uses one shared guard, [scripts/lib/local-target.ts](scripts/lib/local-target.ts), which requires all of:

- `DB_TARGET=local`, and `APP_ENV` unset or `development`/`test` (seeding requires it to be set); no `NODE_ENV=production` or Vercel markers.
- Host exactly `127.0.0.1` or `localhost`; port equal to `POSTGRES_PORT` (default 5432); user equal to `POSTGRES_USER`; database equal to `POSTGRES_DB` (default `vshow`). Under `APP_ENV=test` only, throwaway `vshow_test_*` databases are also allowed.
- Production-like names (`prod`, `live`, `staging`, `preview`) are refused even if `POSTGRES_DB` is set to match.
- `DATABASE_URL` and `DATABASE_URL_DIRECT`, if both set, must describe the same database, and a shell variable must not silently override a different value in `.env`.

Anything it cannot classify is refused. Remote (Neon) migrations are unchanged: they need `--confirm-host=<exact host>`; there is no remote seed or reset. Residual risk: a tunnel deliberately opened on the Compose port with the same database name would look local; do not do that.

### Seed data (development only)

`npm run db:seed` inserts synthetic fixtures: 7 submissions across 2 committees (draft, pending, approved awaiting handoff, rejected, revised after feedback, replaced after approval, scheduled) and 8 users covering role and membership boundaries. All fixtures are marked `[SEED]` / `SEED-*` / `@seed.vshow.invalid`; media object keys (`seed/...`) do not exist in object storage.

It is idempotent (insert-if-missing, never updates), runs in one transaction, and requires `APP_ENV=development|test`, `DB_TARGET=local`, the local Compose database (shared guard below) and a fully migrated schema. It refuses production/Vercel markers; remote seeding is not supported. To remove only the fixture rows (by exact id; roles are kept): `npm run db:seed -- --remove --confirm=<database name>`. Because existing rows are never updated, fixture changes only reach a database after `--remove` and a fresh seed.

## Server Room Manager handoff

Code: [app/submissions/manager.server.ts](app/submissions/manager.server.ts); pages `/manager` (queue) and `/manager/:id`. Requires the `SERVER_ROOM_MANAGER` role.

- **Queue:** only submissions whose _current_ revision has an approving decision appear, split into "To do" and "Done". A new media version or edited revision drops the submission out of the queue until it is approved again.
- **Download:** the manager downloads the exact approved version through the normal authorized, signed-URL file route.
- **Mark done:** records one `SCHEDULED` `schedule_entry` per requested screen for the approved media version, with an optional note. Marking done twice is refused.
- **Undo:** marks the active entries `CANCELLED`. Nothing is deleted; both actions are audited (`SCHEDULE_MARKED_DONE`, `SCHEDULE_UNDONE`).
- Requested windows are never changed. The manager arranges overlaps in the signage software, outside Vshow, and Vshow does not read what is actually playing.

## Administration

Code: [app/admin/users.server.ts](app/admin/users.server.ts); pages `/admin` (user list) and `/admin/:id` (one user). Requires the `ADMIN` role, which grants no access to submissions.

- Grant or revoke the four roles (`CONVENER`, `REVIEWER`, `SERVER_ROOM_MANAGER`, `ADMIN`) for any user. An administrator cannot revoke their own `ADMIN` role.
- Add, change or end a user's committee membership (membership type chosen per committee).
- New sign-ins have no role until an administrator assigns one.
- Role and membership changes are **not yet written to the audit trail**; the rows record `assigned_by_user_id` only.

## Implementation status

Phase 1 against [docs/Vshow_PRD_v1.1.md](docs/Vshow_PRD_v1.1.md):

| Area                                                         | Status                                                          |
| ------------------------------------------------------------ | --------------------------------------------------------------- |
| vauth sign-in, local users, role and committee authorization | Done (dev identity switcher for local use)                      |
| Submissions, media versions, signed uploads, revisions       | Done                                                            |
| Review queue, approve / reject / request changes             | Done                                                            |
| Manager queue, download approved version, mark done / undo   | Done (simplified, see above)                                    |
| Admin: users, roles, committee memberships                   | Done                                                            |
| Admin: create and edit committees and screens                | **Missing** (only via seed data or SQL)                         |
| Admin: global audit history view                             | **Missing** (audit shows per submission only)                   |
| Admin: audit events for role and membership changes          | **Missing**                                                     |
| Manager: actual window, screen override, external reference  | **Missing** (`schedule_entry` supports it; no UI or service)    |
| Manager: manual "playing confirmed" and "completed"          | **Missing**                                                     |
| Withdraw a pending submission (`CANCELLED`)                  | **Missing**                                                     |
| Dedicated "resubmit a rejected submission" button            | **Missing** (service exists; links are shown in both histories) |
| Notifications, reporting, timeline                           | Phase 2                                                         |
| Health-check route, `robots.txt`, web manifest and icons     | Missing                                                         |

## Quality checks

| Command                                   | Checks                                                                                                     |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `npm run check`                           | format + lint + typecheck + tests (run this before pushing)                                                |
| `npm run format` / `npm run format:check` | Prettier (write / verify)                                                                                  |
| `npm run lint`                            | ESLint (typescript-eslint)                                                                                 |
| `npm run typecheck`                       | `react-router typegen && tsc`, run by `scripts/typecheck.mjs` (clears `VSHOW_DEV_AUTH` for this step only) |
| `npm test`                                | Test runner (`scripts/run-tests.mjs`); skipped tests are reported loudly but do not fail locally           |
| `npm run test:ci`                         | Same, but **any skipped or todo test fails the run** (used by CI)                                          |
| `npm run build`                           | Production build                                                                                           |

Database-backed tests create and drop their own uniquely named database on local Postgres. If it is not running they are **skipped, not passed**: `npm test` prints a warning listing them, and `npm run test:ci` exits non-zero. Run `npm run db:up` first. The Docker-context test is likewise skipped when Docker is unavailable. The runner uses the test framework's own events (not output parsing); intentional skips can be allow-listed with a documented reason in `scripts/run-tests.mjs` (currently none).

### Continuous integration

[.github/workflows/ci.yml](.github/workflows/ci.yml) runs on pushes to `main` and pull requests, with read-only permissions, no repository secrets, and third-party actions pinned to commit SHAs (Dependabot proposes updates). Jobs:

- **quality:** `npm ci`, format, lint, typegen + `tsc`, production build.
- **database:** disposable Postgres service; migration check, migrate twice (second must be a no-op), health, seed twice (second must create nothing), then `npm run test:ci` (unsafe-target rejection, Docker build-context test; a skipped test fails the job).
- **docker:** the image builds.
- **security:** `npm audit --omit=dev` (fails on high/critical) and a gitleaks scan of the full git history (image pinned by digest).

Pull requests never need production credentials and never connect to production databases. Note: `npm audit` also reports moderate advisories in `drizzle-kit`'s dev-only esbuild dependency; they concern a dev server we do not run and are excluded from the production audit.

## Authentication (VOSS vauth via Better Auth)

**Status: implemented and tested locally against a mock OpenID Connect provider. Production authentication is deliberately NOT enabled** until (1) Vshow is registered with vauth and (2) the callback-logging risk below has a security decision. Local tests passing does not mean production sign-in is ready.

- **Flow:** Authorization Code + PKCE S256 with vauth (`https://accounts.vosslabs.org/api/auth`), provider ID `voss`, scopes `openid profile email`, `client_secret_post`, explicit issuer validation. Better Auth is pinned to **1.6.23** (do not upgrade to 1.7.x without a separate compatibility review). There are no passwords anywhere.
- **Callback URLs** (register exactly these, no wildcards): production `https://vshow.vosslabs.org/api/auth/oauth2/callback/voss`, local `http://localhost:5173/api/auth/oauth2/callback/voss`. The dev server is pinned to port 5173 (`strictPort`) so the local callback cannot silently change.
- **Trust in the identity:** the ID token is verified with `jose` (EdDSA only, issuer, audience = our client ID, expiry, age, JWKS fetched from the discovered issuer) before any claim is used. Only a **strictly verified** email on an exact `vit.edu.in` / `vosslabs.org` domain is accepted, and `sub` is the permanent identity (the email is a mutable attribute). A returning `sub` with a new valid email updates the same user; a conflict, or an email that is no longer allowed, denies sign-in (and revokes that user's sessions). Accounts are **never** linked or merged because emails match.
- **Authorization is Vshow's alone:** first sign-in creates a user with **no role**; an administrator assigns roles. Anyone without a role goes to `/unclaimed`. Guards in `app/auth/authorize.server.ts` are allowlists, re-read the database on every request (no cookie cache), and each protected route calls its own guard. Deactivating a user ends their sessions immediately (database trigger).
- **Sessions:** 7 days, refreshed at most once a day, **absolute maximum 30 days from creation** (database trigger, plus an application check). Logout ends the Vshow session only; the vauth single-sign-on session is untouched. Cookies: `vshow.` prefix, HttpOnly, `SameSite=Lax`, `Secure` on https, one trusted origin.
- **No OAuth tokens are stored.** Hooks null them, `updateAccountOnSignIn` is off, and a database CHECK constraint makes any attempt fail the sign-in. Session IP and user agent are not stored. `app_user.vauth_subject` is kept consistent with `auth_account` by database triggers (immutable once set, conflicts roll the whole sign-in back).
- **Surface:** `/api/auth/*` is **default-deny**: only the OAuth callback (and `/ok`) are forwarded to Better Auth; everything else is 404, with `Cache-Control: no-store` and `Referrer-Policy: no-referrer` on every response.

| Variable                               | Class                  | Notes                                                                                                    |
| -------------------------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------- |
| `BETTER_AUTH_SECRET`                   | secret                 | at least 32 characters; different per environment (generated by `npm run setup`)                         |
| `BETTER_AUTH_URL`                      | config                 | origin only; `https` in production; exactly `https://vshow.vosslabs.org` in the production environment   |
| `VOSS_DISCOVERY_URL`                   | config                 | production requires exactly the pinned vauth URL                                                         |
| `VOSS_CLIENT_ID`, `VOSS_CLIENT_SECRET` | ID config / **secret** | issued privately by the vauth maintainers; separate for local and production; never commit or paste them |
| `VSHOW_DEV_AUTH`                       | flag                   | local identity switcher; see below                                                                       |

**Local identity switcher** (until Vshow has vauth credentials, and for testing roles): set `VSHOW_DEV_AUTH=1`, then `npm run db:migrate && npm run db:seed && npm run dev` and open `/dev/login`. It signs you in as one of the fixed seeded identities (`admin`, `reviewer`, `manager`, `convener_media`, ...); the browser can only pick a key from that list. It creates a normal Better Auth session; roles and memberships still come from the database. It is enabled only when **all** of these hold, otherwise the server **refuses to start** (and the route/endpoint does not exist when the flag is off): `VSHOW_DEV_AUTH` is exactly `1`; `APP_ENV=development`; `NODE_ENV` is not production; no `VERCEL`/`VERCEL_ENV`; `BETTER_AUTH_URL` is localhost; and the shared local Compose database guard passes (no Neon, no remote). `npm run build` fails while the flag is set (unset it first). With the switcher on, the vauth credentials may be absent; the vauth provider is then simply not registered.

**Unresolved before production authentication can be enabled:**

- **Callback query string in platform logs.** vauth redirects back with `code` and `state` in the URL (its provider supports only the `query` response mode, and Better Auth's callback is GET-only, so `form_post` is not possible). Vshow's own logs record paths only, but Vercel's request logs record the query string and Vercel documents no redaction. Source review shows a logged code and state alone cannot hijack a session (the code is single-use and expires in 10 minutes, exchange needs the client secret and the PKCE verifier kept server-side, and the callback needs the browser's signed state cookie), but that is risk reduction, not elimination. Production sign-in stays blocked until this is explicitly accepted, with compensating controls, or the hosting decision changes.
- Vshow is not registered with vauth yet (see the registration checklist in the project notes); a real sign-in has never been run.
- Previews cannot sign in with vauth (redirect URIs are exact-match per origin).

## Core workflow: submissions, media and review (Phase 1)

A **convener** creates a submission for a committee they actively belong to, uploads one media asset (JPEG, PNG, WebP or MP4, 100 MiB by default), requests display windows on screens, and submits it. A **Corporate Communication reviewer** (global, not per committee) approves, rejects (reason required) or requests changes (comment required). The **Server Room Manager** then marks approved media as put on the screens, and an **administrator** assigns roles and committee memberships (see the two sections below). Per-screen scheduling details, playback confirmation and a dedicated resubmission button are not built yet (see [Implementation status](#implementation-status)).

- **Pages:** `/submissions` (convener list), `/submissions/new`, `/submissions/:id` (details, windows, media, history), `/review` (queue) and `/review/:id` (decision). `/me` is the account page and `/unclaimed` is where a signed-in person with no role lands. Resource routes: `POST /submissions/:id/upload`, `POST /submissions/:id/upload/finalize`, `GET /submissions/:id/versions/:versionId/file` (authorizes, then redirects to a short-lived signed download URL).
- **Authorization** is checked against the actual submission on every read and write ([app/submissions/access.server.ts](app/submissions/access.server.ts)): a convener needs the CONVENER role **and** an active membership of that committee; a reviewer needs the REVIEWER role and never sees drafts or decides on their own submission; admins get nothing implicitly. A submission you may not see is reported as "not found".
- **States:** DRAFT → PENDING_REVIEW → APPROVED / REJECTED / CHANGES_REQUESTED. A pending submission cannot be edited (withdrawal is out of scope). REJECTED is terminal: a resubmission is a **new** submission linked to the old one (`resubmission_of_id`) with its own version 1 and no inherited approval (service and schema are in place; the dedicated UI comes later). Editing or replacing media of an APPROVED submission withdraws the approval (back to DRAFT, audited).
- **Revisions:** submitting freezes title, description, media version and requested windows into an immutable `submission_revision`. A review decision names that exact revision; approving anything but the current revision is refused, and an approval of an old revision never makes a newer one eligible.
- **Windows:** both start and end are required, the end must be after the start, the start must be in the future when submitting, times are entered and shown in `Asia/Kolkata`, and at most `MAX_REQUEST_WINDOWS` (10) per submission. **Overlaps are allowed**, including several windows on one screen at the same time; the manager arranges them later.
- **Reference codes** look like `VS-2026-000123` (year in campus time), generated by a database function that serialises concurrent requests.
- **History:** media versions, review decisions, revisions and audit events are append-only (database triggers refuse UPDATE and DELETE). Audit events are written in the same transaction as the change they describe.

### Media storage (Neon Object Storage)

Files go **directly from the browser to Neon Object Storage** with short-lived presigned URLs; they never pass through a Vshow request. Everything behind the `ObjectStorage` interface ([app/storage/](app/storage/)) is swappable: the Neon adapter (AWS SDK, path-style, SigV4), an in-memory fake used only by tests, and a fail-closed "unconfigured" provider (every media operation answers 503 and nothing else is affected) used whenever the variables below are missing or invalid.

| Variable                                                                                                                  | Class      | Notes                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------- |
| `NEON_STORAGE_ENDPOINT`, `NEON_STORAGE_REGION`                                                                            | config     | from `GET /projects/{id}/branches/{id}/storage` (`s3_endpoint`, `region`); read from the environment, never hard-coded  |
| `NEON_STORAGE_BUCKET`                                                                                                     | config     | the private bucket you created                                                                                          |
| `NEON_STORAGE_ACCESS_KEY_ID`, `NEON_STORAGE_SECRET_ACCESS_KEY`                                                            | **secret** | Neon storage credentials (`neon credentials create --scope storage:read --scope storage:write`); never the database URL |
| `MEDIA_MAX_PIXELS`                                                                                                        | optional   | pixel limit per image/video frame (width × height); default 100 000 000                                                 |
| `MEDIA_MAX_BYTES`, `MAX_REQUEST_WINDOWS`, `UPLOAD_URL_TTL_SECONDS`, `DOWNLOAD_URL_TTL_SECONDS`, `PREVIEW_URL_TTL_SECONDS` | optional   | limits; defaults 100 MiB, 10, 600 s, 120 s, 900 s                                                                       |

**Access requests.** Anyone who signs in with a campus account but holds no role lands on a "waiting for approval" page and appears under _Access requests_ (`/requests`) for Corporate Communication reviewers and administrators. They choose Committee convener (with a searchable committee box that can also create a new committee, e.g. College Management), Corporate Communication reviewer, or Server Room Manager. Only an administrator can create administrators (on the Users page), and a decision cannot change an account that already has a role.

**Media analysis.** When an upload is finalized the server reads the stored file's headers with a few range requests (never the whole file) and records a description with the version (migration `0005`): format, displayed dimensions (EXIF/MP4 rotation applied), aspect ratio, megapixels, colour mode, transparency, animation, and for MP4 duration, frame rate, codecs, audio and whether it streams (fast-start). Structural problems reject the upload before it reaches the server room: unreadable or truncated files, zero dimensions, and decompression bombs (`MEDIA_MAX_PIXELS`). Softer findings are warnings the reviewer sees under _Technical details_: data after the end of the image, script-like content in that data, GPS location metadata, CMYK colour, animation, low resolution, uncommon codecs, a non-streamable MP4. These are structural checks, **not a virus scan**; versions recorded earlier show no details.

**Previews.** Reviewers, conveners and the manager can look at the media in the page without downloading it (images and MP4 video). The page never contains a storage URL: the `<img>`/`<video>` points at `GET /submissions/:id/versions/:versionId/preview`, which applies the same authorization as the download route on every request and redirects (`no-store`, `no-referrer`) to a short-lived signed URL served `inline` with the validated content type. A video seeks with range requests straight from storage, so previews live longer than downloads (`PREVIEW_URL_TTL_SECONDS`).

**Upload lifecycle** ([app/submissions/uploads.server.ts](app/submissions/uploads.server.ts)): (1) the server authorizes the caller, reserves a version id and two server-generated keys, and returns an upload URL for the **staging** key only; (2) the browser uploads; (3) _finalize_ authorizes again, **copies** staging to the final key, then validates the **final** object (size, declared type, and the actual file signature) and records it with its ETag, atomically. An upload URL can be reused until it expires, so nothing validated at the staging key is trusted; no URL is ever created for a final key, so a reused URL cannot overwrite finalized media, and the bytes validated are the bytes recorded. The design does not rely on conditional copy (`If-Match`) or write-once semantics. A failed finalization records no media version; abandoned objects are removed by `npm run storage:sweep -- --run`, which only ever deletes keys no media version references. Filenames are never part of a key.

**Not verified yet:** the Neon adapter and the browser upload flow (bucket CORS, signed headers, `CopyObject` on the real service) have only been exercised against stubs and an in-memory store. Configure your bucket's CORS yourself (this repository changes nothing in Neon) and test a real upload before relying on it. Neon's branch-wide credentials are not bucket-scoped: use separate credentials and a separate bucket/branch for development and production.

## Logging and dependency wiring

**Logging** uses [Pino](https://getpino.io) behind a small Vshow-owned interface (`Logger` in [app/logging/logger.server.ts](app/logging/logger.server.ts)); application code never imports Pino. Output is one JSON object per line with an ISO timestamp, level, `service`, and the request's `requestId`. In an interactive dev terminal it is printed in a compact readable form. Configure with `LOG_LEVEL` and `LOG_FORMAT` (see `.env.example`).

- **Redaction is automatic and applied to every field and message** ([sanitize.server.ts](app/logging/sanitize.server.ts)): passwords, tokens, cookies, `authorization`, sessions, signing/API keys, database connection strings, bearer tokens/JWTs, cloud keys, presigned-URL signatures and email addresses are replaced; binary data, request bodies, IP addresses and user agents are omitted. Errors are logged under `err` (type, message, stack, cause chain) and never copy arbitrary properties such as PostgreSQL's row-value `detail`.
- **Per request** the root middleware logs exactly one line: method, path (no query string), status, duration, `requestId`. A valid incoming `x-request-id` (8-128 chars of `A-Za-z0-9._-`) is reused, otherwise a UUID is generated; it is returned in the `x-request-id` response header. Headers, cookies, queries and bodies are never logged.
- **Errors**: unhandled loader/action/render errors are logged in `entry.server.tsx` (`handleError`) with the request ID; the browser only ever sees a generic message (stack traces appear in development builds only).
- Use it from a loader/action via `getRequestScope(context)`: `const { logger, database, requestId } = getRequestScope(context)`.

**Dependency injection** is plain functions and objects, no framework. [app/server/container.server.ts](app/server/container.server.ts) is the single composition root: it reads the environment and builds `AppDeps` (`logger`, `database`). The database is a lazy `DbProvider` (`database.get()` creates the pool on first use; importing a module or building the container never connects). Loaders receive deps through router context; tests build their own `AppDeps` with fakes (see `tests/container.test.ts`). Future providers (storage, auth) are added as properties of `AppDeps`.

Known limitation: `npm start` / the Docker image use `react-router-serve`, whose built-in `morgan("tiny")` access log prints the full URL **including query strings** to stdout. Do not put secrets in query strings (relevant for OAuth callbacks); Vshow's own logs never include them.

## Troubleshooting and recovery

| Symptom                                             | What to do                                                                                                                                                                                                               |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Node x is not supported`                           | Install Node 24.x (`nvm install` reads `.nvmrc`), then `npm ci`                                                                                                                                                          |
| `Docker daemon is not running`                      | Start Docker Desktop / the docker service, re-run the command                                                                                                                                                            |
| `ports are not available` / port 5432 in use        | Set `POSTGRES_PORT` (e.g. 55432) **and the port in `DATABASE_URL`** in `.env`, then `npm run db:down && npm run db:up`. Windows can reserve port ranges; `netsh int ipv4 show excludedportrange protocol=tcp` lists them |
| `POSTGRES_PASSWORD is not set`                      | Run `npm run setup`                                                                                                                                                                                                      |
| `password authentication failed`                    | The volume keeps the password it was first created with. If the data is only local: `npm run db:reset:local` (or `npm run db:recreate:local` if the password is right and only the database content is wrong)            |
| `Could not connect ...`                             | `npm run db:up`, then `docker compose ps` and `docker compose logs postgres`; check host/port in `.env` (messages never include credentials)                                                                             |
| Setup was interrupted                               | Run `npm run setup` again; it is idempotent and only fills missing values. A leftover `.env.tmp` can be deleted                                                                                                          |
| `db:migrate` failed                                 | The failing migration is rolled back in a transaction, so the schema is unchanged. Read the error, fix, re-run; check state with `npm run db:health`. Never edit an applied migration                                    |
| `applied migration(s) do not match committed files` | A migration file was edited or removed after it was applied. Restore it from Git (`git checkout -- drizzle/`). For a disposable local database you may instead `npm run db:recreate:local` and migrate again             |
| `Seeding refused`                                   | Intentional: check `APP_ENV` (`development`/`test`), `DB_TARGET=local` and that the database is the local Compose one (see below)                                                                                        |
| Database tests are skipped                          | Local Postgres is not reachable: `npm run db:up`                                                                                                                                                                         |
| Corrupted local data, want a clean start            | `npm run db:recreate:local`, `npm run db:migrate`, optionally `npm run db:seed` (local only)                                                                                                                             |

## Security notes

- Secrets live only in `.env` (git-ignored) or CI/host environment variables. The CI database password is a throwaway literal for an ephemeral container.
- On Windows, `.env` permissions are not restricted by setup (POSIX gets `0600`); keep the repository inside your user profile.
- Never run migrations against a remote database from a pull-request job. Production migrations are a manual, confirmed step.
- Do not paste connection strings into issues or logs; scripts print only host, port and database name.

## Deployment: Vercel (serverless), decision recorded

Vshow deploys to **Vercel Functions in React Router framework mode**. There is no Express and no custom persistent Node server.

- **Integration:** Vercel's documented zero-config React Router support. The optional `@vercel/react-router` preset is **not installed**: its latest release (1.3.7) declares peer dependencies on React Router **7**, and this project uses **8.4**, so it is an unsupported combination. Adopt it only after Vercel supports React Router 8 or a preview deployment proves it works.
- **Runtime:** Node 24 (`engines` is `24.x`; also set the Vercel project's Node.js version to 24). Build command: the default `react-router build`. **Migrations never run during build or deploy**; run `db:migrate` deliberately (see above).
- **Environment variables (Vercel project settings, never in git):** `DB_TARGET=neon`, `DATABASE_URL` (Neon **pooled** string), optionally `LOG_LEVEL`. `DATABASE_URL_DIRECT` is only needed by whoever runs migrations, from a trusted machine, not by the deployed app. Use a separate Neon branch/database for Preview deployments and never the production one.
- **Database connections:** one `pg` pool per function instance, created lazily on first use and cached for the instance's lifetime (never per request); max 5 connections, 10 s idle timeout, pointed at Neon's pooler. On Vercel the pool is also registered with `attachDatabasePool` (`@vercel/functions`, marked experimental by Vercel), isolated in `app/platform/vercel.server.ts` so idle connections are closed before an instance is suspended. Nothing retries a database write automatically.
- **Access logs:** `react-router-serve` (and its `morgan` access log that prints query strings) is **not used on Vercel**, which builds its own function entry. Vshow's logs contain paths only. **Unresolved:** Vercel's own runtime-log UI records a request's _search params_ as platform metadata that application code cannot filter (retention: Hobby 1 h, Pro 1 day). An OAuth callback carries `code` and `state` in its query string, so they would appear there. This needs a decision before the auth phase (options: accept, given single-use short-lived codes with PKCE; or use `response_mode=form_post` if vauth supports it, which puts them in a POST body instead).
- **`npm start` and the Docker image** run `react-router-serve` and are for local smoke tests and non-Vercel self-hosting only. They print full URLs including query strings to stdout.

**What is verified locally:** production build, SSR on the built server, request IDs on matched and unmatched routes, per-request log lines, redaction, pool laziness/reuse (with a fake pool), and the Docker image. **What can only be verified on Vercel** (not yet done): that a preview deployment builds and serves React Router 8 without the preset, that the custom `entry.server.tsx` is used, structured logs appearing in Runtime Logs, real Neon pooled connections under concurrency, `attachDatabasePool` behaviour, and exactly what the Vercel log UI records.

## Portability: Vercel, Cloudflare Workers, Node hosting

The deployment target is Vercel today. The code is organised so moving later is a bounded piece of work, **not a zero-change swap**. `tests/portability.test.ts` enforces the boundaries below.

**Shared and provider-independent** (no hosting-provider or Node-only imports): routes and the root route, Zod validation and the API error convention ([api-response](app/server/api-response.server.ts), [validation](app/server/validation.server.ts)), request IDs and per-request scope, the log-redaction logic, the `Logger` interface, database config/safety checks, Drizzle schema and migrations, the seed and migration scripts (they run from any trusted machine), and the shared server-entry hooks ([entry-hooks.server.ts](app/server/entry-hooks.server.ts)). Business logic must keep receiving `logger`/`database` through `AppDeps` and never import a provider package.

**Runtime- or provider-specific, and the only places that may be:**

| File                                                                                                                                        | Why it is specific                                                         | What changes elsewhere                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| [app/platform/vercel.server.ts](app/platform/vercel.server.ts) + the Vercel branch in [platform.server.ts](app/platform/platform.server.ts) | `@vercel/functions` `attachDatabasePool` (lazy import; failure only warns) | Delete the file/branch and the dependency to leave Vercel                         |
| [app/db/client.server.ts](app/db/client.server.ts)                                                                                          | `pg` opens TCP connections (Node API)                                      | Replace the driver behind `DbProvider`; schema and migrations are unaffected      |
| [app/entry.server.tsx](app/entry.server.tsx)                                                                                                | Node stream HTML rendering                                                 | A Cloudflare entry uses Web-stream rendering and re-exports the same shared hooks |
| [app/logging/logger.server.ts](app/logging/logger.server.ts)                                                                                | Pino and `process.stdout`                                                  | Re-implement `createLogger` (the sanitizer and `Logger` interface stay)           |
| [app/server/container.server.ts](app/server/container.server.ts)                                                                            | Reads `process.env` once (the composition root)                            | See "environment" under Cloudflare                                                |

**To run on Vercel (current target):** nothing further beyond the deployment section above; Vercel-only unknowns are listed there.

**To move to Cloudflare Workers** (React Router 8 has an official adapter, `@react-router/cloudflare` 8.4.0):

- Add that package and `wrangler`, a Worker entry using `createRequestHandler`, a Cloudflare `entry.server` with Web-stream rendering that re-exports `handleError`/`instrumentations` from the shared hooks, and the Vite/Wrangler config.
- **Database is the main work.** Node's `pg` over TCP does not suit short-lived isolates. Options: `pg` through Cloudflare Hyperdrive (needs `nodejs_compat`), or Neon's serverless driver with Drizzle's matching adapter. Either replaces the internals of `createDbProvider` and the `Db` type; every `database.get()` caller keeps its API only if the query-builder surface stays the same (the Drizzle adapter differs, so re-test queries and transactions). Migrations still run from a trusted machine with the direct Neon URL.
- Replace the Pino backend with a console/JSON logger behind the same `Logger` interface (Pino is not designed for Workers; unverified). Drop the Vercel adapter and add a Cloudflare one only if a real lifecycle difference appears.
- **Environment:** Workers receive configuration as bindings. `createContainer(env)` already accepts an env object, but `getContainer()` caches one container per process, so it needs to be created per isolate/request from the bindings (or use the `nodejs_compat` flag that populates `process.env`; unverified).
- Check bundle-size and CPU-time limits for the Zod/Drizzle/React bundle (unverified), and what Cloudflare's request logs record about query strings.

**To use conventional Node hosting** (VM, container platform): this already works via `npm start` or the Dockerfile, but note:

- `react-router-serve` prints query strings in its access log, and there is no graceful shutdown that calls `database.close()`. A small production server (Node `http` plus React Router's `createRequestHandler`, no Express needed) would fix both; it is not built because Vercel is the target.
- No platform adapter is needed (a persistent process keeps its pool). Run one process per container, keep `max` at 5 per instance, and put TLS, request limits and log shipping in the host or reverse proxy.
- Pin Node 24 and run migrations as a separate, deliberate step, as everywhere.

**Known remaining portability risks:** the Drizzle query surface differs between `pg` and HTTP/WebSocket drivers; Pino on Workers; per-request environment on Workers; the experimental `attachDatabasePool`; and no production-server shutdown handling off Vercel.

## API routes: errors and validation

Page routes use React Router's own mechanisms (thrown responses, `ErrorBoundary`; unhandled errors are logged by `handleError`). **API / resource routes** use one JSON convention ([api-response.server.ts](app/server/api-response.server.ts)): success `{ "data": ... }`; failure `{ "error": { "code", "message", "requestId", "issues"? } }` with the correct HTTP status and the `x-request-id` header. Inside a resource route's native `async` loader/action, wrap the body in `try { ... } catch (e) { return toApiResponse(e, getRequestScope(context)) }`. Unknown errors become a generic 500 (the real error is logged, never returned); validation failures return field paths and codes, never the submitted values.

Request bodies and queries are validated with shared **Zod** schemas at the boundary via `parseJsonBody` / `parseSearchParams` ([validation.server.ts](app/server/validation.server.ts)): content type is checked, the body is size-limited (1 MB, enforced while streaming), and malformed JSON is rejected without echoing it. No retry logic exists in the codebase, by design: a write is only retried with an explicit idempotency key.

Requests that never reach the root middleware (unmatched routes) still get a request ID and one log line: documents in `entry.server.tsx` (the ID is also returned in the `x-request-id` header), `.data` requests and pre-routing failures via React Router's instrumentation API (logged, but that API is read-only so no header is added).

## Build and run locally

```bash
npm run build
npm run start    # react-router-serve: local smoke test only, see the Vercel section
```

The included `Dockerfile` builds a self-hosted image (the CI `docker` job verifies it builds, and a test verifies the build context excludes env files and dev data).
