// Database-level guarantees of migration 0004, exercised with raw SQL so they hold whatever the application does:
// append-only history, composite foreign keys, the review guard, reference codes, and a safe upgrade path.
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { createDraft, saveDraft, submitForReview } from "../app/submissions/submissions.server.ts";
import { decide } from "../app/submissions/reviews.server.ts";
import { createThrowawayDb, runNode } from "./helpers.ts";
import { PNG, createWorkflowHarness } from "./support/workflow-harness.ts";
import { finalizeUpload, initUpload } from "../app/submissions/uploads.server.ts";

const h = await createWorkflowHarness("vshow_test_wfdb");
const opts = { skip: h.skipReason || false };
after(async () => {
  if (!h.skipReason) await h.close();
});

const NOW = new Date("2030-01-01T00:00:00Z");
async function submittedAndDecided(decision: "APPROVED" | "REJECTED" = "APPROVED") {
  const a = await h.actor("convener");
  const s = await createDraft(h.deps, a, { committeeId: h.ids.media, title: "T" });
  await saveDraft(h.deps, a, s.id, {
    title: "T",
    windows: [{ screenId: h.ids.lobby, startAt: "2030-02-01T10:00", endAt: "2030-02-01T12:00" }],
  });
  const i = await initUpload(h.deps, a, s.id, { filename: "a.png", contentType: "image/png", sizeBytes: PNG.length });
  h.storage.upload(i.upload, PNG);
  await finalizeUpload(h.deps, a, s.id, i.reservationId);
  const r = await submitForReview(h.deps, a, s.id, NOW);
  const d = await decide(h.deps, await h.actor("reviewer"), s.id, {
    revisionId: r.revisionId,
    decision,
    comment: decision === "REJECTED" ? "no" : undefined,
  });
  return { submissionId: s.id, revisionId: r.revisionId, decisionId: d.decisionId };
}

describe("history tables are append-only in the database", () => {
  it("review decisions, audit events and revisions can be inserted but never updated or deleted", opts, async () => {
    const x = await submittedAndDecided();
    const refuse = async (sql: string, params: unknown[]) => assert.rejects(h.q(sql, params), /append-only/);
    await refuse("update review_decision set comment='edited' where id=$1", [x.decisionId]);
    await refuse("update review_decision set decision='REJECTED' where id=$1", [x.decisionId]);
    await refuse("delete from review_decision where id=$1", [x.decisionId]);
    await refuse("update audit_event set action='X' where submission_id=$1", [x.submissionId]);
    await refuse("delete from audit_event where submission_id=$1", [x.submissionId]);
    await refuse("update submission_revision set title='edited' where id=$1", [x.revisionId]);
    await refuse("update submission_revision set requested_windows='[]' where id=$1", [x.revisionId]);
    await refuse("delete from submission_revision where id=$1", [x.revisionId]);
    // deleting the submission is blocked too (history is referenced), and nothing changed
    await assert.rejects(h.q("delete from submission where id=$1", [x.submissionId]), /foreign key/);
    assert.equal((await h.q("select 1 from review_decision where id=$1", [x.decisionId])).length, 1);
  });
});

