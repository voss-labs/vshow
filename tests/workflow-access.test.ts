// Access requests against a REAL migrated database: Corporate Communication (REVIEWER) and administrators decide who
// may use the portal, but only an administrator can create administrators, and a decided account cannot be changed here.
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { committeeCodeFor, grantAccess, listAccessRequests, listCommitteeOptions } from "../app/admin/access.server.ts";
import { WorkflowError, type WorkflowErrorCode } from "../app/submissions/errors.ts";
import { createWorkflowHarness, type PersonKey } from "./support/workflow-harness.ts";

const h = await createWorkflowHarness("vshow_test_wfaccess");
const opts = { skip: h.skipReason || false };
after(async () => {
  if (!h.skipReason) await h.close();
});

async function expectCode(p: Promise<unknown>, code: WorkflowErrorCode) {
  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof WorkflowError, `expected WorkflowError(${code}), got ${String(e)}`);
    assert.equal(e.code, code);
    return true;
  });
}

let n = 0;
async function newcomer(): Promise<string> {
  n += 1;
  const [r] = await h.q<{ id: string }>("insert into app_user (email, display_name) values ($1, $2) returning id", [
    `newcomer${n}@vit.edu.in`,
    `Newcomer ${n}`,
  ]);
  return r.id;
}
const rolesOf = async (id: string) =>
  (
    await h.q<{ code: string }>(
      "select r.code from user_role ur join app_role r on r.id = ur.role_id where ur.user_id=$1 order by 1",
      [id],
    )
  ).map((r) => r.code);
const membershipsOf = (id: string) =>
  h.q<{ name: string; membership_type: string; is_active: boolean; assigned_by_user_id: string }>(
    "select c.name, m.membership_type, m.is_active, m.assigned_by_user_id from committee_membership m join committee c on c.id = m.committee_id where m.user_id=$1",
    [id],
  );

describe("committee codes", () => {
  it("makes a short stable ASCII code from a name", () => {
    assert.equal(committeeCodeFor("College Management"), "college-management");
    assert.equal(committeeCodeFor("  Robotics & AI Club!! "), "robotics-ai-club");
    assert.equal(committeeCodeFor("!!!"), "committee");
  });
});

