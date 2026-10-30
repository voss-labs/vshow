// Builds the app once, checks that no server-only code leaked into the browser bundle, then runs the REAL
// production server (react-router-serve) and exercises the authentication routes over HTTP.
// This test does not contact vauth: every request used here is answered before any identity-provider call.
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { VAUTH } from "../app/auth/config.server.ts";
import { createThrowawayDb, runNode } from "./helpers.ts";
import { TEST_SECRET, createAuthHarness, type CookieJar } from "./support/auth-harness.ts";

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });

const build = spawnSync(process.execPath, ["node_modules/@react-router/dev/bin.cjs", "build"], {
  encoding: "utf8",
  timeout: 120_000,
  env: { ...process.env, VSHOW_DEV_AUTH: "" },
});

describe("production build", () => {
  it("builds", () => {
    assert.equal(build.status, 0, build.stderr.slice(-600) || build.stdout.slice(-600));
  });

  it("keeps server-only code, auth libraries and secrets' names out of the browser bundle", () => {
    const files = walk("build/client").filter((f) => /\.(js|mjs|css|html|json|map)$/.test(f));
    assert.ok(files.length > 0);
    const forbidden = [
      "pino",
      "node-postgres",
      "drizzle-orm",
      "better-auth",
      "better-call",
      "jose",
      "DATABASE_URL",
      "BETTER_AUTH",
      "VOSS_CLIENT",
      "x-request-id",
      "createRequestScopeMiddleware",
      "sanitizeString",
      "getUserInfo",
      "vshow-dev-switcher",
      "/dev/sign-in",
      "oauth2/callback",
    ];
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      for (const needle of forbidden) assert.ok(!text.includes(needle), `${f} contains "${needle}"`);
    }
    const server = walk("build/server").filter((f) => f.endsWith(".js"));
    assert.ok(server.some((f) => readFileSync(f, "utf8").includes("request completed")));
  });
});

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

