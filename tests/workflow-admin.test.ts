// Administrator user management against a REAL migrated database: only ADMIN may use it, roles and committee
// memberships are granted / revoked with the assigning admin recorded, and an admin cannot remove their own ADMIN role.
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { getUserDetail, listUsers, setMembership, setRole } from "../app/admin/users.server.ts";
import { landingPath } from "../app/auth/landing.ts";
import { WorkflowError, type WorkflowErrorCode } from "../app/submissions/errors.ts";
import { createWorkflowHarness, type PersonKey } from "./support/workflow-harness.ts";

const h = await createWorkflowHarness("vshow_test_wfadmin");
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

const NOBODY = "00000000-0000-4000-8000-000000000000";
const idOf = async (key: PersonKey) => (await h.actor(key)).id;
const rolesOf = async (key: PersonKey) => (await h.actor(key)).roles.sort();

describe("landing page by role", () => {
  it("sends each role to its main page, falling back to the account page", () => {
    assert.equal(landingPath(["CONVENER"]), "/submissions");
    assert.equal(landingPath(["REVIEWER"]), "/review");
    assert.equal(landingPath(["SERVER_ROOM_MANAGER"]), "/manager");
    assert.equal(landingPath(["ADMIN"]), "/admin");
    assert.equal(landingPath([]), "/me");
    assert.equal(landingPath(["ADMIN", "REVIEWER"]), "/review");
  });
});

