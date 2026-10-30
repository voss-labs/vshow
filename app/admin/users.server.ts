// Administrator user management: who holds which role, and who belongs to which committee. Every function
// re-checks that the actor is an ADMIN (defense in depth on top of the route guard). Role and membership rows
// record the assigning administrator in `assigned_by_user_id`.
import { and, asc, eq } from "drizzle-orm";
import type { CurrentUser } from "../auth/authorize.server.ts";
import type { Db } from "../db/client.server.ts";
import { committee, committeeMembership } from "../db/schema/campus.ts";
import { appRole, appUser, userRole } from "../db/schema/identity.ts";
import { MEMBERSHIP_TYPES, ROLE_CODES, type MembershipType, type RoleCode } from "../db/schema/values.ts";
import { isUuid, type WorkflowDeps } from "../submissions/access.server.ts";
import { cleanCommitteeName, COMMITTEE_NAME_MAX, resolveCommitteeId } from "./access.server.ts";
import { WorkflowError, notFound } from "../submissions/errors.ts";

const assertAdmin = (actor: CurrentUser) => {
  if (!actor.roles.includes("ADMIN")) throw new WorkflowError("forbidden");
};

export interface AdminUserListItem {
  id: string;
  displayName: string;
  email: string;
  isActive: boolean;
  roles: RoleCode[];
  committees: number;
}

export async function listUsers(db: Db): Promise<AdminUserListItem[]> {
  const [users, roles, memberships] = await Promise.all([
    db
      .select({ id: appUser.id, displayName: appUser.displayName, email: appUser.email, isActive: appUser.isActive })
      .from(appUser)
      .orderBy(asc(appUser.displayName)),
    db
      .select({ userId: userRole.userId, code: appRole.code })
      .from(userRole)
      .innerJoin(appRole, eq(appRole.id, userRole.roleId)),
    db
      .select({ userId: committeeMembership.userId })
      .from(committeeMembership)
      .where(eq(committeeMembership.isActive, true)),
  ]);
  return users.map((u) => ({
    ...u,
    roles: roles.filter((r) => r.userId === u.id).map((r) => r.code as RoleCode),
    committees: memberships.filter((m) => m.userId === u.id).length,
  }));
}

export interface AdminUserDetail {
  id: string;
  displayName: string;
  email: string;
  isActive: boolean;
  isSelf: boolean;
  roles: RoleCode[];
  memberships: Array<{
    committeeId: string;
    committeeName: string;
    committeeCode: string;
    membershipType: MembershipType;
    isActive: boolean;
  }>;
  /** Active committees this user has no membership row for yet. */
  availableCommittees: Array<{ id: string; name: string }>;
}

export async function getUserDetail(db: Db, actor: CurrentUser, userId: string): Promise<AdminUserDetail> {
  assertAdmin(actor);
  if (!isUuid(userId)) throw notFound();
  const [user] = await db
    .select({ id: appUser.id, displayName: appUser.displayName, email: appUser.email, isActive: appUser.isActive })
    .from(appUser)
    .where(eq(appUser.id, userId))
    .limit(1);
  if (!user) throw notFound();

  const [roles, memberships, committees] = await Promise.all([
    db
      .select({ code: appRole.code })
      .from(userRole)
      .innerJoin(appRole, eq(appRole.id, userRole.roleId))
      .where(eq(userRole.userId, userId)),
    db
      .select({
        committeeId: committee.id,
        committeeName: committee.name,
        committeeCode: committee.code,
        membershipType: committeeMembership.membershipType,
        isActive: committeeMembership.isActive,
      })
      .from(committeeMembership)
      .innerJoin(committee, eq(committee.id, committeeMembership.committeeId))
      .where(eq(committeeMembership.userId, userId))
      .orderBy(asc(committee.name)),
    db
      .select({ id: committee.id, name: committee.name })
      .from(committee)
      .where(eq(committee.isActive, true))
      .orderBy(asc(committee.name)),
  ]);
  const taken = new Set(memberships.map((m) => m.committeeId));
  return {
    ...user,
    isSelf: user.id === actor.id,
    roles: roles.map((r) => r.code as RoleCode),
    memberships: memberships as AdminUserDetail["memberships"],
    availableCommittees: committees.filter((c) => !taken.has(c.id)),
  };
}