describe("access requests", () => {
  it("lists only active accounts with no role, to reviewers and admins only", opts, async () => {
    const id = await newcomer();
    const db = h.deps.database.get();
    for (const who of ["reviewer", "admin"] as PersonKey[]) {
      const list = await listAccessRequests(db, await h.actor(who));
      assert.ok(list.some((r) => r.id === id));
      assert.ok(!list.some((r) => r.email === "reviewer@test.invalid"), "people with a role are not requests");
    }
    for (const who of ["convener", "manager", "unassigned"] as PersonKey[]) {
      await expectCode(listAccessRequests(db, await h.actor(who)), "forbidden");
      await expectCode(listCommitteeOptions(db, await h.actor(who)), "forbidden");
    }
    await h.q("update app_user set is_active=false where id=$1", [id]);
    assert.ok(!(await listAccessRequests(db, await h.actor("reviewer"))).some((r) => r.id === id));
  });

  it("lets Corporate Communication give REVIEWER or SERVER_ROOM_MANAGER, recording who decided", opts, async () => {
    const reviewer = await h.actor("reviewer");
    const a = await newcomer();
    const b = await newcomer();
    await grantAccess(h.deps, reviewer, a, { role: "REVIEWER" });
    await grantAccess(h.deps, reviewer, b, { role: "SERVER_ROOM_MANAGER" });
    assert.deepEqual(await rolesOf(a), ["REVIEWER"]);
    assert.deepEqual(await rolesOf(b), ["SERVER_ROOM_MANAGER"]);
    const [by] = await h.q<{ assigned_by_user_id: string }>(
      "select assigned_by_user_id from user_role where user_id=$1",
      [a],
    );
    assert.equal(by.assigned_by_user_id, reviewer.id);
  });

  it("can never create an administrator, even for an admin deciding here", opts, async () => {
    const id = await newcomer();
    for (const who of ["reviewer", "admin"] as PersonKey[]) {
      await expectCode(grantAccess(h.deps, await h.actor(who), id, { role: "ADMIN" }), "validation_failed");
    }
    assert.deepEqual(await rolesOf(id), []);
  });

  it("is forbidden to everyone else", opts, async () => {
    const id = await newcomer();
    for (const who of ["convener", "manager", "unassigned", "member"] as PersonKey[]) {
      await expectCode(grantAccess(h.deps, await h.actor(who), id, { role: "REVIEWER" }), "forbidden");
    }
    assert.deepEqual(await rolesOf(id), []);
  });

  it("makes a convener of an existing committee", opts, async () => {
    const id = await newcomer();
    await grantAccess(h.deps, await h.actor("reviewer"), id, { role: "CONVENER", committeeId: h.ids.media });
    assert.deepEqual(await rolesOf(id), ["CONVENER"]);
    const m = await membershipsOf(id);
    assert.equal(m.length, 1);
    assert.equal(m[0].membership_type, "CONVENER");
    assert.equal(m[0].is_active, true);
  });

  it("creates a new committee by name (College Management) and reuses it by name afterwards", opts, async () => {
    const reviewer = await h.actor("reviewer");
    const a = await newcomer();
    const b = await newcomer();
    await grantAccess(h.deps, reviewer, a, { role: "CONVENER", newCommitteeName: "  College   Management " });
    await grantAccess(h.deps, reviewer, b, { role: "CONVENER", newCommitteeName: "college management" });
    const rows = await h.q<{ id: string; code: string; name: string }>(
      "select id, code, name from committee where lower(name)='college management'",
    );
    assert.equal(rows.length, 1, "the second request reuses the committee");
    assert.equal(rows[0].name, "College Management");
    assert.equal(rows[0].code, "college-management");
    assert.equal((await membershipsOf(b))[0].name, "College Management");
    assert.ok(
      (await listCommitteeOptions(h.deps.database.get(), reviewer)).some((c) => c.name === "College Management"),
    );
  });

  it("keeps committee codes unique when different names collapse to the same code", opts, async () => {
    const reviewer = await h.actor("reviewer");
    const a = await newcomer();
    const b = await newcomer();
    await grantAccess(h.deps, reviewer, a, { role: "CONVENER", newCommitteeName: "Art & Design" });
    await grantAccess(h.deps, reviewer, b, { role: "CONVENER", newCommitteeName: "Art - Design" });
    const codes = (
      await h.q<{ code: string }>("select code from committee where code like 'art-design%' order by 1")
    ).map((r) => r.code);
    assert.deepEqual(codes, ["art-design", "art-design-2"]);
  });

  it("requires a committee for a convener and rejects a bad one, leaving the account untouched", opts, async () => {
    const reviewer = await h.actor("reviewer");
    const id = await newcomer();
    await expectCode(grantAccess(h.deps, reviewer, id, { role: "CONVENER" }), "validation_failed");
    await expectCode(grantAccess(h.deps, reviewer, id, { role: "CONVENER", committeeId: "nope" }), "validation_failed");
    await expectCode(
      grantAccess(h.deps, reviewer, id, { role: "CONVENER", committeeId: "00000000-0000-4000-8000-000000000000" }),
      "validation_failed",
    );
    await expectCode(
      grantAccess(h.deps, reviewer, id, { role: "CONVENER", newCommitteeName: "x".repeat(121) }),
      "validation_failed",
    );
    assert.deepEqual(await rolesOf(id), []);
    assert.deepEqual(await membershipsOf(id), []);
  });

  it("cannot change an account that already has a role, or an unknown or inactive one", opts, async () => {
    const reviewer = await h.actor("reviewer");
    const id = await newcomer();
    await grantAccess(h.deps, reviewer, id, { role: "REVIEWER" });
    await expectCode(grantAccess(h.deps, reviewer, id, { role: "SERVER_ROOM_MANAGER" }), "invalid_state");
    assert.deepEqual(await rolesOf(id), ["REVIEWER"]);
    const admin = await h.actor("admin");
    await expectCode(grantAccess(h.deps, reviewer, admin.id, { role: "REVIEWER" }), "invalid_state");
    assert.deepEqual(await rolesOf(admin.id), ["ADMIN"]);
    await expectCode(
      grantAccess(h.deps, reviewer, "00000000-0000-4000-8000-000000000000", { role: "REVIEWER" }),
      "not_found",
    );
    await expectCode(grantAccess(h.deps, reviewer, "not-a-uuid", { role: "REVIEWER" }), "not_found");
    const off = await newcomer();
    await h.q("update app_user set is_active=false where id=$1", [off]);
    await expectCode(grantAccess(h.deps, reviewer, off, { role: "REVIEWER" }), "not_found");
  });

  it("two simultaneous decisions: one wins, the other is told it is already decided", opts, async () => {
    const id = await newcomer();
    const r1 = await h.actor("reviewer");
    const r2 = await h.actor("reviewer2");
    const results = await Promise.allSettled([
      grantAccess(h.deps, r1, id, { role: "REVIEWER" }),
      grantAccess(h.deps, r2, id, { role: "SERVER_ROOM_MANAGER" }),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal((await rolesOf(id)).length, 1);
  });
});
