// The convener -> reviewer workflow against a REAL migrated database: authorization, the state machine, requested
// windows (overlaps are allowed), revisions, review decisions, approval invalidation, resubmission and concurrency.
// Storage is the in-memory fake; nothing here touches the network or the developer's database.
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { WorkflowError, type WorkflowErrorCode } from "../app/submissions/errors.ts";
import { decide } from "../app/submissions/reviews.server.ts";
import { isHandoffEligible } from "../app/submissions/queries.server.ts";
import { createDraft, saveDraft, submitForReview } from "../app/submissions/submissions.server.ts";
import { finalizeUpload, initUpload } from "../app/submissions/uploads.server.ts";
import { PNG, PNG2, createWorkflowHarness, type PersonKey } from "./support/workflow-harness.ts";

const h = await createWorkflowHarness("vshow_test_wfsvc");
const opts = { skip: h.skipReason || false };
after(async () => {
  if (!h.skipReason) await h.close();
});

const NOW = new Date("2030-01-01T00:00:00Z");
const win = (screenId: string, start = "2030-02-01T10:00", end = "2030-02-01T12:00", note?: string) => ({
  screenId,
  startAt: start,
  endAt: end,
  note,
});

async function expectCode(p: Promise<unknown>, code: WorkflowErrorCode) {
  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof WorkflowError, `expected WorkflowError(${code}), got ${String(e)}`);
    assert.equal(e.code, code);
    return true;
  });
}

async function newDraft(who: PersonKey = "convener", title = "Poster") {
  const a = await h.actor(who);
  return createDraft(h.deps, a, { committeeId: h.ids.media, title, description: "Synthetic" });
}
async function addMedia(who: PersonKey, submissionId: string, bytes = PNG, type = "image/png") {
  const a = await h.actor(who);
  const init = await initUpload(h.deps, a, submissionId, {
    filename: "my poster.png",
    contentType: type,
    sizeBytes: bytes.length,
  });
  h.storage.upload(init.upload, bytes);
  return finalizeUpload(h.deps, a, submissionId, init.reservationId);
}
async function ready(who: PersonKey = "convener", windows = [win(h.ids.lobby)]) {
  const s = await newDraft(who);
  await saveDraft(h.deps, await h.actor(who), s.id, { title: "Poster", description: "Synthetic", windows });
  await addMedia(who, s.id);
  return s.id;
}
async function submitted(who: PersonKey = "convener") {
  const id = await ready(who);
  const r = await submitForReview(h.deps, await h.actor(who), id, NOW);
  return { id, ...r };
}
const status = async (id: string) =>
  (await h.q<{ s: string }>("select workflow_status s from submission where id=$1", [id]))[0].s;
const count = async (table: string, id: string, col = "submission_id") =>
  (await h.q<{ n: number }>(`select count(*)::int n from ${table} where ${col}=$1`, [id]))[0].n;
const actions = async (id: string) =>
  (
    await h.q<{ action: string }>("select action from audit_event where submission_id=$1 order by created_at, id", [id])
  ).map((r) => r.action);

describe("creating drafts: committee ownership and roles", () => {
  it("a convener creates a DRAFT with a VS-YYYY-NNNNNN reference code and an audit event", opts, async () => {
    const s = await newDraft();
    assert.equal(s.workflowStatus, "DRAFT");
    assert.match(s.referenceCode, /^VS-\d{4}-\d{6}$/);
    assert.deepEqual(await actions(s.id), ["SUBMISSION_CREATED"]);
  });

  it("only an active CONVENER with an active membership in THAT committee may create", opts, async () => {
    const create = async (who: PersonKey, committeeId = h.ids.media) =>
      createDraft(h.deps, await h.actor(who), { committeeId, title: "x" });
    await expectCode(create("convenerOther"), "forbidden"); // another committee
    await expectCode(create("lapsed"), "forbidden"); // membership no longer active
    await expectCode(create("member"), "forbidden"); // member without the CONVENER role
    await expectCode(create("reviewer"), "forbidden");
    await expectCode(create("manager"), "forbidden");
    await expectCode(create("admin"), "forbidden"); // admin does not inherit operational roles
    await expectCode(create("unassigned"), "forbidden");
    await expectCode(create("convener", h.ids.robotics), "forbidden");
  });

  it("any active convener of the committee may manage its submissions, others get 'not found'", opts, async () => {
    const s = await newDraft("convener");
    const save = async (who: PersonKey) =>
      saveDraft(h.deps, await h.actor(who), s.id, { title: "Edited", windows: [] });
    const ok = await save("convener2");
    assert.equal(ok.changed, true);
    for (const who of ["convenerOther", "lapsed", "member", "reviewer", "admin", "unassigned"] as PersonKey[]) {
      await expectCode(save(who), "not_found");
    }
    assert.equal((await h.q<{ title: string }>("select title from submission where id=$1", [s.id]))[0].title, "Edited");
  });
});