const invalid = (path: string, code = "invalid") => new WorkflowError("validation_failed", [{ path, code }]);

export async function setRole(
  deps: WorkflowDeps,
  actor: CurrentUser,
  userId: string,
  input: { role: unknown; grant: boolean },
): Promise<void> {
  assertAdmin(actor);
  if (!isUuid(userId)) throw notFound();
  if (typeof input.role !== "string" || !(ROLE_CODES as readonly string[]).includes(input.role)) throw invalid("role");
  // An administrator must not be able to lock the last way into this page out from under themselves.
  if (!input.grant && input.role === "ADMIN" && userId === actor.id) throw new WorkflowError("forbidden");

  await deps.database.get().transaction(async (tx) => {
    const [user] = await tx.select({ id: appUser.id }).from(appUser).where(eq(appUser.id, userId)).limit(1);
    if (!user) throw notFound();
    const [role] = await tx
      .select({ id: appRole.id })
      .from(appRole)
      .where(eq(appRole.code, input.role as string))
      .limit(1);
    if (!role) throw invalid("role");
    if (input.grant) {
      await tx.insert(userRole).values({ userId, roleId: role.id, assignedByUserId: actor.id }).onConflictDoNothing();
    } else {
      await tx.delete(userRole).where(and(eq(userRole.userId, userId), eq(userRole.roleId, role.id)));
    }
  });
}

export async function setMembership(
  deps: WorkflowDeps,
  actor: CurrentUser,
  userId: string,
  input: { committeeId?: unknown; newCommitteeName?: unknown; membershipType?: unknown; active: boolean },
): Promise<void> {
  assertAdmin(actor);
  if (!isUuid(userId)) throw notFound();
  const chosen = typeof input.committeeId === "string" && input.committeeId !== "" ? input.committeeId : null;
  const newName = cleanCommitteeName(input.newCommitteeName);
  // Creating a committee is only possible while adding someone to it.
  const creating = input.active && !chosen && newName !== "";
  if (chosen ? !isUuid(chosen) : !creating) throw invalid("committeeId");
  if (creating && newName.length > COMMITTEE_NAME_MAX) throw invalid("newCommitteeName", "too_long");
  const type = input.membershipType;
  if (input.active && (typeof type !== "string" || !(MEMBERSHIP_TYPES as readonly string[]).includes(type))) {
    throw invalid("membershipType");
  }
  await deps.database.get().transaction(async (tx) => {
    const [user] = await tx.select({ id: appUser.id }).from(appUser).where(eq(appUser.id, userId)).limit(1);
    if (!user) throw notFound();
    if (input.active) {
      if (chosen) {
        const [com] = await tx.select({ id: committee.id }).from(committee).where(eq(committee.id, chosen)).limit(1);
        if (!com) throw notFound();
      }
      const committeeId = await resolveCommitteeId(tx, chosen, newName);
      await tx
        .insert(committeeMembership)
        .values({ committeeId, userId, membershipType: type as string, isActive: true, assignedByUserId: actor.id })
        .onConflictDoUpdate({
          target: [committeeMembership.committeeId, committeeMembership.userId],
          set: { membershipType: type as string, isActive: true, assignedByUserId: actor.id },
        });
    } else {
      const committeeId = chosen as string;
      const [com] = await tx.select({ id: committee.id }).from(committee).where(eq(committee.id, committeeId)).limit(1);
      if (!com) throw notFound();
      // Memberships are ended, never deleted: submissions may reference the committee.
      await tx
        .update(committeeMembership)
        .set({ isActive: false, assignedByUserId: actor.id })
        .where(and(eq(committeeMembership.userId, userId), eq(committeeMembership.committeeId, committeeId)));
    }
  });
}
