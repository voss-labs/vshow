# Contributor onboarding

Get Vshow running on your machine in about 10 minutes. **You do not need any OAuth credentials**: locally you sign in with a built-in _dev identity switcher_ that logs you in as seeded test users.

## 1. What you need

- **Git**
- **Node.js 24.x** (`nvm use` / `fnm use` reads `.nvmrc`)
- **A PostgreSQL database**, any one of: [Docker](#option-a-docker-recommended) (easiest), [PostgreSQL installed on your machine](#option-b-postgresql-without-docker), or [a Neon database](#option-c-a-neon-database-uri) (limited, see below)

## 2. Set up

```bash
git clone <repo-url> && cd vshow
nvm use                 # or install Node 24 yourself
npm ci                  # install dependencies
npm run setup           # creates .env and generates secrets (safe to re-run)
```

Open `.env` and set this one line (it is empty by default):

```
VSHOW_DEV_AUTH=1
```

Now pick **one** way to get a database.

### Option A: Docker (recommended)

Needs Docker with Compose v2 (Docker Desktop on Windows/Mac).

```bash
npm run db:up           # start local PostgreSQL in Docker
```

### Option B: PostgreSQL without Docker

Install PostgreSQL 16 on your machine, then create the user and database that `.env` expects. Run this as the PostgreSQL admin (`psql -U postgres`), using the `POSTGRES_PASSWORD` value from your `.env`:

```sql
CREATE ROLE vshow LOGIN CREATEDB PASSWORD 'paste-POSTGRES_PASSWORD-from-.env';
CREATE DATABASE vshow OWNER vshow;
```

`CREATEDB` matters: the tests create throwaway databases. If your PostgreSQL does not listen on port 5432, change `POSTGRES_PORT` **and** the port inside `DATABASE_URL` in `.env`. Skip `npm run db:up` (and ignore `db:down` / `db:reset:local`, which are Docker-only).

### Option C: A Neon database URI

Use this only if you cannot run PostgreSQL at all. **Limits:** the seed command and the dev switcher both refuse a Neon database (by design, so test users can never exist in a shared database). With Neon you can run the app and migrations, but you **cannot sign in locally**. For anything that needs a login, use Option A or B.

```bash
npm run setup -- --db=neon     # then edit .env (below)
```

In `.env` set `DATABASE_URL` to the **pooled** string (host contains `-pooler`, ends with `?sslmode=require`) and `DATABASE_URL_DIRECT` to the **direct** string, and leave `VSHOW_DEV_AUTH` empty. Use a dedicated Neon **branch**, never the production one. Migrations to a remote database need the host confirmed:

```bash
npm run db:migrate -- --confirm-host=<host of DATABASE_URL_DIRECT>
```

Then skip the seed and go straight to `npm run dev`. Switching later to A or B: edit `DB_TARGET` and the URLs in `.env` by hand (setup never overwrites your choices).

### Then (Options A and B)

```bash
npm run db:migrate      # create the database tables
npm run db:seed         # add fake test data and test users
npm run dev             # start the app at http://localhost:5173
```

Check the database anytime with `npm run db:health` (expect `6 applied, 0 pending`).

## 3. Sign in with the dev switcher

Open **http://localhost:5173/dev/login** and pick a test user. Roles come from the database, not from the browser.

| Pick                | What you can do                                                                     |
| ------------------- | ----------------------------------------------------------------------------------- |
| `convener_media`    | Create submissions for the Media committee: `/submissions`                          |
| `convener_robotics` | Same, for the Robotics committee (cannot see Media's submissions)                   |
| `reviewer`          | Review queue: `/review` (approve / reject / request changes)                        |
| `manager`           | Server Room Manager: `/manager` queue, download, mark done / undo                   |
| `admin`             | Administrator: `/admin` to assign roles and memberships (cannot see submissions)    |
| `member_media`      | Signed in but has no role, so you land on `/unclaimed`                              |
| `convener_lapsed`   | Has the convener role but no active membership, so cannot create or see submissions |
| `inactive_convener` | Deactivated user: sign-in is refused                                                |

Switch users by visiting `/dev/login` again. Try the flow: sign in as `convener_media`, create a submission, then sign in as `reviewer` and review it.

> The dev switcher only works locally. It refuses to start unless `APP_ENV=development`, the database is a local one (`DB_TARGET=local`) and the app runs on localhost, and `npm run build` fails if `VSHOW_DEV_AUTH` is set. Never set it anywhere else.

## 4. Media uploads (optional)

Uploading a file needs a Neon Object Storage bucket (the `NEON_STORAGE_*` values in `.env.example`). **Without it the app still works**: upload requests just answer a safe `503`, and everything else can be tested. A submission needs media before it can be sent for review, so to test the review flow without a bucket, ask a maintainer for a development bucket or attach a database-only stand-in:

<details>
<summary>Stand-in media SQL (local database only)</summary>

Run it after creating a draft. It attaches a fake media row to your draft submissions that have none (no real file exists, so downloads won't work):

```bash
docker compose exec -T postgres psql -U vshow -d vshow <<'SQL'
with t as (
  select id, created_by_user_id from submission
   where reference_code like 'VS-%' and current_version_id is null
     and workflow_status in ('DRAFT', 'CHANGES_REQUESTED')
), v as (
  insert into media_version (submission_id, version_number, object_key, original_filename,
                             content_type, size_bytes, uploaded_by_user_id, change_note)
  select id, 1, 'standin/' || id || '/dev.png', 'dev.png', 'image/png', 70, created_by_user_id, 'dev stand-in'
    from t returning id, submission_id
)
update submission s set current_version_id = v.id from v where s.id = v.submission_id;
SQL
```

That command is for Docker. With Option B, save the SQL between `<<'SQL'` and `SQL` as `standin.sql` and run `psql -U vshow -d vshow -f standin.sql`. On Windows PowerShell with Docker: `Get-Content standin.sql | docker compose exec -T postgres psql -U vshow -d vshow`.

</details>

## 5. Before you open a PR

```bash
npm run check           # format check + lint + typecheck + tests
```

- Tests need a local PostgreSQL (Option A or B, running). They create and drop their own throwaway databases and never touch your `vshow` data.
- Fix formatting with `npm run format`.
- **Never commit `.env`, credentials or secrets** (`.env` is git-ignored).
- If you change the database schema, generate a migration with `npm run db:generate`, review the SQL, and commit it. Never edit a migration that already exists.

## 6. Handy commands

| Command                     | What it does                                                                                                                           |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run db:down`           | Docker only: stop the database container (data is kept)                                                                                |
| `npm run db:recreate:local` | Wipe and recreate only the local `vshow` database (type `vshow` to confirm), then run `npm run db:migrate` and `npm run db:seed` again |
| `npm run setup:check`       | Check your tools and `.env` without changing anything                                                                                  |
| `npm test`                  | Run only the tests                                                                                                                     |

## 7. Troubleshooting

| Problem                                 | Fix                                                                                                                                                      |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/dev/login` shows 404                  | `VSHOW_DEV_AUTH=1` is missing in `.env` (or you are on Neon). Set it and **restart** `npm run dev`                                                       |
| The server refuses to start             | With `VSHOW_DEV_AUTH=1` the database must be a local one (Option A or B); the message names the failed check                                             |
| Sign-in says the identity was not found | The database isn't seeded: run `npm run db:seed`                                                                                                         |
| A page shows a 500 error                | The database isn't migrated: run `npm run db:migrate`                                                                                                    |
| Port 5432 or 5173 is already in use     | Stop whatever uses it. For Postgres you can instead change the port in `.env` (`POSTGRES_PORT` and the port inside `DATABASE_URL`)                       |
| `password authentication failed`        | Docker: your volume has an older password, run `npm run db:reset:local` (deletes local data). Option B: re-create the role with the password from `.env` |
| Changed `.env` but nothing happened     | Restart `npm run dev`; `.env` is read only at startup                                                                                                    |

## 8. Where things are

- `app/routes/` pages and endpoints, `app/submissions/` the workflow logic, `app/storage/` media storage, `app/auth/` sign-in and permissions
- `drizzle/` database migrations, `scripts/` setup, migrate and seed commands, `tests/` automated tests
- `docs/` the product requirements and data model; the [README](README.md) has the full details

Questions? Open an issue or ask in the PR.
