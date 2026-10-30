import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { getAuthTables } from "better-auth/db";
import { getTableColumns, type Table } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { authModelOptions, authSchema } from "../app/auth/schema.server.ts";
import { createThrowawayDb, runNode } from "./helpers.ts";

type AuthFields = Record<string, { fieldName?: string; required?: boolean; defaultValue?: unknown }>;
const baTables = getAuthTables({ ...authModelOptions }) as Record<string, { modelName: string; fields: AuthFields }>;

describe("Better Auth schema compatibility (1.6.23, no database needed)", () => {
  it("every Better Auth model has a Vshow table under the model name the Drizzle adapter looks up", () => {
    for (const model of ["user", "session", "account", "verification"] as const) {
      assert.ok(baTables[model], `Better Auth no longer defines ${model}`);
      assert.ok(authSchema[model], `authSchema is missing ${model}`);
    }
  });

  for (const model of ["user", "session", "account", "verification"] as const) {
    it(`${model}: every field Better Auth writes exists as a column property (else the adapter throws)`, () => {
      const columns = getTableColumns(authSchema[model] as Table);
      for (const [field, attrs] of Object.entries(baTables[model].fields)) {
        const key = attrs.fieldName ?? field;
        assert.ok(key in columns, `${model}.${field} -> "${key}" is missing from the Drizzle table`);
      }
    });

    it(`${model}: no NOT NULL column without a default is left unfilled by Better Auth`, () => {
      const provided = new Set(
        Object.entries(baTables[model].fields).map(([field, attrs]) => attrs.fieldName ?? field),
      );
      for (const [key, col] of Object.entries(getTableColumns(authSchema[model] as Table))) {
        if (key === "id" || !col.notNull || col.hasDefault) continue;
        assert.ok(provided.has(key), `${model}.${key} is NOT NULL with no default and Better Auth does not provide it`);
      }
    });
  }

  it("maps Better Auth's `name` to displayName and uses Better Auth's own names elsewhere", () => {
    assert.equal(baTables.user.fields.name.fieldName, "displayName");
    for (const key of ["email", "emailVerified", "image", "createdAt", "updatedAt"]) {
      assert.ok(key in getTableColumns(authSchema.user), key);
    }
  });

  it("the account unique constraint matches how Better Auth looks accounts up: (providerId, accountId)", () => {
    const src = readFileSync("app/db/schema/identity.ts", "utf8");
    assert.match(src, /unique\("auth_account_provider_account_unique"\)\.on\(t\.providerId, t\.accountId\)/);
    assert.match(src, /unique\("auth_account_user_provider_unique"\)\.on\(t\.userId, t\.providerId\)/);
  });
});

