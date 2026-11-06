/**
 * Browser auth (#9) integration — Task #9, PROJECT_BIBLE §7 tier-1.
 *
 * A control-plane-native operator login: passphrase → httpOnly session cookie validated server-side.
 * The guard accepts the cookie OR the admin bearer; logged-out browsers (Accept: text/html) are
 * redirected to /login, API callers get 401. The cookie also authorizes the same-origin WebSocket.
 */

import { createHash } from "node:crypto";
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/http/app.js";
import { SqliteRegistry, seedDefaults } from "../src/registry/sqlite-repository.js";
import { RegistryService } from "../src/registry/service.js";
import { McpRegistrationService } from "../src/registry/mcp-registration.js";
import { SessionStore } from "../src/http/auth/session.js";
import type { PollerLogger } from "../src/console/poller.js";

const TOKEN = "super-strong-admin-token-0123456789abcdef";
const PASSWORD = "correct-horse-battery-staple";

function makeApp(log?: PollerLogger): FastifyInstance {
  const repo = new SqliteRegistry(":memory:");
  seedDefaults(repo);
  const registry = new RegistryService(repo);
  const mcp = new McpRegistrationService({
    createServer: vi.fn(),
    getServers: vi.fn(async () => ({ success: true, servers: [] }))
  } as never);
  return buildApp({ adminToken: TOKEN, registry, mcp, operatorPassword: PASSWORD, sessions: new SessionStore(), ...(log ? { log } : {}) });
}

const form = (password: string) => ({
  headers: { "content-type": "application/x-www-form-urlencoded" },
  payload: `password=${encodeURIComponent(password)}`
});
const html = { accept: "text/html" };