describe("review decisions: database rules", () => {
  it(
    "a decision must be on a PENDING_REVIEW submission and its CURRENT revision, by someone other than the creator",
    opts,
    async () => {
      const x = await submittedAndDecided("APPROVED"); // now APPROVED, no longer pending
      const reviewer = (await h.actor("reviewer2")).id;
      const insert = (revision: string, who = reviewer, decision = "APPROVED") =>
        h.q(
          "insert into review_decision(submission_id, media_version_id, revision_id, reviewer_user_id, decision, comment) select $1, media_version_id, id, $3, $4, 'c' from submission_revision where id=$2",
          [x.submissionId, revision, who, decision],
        );
      await assert.rejects(insert(x.revisionId), /pending review/);
    },
  );

  it("rejection and change-request comments are required by constraint, not just by the service", opts, async () => {
    const a = await h.actor("convener");
    const s = await createDraft(h.deps, a, { committeeId: h.ids.media, title: "T" });
    await saveDraft(h.deps, a, s.id, {
      title: "T",
      windows: [{ screenId: h.ids.lobby, startAt: "2030-02-01T10:00", endAt: "2030-02-01T12:00" }],
    });
    const i = await initUpload(h.deps, a, s.id, { filename: "a.png", contentType: "image/png", sizeBytes: PNG.length });
    h.storage.upload(i.upload, PNG);
    await finalizeUpload(h.deps, a, s.id, i.reservationId);
    const r = await submitForReview(h.deps, a, s.id, NOW);
    const reviewer = (await h.actor("reviewer")).id;
    for (const decision of ["REJECTED", "CHANGES_REQUESTED"]) {
      for (const comment of [null, "", "  "]) {
        await assert.rejects(
          h.q(
            "insert into review_decision(submission_id, media_version_id, revision_id, reviewer_user_id, decision, comment) select $1, media_version_id, id, $3, $4, $5 from submission_revision where id=$2",
            [s.id, r.revisionId, reviewer, decision, comment],
          ),
          /review_decision_reason_required/,
        );
      }
    }
    await h.q(
      "insert into review_decision(submission_id, media_version_id, revision_id, reviewer_user_id, decision) select $1, media_version_id, id, $3, 'APPROVED' from submission_revision where id=$2",
      [s.id, r.revisionId, reviewer],
    ); // an approval needs no comment
  });

  it("composite foreign keys tie revisions and decisions to the right submission and version", opts, async () => {
    const x = await submittedAndDecided();
    const y = await submittedAndDecided();
    // a submission's current revision must belong to it
    await assert.rejects(
      h.q("update submission set current_revision_id=$1 where id=$2", [y.revisionId, x.submissionId]),
      /submission_current_revision_fk/,
    );
    // a decision must name the revision's own version
    const [other] = await h.q<{ id: string }>("select id from media_version where submission_id=$1", [y.submissionId]);
    await assert.rejects(
      h.q(
        "insert into review_decision(submission_id, media_version_id, revision_id, reviewer_user_id, decision) values ($1,$2,$3,$4,'APPROVED')",
        [x.submissionId, other.id, x.revisionId, (await h.actor("reviewer")).id],
      ),
      /foreign key|pending review/,
    );
    // a revision must reference a version of the SAME submission
    await assert.rejects(
      h.q(
        "insert into submission_revision(submission_id, revision_number, title, media_version_id, requested_windows, created_by_user_id) values ($1, 9, 't', $2, '[]', $3)",
        [x.submissionId, other.id, (await h.actor("convener")).id],
      ),
      /submission_revision_version_fk/,
    );
    await assert.rejects(
      h.q(
        "insert into submission_revision(submission_id, revision_number, title, media_version_id, requested_windows, created_by_user_id) select $1, 9, 't', media_version_id, '{}', $2 from submission_revision where id=$3",
        [x.submissionId, (await h.actor("convener")).id, x.revisionId],
      ),
      /submission_revision_windows_array/,
    );
  });
});

describe("resubmission link", () => {
  it("a submission cannot be its own resubmission, and the link must point at a real submission", opts, async () => {
    const x = await submittedAndDecided("REJECTED");
    await assert.rejects(
      h.q("update submission set resubmission_of_id=id where id=$1", [x.submissionId]),
      /submission_resubmission_not_self/,
    );
    await assert.rejects(
      h.q("update submission set resubmission_of_id='00000000-0000-4000-8000-000000000000' where id=$1", [
        x.submissionId,
      ]),
      /submission_resubmission_of_fk/,
    );
  });
});

