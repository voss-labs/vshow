// A real, disposable local database (migrated with the real migration files) plus the in-memory object store, with
// the people the workflow tests need. No Better Auth, no network: services receive the same `CurrentUser` that the
// route guards produce, built here from the real role / membership rows exactly as authorize.server.ts reads them.
import { and, eq } from "drizzle-orm";
import pg from "pg";
import type { CurrentUser } from "../../app/auth/authorize.server.ts";
import { createDbProvider } from "../../app/db/client.server.ts";
import { resolveDbConfig } from "../../app/db/config.server.ts";
import { committee, committeeMembership } from "../../app/db/schema/campus.ts";
import { appRole, appUser, userRole } from "../../app/db/schema/identity.ts";
import { ROLE_CODES, type MembershipType, type RoleCode } from "../../app/db/schema/values.ts";
import type { WorkflowDeps } from "../../app/submissions/access.server.ts";
import { DEFAULT_MEDIA_POLICY, type MediaPolicy } from "../../app/submissions/media-policy.server.ts";
import { captureLogs, createThrowawayDb, runNode } from "../helpers.ts";
import { buildJpeg, buildMp4, buildPng } from "./media-builders.ts";
import { createMemoryStorage, type MemoryStorage } from "./memory-storage.ts";

// Valid synthetic files (the finalize step parses them). PNG and PNG2 have the same length but different dimensions.
export const PNG = buildPng({ width: 1920, height: 1080 });
export const PNG2 = buildPng({ width: 1280, height: 720 });
export const JPEG = buildJpeg({ width: 1080, height: 1920 });
export const HTML = Uint8Array.from(Buffer.from("<html><script>alert(1)</script></html>"));
export const MP4 = buildMp4({ width: 1920, height: 1080, durationSeconds: 12, fps: 30, audio: true });

/** Everyone is created once per harness; names say what they are. */
export type PersonKey =
  | "convener" // CONVENER, active member of media
  | "convener2" // a second CONVENER of media
  | "convenerOther" // CONVENER of robotics
  | "lapsed" // CONVENER role, membership inactive
  | "member" // MEMBER of media, no role
  | "reviewer"
  | "reviewer2"
  | "manager"
  | "admin"
  | "unassigned" // signed in, no role
  | "both"; // CONVENER of media AND REVIEWER (to prove a reviewer cannot decide on their own submission)

const PEOPLE: Record<
  PersonKey,
  { roles: RoleCode[]; membership?: { committee: "media" | "robotics"; type: MembershipType; active: boolean } }
> = {
  convener: { roles: ["CONVENER"], membership: { committee: "media", type: "CONVENER", active: true } },
  convener2: { roles: ["CONVENER"], membership: { committee: "media", type: "CONVENER", active: true } },
  convenerOther: { roles: ["CONVENER"], membership: { committee: "robotics", type: "CONVENER", active: true } },
  lapsed: { roles: ["CONVENER"], membership: { committee: "media", type: "CONVENER", active: false } },
  member: { roles: [], membership: { committee: "media", type: "MEMBER", active: true } },
  reviewer: { roles: ["REVIEWER"] },
  reviewer2: { roles: ["REVIEWER"] },
  manager: { roles: ["SERVER_ROOM_MANAGER"] },
  admin: { roles: ["ADMIN"] },
  unassigned: { roles: [] },
  both: { roles: ["CONVENER", "REVIEWER"], membership: { committee: "media", type: "CONVENER", active: true } },
};

export interface WorkflowHarness {
  skipReason: string;
  deps: WorkflowDeps;
  storage: MemoryStorage;
  log: ReturnType<typeof captureLogs>;
  dbUrl: string;
  ids: { media: string; robotics: string; lobby: string; canteen: string; library: string };
  q: <T extends pg.QueryResultRow = pg.QueryResultRow>(sql: string, params?: unknown[]) => Promise<T[]>;
  /** The user as the route guards would see them right now (roles and ACTIVE memberships from the database). */
  actor(key: PersonKey): Promise<CurrentUser>;
  setMedia(patch: Partial<MediaPolicy>): void;
  resetStorageCalls(): void;
  close(): Promise<void>;
}