describe("requested windows (overlaps are allowed)", () => {
  it("expands an All screens window to every ACTIVE screen, and stores all-day times as given", opts, async () => {
    const s = await newDraft();
    const a = await h.actor("convener");
    await saveDraft(h.deps, a, s.id, {
      title: "Poster",
      windows: [{ screenId: "ALL", startAt: "2030-02-01T00:00", endAt: "2030-02-03T23:59", note: "all" }],
    });
    const rows = await h.q<{ screen: string; start: string; end: string }>(
      "select s.code screen, to_char(r.preferred_start_at at time zone 'Asia/Kolkata','YYYY-MM-DD HH24:MI') start, to_char(r.preferred_end_at at time zone 'Asia/Kolkata','YYYY-MM-DD HH24:MI') \"end\" from screen_request r join screen s on s.id=r.screen_id where r.submission_id=$1 order by s.code",
      [s.id],
    );
    assert.deepEqual(
      rows.map((r) => `${r.screen} ${r.start} -> ${r.end}`),
      ["canteen 2030-02-01 00:00 -> 2030-02-03 23:59", "lobby 2030-02-01 00:00 -> 2030-02-03 23:59"],
      "the inactive library screen is not included",
    );
  });

  it("still rejects an unknown screen id, and an invalid window beside an All screens one", opts, async () => {
    const s = await newDraft();
    const a = await h.actor("convener");
    await assert.rejects(
      saveDraft(h.deps, a, s.id, { title: "Poster", windows: [win("00000000-0000-4000-8000-000000000000")] }),
      (e: unknown) => e instanceof WorkflowError && e.code === "validation_failed",
    );
    await assert.rejects(
      saveDraft(h.deps, a, s.id, {
        title: "Poster",
        windows: [{ screenId: "ALL", startAt: "2030-02-02T10:00", endAt: "2030-02-01T10:00" }],
      }),
      (e: unknown) => e instanceof WorkflowError && e.code === "validation_failed",
    );
  });

  it(
    "accepts identical and overlapping windows, on the same screen and across screens, and numbers slots per screen",
    opts,
    async () => {
      const s = await newDraft();
      const a = await h.actor("convener");
      const same = win(h.ids.lobby, "2030-02-01T10:00", "2030-02-01T12:00");
      await saveDraft(h.deps, a, s.id, {
        title: "Poster",
        windows: [
          same,
          same,
          win(h.ids.lobby, "2030-02-01T11:00", "2030-02-01T13:00"),
          win(h.ids.canteen, "2030-02-01T10:00", "2030-02-01T12:00"),
        ],
      });
      const rows = await h.q<{ screen: string; slot_number: number }>(
        "select s.code screen, r.slot_number from screen_request r join screen s on s.id=r.screen_id where r.submission_id=$1 order by s.code, r.slot_number",
        [s.id],
      );
      assert.deepEqual(
        rows.map((r) => `${r.screen}#${r.slot_number}`),
        ["canteen#1", "lobby#1", "lobby#2", "lobby#3"],
      );
    },
  );

  it("overlaps are accepted at submission and review too", opts, async () => {
    const id = await ready("convener", [
      win(h.ids.lobby),
      win(h.ids.lobby),
      win(h.ids.lobby, "2030-02-01T11:00", "2030-02-01T11:30"),
    ]);
    const sub = await submitForReview(h.deps, await h.actor("convener"), id, NOW);
    const r = await decide(h.deps, await h.actor("reviewer"), id, { revisionId: sub.revisionId, decision: "APPROVED" });
    assert.equal(r.submission.workflowStatus, "APPROVED");
  });

  it(
    "rejects invalid timestamps, an end that is not after the start, too many windows, and unavailable screens",
    opts,
    async () => {
      const s = await newDraft();
      const a = await h.actor("convener");
      const save = (windows: unknown[]) => saveDraft(h.deps, a, s.id, { title: "x", windows });
      const issues = async (windows: unknown[]) => {
        try {
          await save(windows);
        } catch (e) {
          assert.ok(e instanceof WorkflowError && e.code === "validation_failed");
          return e.issues.map((i) => `${i.path}:${i.code}`);
        }
        assert.fail("expected a validation failure");
      };
      assert.deepEqual(await issues([win(h.ids.lobby, "not a date", "2030-02-01T12:00")]), [
        "windows.0.startAt:invalid_datetime",
      ]);
      assert.deepEqual(await issues([win(h.ids.lobby, "2030-02-31T10:00", "2030-03-01T12:00")]), [
        "windows.0.startAt:invalid_datetime",
      ]);
      assert.deepEqual(await issues([win(h.ids.lobby, "2030-02-01T12:00", "2030-02-01T12:00")]), [
        "windows.0.endAt:end_not_after_start",
      ]);
      assert.deepEqual(await issues([win(h.ids.lobby, "2030-02-01T12:00", "2030-02-01T11:00")]), [
        "windows.0.endAt:end_not_after_start",
      ]);
      assert.deepEqual(await issues([win(h.ids.library)]), ["windows.0.screenId:screen_unavailable"]); // inactive screen
      assert.deepEqual(await issues([win("00000000-0000-4000-8000-000000000000")]), [
        "windows.0.screenId:screen_unavailable",
      ]);
      assert.deepEqual(await issues(Array.from({ length: 11 }, () => win(h.ids.lobby))), ["windows:too_many_windows"]);
      await save(Array.from({ length: 10 }, () => win(h.ids.lobby))); // the default limit is exactly 10
      h.setMedia({ maxWindows: 2 }); // configurable
      assert.deepEqual(await issues([win(h.ids.lobby), win(h.ids.lobby), win(h.ids.lobby)]), [
        "windows:too_many_windows",
      ]);
      h.setMedia({ maxWindows: 10 });
    },
  );

  it("zone-less times are Asia/Kolkata; the start must be in the future at SUBMISSION, not at save", opts, async () => {
    const s = await newDraft();
    const a = await h.actor("convener");
    await saveDraft(h.deps, a, s.id, {
      title: "x",
      windows: [win(h.ids.lobby, "2030-02-01T10:00", "2030-02-01T12:00")],
    });
    const [r] = await h.q<{ s: Date }>("select preferred_start_at s from screen_request where submission_id=$1", [
      s.id,
    ]);
    assert.equal(r.s.toISOString(), "2030-02-01T04:30:00.000Z", "10:00 IST is 04:30 UTC");
    await addMedia("convener", s.id);
    // 'now' is after the window's start: refused, and nothing was submitted
    await assert.rejects(submitForReview(h.deps, a, s.id, new Date("2030-02-01T04:30:00Z")), (e: unknown) => {
      assert.ok(e instanceof WorkflowError);
      assert.deepEqual(e.issues, [{ path: "windows.0.startAt", code: "start_not_in_future" }]);
      return true;
    });
    assert.equal(await status(s.id), "DRAFT");
    assert.equal(await count("submission_revision", s.id), 0);
    await submitForReview(h.deps, a, s.id, new Date("2030-02-01T04:29:59Z")); // one second earlier is fine
  });
});

