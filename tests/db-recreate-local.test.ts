// `npm run db:recreate:local` drops and recreates ONLY the local development database. The refusal tests never
// reach a database (every refusal happens before any connection); the integration tests use disposable
// vshow_test_* databases on the local server, never the developer's `vshow` database.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { createThrowawayDb, runNode } from "./helpers.ts";

const SCRIPT = "scripts/db-recreate-local.ts";
// Nothing listens on this port: if a refusal test ever reached the connection step it would fail differently.
const dev = {
  APP_ENV: "development",
  DB_TARGET: "local",
  DATABASE_URL: "postgresql://vshow:s3cretpw@127.0.0.1:55999/vshow",
  DATABASE_URL_DIRECT: "",
  POSTGRES_PORT: "55999",
  POSTGRES_DB: "vshow",
  POSTGRES_USER: "vshow",
};
const run = (env: Record<string, string>, ...args: string[]) => runNode([SCRIPT, ...args], { ...dev, ...env });
const refusedWith = (r: ReturnType<typeof run>, pattern: RegExp) => {
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, pattern);
  assert.ok(!r.stdout.includes("Target:"), "nothing was inspected: no connection was made");
  assert.ok(!(r.stdout + r.stderr).includes("s3cretpw"), "the password is never printed");
};

describe("db:recreate:local refuses before connecting", () => {
  const neon = "postgresql://u:s3cretpw@ep-x-1.eu.aws.neon.tech/neondb?sslmode=require";

  it("Neon, remote hosts, unexpected ports and names, ambiguous or production-like configurations", () => {
    refusedWith(
      run({ DB_TARGET: "neon", DATABASE_URL: neon }, "--confirm=neondb"),
      /not 'local'|different databases|not an approved/,
    );
    refusedWith(
      run({ DATABASE_URL: neon }, "--confirm=neondb"),
      /not a loopback host|not an approved local host|different|Port/,
    );
    refusedWith(
      run({ DATABASE_URL: "postgresql://vshow:s3cretpw@10.1.2.3:55999/vshow" }, "--confirm=vshow"),
      /not a loopback host|not an approved local host/,
    );
    refusedWith(
      run({ DATABASE_URL: "postgresql://vshow:s3cretpw@127.0.0.1:6543/vshow" }, "--confirm=vshow"),
      /Port 6543 does not match/,
    );
    refusedWith(
      run({ DATABASE_URL: "postgresql://vshow:s3cretpw@127.0.0.1:55999/campus_live" }, "--confirm=campus_live"),
      /not the expected local database/,
    );
    refusedWith(
      run({ DATABASE_URL: "postgresql://vshow:s3cretpw@127.0.0.1:55999/postgres" }, "--confirm=postgres"),
      /not the expected local database/,
    );
    refusedWith(
      run({ DATABASE_URL: "postgresql://other:s3cretpw@127.0.0.1:55999/vshow" }, "--confirm=vshow"),
      /user does not match/,
    );
    refusedWith(
      run({ DATABASE_URL_DIRECT: "postgresql://vshow:s3cretpw@127.0.0.1:55999/vshow_old" }, "--confirm=vshow"),
      /different databases/,
    );
    // production-like markers
    refusedWith(run({ NODE_ENV: "production" }, "--confirm=vshow"), /NODE_ENV=production/);
    refusedWith(run({ VERCEL: "1" }, "--confirm=vshow"), /Vercel/);
    refusedWith(run({ APP_ENV: "production" }, "--confirm=vshow"), /not allowed/);
    refusedWith(run({ APP_ENV: "staging" }, "--confirm=vshow"), /not allowed/);
    refusedWith(run({ APP_ENV: "" }, "--confirm=vshow"), /APP_ENV is not set/);
  });

  it("a development database that is not exactly 'vshow' (even if POSTGRES_DB says so)", () => {
    refusedWith(
      run(
        { POSTGRES_DB: "myapp", DATABASE_URL: "postgresql://vshow:s3cretpw@127.0.0.1:55999/myapp" },
        "--confirm=myapp",
      ),
      /must be named 'vshow'/,
    );
  });

  it("a shell value that silently overrides .env is ambiguous", () => {
    const dir = mkdtempSync(join(tmpdir(), "vshow-recreate-"));
    try {
      const file = join(dir, ".env");
      writeFileSync(file, "DATABASE_URL=postgresql://vshow:s3cretpw@127.0.0.1:55999/vshow_other\n");
      refusedWith(run({ VSHOW_ENV_FILE: file }, "--confirm=vshow"), /differs from \.env/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("requires the exact database name to be typed or passed", () => {
    refusedWith(run({}), /non-interactive shell; pass --confirm/);
    refusedWith(run({}, "--confirm=wrong"), /confirmation did not match/);
    refusedWith(run({}, "--confirm=VSHOW"), /confirmation did not match/);
    refusedWith(run({}, "--confirm="), /confirmation did not match/);
  });
});

describe("db:recreate:local against disposable local databases", async () => {
  const db = await createThrowawayDb("vshow_test_recreate");
  const opts = { skip: db.skipReason || false };
  const name = db.url ? decodeURIComponent(new URL(db.url).pathname.slice(1)) : "";
  const bystander = `vshow_test_bystander_${randomBytes(3).toString("hex")}`;
  const env = () => ({
    APP_ENV: "test",
    DB_TARGET: "local",
    DATABASE_URL: db.url,
    DATABASE_URL_DIRECT: "",
  });
  const urlFor = (database: string) => {
    const u = new URL(db.url);
    u.pathname = `/${database}`;
    return u.toString();
  };
  const withClient = async <T>(database: string, fn: (c: pg.Client) => Promise<T>) => {
    const c = new pg.Client({ connectionString: urlFor(database) });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  };
  const databases = async () =>
    (await db.admin!.query("select datname from pg_database where not datistemplate order by 1")).rows.map(
      (r) => r.datname as string,
    );
  // Other test files create and drop their own disposable databases at the same time; compare only the rest.
  const stable = (list: string[]) => list.filter((d) => !d.startsWith("vshow_test_") || d === bystander || d === name);
  const tableCount = (database: string) =>
    withClient(
      database,
      async (c) =>
        (await c.query("select count(*)::int n from information_schema.tables where table_schema='public'")).rows[0]
          .n as number,
    );
  const seedTarget = () =>
    withClient(name, async (c) => {
      await c.query("create table if not exists precious(id int primary key)");
      await c.query("insert into precious values (1) on conflict do nothing");
    });

  after(async () => {
    if (db.skipReason) return;
    await db.admin!.query(`drop database if exists ${bystander} with (force)`).catch(() => {});
    await db.drop();
  });

  it("dry run checks everything and changes nothing", opts, async () => {
    await db.admin!.query(`create database ${bystander}`);
    await withClient(bystander, (c) => c.query("create table keep(id int); insert into keep values (7)"));
    await seedTarget();
    const r = runNode([SCRIPT, `--confirm=${name}`, "--dry-run"], env());
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Dry run: every check passed/);
    assert.equal(await tableCount(name), 1);
  });

  it("a wrong confirmation changes nothing", opts, async () => {
    const r = runNode([SCRIPT, "--confirm=not_this_one"], env());
    assert.equal(r.status, 1);
    assert.equal(await tableCount(name), 1);
  });

  it(
    "drops and recreates ONLY the target: it is empty afterwards, other databases and their data are intact",
    opts,
    async () => {
      const before = stable(await databases());
      const [meta] = (
        await db.admin!.query(
          "select pg_get_userbyid(datdba) o, pg_encoding_to_char(encoding) e, datcollate c from pg_database where datname=$1",
          [name],
        )
      ).rows;
      const r = runNode([SCRIPT, `--confirm=${name}`], env());
      assert.equal(r.status, 0, r.stderr + r.stdout);
      assert.match(r.stdout, /dropped and recreated empty/);
      assert.match(r.stdout, /No migrations or seeds were run/);
      assert.ok(r.stdout.includes(bystander), "the other databases are listed as untouched");
      assert.equal(await tableCount(name), 0, "the target is empty");
      assert.deepEqual(stable(await databases()), before, "the set of databases is unchanged");
      const [after] = (
        await db.admin!.query(
          "select pg_get_userbyid(datdba) o, pg_encoding_to_char(encoding) e, datcollate c from pg_database where datname=$1",
          [name],
        )
      ).rows;
      assert.deepEqual(after, meta, "owner, encoding and locale are preserved");
      assert.deepEqual(await withClient(bystander, async (c) => (await c.query("select id from keep")).rows), [
        { id: 7 },
      ]);
      assert.ok(!(r.stdout + r.stderr).includes(new URL(db.url).password));
    },
  );

  it("refuses while another session is connected, unless told to disconnect it", opts, async () => {
    await seedTarget();
    const session = new pg.Client({ connectionString: db.url });
    await session.connect();
    session.on("error", () => {}); // the forced disconnect below is expected
    try {
      const refused = runNode([SCRIPT, `--confirm=${name}`], env());
      assert.equal(refused.status, 1);
      assert.match(refused.stderr, /1 other session\(s\) are connected/);
      assert.equal(await tableCount(name), 1, "nothing was dropped");

      const forced = runNode([SCRIPT, `--confirm=${name}`, "--terminate-connections"], env());
      assert.equal(forced.status, 0, forced.stderr + forced.stdout);
      assert.equal(await tableCount(name), 0);
      await assert.rejects(session.query("select 1"), /terminat|closed|not queryable|Connection/i);
    } finally {
      await session.end().catch(() => {});
    }
    assert.ok((await databases()).includes(bystander));
  });

  it("creates the database when it does not exist, and never touches the others", opts, async () => {
    await db.admin!.query(`drop database ${name} with (force)`);
    const r = runNode([SCRIPT, `--confirm=${name}`], env());
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /does not exist yet/);
    assert.equal(await tableCount(name), 0);
    assert.deepEqual(await withClient(bystander, async (c) => (await c.query("select id from keep")).rows), [
      { id: 7 },
    ]);
  });

  it("the migration tooling can migrate the freshly recreated empty database", opts, async () => {
    const r = runNode(["scripts/db-migrate.ts"], env());
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /Applied 6 migration/);
  });
});

describe("package script and documentation", () => {
  it("is wired as an npm script and the reset command's whole-volume effect is documented", async () => {
    const { readFileSync } = await import("node:fs");
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };
    assert.match(pkg.scripts["db:recreate:local"], /scripts\/db-recreate-local\.ts/);
    assert.ok(
      !/docker/.test(readFileSync("scripts/db-recreate-local.ts", "utf8").replace(/\/\/.*$/gm, "")),
      "it never invokes docker",
    );
    assert.match(readFileSync("README.md", "utf8"), /db:recreate:local/);
  });
});