describe("running production server", async () => {
  const db = await createThrowawayDb("vshow_test_srv");
  const opts = { skip: db.skipReason || build.status !== 0 ? db.skipReason || "build failed" : false };
  const ORIGIN = "https://vshow.example.test";
  // The server is reached over plain http here, so React Router's own origin check (scheme+host) accepts only this.
  const HTTP_ORIGIN = ORIGIN.replace("https:", "http:");
  const SECRET_CODE = "OAUTHCODE-must-never-be-logged-0123";
  const SECRET_STATE = "OAUTHSTATE-must-never-be-logged-4567";
  let child: ChildProcess | undefined;
  let port = 0;
  let stdout = "";

  before(async () => {
    if (db.skipReason || build.status !== 0) return;
    const migrate = runNode(["scripts/db-migrate.ts"], {
      DB_TARGET: "local",
      DATABASE_URL: db.url,
      DATABASE_URL_DIRECT: "",
    });
    assert.equal(migrate.status, 0, migrate.stderr);
    port = await freePort();
    child = spawn(process.execPath, ["node_modules/@react-router/serve/dist/cli.js", "./build/server/index.js"], {
      env: {
        PATH: process.env.PATH ?? "",
        SystemRoot: process.env.SystemRoot ?? "",
        PORT: String(port),
        NODE_ENV: "production",
        LOG_LEVEL: "info",
        DB_TARGET: "local",
        DATABASE_URL: db.url,
        BETTER_AUTH_SECRET: randomBytes(32).toString("hex"), // random per run: no secret-shaped literal in source
        BETTER_AUTH_URL: ORIGIN,
        VOSS_DISCOVERY_URL: VAUTH.discoveryUrl,
        VOSS_CLIENT_ID: "e2e-client-id",
        VOSS_CLIENT_SECRET: randomBytes(16).toString("hex"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (stdout += d.toString()));
    for (let i = 0; i < 300; i++) {
      try {
        if ((await fetch(`http://127.0.0.1:${port}/login`)).status === 200) return;
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`server did not start:\n${stdout}`);
  });
  after(async () => {
    child?.kill();
    await new Promise((r) => setTimeout(r, 300));
    if (!db.skipReason) await db.drop();
  });

  // The server is reached on loopback but addressed as the configured host (Host header), so React Router's own
  // origin-versus-host check and Vshow's origin check both see a consistent same-site request.
  interface Res {
    status: number;
    headers: Headers;
    text(): Promise<string>;
  }
  const get = (
    path: string,
    init: { method?: string; headers?: Record<string, string>; body?: string | URLSearchParams } = {},
  ) =>
    new Promise<Res>((resolve, reject) => {
      const body = init.body instanceof URLSearchParams ? init.body.toString() : init.body;
      const headers: Record<string, string> = { host: new URL(ORIGIN).host, ...(init.headers ?? {}) };
      if (init.body instanceof URLSearchParams) headers["content-type"] = "application/x-www-form-urlencoded";
      if (body !== undefined) headers["content-length"] = String(Buffer.byteLength(body));
      const req = httpRequest({ host: "127.0.0.1", port, path, method: init.method ?? "GET", headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const h = new Headers();
          for (const [k, v] of Object.entries(res.headers)) {
            if (Array.isArray(v)) v.forEach((x) => h.append(k, x));
            else if (v !== undefined) h.set(k, v);
          }
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({ status: res.statusCode ?? 0, headers: h, text: async () => text });
        });
      });
      req.on("error", reject);
      req.end(body);
    });

  it("serves the login page with the sign-in button and a request ID", opts, async () => {
    const res = await get("/login");
    assert.equal(res.status, 200);
    assert.ok(res.headers.get("x-request-id"));
    const html = await res.text();
    assert.match(html, /Sign in with VOSS/);
    assert.doesNotMatch(html, /Local development identity switcher/);
  });

  it("protected pages redirect an anonymous visitor to /login", opts, async () => {
    for (const path of ["/me", "/unclaimed"]) {
      const res = await get(path);
      assert.equal(res.status, 302, path);
      assert.equal(res.headers.get("location"), "/login", path);
    }
  });

  it("the development switcher does not exist: page 404, POST 404, API 404", opts, async () => {
    assert.equal((await get("/dev/login")).status, 404);
    const post = await get("/dev/login", {
      method: "POST",
      headers: { origin: HTTP_ORIGIN },
      body: new URLSearchParams({ identity: "admin" }),
    });
    assert.equal(post.status, 404, `POST /dev/login -> ${post.status}: ${(await post.text()).slice(0, 300)}`);
    const api = await get("/api/auth/dev/sign-in", {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ identity: "admin" }),
    });
    assert.equal(api.status, 404);
    assert.equal(api.headers.getSetCookie().length, 0);
  });

  it("denies every /api/auth endpoint Vshow does not use, with no-store and no-referrer headers", opts, async () => {
    const cases: Array<[string, string]> = [
      ["GET", "/api/auth/get-session"],
      ["POST", "/api/auth/sign-in/email"],
      ["POST", "/api/auth/sign-up/email"],
      ["POST", "/api/auth/sign-out"],
      ["POST", "/api/auth/update-user"],
      ["POST", "/api/auth/callback/voss"],
      ["GET", "/api/auth/list-sessions"],
    ];
    for (const [method, path] of cases) {
      const res = await get(path, {
        method,
        headers: { origin: ORIGIN, "content-type": "application/json" },
        body: method === "POST" ? "{}" : undefined,
      });
      assert.equal(res.status, 404, `${method} ${path}`);
      assert.equal(res.headers.get("cache-control"), "no-store");
      assert.equal(res.headers.get("referrer-policy"), "no-referrer");
    }
  });

  it(
    "the OAuth callback keeps working (state is validated), redirects to /login, and is never cacheable or leaky",
    opts,
    async () => {
      const res = await get(
        `/api/auth/oauth2/callback/voss?code=${SECRET_CODE}&state=${SECRET_STATE}&iss=${encodeURIComponent(VAUTH.issuer)}`,
      );
      assert.equal(res.status, 302);
      const location = new URL(res.headers.get("location") as string);
      assert.equal(location.origin + location.pathname, `${ORIGIN}/login`);
      assert.ok(location.searchParams.get("error"), "an unknown state is reported as an error");
      assert.equal(res.headers.get("cache-control"), "no-store");
      assert.equal(res.headers.get("referrer-policy"), "no-referrer");
      assert.equal(
        res.headers.getSetCookie().some((c) => c.includes("session_token=") && !/max-age=0/i.test(c)),
        false,
        "no session is issued",
      );
    },
  );

  it("Vshow's own log lines never contain the callback's code or state", opts, async () => {
    await new Promise((resolve) => setTimeout(resolve, 600)); // let the server flush its log pipe
    const vshowLines = stdout.split(/\r?\n/).filter((l) => l.startsWith("{"));
    assert.ok(
      vshowLines.some((l) => l.includes('"path":"/api/auth/oauth2/callback/voss"')),
      `the callback request was logged (path only). Logged paths: ${vshowLines.map((l) => (JSON.parse(l) as { path?: string }).path).join(", ")}`,
    );
    for (const line of vshowLines) {
      assert.ok(!line.includes(SECRET_CODE) && !line.includes(SECRET_STATE), `leaked: ${line.slice(0, 120)}`);
    }
  });

  it("the login page maps error codes to fixed text and never reflects the query string", opts, async () => {
    const page = async (code: string) => {
      const res = await get(`/login?error=${code}`);
      assert.equal(res.status, 200);
      return res.text();
    };
    const xss = await page(encodeURIComponent("<script>alert(1)</script>"));
    assert.doesNotMatch(xss, /<script>alert/);
    assert.match(xss, /Sign-in failed\. Please try again\./);

    // React Router embeds the URL in its (escaped) hydration payload; what must not happen is the value being
    // shown as page text, so look at the markup outside <script> blocks.
    const visible = (html: string) => html.replace(/<script[\s\S]*?<\/script>/g, "");
    const unknown = await page("some_unknown_code_12345");
    const v = visible(unknown);
    const at = v.indexOf("some_unknown_code_12345");
    assert.equal(at, -1, `value shown outside scripts: ...${v.slice(Math.max(0, at - 120), at + 60)}...`);
    assert.match(unknown, /Sign-in failed\. Please try again\./);

    assert.match(await page("state_mismatch"), /sign-in session expired/);
    assert.match(await page("inactive"), /has been deactivated/);
  });

  it("state-changing posts from a foreign origin are refused", opts, async () => {
    for (const path of ["/login", "/logout"]) {
      const res = await get(path, {
        method: "POST",
        headers: { origin: "https://evil.example" },
        body: new URLSearchParams(),
      });
      // Refused by React Router's own origin check (400) or by Vshow's (403): never processed.
      assert.ok(res.status === 400 || res.status === 403, `${path} -> ${res.status}`);
      assert.equal(res.headers.getSetCookie().length, 0);
    }
  });

  it("GET /logout never signs anyone out", opts, async () => {
    const res = await get("/logout");
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "/");
  });

  it(
    "Vshow's own origin check refuses a post whose origin is not the configured one, even when React Router accepts it",
    opts,
    async () => {
      // HTTP_ORIGIN passes React Router's scheme+host check against this plain-http request, but it is not
      // BETTER_AUTH_URL (https), so Vshow's assertSameOrigin must reject it before anything happens.
      for (const path of ["/login", "/logout"]) {
        const res = await get(path, { method: "POST", headers: { origin: HTTP_ORIGIN }, body: new URLSearchParams() });
        assert.equal(res.status, 403, path);
        assert.equal(res.headers.getSetCookie().length, 0);
      }
    },
  );
});