describe("submitting for review", () => {
  it("needs media and at least one window", opts, async () => {
    const a = await h.actor("convener");
    const bare = await newDraft();
    await assert.rejects(submitForReview(h.deps, a, bare.id, NOW), (e: unknown) => {
      assert.ok(e instanceof WorkflowError);
      assert.deepEqual(e.issues.map((i) => i.code).sort(), ["media_required", "window_required"]);
      return true;
    });
    assert.equal(await status(bare.id), "DRAFT");
  });

  it(
    "creates an immutable revision snapshot and moves to PENDING_REVIEW with an audit event, atomically",
    opts,
    async () => {
      const id = await ready("convener", [
        win(h.ids.lobby),
        win(h.ids.canteen, "2030-03-01T10:00", "2030-03-01T11:00", "evening"),
      ]);
      const r = await submitForReview(h.deps, await h.actor("convener"), id, NOW);
      assert.equal(r.revisionNumber, 1);
      assert.equal(await status(id), "PENDING_REVIEW");
      const [rev] = await h.q<{
        title: string;
        media_version_id: string;
        requested_windows: Array<{ slotNumber: number; note: string | null }>;
      }>("select title, media_version_id, requested_windows from submission_revision where id=$1", [r.revisionId]);
      assert.equal(rev.title, "Poster");
      assert.equal(rev.requested_windows.length, 2);
      assert.ok(rev.requested_windows.some((w) => w.note === "evening"));
      const [sub] = await h.q<{ current_revision_id: string; current_version_id: string; submitted_at: Date | null }>(
        "select current_revision_id, current_version_id, submitted_at from submission where id=$1",
        [id],
      );
      assert.equal(sub.current_revision_id, r.revisionId);
      assert.equal(sub.current_version_id, rev.media_version_id);
      assert.ok(sub.submitted_at);
      assert.deepEqual(await actions(id), [
        "SUBMISSION_CREATED",
        "SUBMISSION_UPDATED",
        "MEDIA_VERSION_UPLOADED",
        "SUBMISSION_SUBMITTED",
      ]);
    },
  );

  it("freezes what was reviewed: later edits never change an existing revision", opts, async () => {
    const { id, revisionId } = await submitted();
    const before = await h.q("select title, requested_windows from submission_revision where id=$1", [revisionId]);
    await expectCode(
      saveDraft(h.deps, await h.actor("convener"), id, { title: "Sneaky", windows: [] }),
      "invalid_state",
    );
    assert.deepEqual(
      await h.q("select title, requested_windows from submission_revision where id=$1", [revisionId]),
      before,
    );
  });
});