describe("Browser auth (#9)", () => {
  let app: FastifyInstance;
  beforeEach(() => {
    app = makeApp();
  });

  it("serves a public login form", async () => {
    const res = await app.inject({ method: "GET", url: "/login" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatch(/name="password"/);
    expect(res.body).toMatch(/<form[^>]*method="post"[^>]*action="\/login"|action="\/login"[^>]*method="post"/i);
  });

  it("rejects a wrong password with no session cookie", async () => {
    const res = await app.inject({ method: "POST", url: "/login", ...form("wrong") });
    expect(res.statusCode).toBe(401);
    expect(res.cookies.find((c) => c.name === "pantheon_session")).toBeUndefined();
  });

  it("accepts the correct password, sets an httpOnly session cookie, and redirects to /harness", async () => {
    const res = await app.inject({ method: "POST", url: "/login", ...form(PASSWORD) });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/harness");
    const cookie = res.cookies.find((c) => c.name === "pantheon_session");
    expect(cookie).toBeDefined();
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite?.toLowerCase()).toBe("lax");
    expect(cookie?.value).toMatch(/^[a-f0-9]{64}$/);
  });

  it("authorizes a guarded page via the session cookie", async () => {
    const login = await app.inject({ method: "POST", url: "/login", ...form(PASSWORD) });
    const sid = login.cookies.find((c) => c.name === "pantheon_session")!.value;
    const res = await app.inject({ method: "GET", url: "/harness", headers: { ...html, cookie: `pantheon_session=${sid}` } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatch(/New Session/i);
  });

  it("redirects a logged-out browser (Accept: text/html) to /login", async () => {
    const res = await app.inject({ method: "GET", url: "/harness", headers: html });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/login");
  });

  it("returns 401 (not a redirect) for an unauthenticated API call", async () => {
    const res = await app.inject({ method: "GET", url: "/api/dev-machines" });
    expect(res.statusCode).toBe(401);
  });

  it("still accepts the admin bearer token (API/scripts keep working)", async () => {
    const res = await app.inject({ method: "GET", url: "/api/dev-machines", headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.statusCode).toBe(200);
  });

  it("logout invalidates the session (the old cookie no longer authorizes)", async () => {
    const login = await app.inject({ method: "POST", url: "/login", ...form(PASSWORD) });
    const sid = login.cookies.find((c) => c.name === "pantheon_session")!.value;
    const cookieHdr = `pantheon_session=${sid}`;
    expect((await app.inject({ method: "POST", url: "/logout", headers: { cookie: cookieHdr } })).statusCode).toBeLessThan(400);
    const after = await app.inject({ method: "GET", url: "/harness", headers: { ...html, cookie: cookieHdr } });
    expect(after.statusCode).toBe(302); // back to /login
  });
});

describe("root path — what a bookmark or the chat UI's shortcut actually hits", () => {
  let app: FastifyInstance;
  beforeEach(() => {
    app = makeApp();
  });

  // Regression for BUGS #15: `/` had no route at all. Logged OUT the gap was invisible, because
  // the auth hook redirects to /login before routing; logged IN the request reached Fastify's
  // 404 handler and the operator got raw JSON ("Route GET:/ not found") from a link.
  it("sends an authenticated browser from / to the harness", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/",
      headers: { authorization: `Bearer ${TOKEN}`, ...html }
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/harness");
  });

  it("still sends a logged-out browser from / to /login (fail-closed unchanged)", async () => {
    const res = await app.inject({ method: "GET", url: "/", headers: html });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/login");
  });

  it("does not hand an unauthenticated API caller a redirect", async () => {
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(401);
  });
});

// BUGS #79: sign-in success (info), sign-in refused (warn) and sign-out (info) each leave one structured line with
// the request id as correlation id — never the password, never the session id (only its 12-hex SHA-256 prefix).
describe("operator sign-in and sign-out are logged (BUGS #79)", () => {
  interface Line {
    readonly level: "info" | "warn" | "error";
    readonly obj: Record<string, unknown>;
    readonly msg: string | undefined;
  }
  const capture = (): { log: PollerLogger; lines: Line[] } => {
    const lines: Line[] = [];
    const at =
      (level: Line["level"]) =>
      (a: object | string, msg?: string): void => {
        lines.push(typeof a === "string" ? { level, obj: {}, msg: a } : { level, obj: a as Record<string, unknown>, msg });
      };
    return { log: { info: at("info"), warn: at("warn"), error: at("error") }, lines };
  };
  const UUID = /^[0-9a-f-]{36}$/;
  const hash12 = (sid: string): string => createHash("sha256").update(sid).digest("hex").slice(0, 12);

  it("a sign-in writes one info line with the hashed session id; a sign-out writes one info line", async () => {
    const { log, lines } = capture();
    const app = makeApp(log);
    const login = await app.inject({ method: "POST", url: "/login", ...form(PASSWORD) });
    const sid = login.cookies.find((c) => c.name === "pantheon_session")!.value;
    await app.inject({ method: "POST", url: "/logout", headers: { cookie: `pantheon_session=${sid}` } });
    await app.inject({ method: "POST", url: "/logout" });
    expect(lines).toEqual([
      { level: "info", msg: "operator signed in", obj: { event: "auth.login", outcome: "signed_in", sessionIdHash: hash12(sid), correlationId: expect.stringMatching(UUID) } },
      { level: "info", msg: "operator signed out", obj: { event: "auth.logout", sessionIdHash: hash12(sid), hadSession: true, correlationId: expect.stringMatching(UUID) } },
      { level: "info", msg: "operator signed out", obj: { event: "auth.logout", hadSession: false, correlationId: expect.stringMatching(UUID) } }
    ]);
    const all = JSON.stringify(lines);
    expect(all).not.toContain(sid);
    expect(all).not.toContain(PASSWORD);
  });

  it("a wrong or missing password writes one warn line with the reason — never the password tried", async () => {
    const { log, lines } = capture();
    const app = makeApp(log);
    const tried = "hunter2-almost-the-passphrase";
    expect((await app.inject({ method: "POST", url: "/login", ...form(tried) })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/login", headers: { "content-type": "application/x-www-form-urlencoded" }, payload: "user=karl" })).statusCode).toBe(401);
    expect(lines).toEqual([
      { level: "warn", msg: "operator sign-in refused", obj: { event: "auth.login", outcome: "refused", reason: "wrong_password", correlationId: expect.stringMatching(UUID) } },
      { level: "warn", msg: "operator sign-in refused", obj: { event: "auth.login", outcome: "refused", reason: "no_password", correlationId: expect.stringMatching(UUID) } }
    ]);
    const all = JSON.stringify(lines);
    expect(all).not.toContain(tried);
    expect(all).not.toContain(PASSWORD);
  });
});