// ---------------------------------------------------------------------------------------------------------
// Regression: authentication configuration missing (no vauth client credentials, dev switcher off).
// /me, /unclaimed, /logout and a direct POST /login used to answer 500; they must answer cleanly instead, while
// still granting nothing and never exposing the reason.
describe("running production server WITHOUT vauth credentials", async () => {
  const db = await createThrowawayDb("vshow_test_nocred");
  const opts = { skip: db.skipReason || build.status !== 0 ? db.skipReason || "build failed" : false };
  const ORIGIN = "https://vshow.example.test";
  const HTTP_ORIGIN = ORIGIN.replace("https:", "http:"); // what React Router's own origin check accepts over plain http
  const SESSION_SECRET = randomBytes(32).toString("hex");
  let child: ChildProcess | undefined;
  let port = 0;
  let stdout = "";

  before(async () => {
    if (db.skipReason || build.status !== 0) return;
    const migrate = runNode(["scripts/db-migrate.ts"], {
      DB_TARGET: "local",
      DATABASE_URL: db.url,
      DATABASE_URL_DIRECT: "",
    });
    assert.equal(migrate.status, 0, migrate.stderr);
    port = await freePort();
    child = spawn(process.execPath, ["node_modules/@react-router/serve/dist/cli.js", "./build/server/index.js"], {
      env: {
        PATH: process.env.PATH ?? "",
        SystemRoot: process.env.SystemRoot ?? "",
        PORT: String(port),
        NODE_ENV: "production",
        LOG_LEVEL: "info",
        DB_TARGET: "local",
        DATABASE_URL: db.url,
        BETTER_AUTH_SECRET: SESSION_SECRET,
        BETTER_AUTH_URL: ORIGIN,
        VOSS_DISCOVERY_URL: VAUTH.discoveryUrl,
        // VOSS_CLIENT_ID / VOSS_CLIENT_SECRET deliberately absent; VSHOW_DEV_AUTH absent (switcher off).
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (stdout += d.toString()));
    for (let i = 0; i < 300; i++) {
      try {
        if ((await fetch(`http://127.0.0.1:${port}/login`)).status === 200) return;
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`server did not start:\n${stdout}`);
  });
  after(async () => {
    child?.kill();
    await new Promise((r) => setTimeout(r, 300));
    if (!db.skipReason) await db.drop();
  });

  interface Res {
    status: number;
    headers: Headers;
    body: string;
  }
  const send = (path: string, method = "GET", headers: Record<string, string> = {}, form?: URLSearchParams) =>
    new Promise<Res>((resolve, reject) => {
      const body = form?.toString();
      const h: Record<string, string> = { host: new URL(ORIGIN).host, ...headers };
      if (body !== undefined) {
        h["content-type"] = "application/x-www-form-urlencoded";
        h["content-length"] = String(Buffer.byteLength(body));
      }
      const req = httpRequest({ host: "127.0.0.1", port, path, method, headers: h }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const out = new Headers();
          for (const [k, v] of Object.entries(res.headers)) {
            if (Array.isArray(v)) v.forEach((x) => out.append(k, x));
            else if (v !== undefined) out.set(k, v);
          }
          resolve({ status: res.statusCode ?? 0, headers: out, body: Buffer.concat(chunks).toString("utf8") });
        });
      });
      req.on("error", reject);
      req.end(body);
    });

  // Nothing about the cause, the configuration or the runtime may reach the browser.
  const assertNothingLeaked = (res: Res, label: string) => {
    const headerText = JSON.stringify([...res.headers]);
    for (const needle of [
      "AuthConfigError",
      "VOSS_CLIENT",
      "BETTER_AUTH",
      SESSION_SECRET,
      "node_modules",
      "at async",
    ]) {
      assert.ok(!res.body.includes(needle), `${label}: response contains "${needle}"`);
      assert.ok(!headerText.includes(needle), `${label}: headers contain "${needle}"`);
    }
  };

  it("/me answers 503 (not 500) with fixed text, and grants nothing", opts, async () => {
    const res = await send("/me");
    assert.equal(res.status, 503);
    assert.match(res.body, /Service Unavailable/);
    assert.doesNotMatch(res.body, /REVIEWER|Roles/);
    assertNothingLeaked(res, "/me");
  });

  it("/unclaimed answers 503, not 500, and does not show the page", opts, async () => {
    const res = await send("/unclaimed");
    assert.equal(res.status, 503);
    assert.match(res.body, /Service Unavailable/);
    assert.doesNotMatch(res.body, /access is not set up yet/);
    assertNothingLeaked(res, "/unclaimed");
  });

  it("/logout ends the session locally: expires every auth cookie and redirects to /login", opts, async () => {
    const res = await send(
      "/logout",
      "POST",
      { origin: HTTP_ORIGIN, cookie: "vshow.session_token=stale.value" },
      new URLSearchParams(),
    );
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "/login");
    assert.equal(res.headers.get("cache-control"), "no-store");
    const cookies = res.headers.getSetCookie();
    for (const name of ["vshow.session_token", "__Secure-vshow.session_token", "vshow.state"]) {
      assert.ok(
        cookies.some((c) => c.startsWith(`${name}=;`) && /Max-Age=0/i.test(c)),
        `${name} must be expired`,
      );
    }
    assert.ok(
      cookies.every((c) => !c.includes("stale.value")),
      "the stale value is never echoed back",
    );
    assertNothingLeaked(res, "/logout");
  });

  it("GET /logout still signs nobody out", opts, async () => {
    const res = await send("/logout");
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "/");
    assert.equal(res.headers.getSetCookie().length, 0);
  });

  it(
    "a direct POST /login answers 503: the form is not offered, but the action must not 500 either",
    opts,
    async () => {
      const res = await send("/login", "POST", { origin: HTTP_ORIGIN }, new URLSearchParams());
      assert.equal(res.status, 503);
      assert.equal(res.headers.getSetCookie().length, 0, "no OAuth state cookie is issued");
      assertNothingLeaked(res, "POST /login");
    },
  );

  it("the public pages and the other guards behave as before", opts, async () => {
    const login = await send("/login");
    assert.equal(login.status, 200);
    assert.match(login.body, /Sign-in is not available right now/);
    assert.doesNotMatch(login.body, /Sign in with VOSS/);
    assert.equal((await send("/dev/login")).status, 404, "the switcher is not enabled");
    assert.equal((await send("/api/auth/ok")).status, 503);
    assert.equal((await send("/api/auth/get-session")).status, 404, "default-deny is checked before configuration");
    const foreign = await send("/logout", "POST", { origin: "https://evil.example" }, new URLSearchParams());
    assert.equal(foreign.status, 403, "a foreign origin is refused by Vshow's host check, with no cookies touched");
    assert.equal(foreign.headers.getSetCookie().length, 0);
  });

  it("the cause is logged by variable name only: no exception object, no stack, no secret", opts, async () => {
    await send("/me");
    await new Promise((r) => setTimeout(r, 600)); // let the server flush its log pipe
    const lines = stdout.split(/\r?\n/).filter((l) => l.startsWith("{"));
    const reasons = lines.filter(
      (l) => (JSON.parse(l) as { msg?: string }).msg === "authentication is not configured correctly",
    );
    assert.ok(reasons.length >= 1);
    for (const l of reasons) {
      const rec = JSON.parse(l) as Record<string, unknown>;
      assert.equal(rec.level, "error");
      assert.match(String(rec.reason), /VOSS_CLIENT_ID is not set/);
      assert.ok(!("err" in rec) && !("stack" in rec), "no exception object or stack in the record");
    }
    for (const l of lines) assert.ok(!l.includes(SESSION_SECRET), "the session secret never reaches the logs");
  });
});