export async function createWorkflowHarness(prefix = "vshow_test_workflow"): Promise<WorkflowHarness> {
  const db = await createThrowawayDb(prefix);
  const log = captureLogs();
  const storage = createMemoryStorage();
  const media: MediaPolicy = { ...DEFAULT_MEDIA_POLICY };
  if (db.skipReason) {
    return { skipReason: db.skipReason, log, storage } as unknown as WorkflowHarness;
  }
  const migrate = runNode(["scripts/db-migrate.ts"], {
    DB_TARGET: "local",
    DATABASE_URL: db.url,
    DATABASE_URL_DIRECT: "",
  });
  if (migrate.status !== 0) throw new Error(`test database migration failed: ${migrate.stderr || migrate.stdout}`);

  const database = createDbProvider({
    resolveConfig: () => resolveDbConfig({ DB_TARGET: "local", DATABASE_URL: db.url }, "runtime"),
    logger: log.logger,
  });
  const q = async <T extends pg.QueryResultRow = pg.QueryResultRow>(sql: string, params: unknown[] = []) => {
    const c = new pg.Client({ connectionString: db.url });
    await c.connect();
    try {
      return (await c.query<T>(sql, params)).rows;
    } finally {
      await c.end();
    }
  };

  // --- reference data and people -------------------------------------------------------------------------------
  const d = database.get();
  const roleIds = new Map<RoleCode, string>();
  for (const code of ROLE_CODES) {
    const [r] = await d.insert(appRole).values({ code, name: code }).returning({ id: appRole.id });
    roleIds.set(code, r.id);
  }
  const committees = {} as Record<"media" | "robotics", string>;
  for (const code of ["media", "robotics"] as const) {
    const [c] = await d
      .insert(committee)
      .values({ code, name: `${code} committee` })
      .returning({ id: committee.id });
    committees[code] = c.id;
  }
  const screens: Record<string, string> = {};
  for (const [code, active] of [
    ["lobby", true],
    ["canteen", true],
    ["library", false],
  ] as const) {
    const rows = await q<{ id: string }>("insert into screen(code, name, is_active) values ($1,$1,$2) returning id", [
      code,
      active,
    ]);
    screens[code] = rows[0].id;
  }
  const userIds = new Map<PersonKey, string>();
  for (const [key, spec] of Object.entries(PEOPLE) as Array<[PersonKey, (typeof PEOPLE)[PersonKey]]>) {
    const [u] = await d
      .insert(appUser)
      .values({ email: `${key.toLowerCase()}@test.invalid`, displayName: key })
      .returning({ id: appUser.id });
    userIds.set(key, u.id);
    for (const role of spec.roles) await d.insert(userRole).values({ userId: u.id, roleId: roleIds.get(role)! });
    if (spec.membership) {
      await d.insert(committeeMembership).values({
        committeeId: committees[spec.membership.committee],
        userId: u.id,
        membershipType: spec.membership.type,
        isActive: spec.membership.active,
      });
    }
  }

  async function actor(key: PersonKey): Promise<CurrentUser> {
    const id = userIds.get(key)!;
    const [u] = await d.select().from(appUser).where(eq(appUser.id, id));
    const roles = (
      await d
        .select({ code: appRole.code })
        .from(userRole)
        .innerJoin(appRole, eq(appRole.id, userRole.roleId))
        .where(eq(userRole.userId, id))
    ).map((r) => r.code as RoleCode);
    const memberships = await d
      .select({
        committeeId: committeeMembership.committeeId,
        committeeCode: committee.code,
        membershipType: committeeMembership.membershipType,
      })
      .from(committeeMembership)
      .innerJoin(committee, eq(committee.id, committeeMembership.committeeId))
      .where(
        and(eq(committeeMembership.userId, id), eq(committeeMembership.isActive, true), eq(committee.isActive, true)),
      );
    return {
      id,
      email: u.email,
      displayName: u.displayName,
      roles,
      memberships: memberships.map((m) => ({ ...m, membershipType: m.membershipType as MembershipType })),
    };
  }

  const deps: WorkflowDeps = { database, logger: log.logger, storage, media };
  return {
    skipReason: "",
    deps,
    storage,
    log,
    dbUrl: db.url,
    ids: {
      media: committees.media,
      robotics: committees.robotics,
      lobby: screens.lobby,
      canteen: screens.canteen,
      library: screens.library,
    },
    q,
    actor,
    setMedia: (patch) => Object.assign(media, patch),
    resetStorageCalls: () => {
      storage.calls.length = 0;
    },
    close: async () => {
      await database.close();
      await db.drop();
    },
  };
}