// ---------------------------------------------------------------------------------------------------------
describe("auth tables, identity triggers and upgrade safety (disposable local database)", async () => {
  const db = await createThrowawayDb("vshow_test_auth");
  const opts = { skip: db.skipReason || false };
  const env = () => ({ DB_TARGET: "local", DATABASE_URL: db.url, DATABASE_URL_DIRECT: "" });
  const withClient = async <T>(fn: (c: pg.Client) => Promise<T>): Promise<T> => {
    const c = new pg.Client({ connectionString: db.url });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  };
  const mkUser = async (c: pg.Client, email: string, subject: string | null = null) =>
    (
      await c.query("insert into app_user(email, display_name, vauth_subject) values ($1, 'Test', $2) returning id", [
        email,
        subject,
      ])
    ).rows[0].id as string;
  const mkAccount = (c: pg.Client, userId: string, accountId: string, providerId = "voss") =>
    c.query("insert into auth_account(user_id, account_id, provider_id) values ($1, $2, $3)", [
      userId,
      accountId,
      providerId,
    ]);

  it(
    "UPGRADE: applying the auth migrations on top of existing data preserves every row and relationship",
    opts,
    async () => {
      // Build a database at migration 0000 only, put application data in it, then run the real migrate script.
      const tmp = mkdtempSync(join(tmpdir(), "vshow-upgrade-"));
      try {
        cpSync("drizzle", tmp, { recursive: true });
        const journalPath = join(tmp, "meta", "_journal.json");
        const full = JSON.parse(readFileSync(journalPath, "utf8"));
        writeFileSync(journalPath, JSON.stringify({ ...full, entries: full.entries.slice(0, 1) }));
        const c = new pg.Client({ connectionString: db.url });
        await c.connect();
        try {
          await migrate(drizzle({ client: c }), { migrationsFolder: tmp });
          const u = (await c.query("insert into app_user(email, display_name) values ('old@x.org','Old') returning id"))
            .rows[0].id;
          const com = (await c.query("insert into committee(name, code) values ('c','c1') returning id")).rows[0].id;
          await c.query(
            "insert into submission(reference_code, committee_id, created_by_user_id, title, workflow_status) values ('R1',$1,$2,'t','DRAFT')",
            [com, u],
          );
        } finally {
          await c.end();
        }
        const r = runNode(["scripts/db-migrate.ts"], env());
        assert.equal(r.status, 0, r.stderr || r.stdout);
        assert.match(r.stdout, /Applied 5 migration/);
        await withClient(async (c2) => {
          const user = (await c2.query("select email, email_verified, image, is_active from app_user")).rows[0];
          assert.deepEqual(user, { email: "old@x.org", email_verified: false, image: null, is_active: true });
          assert.equal((await c2.query("select count(*)::int n from submission")).rows[0].n, 1);
          // Application foreign keys still restrict (no cascade); only the auth tables cascade from the user.
          const fks = (
            await c2.query(`select conrelid::regclass::text t, confdeltype d from pg_constraint
                           where contype='f' and confrelid='app_user'::regclass order by 1`)
          ).rows;
          for (const fk of fks) {
            const expected = String(fk.t).startsWith("auth_") ? "c" : "a";
            assert.equal(fk.d, expected, `${fk.t} foreign key to app_user has the wrong delete rule`);
          }
          await assert.rejects(c2.query("delete from app_user"), /violates foreign key constraint/);
        });
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    },
  );

  it("a second migrate run is a no-op and the destructive-statement guard did not block these migrations", opts, () => {
    const r = runNode(["scripts/db-migrate.ts"], env());
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Up to date/);
  });

  it("account uniqueness: one row per (provider, subject) and one voss identity per user", opts, () =>
    withClient(async (c) => {
      const a = await mkUser(c, "a@vit.edu.in");
      const b = await mkUser(c, "b@vit.edu.in");
      await mkAccount(c, a, "sub-1");
      await assert.rejects(mkAccount(c, b, "sub-1"), /auth_account_provider_account_unique/);
      await assert.rejects(mkAccount(c, a, "sub-2"), /auth_account_user_provider_unique/);
      await mkAccount(c, b, "sub-2");
    }),
  );

  it("identity consistency: linking a voss account binds app_user.vauth_subject; other providers do not", opts, () =>
    withClient(async (c) => {
      const u = await mkUser(c, "bind@vit.edu.in");
      await mkAccount(c, u, "sub-bind");
      assert.equal((await c.query("select vauth_subject s from app_user where id=$1", [u])).rows[0].s, "sub-bind");
      const v = await mkUser(c, "other@vit.edu.in");
      await mkAccount(c, v, "gh-123", "github");
      assert.equal((await c.query("select vauth_subject s from app_user where id=$1", [v])).rows[0].s, null);
    }),
  );

  it(
    "a user already bound to the same subject can be re-linked; a different subject is a conflict with no subject in the message",
    opts,
    () =>
      withClient(async (c) => {
        const same = await mkUser(c, "same@vit.edu.in", "sub-same");
        await mkAccount(c, same, "sub-same");
        const bound = await mkUser(c, "bound@vit.edu.in", "seed-bound");
        await assert.rejects(mkAccount(c, bound, "sub-different"), (e: Error) => {
          assert.match(e.message, /vauth identity conflict/);
          assert.ok(!e.message.includes("sub-different") && !e.message.includes("seed-bound"));
          return true;
        });
        assert.equal(
          (await c.query("select count(*)::int n from auth_account where account_id='sub-different'")).rows[0].n,
          0,
        );
      }),
  );

  it("ROLLBACK: a conflicting identity aborts the whole transaction, including the new user", opts, () =>
    withClient(async (c) => {
      await mkAccount(c, await mkUser(c, "owner@vit.edu.in"), "sub-owned");
      await c.query("begin");
      let failed = false;
      try {
        const newUser = await mkUser(c, "newcomer@vit.edu.in");
        await mkAccount(c, newUser, "sub-owned"); // subject already belongs to someone else
      } catch {
        failed = true;
        await c.query("rollback");
      }
      assert.ok(failed, "the conflicting insert must fail");
      assert.equal(
        (await c.query("select count(*)::int n from app_user where email='newcomer@vit.edu.in'")).rows[0].n,
        0,
      );
    }),
  );

  it("vauth_subject is immutable once set, but can be set from null", opts, () =>
    withClient(async (c) => {
      const u = await mkUser(c, "imm@vit.edu.in");
      await c.query("update app_user set vauth_subject='s1' where id=$1", [u]);
      await c.query("update app_user set vauth_subject='s1' where id=$1", [u]); // unchanged is fine
      await assert.rejects(c.query("update app_user set vauth_subject='s2' where id=$1", [u]), /immutable/);
      await assert.rejects(c.query("update app_user set vauth_subject=null where id=$1", [u]), /immutable/);
    }),
  );

  it("an account's identity columns are immutable; other columns can still change", opts, () =>
    withClient(async (c) => {
      const u = await mkUser(c, "acct@vit.edu.in");
      const other = await mkUser(c, "acct2@vit.edu.in");
      await mkAccount(c, u, "sub-acct");
      await c.query("update auth_account set updated_at = now(), scope='openid' where user_id=$1", [u]);
      await assert.rejects(c.query("update auth_account set account_id='x' where user_id=$1", [u]), /immutable/);
      await assert.rejects(
        c.query("update auth_account set user_id=$1 where account_id='sub-acct'", [other]),
        /immutable/,
      );
      await assert.rejects(c.query("update auth_account set provider_id='github' where user_id=$1", [u]), /immutable/);
    }),
  );

  it("no OAuth token or password can be stored in auth_account: the database refuses every column", opts, () =>
    withClient(async (c) => {
      const u = await mkUser(c, "tok@vit.edu.in");
      await mkAccount(c, u, "sub-tok");
      for (const col of ["access_token", "refresh_token", "id_token", "password"]) {
        await assert.rejects(
          c.query(`update auth_account set ${col}='secret-value' where user_id=$1`, [u]),
          /auth_account_no_secrets/,
          col,
        );
      }
      for (const col of ["access_token_expires_at", "refresh_token_expires_at"]) {
        await assert.rejects(
          c.query(`update auth_account set ${col}=now() where user_id=$1`, [u]),
          /auth_account_no_secrets/,
          col,
        );
      }
      await assert.rejects(
        c.query(
          "insert into auth_account(user_id, account_id, provider_id, access_token) values ($1,'sub-t2','x','t')",
          [u],
        ),
        /auth_account_no_secrets/,
      );
    }),
  );

  it("deleting a user removes only its sessions and accounts; sessions can be deleted to invalidate them", opts, () =>
    withClient(async (c) => {
      const u = await mkUser(c, "gone@vit.edu.in");
      await mkAccount(c, u, "sub-gone");
      await c.query(
        "insert into auth_session(user_id, token, expires_at) values ($1,'tok-1', now() + interval '1 day')",
        [u],
      );
      await c.query("delete from auth_session where user_id=$1", [u]);
      assert.equal((await c.query("select count(*)::int n from auth_session where user_id=$1", [u])).rows[0].n, 0);
      await c.query(
        "insert into auth_session(user_id, token, expires_at) values ($1,'tok-2', now() + interval '1 day')",
        [u],
      );
      await c.query("delete from app_user where id=$1", [u]);
      assert.equal((await c.query("select count(*)::int n from auth_session where token='tok-2'")).rows[0].n, 0);
      assert.equal(
        (await c.query("select count(*)::int n from auth_account where account_id='sub-gone'")).rows[0].n,
        0,
      );
    }),
  );

  it("seeding still works on the migrated schema and the seed users carry email_verified", opts, async () => {
    const r = runNode(["scripts/db-seed.ts"], env());
    assert.equal(r.status, 0, r.stderr || r.stdout);
    await withClient(async (c) => {
      const rows = (
        await c.query(
          "select bool_and(email_verified) v, count(*)::int n from app_user where email like '%@seed.vshow.invalid'",
        )
      ).rows[0];
      assert.deepEqual(rows, { v: true, n: 8 });
    });
  });

  it("cleanup", async () => {
    await db.drop();
  });
});