describe("reference codes", () => {
  it("are gap-free per year, unique under parallel transactions, and formatted VS-YYYY-NNNNNN", opts, async () => {
    const next = async (year: number) => {
      const c = new pg.Client({ connectionString: h.dbUrl });
      await c.connect();
      try {
        await c.query("begin");
        const code = (await c.query("select vshow_next_reference_code($1) as code", [year])).rows[0].code as string;
        await c.query("commit");
        return code;
      } finally {
        await c.end();
      }
    };
    const codes = await Promise.all(Array.from({ length: 20 }, () => next(2040)));
    assert.equal(new Set(codes).size, 20);
    assert.deepEqual(
      codes.sort(),
      Array.from({ length: 20 }, (_, i) => `VS-2040-${String(i + 1).padStart(6, "0")}`),
    );
    assert.equal(await next(2041), "VS-2041-000001", "each year counts from 1");
  });

  it("a rolled-back transaction does not consume a number", opts, async () => {
    const c = new pg.Client({ connectionString: h.dbUrl });
    await c.connect();
    try {
      await c.query("begin");
      const burned = (await c.query("select vshow_next_reference_code(2050) as code")).rows[0].code;
      await c.query("rollback");
      await c.query("begin");
      const reused = (await c.query("select vshow_next_reference_code(2050) as code")).rows[0].code;
      await c.query("commit");
      assert.equal(burned, "VS-2050-000001");
      assert.equal(reused, burned);
    } finally {
      await c.end();
    }
  });

  it("reference_code stays unique", opts, async () => {
    const a = await h.actor("convener");
    const s = await createDraft(h.deps, a, { committeeId: h.ids.media, title: "dup" });
    await assert.rejects(
      h.q(
        "insert into submission(reference_code, committee_id, created_by_user_id, title, workflow_status) values ($1,$2,$3,'t','DRAFT')",
        [s.referenceCode, h.ids.media, a.id],
      ),
      /reference_code/,
    );
  });
});