describe("every illegal action in every state", () => {
  it("a PENDING_REVIEW submission can be neither edited, uploaded to, re-submitted nor withdrawn", opts, async () => {
    const { id } = await submitted();
    const a = await h.actor("convener");
    await expectCode(saveDraft(h.deps, a, id, { title: "x", windows: [] }), "invalid_state");
    await expectCode(
      initUpload(h.deps, a, id, { filename: "a.png", contentType: "image/png", sizeBytes: 16 }),
      "invalid_state",
    );
    await expectCode(submitForReview(h.deps, a, id, NOW), "invalid_state");
    assert.equal(await status(id), "PENDING_REVIEW");
  });

  it("a reviewer cannot see or decide a DRAFT", opts, async () => {
    const id = await ready();
    await expectCode(
      decide(h.deps, await h.actor("reviewer"), id, {
        revisionId: "11111111-1111-4111-8111-111111111111",
        decision: "APPROVED",
      }),
      "not_found",
    );
  });

  it(
    "an APPROVED submission cannot be re-submitted or decided again; a decided one cannot be decided twice",
    opts,
    async () => {
      const { id, revisionId } = await submitted();
      const rv = await h.actor("reviewer");
      await decide(h.deps, rv, id, { revisionId, decision: "APPROVED" });
      await expectCode(decide(h.deps, rv, id, { revisionId, decision: "APPROVED" }), "invalid_state");
      await expectCode(
        decide(h.deps, await h.actor("reviewer2"), id, { revisionId, decision: "REJECTED", comment: "no" }),
        "invalid_state",
      );
      await expectCode(submitForReview(h.deps, await h.actor("convener"), id, NOW), "invalid_state");
    },
  );
});

describe("review decisions", () => {
  it(
    "approve / reject / request changes each set the right status and record reviewer, revision and comment",
    opts,
    async () => {
      for (const [decision, expected, comment] of [
        ["APPROVED", "APPROVED", undefined],
        ["REJECTED", "REJECTED", "Third-party branding is not allowed."],
        ["CHANGES_REQUESTED", "CHANGES_REQUESTED", "Fix the date on slide 2."],
      ] as const) {
        const { id, revisionId } = await submitted();
        const reviewer = await h.actor("reviewer");
        const r = await decide(h.deps, reviewer, id, { revisionId, decision, comment });
        assert.equal(r.submission.workflowStatus, expected);
        const [d] = await h.q<{
          reviewer_user_id: string;
          revision_id: string;
          media_version_id: string;
          comment: string | null;
        }>(
          "select reviewer_user_id, revision_id, media_version_id, comment from review_decision where submission_id=$1",
          [id],
        );
        assert.equal(d.reviewer_user_id, reviewer.id);
        assert.equal(d.revision_id, revisionId);
        assert.equal(d.comment ?? undefined, comment);
        const [rev] = await h.q<{ media_version_id: string }>(
          "select media_version_id from submission_revision where id=$1",
          [revisionId],
        );
        assert.equal(d.media_version_id, rev.media_version_id, "the decision names the very version of that revision");
        const last = (await actions(id)).at(-1);
        assert.equal(
          last,
          decision === "APPROVED"
            ? "REVIEW_APPROVED"
            : decision === "REJECTED"
              ? "REVIEW_REJECTED"
              : "CHANGES_REQUESTED",
        );
      }
    },
  );

  it("a rejection reason and a change-request comment are mandatory (blank is not enough)", opts, async () => {
    const { id, revisionId } = await submitted();
    const rv = await h.actor("reviewer");
    for (const decision of ["REJECTED", "CHANGES_REQUESTED"] as const) {
      for (const comment of [undefined, "", "   \n  "]) {
        await assert.rejects(decide(h.deps, rv, id, { revisionId, decision, comment }), (e: unknown) => {
          assert.ok(e instanceof WorkflowError && e.code === "validation_failed");
          assert.deepEqual(e.issues, [{ path: "comment", code: "required" }]);
          return true;
        });
      }
    }
    assert.equal(await status(id), "PENDING_REVIEW");
    assert.equal(await count("review_decision", id), 0);
  });

  it("reviewers are global: a reviewer decides on submissions of any committee", opts, async () => {
    const a = await h.actor("convenerOther");
    const s = await createDraft(h.deps, a, { committeeId: h.ids.robotics, title: "Robotics" });
    await saveDraft(h.deps, a, s.id, { title: "Robotics", windows: [win(h.ids.canteen)] });
    await addMedia("convenerOther", s.id);
    const r = await submitForReview(h.deps, a, s.id, NOW);
    const out = await decide(h.deps, await h.actor("reviewer"), s.id, {
      revisionId: r.revisionId,
      decision: "APPROVED",
    });
    assert.equal(out.submission.workflowStatus, "APPROVED");
  });

  it("only users with the REVIEWER role may decide; convener, manager, admin and unassigned cannot", opts, async () => {
    const { id, revisionId } = await submitted();
    for (const who of ["convener", "convener2", "manager", "admin", "unassigned", "member", "lapsed"] as PersonKey[]) {
      await expectCode(decide(h.deps, await h.actor(who), id, { revisionId, decision: "APPROVED" }), "not_found");
    }
    assert.equal(await status(id), "PENDING_REVIEW");
  });

  it(
    "a person who is both convener and reviewer cannot decide on their own submission, in the service or the database",
    opts,
    async () => {
      const { id, revisionId } = await submitted("both");
      const both = await h.actor("both");
      await expectCode(decide(h.deps, both, id, { revisionId, decision: "APPROVED" }), "own_submission");
      // the database refuses the same thing independently of the service
      await assert.rejects(
        h.q(
          "insert into review_decision(submission_id, media_version_id, revision_id, reviewer_user_id, decision) select $1, media_version_id, id, $3, 'APPROVED' from submission_revision where id=$2",
          [id, revisionId, both.id],
        ),
        /cannot decide on their own submission/,
      );
      // another reviewer can
      await decide(h.deps, await h.actor("reviewer"), id, { revisionId, decision: "APPROVED" });
    },
  );

  it(
    "a colleague's submission can be reviewed by a person who is also a convener of the same committee",
    opts,
    async () => {
      const { id, revisionId } = await submitted("convener");
      const r = await decide(h.deps, await h.actor("both"), id, { revisionId, decision: "APPROVED" });
      assert.equal(r.submission.workflowStatus, "APPROVED");
    },
  );
});