describe("admin user management", () => {
  it("lists every user with roles and active committee counts", opts, async () => {
    const users = await listUsers(h.deps.database.get());
    const byEmail = new Map(users.map((u) => [u.email, u]));
    assert.deepEqual(byEmail.get("reviewer@test.invalid")?.roles, ["REVIEWER"]);
    assert.deepEqual(byEmail.get("admin@test.invalid")?.roles, ["ADMIN"]);
    assert.equal(byEmail.get("convener@test.invalid")?.committees, 1);
    assert.equal(byEmail.get("lapsed@test.invalid")?.committees, 0, "ended memberships do not count");
    assert.equal(byEmail.get("unassigned@test.invalid")?.roles.length, 0);
  });

  it("is forbidden to every other role", opts, async () => {
    const target = await idOf("unassigned");
    const media = h.ids.media;
    for (const who of ["convener", "reviewer", "manager", "unassigned"] as PersonKey[]) {
      const a = await h.actor(who);
      await expectCode(getUserDetail(h.deps.database.get(), a, target), "forbidden");
      await expectCode(setRole(h.deps, a, target, { role: "REVIEWER", grant: true }), "forbidden");
      await expectCode(
        setMembership(h.deps, a, target, { committeeId: media, membershipType: "MEMBER", active: true }),
        "forbidden",
      );
    }
    assert.deepEqual(await rolesOf("unassigned"), []);
  });

  it("shows a user's detail, including committees they could still be added to", opts, async () => {
    const admin = await h.actor("admin");
    const d = await getUserDetail(h.deps.database.get(), admin, await idOf("convener"));
    assert.equal(d.isSelf, false);
    assert.deepEqual(d.roles, ["CONVENER"]);
    assert.deepEqual(
      d.memberships.map((m) => [m.committeeCode, m.membershipType, m.isActive]),
      [["media", "CONVENER", true]],
    );
    assert.deepEqual(
      d.availableCommittees.map((c) => c.id),
      [h.ids.robotics],
    );
    assert.equal((await getUserDetail(h.deps.database.get(), admin, admin.id)).isSelf, true);
  });

  it("answers not_found for a malformed or unknown user id", opts, async () => {
    const admin = await h.actor("admin");
    await expectCode(getUserDetail(h.deps.database.get(), admin, "not-a-uuid"), "not_found");
    await expectCode(getUserDetail(h.deps.database.get(), admin, NOBODY), "not_found");
    await expectCode(setRole(h.deps, admin, NOBODY, { role: "REVIEWER", grant: true }), "not_found");
    await expectCode(setRole(h.deps, admin, "not-a-uuid", { role: "REVIEWER", grant: true }), "not_found");
  });

  it("grants and revokes a role, records the assigning admin, and is idempotent", opts, async () => {
    const admin = await h.actor("admin");
    const target = await idOf("member");
    await setRole(h.deps, admin, target, { role: "SERVER_ROOM_MANAGER", grant: true });
    await setRole(h.deps, admin, target, { role: "SERVER_ROOM_MANAGER", grant: true }); // no duplicate row
    assert.deepEqual(await rolesOf("member"), ["SERVER_ROOM_MANAGER"]);
    const rows = await h.q<{ assigned_by_user_id: string }>(
      "select assigned_by_user_id from user_role where user_id=$1",
      [target],
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].assigned_by_user_id, admin.id);

    await setRole(h.deps, admin, target, { role: "SERVER_ROOM_MANAGER", grant: false });
    await setRole(h.deps, admin, target, { role: "SERVER_ROOM_MANAGER", grant: false }); // already gone: fine
    assert.deepEqual(await rolesOf("member"), []);
  });

  it("a newly granted role takes effect on the next read of the user", opts, async () => {
    const admin = await h.actor("admin");
    const target = await idOf("unassigned");
    await expectCode(getUserDetail(h.deps.database.get(), await h.actor("unassigned"), admin.id), "forbidden");
    await setRole(h.deps, admin, target, { role: "ADMIN", grant: true });
    const promoted = await h.actor("unassigned");
    assert.ok(promoted.roles.includes("ADMIN"));
    await getUserDetail(h.deps.database.get(), promoted, admin.id); // now allowed
    await setRole(h.deps, admin, target, { role: "ADMIN", grant: false });
  });

  it("rejects an unknown or malformed role", opts, async () => {
    const admin = await h.actor("admin");
    const target = await idOf("unassigned");
    for (const role of ["SUPERUSER", "", 7, null, undefined]) {
      await expectCode(setRole(h.deps, admin, target, { role, grant: true }), "validation_failed");
    }
    assert.deepEqual(await rolesOf("unassigned"), []);
  });

  it("will not let an admin remove their own ADMIN role, but may remove another admin's", opts, async () => {
    const admin = await h.actor("admin");
    await expectCode(setRole(h.deps, admin, admin.id, { role: "ADMIN", grant: false }), "forbidden");
    assert.ok((await h.actor("admin")).roles.includes("ADMIN"));
    // Other roles on themselves are not protected.
    await setRole(h.deps, admin, admin.id, { role: "REVIEWER", grant: true });
    await setRole(h.deps, admin, admin.id, { role: "REVIEWER", grant: false });

    const target = await idOf("unassigned");
    await setRole(h.deps, admin, target, { role: "ADMIN", grant: true });
    await setRole(h.deps, admin, target, { role: "ADMIN", grant: false });
    assert.deepEqual(await rolesOf("unassigned"), []);
  });

  it("adds, changes and ends a committee membership without deleting the row", opts, async () => {
    const admin = await h.actor("admin");
    const target = await idOf("unassigned");
    const robotics = h.ids.robotics;
    const row = () =>
      h.q<{ membership_type: string; is_active: boolean; assigned_by_user_id: string }>(
        "select membership_type, is_active, assigned_by_user_id from committee_membership where user_id=$1 and committee_id=$2",
        [target, robotics],
      );

    await setMembership(h.deps, admin, target, { committeeId: robotics, membershipType: "MEMBER", active: true });
    assert.deepEqual(await row(), [{ membership_type: "MEMBER", is_active: true, assigned_by_user_id: admin.id }]);
    assert.equal((await h.actor("unassigned")).memberships.length, 1);

    // Re-assigning updates the same row (no duplicate, no unique-constraint error).
    await setMembership(h.deps, admin, target, { committeeId: robotics, membershipType: "CONVENER", active: true });
    assert.deepEqual(
      (await row()).map((r) => r.membership_type),
      ["CONVENER"],
    );

    await setMembership(h.deps, admin, target, { committeeId: robotics, active: false });
    const ended = await row();
    assert.equal(ended.length, 1, "ended, never deleted");
    assert.equal(ended[0].is_active, false);
    assert.equal((await h.actor("unassigned")).memberships.length, 0);

    // It can be restored later.
    await setMembership(h.deps, admin, target, { committeeId: robotics, membershipType: "MEMBER", active: true });
    assert.equal((await row())[0].is_active, true);
    await setMembership(h.deps, admin, target, { committeeId: robotics, active: false });
  });

  it("validates membership input and unknown users or committees", opts, async () => {
    const admin = await h.actor("admin");
    const target = await idOf("unassigned");
    const media = h.ids.media;
    await expectCode(
      setMembership(h.deps, admin, target, { committeeId: media, membershipType: "BOSS", active: true }),
      "validation_failed",
    );
    await expectCode(setMembership(h.deps, admin, target, { committeeId: media, active: true }), "validation_failed");
    await expectCode(
      setMembership(h.deps, admin, target, { committeeId: "nope", membershipType: "MEMBER", active: true }),
      "validation_failed",
    );
    await expectCode(
      setMembership(h.deps, admin, target, { committeeId: NOBODY, membershipType: "MEMBER", active: true }),
      "not_found",
    );
    await expectCode(
      setMembership(h.deps, admin, NOBODY, { committeeId: media, membershipType: "MEMBER", active: true }),
      "not_found",
    );
    assert.equal((await h.actor("unassigned")).memberships.length, 0);
  });
});

describe("admin adds a person to a committee that does not exist yet", () => {
  it("creates the committee by name, reuses an existing one, and rejects bad input", opts, async () => {
    const admin = await h.actor("admin");
    const target = await idOf("unassigned");
    await setMembership(h.deps, admin, target, {
      newCommitteeName: " Sports  Council ",
      membershipType: "CONVENER",
      active: true,
    });
    await setMembership(h.deps, admin, await idOf("member"), {
      newCommitteeName: "sports council",
      membershipType: "MEMBER",
      active: true,
    });
    const rows = await h.q<{ code: string; n: string }>(
      "select c.code, count(m.id)::text n from committee c join committee_membership m on m.committee_id=c.id where lower(c.name)='sports council' group by c.code",
    );
    assert.deepEqual(rows, [{ code: "sports-council", n: "2" }]);
    await expectCode(
      setMembership(h.deps, admin, target, { membershipType: "MEMBER", active: true }),
      "validation_failed",
    );
    await expectCode(
      setMembership(h.deps, admin, target, {
        newCommitteeName: "x".repeat(121),
        membershipType: "MEMBER",
        active: true,
      }),
      "validation_failed",
    );
    await expectCode(
      setMembership(h.deps, admin, target, { newCommitteeName: "Never", active: false }),
      "validation_failed",
    );
  });
});
