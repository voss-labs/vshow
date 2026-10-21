import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import pg from "pg";
import { isLocalHost, resolveDbConfig } from "../app/db/config.server.ts";
import { readLocalMigrations } from "../scripts/lib/db-runtime.ts";
import { runNode } from "./helpers.ts";

const kit = join("node_modules", "drizzle-kit", "bin.cjs");
const kitArgs = ["--dialect=postgresql", "--schema=./app/db/schema/index.ts"];

describe("migration files", () => {
  it("match the TypeScript schema (no un-generated drift)", () => {
    // Generate into a temp copy so the repository is never modified by the test.
    const tmp = mkdtempSync(join(tmpdir(), "vshow-drift-"));
    try {
      cpSync("drizzle", tmp, { recursive: true });
      const before = readdirSync(tmp).sort();
      const r = runNode([kit, "generate", ...kitArgs, `--out=${tmp}`, "--name=drift_check"]);
      assert.equal(r.status, 0, r.stderr || r.stdout);
      assert.deepEqual(
        readdirSync(tmp).sort(),
        before,
        "schema changed without a committed migration: run `npm run db:generate`",
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("pass drizzle-kit consistency check", () => {
    const r = runNode([kit, "check", "--dialect=postgresql", "--out=drizzle"]);
    assert.equal(r.status, 0, r.stderr || r.stdout);
  });

  it("are listed in the journal, in order, with no destructive statements", () => {
    const migrations = readLocalMigrations();
    assert.ok(migrations.length > 0);
    assert.deepEqual(
      migrations.map((m) => m.when),
      migrations.map((m) => m.when).sort((a, b) => a - b),
    );
    for (const m of migrations) {
      assert.doesNotMatch(
        m.sql,
        /\b(DROP\s+(TABLE|COLUMN|SCHEMA|DATABASE)|TRUNCATE|DELETE\s+FROM)\b/i,
        `${m.tag} is destructive`,
      );
    }
    assert.ok(existsSync(join("drizzle", "meta", "_journal.json")));
  });
});

describe("migrate script safety (no database needed)", () => {
  const fakeNeon = "postgresql://u:s3cretpw@ep-x-1.eu.aws.neon.tech/neondb?sslmode=require";

  it("refuses a remote target without --confirm-host, before connecting", () => {
    const r = runNode(["scripts/db-migrate.ts"], {
      DB_TARGET: "neon",
      DATABASE_URL: fakeNeon,
      DATABASE_URL_DIRECT: "",
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /explicit authorization/);
    assert.ok(!(r.stdout + r.stderr).includes("s3cretpw"));
  });

  it("refuses a pooled URL, a missing target, and a missing URL", () => {
    const pooled = fakeNeon.replace("ep-x-1.", "ep-x-1-pooler.");
    assert.match(
      runNode(["scripts/db-migrate.ts"], { DB_TARGET: "neon", DATABASE_URL: pooled, DATABASE_URL_DIRECT: "" }).stderr,
      /direct \(non-pooled\)/,
    );
    assert.match(
      runNode(["scripts/db-migrate.ts"], { DB_TARGET: "", DATABASE_URL: fakeNeon, DATABASE_URL_DIRECT: "" }).stderr,
      /DB_TARGET is not set/,
    );
    assert.match(
      runNode(["scripts/db-migrate.ts"], { DB_TARGET: "local", DATABASE_URL: "", DATABASE_URL_DIRECT: "" }).stderr,
      /DATABASE_URL is not set/,
    );
  });
});

// Integration: needs the local compose Postgres (npm run db:up). Creates and drops a throwaway
// database; refuses to run against anything that is not a loopback host with DB_TARGET=local.
describe("migrations against a disposable local database", async () => {
  let admin: pg.Client | undefined;
  let skipReason = "";
  let testUrl = "";
  const dbName = `vshow_test_${randomBytes(4).toString("hex")}`;

  try {
    const cfg = resolveDbConfig(process.env, "migration");
    if (cfg.target !== "local" || !isLocalHost(cfg.host)) throw new Error("DB_TARGET is not local");
    const adminUrl = new URL(cfg.url);
    adminUrl.pathname = "/postgres";
    admin = new pg.Client({ connectionString: adminUrl.toString(), connectionTimeoutMillis: 3000 });
    await admin.connect();
    await admin.query(`create database ${dbName}`);
    const u = new URL(cfg.url);
    u.pathname = `/${dbName}`;
    testUrl = u.toString();
  } catch (err) {
    skipReason = `no local database available (${(err as Error).message.split("\n")[0].slice(0, 80)}); run npm run setup && npm run db:up`;
  }

  const env = () => ({ DB_TARGET: "local", DATABASE_URL: testUrl, DATABASE_URL_DIRECT: "" });
  const opts = { skip: skipReason || false };

  it("applies all migrations", opts, () => {
    const r = runNode(["scripts/db-migrate.ts"], env());
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.match(r.stdout, /Applied 6 migration/);
  });

  it(
    "creates the 12 approved tables, the 3 workflow-support tables and the 3 auth tables, and enforces key constraints",
    opts,
    async () => {
      const c = new pg.Client({ connectionString: testUrl });
      await c.connect();
      try {
        const t = await c.query(
          "select table_name from information_schema.tables where table_schema='public' order by 1",
        );
        assert.deepEqual(
          t.rows.map((r) => r.table_name),
          [
            "app_role",
            "app_user",
            "audit_event",
            "auth_account",
            "auth_session",
            "auth_verification",
            "committee",
            "committee_membership",
            "reference_counter",
            "review_decision",
            "schedule_entry",
            "screen",
            "screen_request",
            "submission",
            "submission_revision",
            "upload_reservation",
            "user_role",
            "media_version",
          ].sort(),
        );
        // Email must be normalized.
        await assert.rejects(
          c.query("insert into app_user(email, display_name) values ('A@B.com','x')"),
          /app_user_email_normalized/,
        );
        const u = (await c.query("insert into app_user(email, display_name) values ('a@b.com','x') returning id"))
          .rows[0].id;
        const com = (await c.query("insert into committee(name, code) values ('c','c1') returning id")).rows[0].id;
        const mkSub = async (ref: string) =>
          (
            await c.query(
              "insert into submission(reference_code, committee_id, created_by_user_id, title, workflow_status) values ($1,$2,$3,'t','DRAFT') returning id",
              [ref, com, u],
            )
          ).rows[0].id;
        const s1 = await mkSub("R1");
        const s2 = await mkSub("R2");
        const v1 = (
          await c.query(
            "insert into media_version(submission_id, version_number, object_key, original_filename, content_type, size_bytes, uploaded_by_user_id) values ($1,1,'k1','a.mp4','video/mp4',10,$2) returning id",
            [s1, u],
          )
        ).rows[0].id;
        await assert.rejects(
          c.query(
            "insert into media_version(submission_id, version_number, object_key, original_filename, content_type, size_bytes, uploaded_by_user_id) values ($1,2,'k2','a.mp4','video/mp4',0,$2)",
            [s1, u],
          ),
          /media_version_size_positive/,
        );
        // current_version_id must belong to the same submission.
        await assert.rejects(
          c.query("update submission set current_version_id=$1 where id=$2", [v1, s2]),
          /submission_current_version_fk/,
        );
        await c.query("update submission set current_version_id=$1 where id=$2", [v1, s1]);
        // A review must reference a revision of its own submission (and that revision's version), and rejections and
        // change requests need a comment. (Setup: a second user as reviewer, a revision, and a pending submission.)
        const rev = (await c.query("insert into app_user(email, display_name) values ('rev@b.com','r') returning id"))
          .rows[0].id;
        const r1 = (
          await c.query(
            "insert into submission_revision(submission_id, revision_number, title, media_version_id, requested_windows, created_by_user_id) values ($1,1,'t',$2,'[]',$3) returning id",
            [s1, v1, u],
          )
        ).rows[0].id;
        await c.query("update submission set current_revision_id=$1, workflow_status='PENDING_REVIEW' where id=$2", [
          r1,
          s1,
        ]);
        await assert.rejects(
          c.query(
            "insert into review_decision(submission_id, media_version_id, revision_id, reviewer_user_id, decision) values ($1,$2,$3,$4,'APPROVED')",
            [s2, v1, r1, rev],
          ),
          /pending review|foreign key/,
        );
        for (const decision of ["CHANGES_REQUESTED", "REJECTED"]) {
          await assert.rejects(
            c.query(
              "insert into review_decision(submission_id, media_version_id, revision_id, reviewer_user_id, decision) values ($1,$2,$3,$4,$5)",
              [s1, v1, r1, rev, decision],
            ),
            /review_decision_reason_required/,
          );
        }
        await assert.rejects(
          c.query(
            "insert into submission(reference_code, committee_id, created_by_user_id, title, workflow_status) values ('R3',$1,$2,'t','BOGUS')",
            [com, u],
          ),
          /submission_workflow_status_valid/,
        );
      } finally {
        await c.end();
      }
    },
  );

  it("is idempotent: a second run applies nothing", opts, () => {
    const r = runNode(["scripts/db-migrate.ts"], env());
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Up to date/);
  });

  it("health check connects and reports migration state", opts, () => {
    const r = runNode(["scripts/db-health.ts"], env());
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Connected to 127\.0\.0\.1/);
    assert.match(r.stdout, /6 applied, 0 pending/);
    assert.ok(!r.stdout.includes(new URL(testUrl).password));
  });

  it("refuses to proceed when applied history no longer matches committed files", opts, async () => {
    const c = new pg.Client({ connectionString: testUrl });
    await c.connect();
    try {
      await c.query("update drizzle.__drizzle_migrations set hash = 'tampered'");
      const r = runNode(["scripts/db-migrate.ts"], env());
      assert.equal(r.status, 1);
      assert.match(r.stderr, /do not match any committed file/);
      assert.equal(runNode(["scripts/db-health.ts"], env()).status, 1);
    } finally {
      await c.end();
    }
  });

  it("fails safely when the database is unreachable", () => {
    const r = runNode(["scripts/db-health.ts"], {
      DB_TARGET: "local",
      DATABASE_URL: "postgresql://vshow:s3cretpw@127.0.0.1:1/vshow",
      DATABASE_URL_DIRECT: "",
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Could not connect to 127\.0\.0\.1:1/);
    assert.ok(!(r.stdout + r.stderr).includes("s3cretpw"));
  });

  it("cleanup", async () => {
    if (admin) {
      if (!skipReason) await admin.query(`drop database ${dbName} with (force)`);
      await admin.end();
    }
  });
});
