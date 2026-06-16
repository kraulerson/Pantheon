/**
 * Browser auth (#9) integration — Task #9, PROJECT_BIBLE §7 tier-1.
 *
 * A control-plane-native operator login: passphrase → httpOnly session cookie validated server-side.
 * The guard accepts the cookie OR the admin bearer; logged-out browsers (Accept: text/html) are
 * redirected to /login, API callers get 401. The cookie also authorizes the same-origin WebSocket.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/http/app.js";
import { SqliteRegistry, seedDefaults } from "../src/registry/sqlite-repository.js";
import { RegistryService } from "../src/registry/service.js";
import { McpRegistrationService } from "../src/registry/mcp-registration.js";
import { SessionStore } from "../src/http/auth/session.js";

const TOKEN = "super-strong-admin-token-0123456789abcdef";
const PASSWORD = "correct-horse-battery-staple";

function makeApp(): FastifyInstance {
  const repo = new SqliteRegistry(":memory:");
  seedDefaults(repo);
  const registry = new RegistryService(repo);
  const mcp = new McpRegistrationService({
    createServer: vi.fn(),
    getServers: vi.fn(async () => ({ success: true, servers: [] }))
  } as never);
  return buildApp({ adminToken: TOKEN, registry, mcp, operatorPassword: PASSWORD, sessions: new SessionStore() });
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
