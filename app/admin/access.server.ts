// Access requests: someone who signed in with a campus account but holds no role is waiting for access. Corporate
// Communication (REVIEWER) and administrators decide who may use the portal. Corporate Communication can hand out the
// everyday roles only - never ADMIN - and only to people who hold no role yet, so it cannot alter an existing
// account (least of all an administrator's). Everything is re-checked here on top of the route guard.
import { asc, eq, sql } from "drizzle-orm";
import type { CurrentUser } from "../auth/authorize.server.ts";
import type { Db } from "../db/client.server.ts";
import { committee, committeeMembership } from "../db/schema/campus.ts";
import { appRole, appUser, userRole } from "../db/schema/identity.ts";
import type { RoleCode } from "../db/schema/values.ts";
import { isUuid, type WorkflowDeps } from "../submissions/access.server.ts";
import { WorkflowError, notFound } from "../submissions/errors.ts";

/** Roles Corporate Communication may grant. ADMIN is deliberately absent. */
export const GRANTABLE_ROLES = ["CONVENER", "REVIEWER", "SERVER_ROOM_MANAGER"] as const satisfies readonly RoleCode[];
export type GrantableRole = (typeof GRANTABLE_ROLES)[number];

export const COMMITTEE_NAME_MAX = 120;

const assertDecider = (actor: CurrentUser) => {
  if (!actor.roles.includes("REVIEWER") && !actor.roles.includes("ADMIN")) throw new WorkflowError("forbidden");
};

const invalid = (path: string, code = "invalid") => new WorkflowError("validation_failed", [{ path, code }]);

export interface AccessRequest {
  id: string;
  displayName: string;
  email: string;
  requestedAt: Date;
}

/** Active accounts with no role, oldest first. */
export async function listAccessRequests(db: Db, actor: CurrentUser): Promise<AccessRequest[]> {
  assertDecider(actor);
  const rows = await db
    .select({ id: appUser.id, displayName: appUser.displayName, email: appUser.email, requestedAt: appUser.createdAt })
    .from(appUser)
    .leftJoin(userRole, eq(userRole.userId, appUser.id))
    .where(sql`${appUser.isActive} AND ${userRole.userId} IS NULL`)
    .orderBy(asc(appUser.createdAt));
  return rows;
}

export const countAccessRequests = async (db: Db, actor: CurrentUser) => (await listAccessRequests(db, actor)).length;

export interface CommitteeOption {
  id: string;
  name: string;
}

export async function listCommitteeOptions(db: Db, actor: CurrentUser): Promise<CommitteeOption[]> {
  assertDecider(actor);
  return db
    .select({ id: committee.id, name: committee.name })
    .from(committee)
    .where(eq(committee.isActive, true))
    .orderBy(asc(committee.name));
}

/** Lower-case, hyphenated, ASCII; the stable code of a committee created from its name. */
export function committeeCodeFor(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/[^a-z0-9-]/gi, "")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 60);
  return slug || "committee";
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** The committee to use: the chosen one, else an active one with the same name, else a newly created one. */
export async function resolveCommitteeId(tx: Tx, existingId: string | null, newName: string): Promise<string> {
  if (existingId) {
    const [c] = await tx.select({ id: committee.id }).from(committee).where(eq(committee.id, existingId)).limit(1);
    if (!c) throw invalid("committeeId");
    return c.id;
  }
  // Reuse a committee of the same name instead of making a near-duplicate.
  const [same] = await tx
    .select({ id: committee.id })
    .from(committee)
    .where(sql`lower(${committee.name}) = lower(${newName}) AND ${committee.isActive}`)
    .limit(1);
  if (same) return same.id;
  const base = committeeCodeFor(newName);
  const taken = new Set(
    (
      await tx
        .select({ code: committee.code })
        .from(committee)
        .where(sql`${committee.code} = ${base} OR ${committee.code} LIKE ${base + "-%"}`)
    ).map((r) => r.code),
  );
  let code = base;
  for (let n = 2; taken.has(code); n++) code = `${base}-${n}`;
  const [created] = await tx.insert(committee).values({ name: newName, code }).returning({ id: committee.id });
  return created.id;
}

/** Trimmed, single-spaced committee name from form input ("" when absent). */
export const cleanCommitteeName = (v: unknown) => (typeof v === "string" ? v.trim().replace(/\s+/g, " ") : "");

export interface GrantInput {
  role: unknown;
  /** An existing committee (CONVENER only). */
  committeeId?: unknown;
  /** A committee to create by name when none of the existing ones fits (CONVENER only). */
  newCommitteeName?: unknown;
}

export async function grantAccess(
  deps: WorkflowDeps,
  actor: CurrentUser,
  userId: string,
  input: GrantInput,
): Promise<void> {
  assertDecider(actor);
  if (!isUuid(userId)) throw notFound();
  const role = input.role;
  if (typeof role !== "string" || !(GRANTABLE_ROLES as readonly string[]).includes(role)) throw invalid("role");

  const existingId = typeof input.committeeId === "string" && input.committeeId !== "" ? input.committeeId : null;
  const newName = cleanCommitteeName(input.newCommitteeName);
  if (role === "CONVENER") {
    if (!existingId && !newName) throw invalid("committeeId", "required");
    if (existingId && !isUuid(existingId)) throw invalid("committeeId");
    if (!existingId && newName.length > COMMITTEE_NAME_MAX) throw invalid("newCommitteeName", "too_long");
  }

  await deps.database.get().transaction(async (tx) => {
    // Lock the account so two deciders cannot grant at once.
    const [user] = await tx
      .select({ id: appUser.id, isActive: appUser.isActive })
      .from(appUser)
      .where(eq(appUser.id, userId))
      .for("update")
      .limit(1);
    if (!user || !user.isActive) throw notFound();
    const [held] = await tx.select({ r: userRole.roleId }).from(userRole).where(eq(userRole.userId, userId)).limit(1);
    // Already decided by someone else: the request is gone.
    if (held) throw new WorkflowError("invalid_state");

    const [roleRow] = await tx.select({ id: appRole.id }).from(appRole).where(eq(appRole.code, role)).limit(1);
    if (!roleRow) throw invalid("role");

    if (role === "CONVENER") {
      const committeeId = await resolveCommitteeId(tx, existingId, newName);
      await tx
        .insert(committeeMembership)
        .values({ committeeId, userId, membershipType: "CONVENER", isActive: true, assignedByUserId: actor.id })
        .onConflictDoUpdate({
          target: [committeeMembership.committeeId, committeeMembership.userId],
          set: { membershipType: "CONVENER", isActive: true, assignedByUserId: actor.id },
        });
    }
    await tx.insert(userRole).values({ userId, roleId: roleRow.id, assignedByUserId: actor.id });
  });
}