describe("revisions: approval is tied to the exact reviewed state", () => {
  it(
    "changes requested -> edit -> resubmit creates revision 2; revision 1 and its decision remain; fresh approval is needed",
    opts,
    async () => {
      const { id, revisionId: r1 } = await submitted();
      const rv = await h.actor("reviewer");
      await decide(h.deps, rv, id, { revisionId: r1, decision: "CHANGES_REQUESTED", comment: "Shorten the intro." });
      const a = await h.actor("convener");
      await saveDraft(h.deps, a, id, { title: "Poster v2", windows: [win(h.ids.lobby)] });
      assert.equal(
        await status(id),
        "CHANGES_REQUESTED",
        "editing during changes-requested keeps the status until resubmission",
      );
      const r2 = await submitForReview(h.deps, a, id, NOW);
      assert.equal(r2.revisionNumber, 2);
      assert.equal(await status(id), "PENDING_REVIEW");
      assert.equal(await count("submission_revision", id), 2);
      assert.equal(await count("review_decision", id), 1, "the earlier decision is preserved");
      const [old] = await h.q<{ title: string }>("select title from submission_revision where id=$1", [r1]);
      assert.equal(old.title, "Poster");
      assert.equal(await isHandoffEligible(h.deps.database.get(), id), false);
      await decide(h.deps, rv, id, { revisionId: r2.revisionId, decision: "APPROVED" });
      assert.equal(await isHandoffEligible(h.deps.database.get(), id), true);
    },
  );

  it(
    "a stale decision (an older revision) is refused and can never make the newer revision eligible",
    opts,
    async () => {
      const { id, revisionId: r1 } = await submitted();
      await decide(h.deps, await h.actor("reviewer"), id, {
        revisionId: r1,
        decision: "CHANGES_REQUESTED",
        comment: "fix",
      });
      const a = await h.actor("convener");
      const r2 = await submitForReview(h.deps, a, id, NOW);
      // a reviewer who still has revision 1 open tries to approve it
      await expectCode(
        decide(h.deps, await h.actor("reviewer2"), id, { revisionId: r1, decision: "APPROVED" }),
        "stale_revision",
      );
      assert.equal(await status(id), "PENDING_REVIEW");
      assert.equal(await isHandoffEligible(h.deps.database.get(), id), false);
      // and the database backstop refuses it too
      const rv2 = await h.actor("reviewer2");
      await assert.rejects(
        h.q(
          "insert into review_decision(submission_id, media_version_id, revision_id, reviewer_user_id, decision) select $1, media_version_id, id, $3, 'APPROVED' from submission_revision where id=$2",
          [id, r1, rv2.id],
        ),
        /current revision/,
      );
      await decide(h.deps, rv2, id, { revisionId: r2.revisionId, decision: "APPROVED" });
    },
  );

  it(
    "editing an approved submission withdraws the approval; the old approval never covers the new revision",
    opts,
    async () => {
      const { id, revisionId: r1 } = await submitted();
      await decide(h.deps, await h.actor("reviewer"), id, { revisionId: r1, decision: "APPROVED" });
      assert.equal(await isHandoffEligible(h.deps.database.get(), id), true);
      const a = await h.actor("convener");
      const edit = await saveDraft(h.deps, a, id, { title: "Poster, new title", windows: [win(h.ids.lobby)] });
      assert.equal(edit.approvalInvalidated, true);
      assert.equal(await status(id), "DRAFT");
      assert.equal(await isHandoffEligible(h.deps.database.get(), id), false);
      assert.ok((await actions(id)).includes("APPROVAL_INVALIDATED"));
      const r2 = await submitForReview(h.deps, a, id, NOW);
      assert.notEqual(r2.revisionId, r1);
      assert.equal(
        await isHandoffEligible(h.deps.database.get(), id),
        false,
        "pending, and the old approval does not count",
      );
      assert.equal(await count("review_decision", id), 1, "the original approval is preserved as history");
    },
  );

  it("an edit that changes nothing does not withdraw the approval or write an audit event", opts, async () => {
    const { id, revisionId } = await submitted();
    await decide(h.deps, await h.actor("reviewer"), id, { revisionId, decision: "APPROVED" });
    const before = (await actions(id)).length;
    const r = await saveDraft(h.deps, await h.actor("convener"), id, {
      title: "Poster",
      description: "Synthetic",
      windows: [win(h.ids.lobby)],
    });
    assert.equal(r.changed, false);
    assert.equal(await status(id), "APPROVED");
    assert.equal((await actions(id)).length, before);
  });

  it("every approval-relevant change (title, description, windows, media) invalidates the approval", opts, async () => {
    const edits: Array<(id: string, a: Awaited<ReturnType<typeof h.actor>>) => Promise<unknown>> = [
      (id, a) =>
        saveDraft(h.deps, a, id, { title: "Different", description: "Synthetic", windows: [win(h.ids.lobby)] }),
      (id, a) => saveDraft(h.deps, a, id, { title: "Poster", description: "Different", windows: [win(h.ids.lobby)] }),
      (id, a) => saveDraft(h.deps, a, id, { title: "Poster", description: "Synthetic", windows: [win(h.ids.canteen)] }),
      (id, a) =>
        saveDraft(h.deps, a, id, {
          title: "Poster",
          description: "Synthetic",
          windows: [win(h.ids.lobby, "2030-02-01T10:00", "2030-02-01T13:00")],
        }),
      (id, a) =>
        saveDraft(h.deps, a, id, {
          title: "Poster",
          description: "Synthetic",
          windows: [win(h.ids.lobby), win(h.ids.lobby)],
        }),
      (id, a) =>
        saveDraft(h.deps, a, id, {
          title: "Poster",
          description: "Synthetic",
          windows: [win(h.ids.lobby, "2030-02-01T10:00", "2030-02-01T12:00", "a note")],
        }),
      async (id) => addMedia("convener", id, PNG2),
    ];
    for (const edit of edits) {
      const { id, revisionId } = await submitted();
      await decide(h.deps, await h.actor("reviewer"), id, { revisionId, decision: "APPROVED" });
      await edit(id, await h.actor("convener"));
      assert.equal(await status(id), "DRAFT");
      assert.equal(await isHandoffEligible(h.deps.database.get(), id), false);
    }
  });
});