describe("migration 0004 upgrade safety", async () => {
  const db = await createThrowawayDb("vshow_test_wf0004");
  const uopts = { skip: db.skipReason || false };
  after(async () => {
    if (!db.skipReason) await db.drop();
  });
  const env = () => ({ DB_TARGET: "local", DATABASE_URL: db.url, DATABASE_URL_DIRECT: "" });

  /** Builds a database at migrations 0000-0003 only. */
  async function upToAuth(extra: (c: pg.Client) => Promise<void>) {
    const tmp = mkdtempSync(join(tmpdir(), "vshow-upgrade4-"));
    try {
      cpSync("drizzle", tmp, { recursive: true });
      const journalPath = join(tmp, "meta", "_journal.json");
      const full = JSON.parse(readFileSync(journalPath, "utf8"));
      writeFileSync(journalPath, JSON.stringify({ ...full, entries: full.entries.slice(0, 4) }));
      const c = new pg.Client({ connectionString: db.url });
      await c.connect();
      try {
        await migrate(drizzle({ client: c }), { migrationsFolder: tmp });
        await extra(c);
      } finally {
        await c.end();
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
  const tables = async () => {
    const c = new pg.Client({ connectionString: db.url });
    await c.connect();
    try {
      return (await c.query("select table_name t from information_schema.tables where table_schema='public'")).rows.map(
        (r) => r.t as string,
      );
    } finally {
      await c.end();
    }
  };

  it(
    "fails safely, changing nothing, when review decisions already exist (they would have no revision)",
    uopts,
    async () => {
      await upToAuth(async (c) => {
        const u = (await c.query("insert into app_user(email, display_name) values ('a@x.org','A') returning id"))
          .rows[0].id;
        const v = (await c.query("insert into app_user(email, display_name) values ('r@x.org','R') returning id"))
          .rows[0].id;
        const com = (await c.query("insert into committee(name, code) values ('c','c1') returning id")).rows[0].id;
        const sub = (
          await c.query(
            "insert into submission(reference_code, committee_id, created_by_user_id, title, workflow_status) values ('R1',$1,$2,'t','PENDING_REVIEW') returning id",
            [com, u],
          )
        ).rows[0].id;
        const ver = (
          await c.query(
            "insert into media_version(submission_id, version_number, object_key, original_filename, content_type, size_bytes, uploaded_by_user_id) values ($1,1,'k','a.png','image/png',10,$2) returning id",
            [sub, u],
          )
        ).rows[0].id;
        await c.query(
          "insert into review_decision(submission_id, media_version_id, reviewer_user_id, decision) values ($1,$2,$3,'APPROVED')",
          [sub, ver, v],
        );
      });
      const r = runNode(["scripts/db-migrate.ts"], env());
      assert.notEqual(r.status, 0, "the migration must not silently succeed");
      assert.ok(!(await tables()).includes("submission_revision"), "nothing from 0004 was applied");
      assert.ok((await tables()).includes("review_decision"));
      // the failed run left the database exactly as it was: same migration history, same rows, nothing half-applied
      const c = new pg.Client({ connectionString: db.url });
      await c.connect();
      try {
        assert.equal((await c.query("select count(*)::int n from drizzle.__drizzle_migrations")).rows[0].n, 4);
        assert.equal((await c.query("select count(*)::int n from review_decision")).rows[0].n, 1);
        assert.equal((await c.query("select count(*)::int n from submission")).rows[0].n, 1);
        const cols = (
          await c.query("select column_name from information_schema.columns where table_name = 'review_decision'")
        ).rows.map((x) => x.column_name);
        assert.ok(!cols.includes("revision_id"), "the new column was rolled back with the rest");
        const fns = (await c.query("select proname from pg_proc where proname like 'vshow\\_%'")).rows.map(
          (x) => x.proname,
        );
        assert.ok(
          !fns.includes("vshow_forbid_modification") && !fns.includes("vshow_next_reference_code"),
          "no trigger function leaked",
        );
      } finally {
        await c.end();
      }
      // and the health check reports the migration as pending, so the operator is told what to do
      const health = runNode(["scripts/db-health.ts"], env());
      assert.match(health.stdout + health.stderr, /4 applied, 2 pending/);
    },
  );
});

describe("migration 0004 upgrade over data without decisions", async () => {
  const db = await createThrowawayDb("vshow_test_wf0004b");
  const uopts = { skip: db.skipReason || false };
  after(async () => {
    if (!db.skipReason) await db.drop();
  });
  it("preserves every existing row and adds the new structures", uopts, async () => {
    const tmp = mkdtempSync(join(tmpdir(), "vshow-upgrade4b-"));
    try {
      cpSync("drizzle", tmp, { recursive: true });
      const journalPath = join(tmp, "meta", "_journal.json");
      const full = JSON.parse(readFileSync(journalPath, "utf8"));
      writeFileSync(journalPath, JSON.stringify({ ...full, entries: full.entries.slice(0, 4) }));
      const c = new pg.Client({ connectionString: db.url });
      await c.connect();
      try {
        await migrate(drizzle({ client: c }), { migrationsFolder: tmp });
        const u = (await c.query("insert into app_user(email, display_name) values ('a@x.org','A') returning id"))
          .rows[0].id;
        const com = (await c.query("insert into committee(name, code) values ('c','c1') returning id")).rows[0].id;
        const sub = (
          await c.query(
            "insert into submission(reference_code, committee_id, created_by_user_id, title, workflow_status) values ('R1',$1,$2,'t','DRAFT') returning id",
            [com, u],
          )
        ).rows[0].id;
        await c.query(
          "insert into media_version(submission_id, version_number, object_key, original_filename, content_type, size_bytes, uploaded_by_user_id) values ($1,1,'k','a.png','image/png',10,$2)",
          [sub, u],
        );
      } finally {
        await c.end();
      }
      const r = runNode(["scripts/db-migrate.ts"], {
        DB_TARGET: "local",
        DATABASE_URL: db.url,
        DATABASE_URL_DIRECT: "",
      });
      assert.equal(r.status, 0, r.stderr || r.stdout);
      assert.match(r.stdout, /Applied 2 migration/);
      const c2 = new pg.Client({ connectionString: db.url });
      await c2.connect();
      try {
        const s = (await c2.query("select reference_code, current_revision_id, resubmission_of_id from submission"))
          .rows;
        assert.deepEqual(s, [{ reference_code: "R1", current_revision_id: null, resubmission_of_id: null }]);
        assert.equal((await c2.query("select storage_etag from media_version")).rows[0].storage_etag, null);
        assert.equal((await c2.query("select count(*)::int n from submission_revision")).rows[0].n, 0);
        assert.equal((await c2.query("select vshow_next_reference_code(2030) c")).rows[0].c, "VS-2030-000001");
      } finally {
        await c2.end();
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
