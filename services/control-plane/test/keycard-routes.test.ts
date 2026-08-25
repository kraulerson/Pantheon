/**
 * Keycard door + admin minting routes — M1 task 2 (TP-3; docs/machine-auth-design.md §4).
 *
 *  - `/keycard/v1/*` is its OWN auth domain: a keycard bearer works only there; the operator cookie
 *    and the admin bearer are rejected there; a keycard bearer is rejected everywhere else.
 *  - one route per scope, GET only; no management route exists under the prefix at any scope.
 *  - minting / listing / revoking live on the admin surface (D6); the raw token is returned ONCE.
 *  - approvals via keycard are reference-only (D8): no arguments / diff / payload ever.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/http/app.js";
import { SessionStore } from "../src/http/auth/session.js";
import { SqliteRegistry, seedDefaults } from "../src/registry/sqlite-repository.js";
import { RegistryService } from "../src/registry/service.js";
import { McpRegistrationService } from "../src/registry/mcp-registration.js";
import { SqliteKeycardStore } from "../src/keycard/sqlite-store.js";
import { KeycardService } from "../src/keycard/service.js";
import type { Session } from "../src/session/types.js";

const TOKEN = "super-strong-admin-token-0123456789abcdef";
const admin = { authorization: `Bearer ${TOKEN}` };
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
const T0 = Date.parse("2026-08-25T12:00:00.000Z");

const APPROVALS = [
  { approvalId: "ap-1", tool: "gitea_file_write", serverId: "gitea", status: "pending", createdAt: "2026-08-25T11:00:00.000Z", userId: "u-alden1",
    arguments: { path: "secret.txt", content: "SECRET-CONTENT" }, diff: "--- a\n+++ b\n+SECRET-CONTENT", payload: { x: 1 } }
];
const SESSIONS: Session[] = [
  { id: "s1", identityId: "alden-1", backendId: "b1", taintFlag: true, createdAt: "2026-08-25T10:00:00.000Z", closedAt: null }
];

interface Made {
  app: FastifyInstance;
  keycards: KeycardService;
  approvals: { listApprovals: ReturnType<typeof vi.fn>; decideApproval: ReturnType<typeof vi.fn> };
}

function makeApp(opts: { keycards?: boolean; peta?: boolean; sessions?: boolean; login?: boolean; now?: () => number } = {}): Made {
  const repo = new SqliteRegistry(":memory:");
  seedDefaults(repo);
  const registry = new RegistryService(repo);
  const mcp = new McpRegistrationService({ createServer: vi.fn(), getServers: vi.fn(async () => ({ success: true, servers: [] })) } as never);
  const keycards = new KeycardService(new SqliteKeycardStore(":memory:"), { now: opts.now ?? (() => T0) });
  const approvals = { listApprovals: vi.fn(async () => ({ success: true, approvals: APPROVALS })), decideApproval: vi.fn(async () => ({ success: true })) };
  const app = buildApp({
    adminToken: TOKEN,
    registry,
    mcp,
    ...(opts.keycards === false ? {} : { keycards }),
    ...(opts.peta === false ? {} : { peta: approvals }),
    ...(opts.sessions === false ? {} : { sessionLedger: { list: () => SESSIONS } }),
    ...(opts.login ? { operatorPassword: "correct horse", sessions: new SessionStore() } : {})
  });
  return { app, keycards, approvals };
}

function mint(keycards: KeycardService, scopes: Array<"usage:read" | "approvals:read" | "sessions:read">, principal = "cli-test"): string {
  return keycards.mint({ principal, scopes }).token;
}

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("keycard door — auth domain", () => {
  it("no credential → 401 keycard_required (never a login redirect, never an SSH dial)", async () => {
    ({ app } = makeApp());
    const res = await app.inject({ method: "GET", url: "/keycard/v1/whoami", headers: { accept: "text/html" } });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "keycard_required" });
  });

  it("the operator session cookie is REJECTED on the keycard surface (no endpoint accepts both tiers)", async () => {
    const made = makeApp({ login: true });
    app = made.app;
    const login = await app.inject({ method: "POST", url: "/login", payload: "password=correct%20horse", headers: { "content-type": "application/x-www-form-urlencoded" } });
    const cookie = String(login.headers["set-cookie"]).split(";")[0];
    expect(cookie).toMatch(/^pantheon_session=/);
    expect((await app.inject({ method: "GET", url: "/harness", headers: { cookie } })).statusCode).toBe(200); // cookie works on the admin side
    const res = await app.inject({ method: "GET", url: "/keycard/v1/whoami", headers: { cookie } });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "keycard_required" });
  });

  it("the ADMIN bearer is rejected on the keycard surface (403 invalid_keycard)", async () => {
    ({ app } = makeApp());
    const res = await app.inject({ method: "GET", url: "/keycard/v1/whoami", headers: admin });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "invalid_keycard" });
  });

  it("a keycard bearer is rejected on EVERY admin route (403) and opens nothing there", async () => {
    const made = makeApp();
    app = made.app;
    const t = mint(made.keycards, ["usage:read", "approvals:read", "sessions:read"]);
    for (const url of ["/api/backends", "/api/dev-machines", "/api/keycards", "/approvals", "/harness", "/admin/config", "/harness/tmux/x"]) {
      const res = await app.inject({ method: "GET", url, headers: bearer(t) });
      expect(res.statusCode, url).toBe(403);
    }
    const post = await app.inject({ method: "POST", url: "/api/keycards", headers: bearer(t), payload: { principal: "x", scopes: ["usage:read"] } });
    expect(post.statusCode).toBe(403);
  });

  it("an unknown route under the prefix still requires a keycard (401), then 404 with one", async () => {
    const made = makeApp();
    app = made.app;
    expect((await app.inject({ method: "GET", url: "/keycard/v1/nope" })).statusCode).toBe(401);
    const t = mint(made.keycards, ["usage:read"]);
    expect((await app.inject({ method: "GET", url: "/keycard/v1/nope", headers: bearer(t) })).statusCode).toBe(404);
  });

  it("when no keycard service is wired, the whole prefix answers 503 keycard_unavailable (fail closed)", async () => {
    ({ app } = makeApp({ keycards: false }));
    const res = await app.inject({ method: "GET", url: "/keycard/v1/whoami", headers: bearer("pk1_" + "0".repeat(64)) });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: "keycard_unavailable" });
  });

  it("revoked and expired cards fail closed with a labeled reason", async () => {
    let t = T0;
    const made = makeApp({ now: () => t });
    app = made.app;
    const { card, token } = made.keycards.mint({ principal: "a", scopes: ["usage:read"], ttlDays: 1 });
    expect((await app.inject({ method: "GET", url: "/keycard/v1/whoami", headers: bearer(token) })).statusCode).toBe(200);
    t = T0 + 2 * 86_400_000;
    const expired = await app.inject({ method: "GET", url: "/keycard/v1/whoami", headers: bearer(token) });
    expect(expired.statusCode).toBe(403);
    expect(expired.json()).toEqual({ error: "keycard_expired" });
    t = T0;
    made.keycards.revoke(card.id);
    const revoked = await app.inject({ method: "GET", url: "/keycard/v1/whoami", headers: bearer(token) });
    expect(revoked.statusCode).toBe(403);
    expect(revoked.json()).toEqual({ error: "keycard_revoked" });
  });
});

describe("keycard door — routes and scopes", () => {
  it("whoami needs no scope: it returns the principal + scopes and never the token or hash", async () => {
    const made = makeApp();
    app = made.app;
    const t = mint(made.keycards, ["sessions:read"], "cli-mac-mini");
    const res = await app.inject({ method: "GET", url: "/keycard/v1/whoami", headers: bearer(t) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ principal: "cli-mac-mini", scopes: ["sessions:read"] });
    expect(res.body).not.toContain(t);
    expect(res.body).not.toMatch(/hash/i);
  });

  it("each scope grants exactly its route and no other (403 insufficient_scope names the missing scope)", async () => {
    const made = makeApp();
    app = made.app;
    const matrix: Array<["usage:read" | "approvals:read" | "sessions:read", string]> = [
      ["usage:read", "/keycard/v1/usage"],
      ["approvals:read", "/keycard/v1/approvals"],
      ["sessions:read", "/keycard/v1/sessions"]
    ];
    for (const [scope] of matrix) {
      const t = mint(made.keycards, [scope]);
      for (const [otherScope, url] of matrix) {
        const res = await app.inject({ method: "GET", url, headers: bearer(t) });
        if (otherScope === scope) {
          expect(res.statusCode, `${scope} → ${url}`).not.toBe(403);
        } else {
          expect(res.statusCode, `${scope} → ${url}`).toBe(403);
          expect(res.json()).toEqual({ error: "insufficient_scope", required: otherScope });
        }
      }
    }
  });

  it("sessions:read lists session METADATA only (ids, binding, taint, timestamps)", async () => {
    const made = makeApp();
    app = made.app;
    const t = mint(made.keycards, ["sessions:read"]);
    const res = await app.inject({ method: "GET", url: "/keycard/v1/sessions", headers: bearer(t) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ sessions: SESSIONS });
  });

  it("approvals:read is REFERENCE-ONLY (D8): id, tool, server, status, time, requester — never arguments/diff/payload", async () => {
    const made = makeApp();
    app = made.app;
    const t = mint(made.keycards, ["approvals:read"]);
    const res = await app.inject({ method: "GET", url: "/keycard/v1/approvals", headers: bearer(t) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      approvals: [{ id: "ap-1", tool: "gitea_file_write", server: "gitea", status: "pending", createdAt: "2026-08-25T11:00:00.000Z", requester: "u-alden1" }],
      truncated: false
    });
    expect(res.body).not.toContain("SECRET-CONTENT");
    expect(res.body).not.toMatch(/arguments|diff|payload/);
    expect(made.approvals.listApprovals).toHaveBeenCalledTimes(1);
  });

  it("approvals:read with Peta not wired → 503 labeled (scope still checked first)", async () => {
    const made = makeApp({ peta: false });
    app = made.app;
    const no = await app.inject({ method: "GET", url: "/keycard/v1/approvals", headers: bearer(mint(made.keycards, ["usage:read"])) });
    expect(no.statusCode).toBe(403);
    const res = await app.inject({ method: "GET", url: "/keycard/v1/approvals", headers: bearer(mint(made.keycards, ["approvals:read"])) });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ state: "unavailable" });
  });

  it("usage:read answers a LABELED 503 until the usage ledger exists (M2 step 6) — scope still checked first", async () => {
    const made = makeApp();
    app = made.app;
    const res = await app.inject({ method: "GET", url: "/keycard/v1/usage", headers: bearer(mint(made.keycards, ["usage:read"])) });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ state: "unavailable" });
    expect(String(res.json().message)).toMatch(/ledger/i);
  });

  it("no management route exists under the prefix at any scope — every route there is GET; decide/mutate paths are 404", async () => {
    const made = makeApp();
    app = made.app;
    await app.ready();
    // printRoutes prints each path WITHOUT its leading slash ("keycard/v1/whoami (GET, HEAD)").
    const routes = app.printRoutes({ commonPrefix: false });
    const keycardLines = routes.split("\n").filter((l) => l.includes("keycard/v1/"));
    expect(keycardLines.length).toBe(4);
    for (const l of keycardLines) expect(l, l).toMatch(/\(GET(, HEAD)?\)/);
    const t = mint(made.keycards, ["usage:read", "approvals:read", "sessions:read"]);
    for (const [method, url] of [
      ["POST", "/keycard/v1/approvals/ap-1/decide"],
      ["POST", "/keycard/v1/keycards"],
      ["DELETE", "/keycard/v1/sessions/s1"],
      ["POST", "/keycard/v1/sessions"],
      ["PUT", "/keycard/v1/usage"]
    ] as const) {
      const res = await app.inject({ method, url, headers: bearer(t) });
      expect([404, 405], `${method} ${url}`).toContain(res.statusCode);
    }
    expect(made.approvals.decideApproval).not.toHaveBeenCalled();
  });

  it("denies are visible: a wrong-scope call increments the card's denyCount in the admin listing", async () => {
    const made = makeApp();
    app = made.app;
    const { card, token } = made.keycards.mint({ principal: "a", scopes: ["usage:read"] });
    await app.inject({ method: "GET", url: "/keycard/v1/sessions", headers: bearer(token) });
    const list = await app.inject({ method: "GET", url: "/api/keycards", headers: admin });
    const row = (list.json() as Array<{ id: string; denyCount: number; useCount: number }>).find((c) => c.id === card.id);
    expect(row?.denyCount).toBe(1);
    expect(row?.useCount).toBe(1);
  });

  it("rate cap: the 61st call within a minute answers 429 rate_limited", async () => {
    const made = makeApp();
    app = made.app;
    const t = mint(made.keycards, ["sessions:read"]);
    let last = 0;
    for (let i = 0; i < 61; i++) last = (await app.inject({ method: "GET", url: "/keycard/v1/sessions", headers: bearer(t) })).statusCode;
    expect(last).toBe(429);
  });
});

describe("admin surface — mint / list / revoke (D6)", () => {
  it("POST /api/keycards (JSON) mints and returns the raw token ONCE alongside the card (no hash)", async () => {
    const made = makeApp();
    app = made.app;
    const res = await app.inject({ method: "POST", url: "/api/keycards", headers: admin, payload: { principal: "cli-mac-mini", scopes: ["sessions:read"], ttlDays: 30 } });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.token).toMatch(/^pk1_[0-9a-f]{64}$/);
    expect(body.card).toMatchObject({ principal: "cli-mac-mini", scopes: ["sessions:read"], revokedAt: null });
    expect(res.body).not.toMatch(/hash/i);
    // the token works on the door…
    expect((await app.inject({ method: "GET", url: "/keycard/v1/whoami", headers: bearer(body.token) })).statusCode).toBe(200);
    // …and never appears again in any listing
    const list = await app.inject({ method: "GET", url: "/api/keycards", headers: admin });
    expect(list.statusCode).toBe(200);
    expect(list.body).not.toContain(body.token);
    expect(list.body).not.toMatch(/tokenHash|token_hash/);
    expect(list.json()[0]).toMatchObject({ id: body.card.id, principal: "cli-mac-mini" });
  });

  it("minting is admin-only and validates input (400 on a bad scope / principal, never a partial write)", async () => {
    const made = makeApp();
    app = made.app;
    expect((await app.inject({ method: "POST", url: "/api/keycards", payload: { principal: "x", scopes: ["usage:read"] } })).statusCode).toBe(401);
    const bad = await app.inject({ method: "POST", url: "/api/keycards", headers: admin, payload: { principal: "x", scopes: ["admin:write"] } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ error: "validation_error" });
    const bad2 = await app.inject({ method: "POST", url: "/api/keycards", headers: admin, payload: { principal: "a b", scopes: ["usage:read"] } });
    expect(bad2.statusCode).toBe(400);
    expect(made.keycards.list()).toHaveLength(0);
  });

  it("POST /api/keycards/:id/revoke → 204; the card then fails closed on the door", async () => {
    const made = makeApp();
    app = made.app;
    const { card, token } = made.keycards.mint({ principal: "a", scopes: ["usage:read"] });
    expect((await app.inject({ method: "POST", url: `/api/keycards/${card.id}/revoke`, headers: admin })).statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: "/keycard/v1/whoami", headers: bearer(token) })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/api/keycards/nope/revoke", headers: admin })).statusCode).toBe(404);
  });

  it("an urlencoded (Configuration-page) mint is Post/Redirect/Get to a ONE-SHOT token page: shown once, no token in any URL, a reload cannot re-mint", async () => {
    const made = makeApp();
    app = made.app;
    const res = await app.inject({
      method: "POST",
      url: "/api/keycards",
      headers: { ...admin, "content-type": "application/x-www-form-urlencoded" },
      payload: "principal=cli-mac-mini&scopes=sessions%3Aread&scopes=approvals%3Aread&ttlDays=30"
    });
    expect(res.statusCode).toBe(303);
    const location = String(res.headers.location);
    expect(location).toMatch(/^\/admin\/keycards\/minted\?slot=[A-Za-z0-9_-]+$/);
    expect(location).not.toMatch(/pk1_/);
    expect(res.body).not.toMatch(/pk1_/);
    const page = await app.inject({ method: "GET", url: location, headers: admin });
    expect(page.statusCode).toBe(200);
    expect(page.headers["content-type"]).toMatch(/text\/html/);
    expect(page.headers["cache-control"]).toMatch(/no-store/);
    expect(page.body).toMatch(/pk1_[0-9a-f]{64}/);
    expect(page.body).toMatch(/not be shown again/i);
    expect(page.body).toContain('href="/admin/config?notice=keycard_minted"');
    expect(page.body).toContain("cli-mac-mini");
    expect(page.body).toContain("sessions:read");
    expect(page.body).toContain("approvals:read");
    expect(page.body).not.toMatch(/hash/i);
    // second read of the same slot: token gone, labeled
    const again = await app.inject({ method: "GET", url: location, headers: admin });
    expect(again.statusCode).toBe(410);
    expect(again.body).not.toMatch(/pk1_/);
    expect(again.body).toMatch(/already (been )?collected|no longer available/i);
    expect(again.body).toContain('href="/admin/config"');
    // the slot page is admin-guarded
    expect((await app.inject({ method: "GET", url: location })).statusCode).toBe(401);
    // exactly one card was minted
    expect(made.keycards.list()).toHaveLength(1);
  });

  it("a form mint with no scope ticked redirects back to the Configuration page with a field-level error banner (never raw JSON)", async () => {
    const made = makeApp();
    app = made.app;
    const res = await app.inject({
      method: "POST",
      url: "/api/keycards",
      headers: { ...admin, "content-type": "application/x-www-form-urlencoded" },
      payload: "principal=cli-mac-mini&ttlDays=30"
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/admin/config?error=keycard_scopes");
    const page = await app.inject({ method: "GET", url: "/admin/config?error=keycard_scopes", headers: admin });
    expect(page.statusCode).toBe(200);
    expect(page.body).toMatch(/role="alert"[^>]*>[\s\S]*Invalid scopes[\s\S]*not minted/i);
    expect(made.keycards.list()).toHaveLength(0);
    // an unknown error code is ignored, never reflected
    const junk = await app.inject({ method: "GET", url: "/admin/config?error=%3Cscript%3Ealert(1)", headers: admin });
    expect(junk.body).not.toContain("alert(1)");
    expect(junk.body).not.toContain("&lt;script&gt;");
    expect(junk.body).not.toMatch(/role="alert"/);
  });

  it("revoke from the form redirects with a success receipt; the page shows it", async () => {
    const made = makeApp();
    app = made.app;
    const { card } = made.keycards.mint({ principal: "a", scopes: ["usage:read"] });
    const res = await app.inject({ method: "POST", url: `/api/keycards/${card.id}/revoke`, headers: { ...admin, "content-type": "application/x-www-form-urlencoded" }, payload: "" });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/admin/config?notice=keycard_revoked");
    const page = await app.inject({ method: "GET", url: "/admin/config?notice=keycard_revoked", headers: admin });
    expect(page.body).toMatch(/role="status"[^>]*>[\s\S]*revoked/i);
  });

  it("the Configuration page lists keycards (no token, no hash) with text state pills and a Revoke control", async () => {
    const made = makeApp();
    app = made.app;
    const { card, token } = made.keycards.mint({ principal: "cli-mac-mini", scopes: ["sessions:read"] });
    const res = await app.inject({ method: "GET", url: "/admin/config", headers: admin });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Session Keycards");
    expect(res.body).toContain("cli-mac-mini");
    expect(res.body).toContain(`/api/keycards/${card.id}/revoke`);
    expect(res.body).not.toContain(token);
  });
});

describe("keycard — audit remediation (2026-08-25)", () => {
  it("a rate-limited request is NOT counted as a served use; refused authentications are counted and shown on the Configuration page", async () => {
    const made = makeApp();
    app = made.app;
    const { card, token } = made.keycards.mint({ principal: "a", scopes: ["sessions:read"] });
    for (let i = 0; i < 61; i++) await app.inject({ method: "GET", url: "/keycard/v1/whoami", headers: bearer(token) });
    expect(made.keycards.get(card.id)?.useCount).toBe(60);
    expect(made.keycards.stats().rateLimited).toBe(1);
    await app.inject({ method: "GET", url: "/keycard/v1/whoami", headers: bearer("pk1_" + "0".repeat(64)) });
    await app.inject({ method: "GET", url: "/keycard/v1/whoami", headers: bearer("garbage") });
    expect(made.keycards.stats().refusedAuth).toBe(2);
    const page = await app.inject({ method: "GET", url: "/admin/config", headers: admin });
    expect(page.body).toMatch(/Refused keycard attempts:\s*2/);
    expect(page.body).toMatch(/Rate-limited:\s*1/);
  });

  it("a replayed REVOKED card is visible: its denied counter rises on every attempt", async () => {
    const made = makeApp();
    app = made.app;
    const { card, token } = made.keycards.mint({ principal: "a", scopes: ["sessions:read"] });
    made.keycards.revoke(card.id);
    for (let i = 0; i < 3; i++) expect((await app.inject({ method: "GET", url: "/keycard/v1/whoami", headers: bearer(token) })).statusCode).toBe(403);
    expect(made.keycards.get(card.id)?.denyCount).toBe(3);
  });

  it("pre-auth budget: after 120 refusals in a minute the door answers 429 without looking tokens up; the budget slides", async () => {
    let t = T0;
    const made = makeApp({ now: () => t });
    app = made.app;
    for (let i = 0; i < 120; i++) await app.inject({ method: "GET", url: "/keycard/v1/whoami", headers: bearer("pk1_" + i.toString(16).padStart(64, "0")) });
    const blocked = await app.inject({ method: "GET", url: "/keycard/v1/whoami", headers: bearer("pk1_" + "f".repeat(64)) });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toEqual({ error: "rate_limited" });
    t = T0 + 60_001;
    const after = await app.inject({ method: "GET", url: "/keycard/v1/whoami", headers: bearer("pk1_" + "f".repeat(64)) });
    expect(after.statusCode).toBe(403);
  });

  it("the bare prefix /keycard/v1 (no trailing slash) belongs to the keycard domain, not the admin guard", async () => {
    ({ app } = makeApp());
    const res = await app.inject({ method: "GET", url: "/keycard/v1", headers: { accept: "text/html" } });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "keycard_required" });
  });

  it("state-changing requests marked cross-site or same-site by the browser are refused (CSRF), same-origin and non-browser callers pass", async () => {
    const made = makeApp();
    app = made.app;
    const body = { principal: "csrf", scopes: ["usage:read"] };
    expect((await app.inject({ method: "POST", url: "/api/keycards", headers: { ...admin, "sec-fetch-site": "cross-site" }, payload: body })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/api/keycards", headers: { ...admin, "sec-fetch-site": "same-site" }, payload: body })).statusCode).toBe(403);
    expect(made.keycards.list()).toHaveLength(0);
    expect((await app.inject({ method: "POST", url: "/api/keycards", headers: { ...admin, "sec-fetch-site": "same-origin" }, payload: body })).statusCode).toBe(201);
    expect((await app.inject({ method: "POST", url: "/api/keycards", headers: admin, payload: body })).statusCode).toBe(201);
    // GET is never affected
    expect((await app.inject({ method: "GET", url: "/api/keycards", headers: { ...admin, "sec-fetch-site": "cross-site" } })).statusCode).toBe(200);
    // the pre-existing forms get the same protection
    expect((await app.inject({ method: "POST", url: "/api/dev-machines", headers: { ...admin, "sec-fetch-site": "same-site" }, payload: { logicalName: "x", host: "1.1.1.1", user: "u", enabled: true } })).statusCode).toBe(403);
  });

  it("a malformed URL under the prefix still gets a sanitized 400 with the security header", async () => {
    ({ app } = makeApp());
    const res = await app.inject({ method: "GET", url: "/keycard/v1/%zz" });
    expect(res.statusCode).toBe(400);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.body).not.toContain("%zz");
  });

  it("approvals:read bounds the upstream: item cap 200 (labeled truncated), strings capped, a hung gate answers a labeled 502 in time", async () => {
    const big = Array.from({ length: 300 }, (_, i) => ({ approvalId: "ap-" + i, tool: "t".repeat(5000), status: "pending" }));
    const repo = new SqliteRegistry(":memory:");
    seedDefaults(repo);
    const keycards = new KeycardService(new SqliteKeycardStore(":memory:"), { now: () => T0 });
    let hang = false;
    const peta = {
      listApprovals: vi.fn(() => (hang ? new Promise<never>(() => {}) : Promise.resolve({ approvals: big }))),
      decideApproval: vi.fn()
    };
    app = buildApp({ adminToken: TOKEN, registry: new RegistryService(repo), mcp: new McpRegistrationService({ createServer: vi.fn(), getServers: vi.fn() } as never), keycards, peta, approvalsTimeoutMs: 50 });
    const t = keycards.mint({ principal: "a", scopes: ["approvals:read"] }).token;
    const res = await app.inject({ method: "GET", url: "/keycard/v1/approvals", headers: bearer(t) });
    expect(res.statusCode).toBe(200);
    expect(res.json().approvals).toHaveLength(200);
    expect(res.json().truncated).toBe(true);
    expect(res.json().approvals[0].tool.length).toBeLessThanOrEqual(256);
    hang = true;
    const hung = await app.inject({ method: "GET", url: "/keycard/v1/approvals", headers: bearer(t) });
    expect(hung.statusCode).toBe(502);
    expect(hung.json()).toMatchObject({ state: "failed" });
    expect(String(hung.json().message)).toMatch(/time/i);
  });

  it("JSON mint does not launder input: a bare string or nested array for scopes is a 400, a repeated ttlDays form key is a 400", async () => {
    const made = makeApp();
    app = made.app;
    expect((await app.inject({ method: "POST", url: "/api/keycards", headers: admin, payload: { principal: "a", scopes: "usage:read" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/keycards", headers: admin, payload: { principal: "a", scopes: [["usage:read"]] } })).statusCode).toBe(400);
    const form = await app.inject({
      method: "POST",
      url: "/api/keycards",
      headers: { ...admin, "content-type": "application/x-www-form-urlencoded" },
      payload: "principal=a&scopes=usage%3Aread&ttlDays=30&ttlDays=1"
    });
    expect(form.statusCode).toBe(303);
    expect(form.headers.location).toBe("/admin/config?error=keycard_ttl");
    expect(made.keycards.list()).toHaveLength(0);
  });
});