// ---------------------------------------------------------------------------------------------------------
// The convener -> reviewer workflow over real HTTP against the real production build, with REAL signed-in sessions
// (created through the mock identity provider and Better Auth). Object storage is deliberately NOT configured here:
// it proves that media routes fail closed. (Upload/finalize logic is covered with an in-memory store elsewhere;
// real Neon storage and browser uploads have not been verified.)
describe("workflow routes over HTTP (production build, real sessions)", async () => {
  const ORIGIN_W = "https://vshow.example.test";
  const h = await createAuthHarness({ baseURL: ORIGIN_W });
  const opts = { skip: h.skipReason || build.status !== 0 ? h.skipReason || "build failed" : false };
  let child: ChildProcess | undefined;
  let port = 0;
  let out = "";
  const jars: Record<string, CookieJar> = {};
  const ids: Record<string, string> = {};

  async function signInAs(key: string, email: string, roles: string[], committee?: string) {
    Object.assign(h.idp.tweaks.profile, { sub: `sub-${key}`, email, name: key, email_verified: true });
    const r = await h.signIn();
    assert.equal(r.errorCode, null, `sign-in of ${key}`);
    jars[key] = r.jar;
    const [u] = await h.q<{ id: string }>("select id from app_user where email = $1", [email]);
    ids[key] = u.id;
    for (const code of roles) {
      const [role] = await h.q<{ id: string }>(
        "insert into app_role(code, name) values ($1::text, $1::text) on conflict (code) do update set name = excluded.name returning id",
        [code],
      );
      await h.q("insert into user_role(user_id, role_id) values ($1,$2)", [u.id, role.id]);
    }
    if (committee) {
      await h.q("insert into committee_membership(committee_id, user_id, membership_type) values ($1,$2,'CONVENER')", [
        committee,
        u.id,
      ]);
    }
  }

  let media = "";
  let robotics = "";
  let lobby = "";

  before(async () => {
    if (h.skipReason || build.status !== 0) return;
    media = (await h.q<{ id: string }>("insert into committee(name, code) values ('Media','media') returning id"))[0]
      .id;
    robotics = (
      await h.q<{ id: string }>("insert into committee(name, code) values ('Robotics','robotics') returning id")
    )[0].id;
    lobby = (await h.q<{ id: string }>("insert into screen(name, code) values ('Lobby','lobby') returning id"))[0].id;
    await signInAs("convener", "convener@vit.edu.in", ["CONVENER"], media);
    await signInAs("convenerb", "convenerb@vit.edu.in", ["CONVENER"], robotics);
    await signInAs("reviewer", "reviewer@vit.edu.in", ["REVIEWER"]);
    await signInAs("manager", "manager@vit.edu.in", ["SERVER_ROOM_MANAGER"]);
    await signInAs("plain", "plain@vit.edu.in", []);
    port = await freePort();
    child = spawn(process.execPath, ["node_modules/@react-router/serve/dist/cli.js", "./build/server/index.js"], {
      env: {
        PATH: process.env.PATH ?? "",
        SystemRoot: process.env.SystemRoot ?? "",
        PORT: String(port),
        NODE_ENV: "production",
        LOG_LEVEL: "info",
        DB_TARGET: "local",
        DATABASE_URL: h.dbUrl,
        BETTER_AUTH_SECRET: TEST_SECRET,
        BETTER_AUTH_URL: ORIGIN_W,
        VOSS_DISCOVERY_URL: VAUTH.discoveryUrl,
        VOSS_CLIENT_ID: "e2e-client-id",
        VOSS_CLIENT_SECRET: randomBytes(16).toString("hex"),
        // NEON_STORAGE_* deliberately absent: media storage is unconfigured.
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (out += d.toString()));
    for (let i = 0; i < 300; i++) {
      try {
        if ((await fetch(`http://127.0.0.1:${port}/login`)).status === 200) return;
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`server did not start:\n${out}`);
  });
  after(async () => {
    child?.kill();
    await new Promise((r) => setTimeout(r, 300));
    if (!h.skipReason) await h.close();
  });

  interface R {
    status: number;
    headers: Headers;
    body: string;
  }
  const send = (
    path: string,
    o: { method?: string; as?: string; origin?: string | null; form?: Record<string, string>; json?: unknown } = {},
  ) =>
    new Promise<R>((resolve, reject) => {
      const headers: Record<string, string> = { host: new URL(ORIGIN_W).host };
      if (o.as) headers.cookie = jars[o.as].header();
      // Over plain http React Router and Vshow cannot both accept an Origin header (one compares scheme+host with the
      // request, the other with the https base URL), so positive requests send none (as a non-browser client would);
      // refusals pass an explicit foreign Origin.
      const origin = o.origin ?? null;
      if (origin) headers.origin = origin;
      let body: string | undefined;
      if (o.form) {
        body = new URLSearchParams(o.form).toString();
        headers["content-type"] = "application/x-www-form-urlencoded";
      } else if (o.json !== undefined) {
        body = JSON.stringify(o.json);
        headers["content-type"] = "application/json";
      }
      if (body !== undefined) headers["content-length"] = String(Buffer.byteLength(body));
      const req = httpRequest({ host: "127.0.0.1", port, path, method: o.method ?? "GET", headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const hs = new Headers();
          for (const [k, v] of Object.entries(res.headers)) {
            if (Array.isArray(v)) v.forEach((x) => hs.append(k, x));
            else if (v !== undefined) hs.set(k, v);
          }
          resolve({ status: res.statusCode ?? 0, headers: hs, body: Buffer.concat(chunks).toString("utf8") });
        });
      });
      req.on("error", reject);
      req.end(body);
    });
  const submissionStatus = async (id: string) =>
    (await h.q<{ s: string }>("select workflow_status s from submission where id=$1", [id]))[0].s;

  let submissionId = "";
  let revisionId = "";

  it("anonymous visitors are redirected to sign in; JSON endpoints answer 401", opts, async () => {
    for (const path of ["/submissions", "/submissions/new", "/review", `/review/${ids.convener}`]) {
      const r = await send(path);
      assert.equal(r.status, 302, path);
      assert.equal(r.headers.get("location"), "/login", path);
    }
    const up = await send(`/submissions/${ids.convener}/upload`, { method: "POST", json: {} });
    assert.equal(up.status, 401);
    assert.equal(JSON.parse(up.body).error.code, "unauthorized");
    const fin = await send(`/submissions/${ids.convener}/upload/finalize`, { method: "POST", json: {} });
    assert.equal(fin.status, 401);
    const dl = await send(`/submissions/${ids.convener}/versions/${ids.convener}/file`);
    assert.equal(dl.status, 302);
    assert.equal(dl.headers.get("location"), "/login");
    const pv = await send(`/submissions/${ids.convener}/versions/${ids.convener}/preview`);
    assert.equal(pv.status, 302, "an anonymous preview request is refused too");
    assert.equal(pv.headers.get("location"), "/login");
  });

  it(
    "each role reaches only its own area: wrong roles get 403, unassigned users are sent to /unclaimed",
    opts,
    async () => {
      assert.equal((await send("/submissions", { as: "convener" })).status, 200);
      assert.equal((await send("/review", { as: "reviewer" })).status, 200);
      assert.equal((await send("/review", { as: "convener" })).status, 403);
      assert.equal((await send("/submissions", { as: "reviewer" })).status, 403);
      assert.equal((await send("/submissions", { as: "manager" })).status, 403);
      assert.equal((await send("/review", { as: "manager" })).status, 403);
      const plain = await send("/submissions", { as: "plain" });
      assert.equal(plain.status, 302);
      assert.equal(plain.headers.get("location"), "/unclaimed");
    },
  );

  it("a convener creates a draft and sees it; a foreign-origin POST is refused and creates nothing", opts, async () => {
    const before = (await h.q("select 1 from submission")).length;
    const foreign = await send("/submissions/new", {
      method: "POST",
      as: "convener",
      origin: "https://evil.example",
      form: { committeeId: media, title: "Evil" },
    });
    assert.ok([400, 403].includes(foreign.status), String(foreign.status));
    assert.equal((await h.q("select 1 from submission")).length, before);

    const created = await send("/submissions/new", {
      method: "POST",
      as: "convener",
      form: { committeeId: media, title: "Welcome poster", description: "d" },
    });
    assert.equal(created.status, 302, created.body.slice(0, 200));
    const loc = created.headers.get("location") ?? "";
    assert.match(loc, /^\/submissions\/[0-9a-f-]{36}$/);
    submissionId = loc.split("/").pop()!;
    const page = await send(loc, { as: "convener" });
    assert.equal(page.status, 200);
    assert.match(page.body, /Welcome poster/);
    assert.match(page.body, /VS-\d{4}-\d{6}/);
    const list = await send("/submissions", { as: "convener" });
    assert.match(list.body, /Welcome poster/);
  });

  it("creating for a committee you do not belong to is refused", opts, async () => {
    const r = await send("/submissions/new", {
      method: "POST",
      as: "convener",
      form: { committeeId: robotics, title: "Not mine" },
    });
    assert.equal(r.status, 403);
    assert.equal((await h.q("select 1 from submission where title='Not mine'")).length, 0);
  });

  it(
    "another committee's convener, reviewers, the manager and unassigned users cannot see the draft",
    opts,
    async () => {
      for (const who of ["convenerb", "reviewer", "manager", "plain"]) {
        const r = await send(`/submissions/${submissionId}`, { as: who });
        assert.ok([302, 403, 404].includes(r.status), `${who}: ${r.status}`);
        assert.ok(!r.body.includes("Welcome poster"), `${who} saw the draft`);
      }
      assert.equal((await send(`/submissions/${submissionId}`, { as: "convenerb" })).status, 404);
      assert.equal(
        (await send(`/review/${submissionId}`, { as: "reviewer" })).status,
        404,
        "drafts are invisible to reviewers",
      );
      const queue = await send("/review", { as: "reviewer" });
      assert.ok(!queue.body.includes("Welcome poster"));
      // nor can they modify it
      const edit = await send(`/submissions/${submissionId}`, {
        method: "POST",
        as: "convenerb",
        form: { intent: "save", title: "Hacked", windows: "[]" },
      });
      assert.equal(edit.status, 404);
      assert.equal(
        (await h.q<{ title: string }>("select title from submission where id=$1", [submissionId]))[0].title,
        "Welcome poster",
      );
    },
  );

  it(
    "saving windows works, overlapping windows included, and invalid ones are refused with field codes",
    opts,
    async () => {
      const ok = [
        { screenId: lobby, startAt: "2099-02-01T10:00", endAt: "2099-02-01T12:00", note: "" },
        { screenId: lobby, startAt: "2099-02-01T10:00", endAt: "2099-02-01T12:00", note: "same time again" },
      ];
      const saved = await send(`/submissions/${submissionId}`, {
        method: "POST",
        as: "convener",
        form: { intent: "save", title: "Welcome poster", description: "d", windows: JSON.stringify(ok) },
      });
      assert.equal(saved.status, 200, saved.body.slice(0, 300));
      assert.equal((await h.q("select 1 from screen_request where submission_id=$1", [submissionId])).length, 2);
      const bad = await send(`/submissions/${submissionId}`, {
        method: "POST",
        as: "convener",
        form: {
          intent: "save",
          title: "Welcome poster",
          windows: JSON.stringify([{ screenId: lobby, startAt: "2099-02-01T12:00", endAt: "2099-02-01T10:00" }]),
        },
      });
      assert.equal(bad.status, 422);
      assert.match(bad.body, /the end must be after the start/);
      assert.equal(
        (await h.q("select 1 from screen_request where submission_id=$1", [submissionId])).length,
        2,
        "the failed save changed nothing",
      );
    },
  );

  it("media routes fail closed while storage is unconfigured: fixed 503, no reservation, no media", opts, async () => {
    const r = await send(`/submissions/${submissionId}/upload`, {
      method: "POST",
      as: "convener",
      json: { filename: "a.png", contentType: "image/png", sizeBytes: 100 },
    });
    assert.equal(r.status, 503);
    const body = JSON.parse(r.body) as { error: { code: string } };
    assert.equal(body.error.code, "storage_unavailable");
    assert.ok(!/NEON_STORAGE|bucket|endpoint|secret/i.test(r.body));
    assert.equal((await h.q("select 1 from upload_reservation")).length, 0);
    assert.equal((await h.q("select 1 from media_version")).length, 0);
    // other callers never get that far
    const other = await send(`/submissions/${submissionId}/upload`, {
      method: "POST",
      as: "convenerb",
      json: { filename: "a.png", contentType: "image/png", sizeBytes: 100 },
    });
    assert.equal(other.status, 404);
    const reviewer = await send(`/submissions/${submissionId}/upload`, {
      method: "POST",
      as: "reviewer",
      json: { filename: "a.png", contentType: "image/png", sizeBytes: 100 },
    });
    assert.equal(reviewer.status, 403);
    const wrongOrigin = await send(`/submissions/${submissionId}/upload`, {
      method: "POST",
      as: "convener",
      origin: "https://evil.example",
      json: { filename: "a.png", contentType: "image/png", sizeBytes: 100 },
    });
    assert.ok([400, 403].includes(wrongOrigin.status));
    const invalid = await send(`/submissions/${submissionId}/upload`, {
      method: "POST",
      as: "convener",
      json: { filename: "a.gif", contentType: "image/gif", sizeBytes: 100 },
    });
    assert.equal(invalid.status, 422, "an unsupported type is rejected before storage is even considered");
  });

  it("submitting without media is refused; with media (recorded directly here) it goes to review", opts, async () => {
    const noMedia = await send(`/submissions/${submissionId}`, {
      method: "POST",
      as: "convener",
      form: { intent: "submit" },
    });
    assert.equal(noMedia.status, 422);
    assert.match(noMedia.body, /Upload the media before submitting/);
    assert.equal(await submissionStatus(submissionId), "DRAFT");

    // Stand in for a finalized upload (the real upload path needs object storage, tested separately).
    const [v] = await h.q<{ id: string }>(
      "insert into media_version(submission_id, version_number, object_key, original_filename, content_type, size_bytes, uploaded_by_user_id) values ($1,1,$2,'poster.png','image/png',16,$3) returning id",
      [submissionId, `media/${submissionId}/test.png`, ids.convener],
    );
    await h.q("update submission set current_version_id=$1 where id=$2", [v.id, submissionId]);
    const sent = await send(`/submissions/${submissionId}`, {
      method: "POST",
      as: "convener",
      form: { intent: "submit" },
    });
    assert.equal(sent.status, 200, sent.body.slice(0, 300));
    assert.equal(await submissionStatus(submissionId), "PENDING_REVIEW");
    revisionId = (
      await h.q<{ id: string }>("select current_revision_id id from submission where id=$1", [submissionId])
    )[0].id;
    // pending: cannot be edited or submitted again, over HTTP too
    const edit = await send(`/submissions/${submissionId}`, {
      method: "POST",
      as: "convener",
      form: { intent: "save", title: "Changed while pending", windows: "[]" },
    });
    assert.equal(edit.status, 409);
    assert.equal(
      (await send(`/submissions/${submissionId}`, { method: "POST", as: "convener", form: { intent: "submit" } }))
        .status,
      409,
    );
  });

  it(
    "the reviewer sees it in the queue and on its page; media downloads fail closed without storage",
    opts,
    async () => {
      const queue = await send("/review", { as: "reviewer" });
      assert.match(queue.body, /Welcome poster/);
      const page = await send(`/review/${submissionId}`, { as: "reviewer" });
      assert.equal(page.status, 200);
      const text = page.body.replaceAll("<!-- -->", ""); // React inserts comment nodes between adjacent text parts
      assert.match(text, /Revision 1/);
      assert.match(text, /Record decision/);
      const [{ id: vid }] = await h.q<{ id: string }>("select id from media_version where submission_id=$1", [
        submissionId,
      ]);
      const dl = await send(`/submissions/${submissionId}/versions/${vid}/file`, { as: "reviewer" });
      assert.equal(dl.status, 503);
      assert.equal(dl.headers.get("location"), null, "no URL is ever produced");
      const stranger = await send(`/submissions/${submissionId}/versions/${vid}/file`, { as: "convenerb" });
      assert.equal(stranger.status, 404);

      // The page offers an in-page preview that points at OUR route (never at a signed storage URL).
      assert.ok(
        page.body.includes(`/submissions/${submissionId}/versions/${vid}/preview`),
        "the reviewer page previews the exact version under review",
      );
      assert.match(text, /Open full size/);
      assert.doesNotMatch(page.body, /X-Amz-|\.neon\.tech/);
      const pv = await send(`/submissions/${submissionId}/versions/${vid}/preview`, { as: "reviewer" });
      assert.equal(pv.status, 503, "preview fails closed without storage, like a download");
      assert.equal(pv.headers.get("location"), null, "no URL is ever produced");
      assert.equal(
        (await send(`/submissions/${submissionId}/versions/${vid}/preview`, { as: "convenerb" })).status,
        404,
      );
      assert.equal((await send(`/submissions/${submissionId}/versions/${vid}/preview`, { as: "manager" })).status, 404);
      const own = await send(`/submissions/${submissionId}`, { as: "convener" });
      assert.ok(own.body.includes(`/submissions/${submissionId}/versions/${vid}/preview`), "the convener sees it too");
    },
  );

  it("decision rules over HTTP: mandatory reason, foreign origin, non-reviewers, stale revision", opts, async () => {
    const decide = (as: string, form: Record<string, string>, origin?: string | null) =>
      send(`/review/${submissionId}`, { method: "POST", as, form, origin });
    const noReason = await decide("reviewer", { revisionId, decision: "REJECTED", comment: "  " });
    assert.equal(noReason.status, 422);
    assert.match(noReason.body, /comment or reason is required/);
    const noReason2 = await decide("reviewer", { revisionId, decision: "CHANGES_REQUESTED" });
    assert.equal(noReason2.status, 422);
    assert.equal((await decide("convener", { revisionId, decision: "APPROVED" })).status, 403);
    assert.equal((await decide("manager", { revisionId, decision: "APPROVED" })).status, 403);
    const foreign = await decide("reviewer", { revisionId, decision: "APPROVED" }, "https://evil.example");
    assert.ok([400, 403].includes(foreign.status));
    const stale = await decide("reviewer", {
      revisionId: "00000000-0000-4000-8000-000000000000",
      decision: "APPROVED",
    });
    assert.equal(stale.status, 409);
    assert.equal(await submissionStatus(submissionId), "PENDING_REVIEW", "no refused attempt changed anything");
    assert.equal((await h.q("select 1 from review_decision where submission_id=$1", [submissionId])).length, 0);
  });

  it("request changes -> the convener sees the comment, edits and resubmits -> approve", opts, async () => {
    const changes = await send(`/review/${submissionId}`, {
      method: "POST",
      as: "reviewer",
      form: { revisionId, decision: "CHANGES_REQUESTED", comment: "Please fix the date." },
    });
    assert.equal(changes.status, 302);
    assert.equal(changes.headers.get("location"), "/review");
    assert.equal(await submissionStatus(submissionId), "CHANGES_REQUESTED");
    const page = await send(`/submissions/${submissionId}`, { as: "convener" });
    assert.match(page.body, /Please fix the date\./);
    const windows = JSON.stringify([{ screenId: lobby, startAt: "2099-03-01T10:00", endAt: "2099-03-01T12:00" }]);
    assert.equal(
      (
        await send(`/submissions/${submissionId}`, {
          method: "POST",
          as: "convener",
          form: { intent: "save", title: "Welcome poster v2", windows },
        })
      ).status,
      200,
    );
    assert.equal(
      (await send(`/submissions/${submissionId}`, { method: "POST", as: "convener", form: { intent: "submit" } }))
        .status,
      200,
    );
    const [{ id: rev2 }] = await h.q<{ id: string }>("select current_revision_id id from submission where id=$1", [
      submissionId,
    ]);
    assert.notEqual(rev2, revisionId);
    // approving the OLD revision is refused as stale; the new one is accepted
    const stale = await send(`/review/${submissionId}`, {
      method: "POST",
      as: "reviewer",
      form: { revisionId, decision: "APPROVED" },
    });
    assert.equal(stale.status, 409);
    const ok = await send(`/review/${submissionId}`, {
      method: "POST",
      as: "reviewer",
      form: { revisionId: rev2, decision: "APPROVED" },
    });
    assert.equal(ok.status, 302);
    assert.equal(await submissionStatus(submissionId), "APPROVED");
    assert.equal(
      (await h.q("select 1 from review_decision where submission_id=$1", [submissionId])).length,
      2,
      "history is kept",
    );
    const done = await send(`/submissions/${submissionId}`, { as: "convener" });
    assert.match(done.body, /Approved/);
  });

  it("editing after approval withdraws it; the logs never contain secrets or storage details", opts, async () => {
    const windows = JSON.stringify([{ screenId: lobby, startAt: "2099-04-01T10:00", endAt: "2099-04-01T12:00" }]);
    const edit = await send(`/submissions/${submissionId}`, {
      method: "POST",
      as: "convener",
      form: { intent: "save", title: "Welcome poster v3", windows },
    });
    assert.equal(edit.status, 200);
    assert.equal(await submissionStatus(submissionId), "DRAFT");
    await new Promise((r) => setTimeout(r, 400));
    assert.ok(!out.includes(TEST_SECRET), "the session secret never reaches the logs");
    assert.ok(!/nsk_|nak_|X-Amz-Signature/i.test(out));
  });
});