describe("rejected submissions are terminal; a resubmission is a new linked submission", () => {
  it("a rejected submission cannot be edited, uploaded to, submitted or decided again", opts, async () => {
    const { id, revisionId } = await submitted();
    await decide(h.deps, await h.actor("reviewer"), id, {
      revisionId,
      decision: "REJECTED",
      comment: "Not appropriate.",
    });
    const a = await h.actor("convener");
    await expectCode(saveDraft(h.deps, a, id, { title: "x", windows: [] }), "invalid_state");
    await expectCode(
      initUpload(h.deps, a, id, { filename: "a.png", contentType: "image/png", sizeBytes: 16 }),
      "invalid_state",
    );
    await expectCode(submitForReview(h.deps, a, id, NOW), "invalid_state");
    await expectCode(
      decide(h.deps, await h.actor("reviewer"), id, { revisionId, decision: "APPROVED" }),
      "invalid_state",
    );
    const [row] = await h.q<{ closed_at: Date | null }>("select closed_at from submission where id=$1", [id]);
    assert.ok(row.closed_at, "rejection closes the submission");
  });

  it(
    "creates a NEW submission linked to the rejected one, with no inherited media, revisions, decisions or approval",
    opts,
    async () => {
      const { id: oldId, revisionId } = await submitted();
      await decide(h.deps, await h.actor("reviewer"), oldId, {
        revisionId,
        decision: "REJECTED",
        comment: "Wrong dates.",
      });
      const snapshot = async () => ({
        rows: await h.q("select * from submission where id=$1", [oldId]),
        versions: await count("media_version", oldId),
        revisions: await count("submission_revision", oldId),
        decisions: await count("review_decision", oldId),
        audit: await count("audit_event", oldId),
      });
      const before = await snapshot();
      const a2 = await h.actor("convener2"); // any active convener of the committee may start it
      const fresh = await createDraft(h.deps, a2, {
        committeeId: h.ids.media,
        title: "Poster (corrected)",
        resubmissionOfId: oldId,
      });
      assert.notEqual(fresh.id, oldId);
      assert.equal(fresh.resubmissionOfId, oldId);
      assert.equal(fresh.workflowStatus, "DRAFT");
      assert.equal(fresh.currentVersionId, null);
      assert.equal(fresh.currentRevisionId, null);
      assert.equal(await count("media_version", fresh.id), 0, "its own version 1 needs a fresh upload");
      assert.equal(await count("submission_revision", fresh.id), 0);
      assert.equal(await count("review_decision", fresh.id), 0);
      assert.equal(await isHandoffEligible(h.deps.database.get(), fresh.id), false);
      assert.deepEqual(await snapshot(), before, "the rejected submission, its media, reviews and audit are untouched");
      // the new submission numbers its first upload as version 1
      const v = await addMedia("convener2", fresh.id);
      assert.equal(v.versionNumber, 1);
    },
  );

  it(
    "only a REJECTED submission of the same committee, that the caller may manage, can be resubmitted",
    opts,
    async () => {
      const pending = await submitted();
      const c = await h.actor("convener");
      const link = (resubmissionOfId: string, who = c, committeeId = h.ids.media) =>
        createDraft(h.deps, who, { committeeId, title: "again", resubmissionOfId });
      await expectCode(link(pending.id), "invalid_state");
      const rejected = await submitted();
      await decide(h.deps, await h.actor("reviewer"), rejected.id, {
        revisionId: rejected.revisionId,
        decision: "REJECTED",
        comment: "no",
      });
      await expectCode(link(rejected.id, await h.actor("convenerOther"), h.ids.robotics), "not_found");
      await expectCode(link("00000000-0000-4000-8000-000000000000"), "not_found");
      const created = await link(rejected.id);
      assert.equal(created.resubmissionOfId, rejected.id);
    },
  );
});

describe("concurrency", () => {
  it("two simultaneous decisions on one submission produce exactly one decision", opts, async () => {
    const { id, revisionId } = await submitted();
    const [a, b] = await Promise.allSettled([
      decide(h.deps, await h.actor("reviewer"), id, { revisionId, decision: "APPROVED" }),
      decide(h.deps, await h.actor("reviewer2"), id, { revisionId, decision: "REJECTED", comment: "no" }),
    ]);
    const outcomes = [a, b].map((r) => r.status);
    assert.deepEqual(outcomes.sort(), ["fulfilled", "rejected"]);
    const rejected = [a, b].find((r) => r.status === "rejected") as PromiseRejectedResult;
    assert.ok(rejected.reason instanceof WorkflowError && rejected.reason.code === "invalid_state");
    assert.equal(await count("review_decision", id), 1);
    const [{ d }] = await h.q<{ d: string }>("select decision d from review_decision where submission_id=$1", [id]);
    assert.equal(
      await status(id),
      d === "APPROVED" ? "APPROVED" : "REJECTED",
      "status always matches the one recorded decision",
    );
  });

  it("two simultaneous submissions create exactly one new revision", opts, async () => {
    const id = await ready();
    const a = await h.actor("convener");
    const results = await Promise.allSettled([
      submitForReview(h.deps, a, id, NOW),
      submitForReview(h.deps, a, id, NOW),
    ]);
    assert.deepEqual(results.map((r) => r.status).sort(), ["fulfilled", "rejected"]);
    assert.equal(await count("submission_revision", id), 1);
  });

  it("an edit racing a decision cannot change what the decision applied to", opts, async () => {
    const { id, revisionId } = await submitted();
    const results = await Promise.allSettled([
      decide(h.deps, await h.actor("reviewer"), id, { revisionId, decision: "APPROVED" }),
      saveDraft(h.deps, await h.actor("convener"), id, { title: "Changed in flight", windows: [win(h.ids.lobby)] }),
    ]);
    // Whichever got the lock first wins; an edit can only succeed AFTER an approval (then it withdraws it).
    const [{ s }] = await h.q<{ s: string }>("select workflow_status s from submission where id=$1", [id]);
    assert.ok(["APPROVED", "DRAFT"].includes(s), `unexpected status ${s}`);
    assert.equal(await isHandoffEligible(h.deps.database.get(), id), s === "APPROVED");
    assert.equal(results[0].status, "fulfilled");
  });

  it("concurrent draft creation never duplicates a reference code", opts, async () => {
    const a = await h.actor("convener");
    const made = await Promise.all(
      Array.from({ length: 15 }, (_, i) =>
        createDraft(h.deps, a, { committeeId: h.ids.media, title: `Parallel ${i}` }),
      ),
    );
    const codes = made.map((m) => m.referenceCode);
    assert.equal(new Set(codes).size, codes.length);
  });
});

describe("atomicity: workflow changes and their audit events succeed or fail together", () => {
  // Drizzle wraps driver errors ("Failed query"); the database's own message is on `cause`.
  const AUDIT_FAILURE = (e: unknown) =>
    /simulated audit failure/.test(String((e as { cause?: Error }).cause?.message ?? e));
  const failAudit = async (action: string) => {
    await h.q(`create or replace function t_fail_audit() returns trigger language plpgsql as $$ begin
      if new.action = '${action}' then raise exception 'simulated audit failure'; end if; return new; end $$`);
    await h.q("create trigger t_fail_audit before insert on audit_event for each row execute function t_fail_audit()");
  };
  const restore = () => h.q("drop trigger if exists t_fail_audit on audit_event");

  it("a failing audit insert rolls back a review decision (no decision, status unchanged)", opts, async () => {
    const { id, revisionId } = await submitted();
    await failAudit("REVIEW_APPROVED");
    try {
      await assert.rejects(
        decide(h.deps, await h.actor("reviewer"), id, { revisionId, decision: "APPROVED" }),
        AUDIT_FAILURE,
      );
    } finally {
      await restore();
    }
    assert.equal(await status(id), "PENDING_REVIEW");
    assert.equal(await count("review_decision", id), 0);
    assert.ok(!(await actions(id)).includes("REVIEW_APPROVED"));
    await decide(h.deps, await h.actor("reviewer"), id, { revisionId, decision: "APPROVED" }); // and it still works afterwards
  });

  it("a failing audit insert rolls back a submission (no revision, still a draft)", opts, async () => {
    const id = await ready();
    await failAudit("SUBMISSION_SUBMITTED");
    try {
      await assert.rejects(submitForReview(h.deps, await h.actor("convener"), id, NOW), AUDIT_FAILURE);
    } finally {
      await restore();
    }
    assert.equal(await status(id), "DRAFT");
    assert.equal(await count("submission_revision", id), 0);
    const [s] = await h.q<{ current_revision_id: string | null; submitted_at: Date | null }>(
      "select current_revision_id, submitted_at from submission where id=$1",
      [id],
    );
    assert.deepEqual([s.current_revision_id, s.submitted_at], [null, null]);
  });

  it("a failing audit insert rolls back draft creation, and the reference number is not consumed", opts, async () => {
    const a = await h.actor("convener");
    const first = await createDraft(h.deps, a, { committeeId: h.ids.media, title: "before" });
    await failAudit("SUBMISSION_CREATED");
    try {
      await assert.rejects(createDraft(h.deps, a, { committeeId: h.ids.media, title: "fails" }), AUDIT_FAILURE);
    } finally {
      await restore();
    }
    const next = await createDraft(h.deps, a, { committeeId: h.ids.media, title: "after" });
    const n = (code: string) => Number(code.slice(-6));
    assert.equal(
      n(next.referenceCode),
      n(first.referenceCode) + 1,
      "no gap: the failed attempt's number was rolled back",
    );
  });

  it(
    "a failing audit insert rolls back an approval-invalidating edit (still approved, windows unchanged)",
    opts,
    async () => {
      const { id, revisionId } = await submitted();
      await decide(h.deps, await h.actor("reviewer"), id, { revisionId, decision: "APPROVED" });
      await failAudit("APPROVAL_INVALIDATED");
      try {
        await assert.rejects(
          saveDraft(h.deps, await h.actor("convener"), id, { title: "Changed", windows: [win(h.ids.canteen)] }),
          AUDIT_FAILURE,
        );
      } finally {
        await restore();
      }
      assert.equal(await status(id), "APPROVED");
      const [t] = await h.q<{ title: string }>("select title from submission where id=$1", [id]);
      assert.equal(t.title, "Poster");
      const [w] = await h.q<{ code: string }>(
        "select s.code from screen_request r join screen s on s.id=r.screen_id where r.submission_id=$1",
        [id],
      );
      assert.equal(w.code, "lobby");
    },
  );
});

describe("reference codes use the campus (Asia/Kolkata) year", () => {
  it("rolls over at midnight IST, not UTC", opts, async () => {
    const a = await h.actor("convener");
    const make = (now: Date) => createDraft(h.deps, a, { committeeId: h.ids.media, title: "year" }, now);
    const lateUtc = await make(new Date("2031-12-31T10:00:00Z")); // 15:30 IST, still 2031
    const afterMidnightIst = await make(new Date("2031-12-31T19:00:00Z")); // 00:30 IST on 1 Jan 2032
    assert.match(lateUtc.referenceCode, /^VS-2031-\d{6}$/);
    assert.match(afterMidnightIst.referenceCode, /^VS-2032-000001$/);
  });
});
