/**
 * Passphrase step-up window (F2 Task 3; spec R4, the first D6 consumer; ADR-0010). Every action that types into a
 * live Claude Code session consults this window, so the tests are adversarial: a bearer-only caller, an expired
 * window, an expired or destroyed session, a cross-site POST and a body without a passphrase must each be proven
 * unable to reach an elevated state. The window is per SESSION ID (Review Focus 4: two tabs on one operator session
 * share it), so two requests carrying the same cookie both see it, and a second login does not.
 *
 * Rulings: P-1 (`{ revoke: true }` → 204; both or neither of passphrase/revoke → 400), T3-0 (refuse with the
 * timing-safe compare only — no artificial delay, no rate limiting here), T3-1 (a refused passphrase is logged like
 * an elevation — the same `console.step_up` event, action "refuse", the hashed session id; never the guess).
 */

import { createHash } from "node:crypto";
import { describe, it, expect, afterEach, vi, type Mock } from "vitest";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { buildApp, PUBLIC_PATHS } from "../src/http/app.js";
import { SessionStore } from "../src/http/auth/session.js";
import { requireElevated, sessionIdHash, StepUpWindow, STEP_UP_TTL_MS } from "../src/http/auth/step-up.js";
import { SqliteRegistry, seedDefaults } from "../src/registry/sqlite-repository.js";
import { RegistryService } from "../src/registry/service.js";
import { McpRegistrationService } from "../src/registry/mcp-registration.js";
import { maskSecrets } from "../src/console/masking.js";
import { createConsolePoller } from "../src/console/poller.js";
import { DEFAULT_CONSOLE_SETTINGS } from "../src/console/settings.js";
import { SqliteConsoleStore } from "../src/console/store.js";

const TOKEN = "super-strong-admin-token-0123456789abcdef";
const PASSWORD = "correct horse battery staple";
const admin = { authorization: `Bearer ${TOKEN}` };
const URL = "/console/api/step-up";
const T0 = Date.parse("2026-10-19T12:00:00.000Z");
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const iso = (ms: number): string => new Date(ms).toISOString();

type Log = { info: Mock; warn: Mock; error: Mock };

interface Made {
  readonly app: FastifyInstance;
  readonly stepUp: StepUpWindow;
  readonly sessions: SessionStore;
  readonly log: Log;
  /** Mutable test clock, shared by the window and the session store. */
  readonly clock: { now: number };
}

function makeApp(o: { login?: boolean; sessionTtlMs?: number; appMintsSessions?: boolean } = {}): Made {
  const clock = { now: T0 };
  const now = (): number => clock.now;
  const repo = new SqliteRegistry(":memory:");
  seedDefaults(repo);
  const registry = new RegistryService(repo);
  const mcp = new McpRegistrationService({ createServer: vi.fn(), getServers: vi.fn(async () => ({ success: true, servers: [] })) } as never);
  const store = new SqliteConsoleStore();
  const poller = createConsolePoller({
    registry,
    exec: () => Promise.reject(new Error("test: nothing is dialled")),
    store,
    settings: DEFAULT_CONSOLE_SETTINGS,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  });
  const stepUp = new StepUpWindow(now);
  const sessions = new SessionStore(o.sessionTtlMs ?? SESSION_TTL_MS, now);
  const log: Log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const app = buildApp({
    adminToken: TOKEN,
    registry,
    mcp,
    console: {
      store,
      poller,
      settings: { ok: true, settings: DEFAULT_CONSOLE_SETTINGS },
      exec: () => Promise.reject(new Error("test: nothing is dialled")),
      mask: maskSecrets,
      stepUp,
      log
    },
    // `appMintsSessions`: server.ts's own shape — the passphrase only, so buildApp mints the session store itself.
    ...(o.login === false ? {} : o.appMintsSessions === true ? { operatorPassword: PASSWORD } : { operatorPassword: PASSWORD, sessions })
  });
  return { app, stepUp, sessions, log, clock };
}

/** Log in through the real form and return the cookie header a browser would send back, plus the raw id. */
async function login(app: FastifyInstance): Promise<{ readonly cookie: string; readonly sid: string }> {
  const res = await app.inject({
    method: "POST",
    url: "/login",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: `password=${encodeURIComponent(PASSWORD)}`
  });
  expect(res.statusCode).toBe(302);
  const sid = res.cookies.find((c) => c.name === "pantheon_session")!.value;
  return { cookie: `pantheon_session=${sid}`, sid };
}

const fakeReq = (cookie?: string): FastifyRequest => ({ headers: cookie === undefined ? {} : { cookie } }) as unknown as FastifyRequest;

const expectedHash = (sid: string): string => createHash("sha256").update(sid).digest("hex").slice(0, 12);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
  vi.restoreAllMocks();
});

describe("StepUpWindow", () => {
  it("elevate opens a 15-minute window (ISO until); at now + 900_000 it reads closed and the entry is dropped", () => {
    const clock = { now: T0 };
    const w = new StepUpWindow(() => clock.now);
    expect(STEP_UP_TTL_MS).toBe(900_000);
    expect(w.isElevated("s1")).toBe(false);
    expect(w.elevatedUntil("s1")).toBeUndefined();
    const until = w.elevate("s1");
    expect(until).toBe(iso(T0 + 900_000));
    expect(w.isElevated("s1")).toBe(true);
    expect(w.elevatedUntil("s1")).toBe(until);
    clock.now = T0 + 899_999;
    expect(w.isElevated("s1")).toBe(true);
    clock.now = T0 + 900_000;
    expect(w.isElevated("s1")).toBe(false);
    expect(w.elevatedUntil("s1")).toBeUndefined();
    // Dropped on that read, not merely compared: winding the clock back does not resurrect it.
    clock.now = T0;
    expect(w.isElevated("s1")).toBe(false);
  });

  it("a custom ttl applies; re-elevating re-arms the full window from now", () => {
    const clock = { now: T0 };
    const w = new StepUpWindow(() => clock.now, 1000);
    expect(w.elevate("s1")).toBe(iso(T0 + 1000));
    clock.now = T0 + 600;
    expect(w.elevate("s1")).toBe(iso(T0 + 1600));
    clock.now = T0 + 1599;
    expect(w.isElevated("s1")).toBe(true);
    clock.now = T0 + 1600;
    expect(w.isElevated("s1")).toBe(false);
  });

  it("revoke drops the entry; revoking an unknown id is a no-op; windows are per session id", () => {
    const w = new StepUpWindow(() => T0);
    w.elevate("s1");
    w.elevate("s2");
    expect(() => w.revoke("never-seen")).not.toThrow();
    w.revoke("s1");
    expect(w.isElevated("s1")).toBe(false);
    expect(w.elevatedUntil("s1")).toBeUndefined();
    expect(w.isElevated("s2")).toBe(true);
  });

  it("sessionIdHash is the first 12 hex of sha256 (never the id itself)", () => {
    const sid = "a".repeat(64);
    expect(sessionIdHash(sid)).toBe(createHash("sha256").update(sid).digest("hex").slice(0, 12));
    expect(sessionIdHash(sid)).toHaveLength(12);
    expect(sid).not.toContain(sessionIdHash(sid));
  });
});

describe("requireElevated", () => {
  it("a valid cookie on an elevated session passes with the session id; without elevation it is step_up_required", () => {
    const clock = { now: T0 };
    const now = (): number => clock.now;
    const sessions = new SessionStore(SESSION_TTL_MS, now);
    const stepUp = new StepUpWindow(now);
    const sid = sessions.create();
    expect(requireElevated(fakeReq(`pantheon_session=${sid}`), sessions, stepUp)).toEqual({ ok: false, status: 403, reason: "step_up_required" });
    stepUp.elevate(sid);
    expect(requireElevated(fakeReq(`pantheon_session=${sid}`), sessions, stepUp)).toEqual({ ok: true, sessionId: sid });
    // Other cookies around it do not matter; an empty value is no session.
    expect(requireElevated(fakeReq(`other=1; pantheon_session=${sid}; x=y`), sessions, stepUp)).toEqual({ ok: true, sessionId: sid });
    expect(requireElevated(fakeReq("pantheon_session="), sessions, stepUp)).toEqual({ ok: false, status: 403, reason: "step_up_cookie_only" });
    // The window expires: back to step_up_required.
    clock.now = T0 + STEP_UP_TTL_MS;
    expect(requireElevated(fakeReq(`pantheon_session=${sid}`), sessions, stepUp)).toEqual({ ok: false, status: 403, reason: "step_up_required" });
  });

  it("no cookie (bearer-only), an unknown cookie, an expired session and a destroyed session are all step_up_cookie_only — even with the window open", () => {
    const clock = { now: T0 };
    const now = (): number => clock.now;
    const sessions = new SessionStore(1000, now);
    const stepUp = new StepUpWindow(now, 60_000);
    const cookieOnly = { ok: false, status: 403, reason: "step_up_cookie_only" };
    expect(requireElevated(fakeReq(), sessions, stepUp)).toEqual(cookieOnly);
    stepUp.elevate("f".repeat(64));
    expect(requireElevated(fakeReq(`pantheon_session=${"f".repeat(64)}`), sessions, stepUp)).toEqual(cookieOnly);
    const sid = sessions.create();
    stepUp.elevate(sid);
    expect(requireElevated(fakeReq(`pantheon_session=${sid}`), sessions, stepUp)).toEqual({ ok: true, sessionId: sid });
    clock.now = T0 + 1000; // the SESSION expired first (the window still has 59 s)
    expect(stepUp.isElevated(sid)).toBe(true);
    expect(requireElevated(fakeReq(`pantheon_session=${sid}`), sessions, stepUp)).toEqual(cookieOnly);
    clock.now = T0;
    const sid2 = sessions.create();
    stepUp.elevate(sid2);
    sessions.destroy(sid2); // logout
    expect(requireElevated(fakeReq(`pantheon_session=${sid2}`), sessions, stepUp)).toEqual(cookieOnly);
  });
});

describe("guard and shape", () => {
  it("both methods sit behind the operator guard (401 without a credential), nothing joins PUBLIC_PATHS, HEAD is not exposed", async () => {
    const before = [...PUBLIC_PATHS].sort();
    ({ app } = makeApp());
    await app.ready();
    expect([...PUBLIC_PATHS].sort()).toEqual(before);
    const get = await app.inject({ method: "GET", url: URL });
    expect(get.statusCode).toBe(401);
    expect(get.json()).toEqual({ error: "unauthenticated" });
    const post = await app.inject({ method: "POST", url: URL, payload: { passphrase: PASSWORD } });
    expect(post.statusCode).toBe(401);
    expect(post.json()).toEqual({ error: "unauthenticated" });
    const head = await app.inject({ method: "HEAD", url: URL, headers: admin });
    expect(head.statusCode).toBe(404);
  });

  it("with login disabled both methods answer 503 step_up_unavailable (no-store) and nothing is elevated", async () => {
    const made = makeApp({ login: false });
    ({ app } = made);
    const elevate = vi.spyOn(made.stepUp, "elevate");
    const get = await app.inject({ method: "GET", url: URL, headers: admin });
    expect(get.statusCode).toBe(503);
    expect(get.json()).toEqual({ error: "step_up_unavailable" });
    expect(get.headers["cache-control"]).toBe("no-store");
    const post = await app.inject({ method: "POST", url: URL, headers: admin, payload: { passphrase: PASSWORD } });
    expect(post.statusCode).toBe(503);
    expect(post.json()).toEqual({ error: "step_up_unavailable" });
    expect(post.headers["cache-control"]).toBe("no-store");
    expect(elevate).not.toHaveBeenCalled();
    expect(made.log.info).not.toHaveBeenCalled();
  });
});

describe("POST /console/api/step-up", () => {
  it("the right passphrase on a cookie session opens the window: 200 { elevatedUntil = now + 15 min }, no-store; a second request with the same cookie sees it (Review Focus 4)", async () => {
    const made = makeApp();
    ({ app } = made);
    const { cookie, sid } = await login(app);
    const before = await app.inject({ method: "GET", url: URL, headers: { cookie } });
    expect(before.statusCode).toBe(200);
    expect(before.json()).toEqual({ elevatedUntil: null });
    expect(before.headers["cache-control"]).toBe("no-store");

    const res = await app.inject({ method: "POST", url: URL, headers: { cookie, "sec-fetch-site": "same-origin" }, payload: { passphrase: PASSWORD } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.json()).toEqual({ elevatedUntil: iso(T0 + STEP_UP_TTL_MS) });
    expect(made.stepUp.elevatedUntil(sid)).toBe(iso(T0 + STEP_UP_TTL_MS));

    // The other tab: a separate request carrying the SAME session cookie (the window is per session id).
    const other = await app.inject({ method: "GET", url: URL, headers: { cookie } });
    expect(other.statusCode).toBe(200);
    expect(other.json()).toEqual({ elevatedUntil: iso(T0 + STEP_UP_TTL_MS) });
    expect(requireElevated(fakeReq(cookie), made.sessions, made.stepUp)).toEqual({ ok: true, sessionId: sid });
  });

  it("triage 37: through the production wiring (server.ts passes the passphrase only and buildApp mints the session store), log in, POST the passphrase → 200 and the window is open for that cookie", async () => {
    const made = makeApp({ appMintsSessions: true });
    ({ app } = made);
    const { cookie, sid } = await login(app);
    const res = await app.inject({ method: "POST", url: URL, headers: { cookie }, payload: { passphrase: PASSWORD } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ elevatedUntil: iso(T0 + STEP_UP_TTL_MS) });
    expect(made.stepUp.isElevated(sid)).toBe(true);
    expect((await app.inject({ method: "GET", url: URL, headers: { cookie } })).json()).toEqual({ elevatedUntil: iso(T0 + STEP_UP_TTL_MS) });
    // The test's own store was never handed to the app: the app's minted store is the one the guard and /login use.
    expect(made.sessions.validate(sid)).toBe(false);
  });

  it("a second operator session does not share the window", async () => {
    const made = makeApp();
    ({ app } = made);
    const first = await login(app);
    const second = await login(app);
    expect(second.sid).not.toBe(first.sid);
    expect((await app.inject({ method: "POST", url: URL, headers: { cookie: first.cookie }, payload: { passphrase: PASSWORD } })).statusCode).toBe(200);
    const res = await app.inject({ method: "GET", url: URL, headers: { cookie: second.cookie } });
    expect(res.json()).toEqual({ elevatedUntil: null });
    expect(requireElevated(fakeReq(second.cookie), made.sessions, made.stepUp)).toEqual({ ok: false, status: 403, reason: "step_up_required" });
    expect(requireElevated(fakeReq(first.cookie), made.sessions, made.stepUp)).toEqual({ ok: true, sessionId: first.sid });
  });

  it("a wrong passphrase is 403 step_up_refused with no detail, no-store, the window stays closed, and each refusal is logged without the guess (ruling T3-1)", async () => {
    const made = makeApp();
    ({ app } = made);
    const { cookie, sid } = await login(app);
    const elevate = vi.spyOn(made.stepUp, "elevate");
    const guesses = ["", "wrong", PASSWORD.toUpperCase(), `${PASSWORD} `, PASSWORD.slice(0, -1)];
    for (const passphrase of guesses) {
      const res = await app.inject({ method: "POST", url: URL, headers: { cookie }, payload: { passphrase } });
      expect(res.statusCode, JSON.stringify(passphrase)).toBe(403);
      expect(res.json()).toEqual({ error: "step_up_refused" });
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.body).not.toContain(PASSWORD);
    }
    expect(elevate).not.toHaveBeenCalled();
    expect(made.stepUp.isElevated(sid)).toBe(false);
    expect((await app.inject({ method: "GET", url: URL, headers: { cookie } })).json()).toEqual({ elevatedUntil: null });
    expect(requireElevated(fakeReq(cookie), made.sessions, made.stepUp)).toEqual({ ok: false, status: 403, reason: "step_up_required" });
    // Ruling T3-1: exactly one console.step_up line per refusal, hashed id only — never a guess, never the raw id. A
    // refusal is a warn line (L5, D13), so a level filter keeps the passphrase-guessing trail.
    expect(made.log.info).not.toHaveBeenCalled();
    expect(made.log.warn).toHaveBeenCalledTimes(guesses.length);
    for (const call of made.log.warn.mock.calls) {
      expect(call[0]).toEqual({ event: "console.step_up", action: "refuse", sessionIdHash: expectedHash(sid), correlationId: expect.stringMatching(UUID_RE) as string });
    }
    const everything = JSON.stringify([...made.log.info.mock.calls, ...made.log.warn.mock.calls, ...made.log.error.mock.calls]);
    for (const guess of guesses.filter((g) => g !== "")) expect(everything).not.toContain(guess);
    expect(everything).not.toContain(sid);
  });

  it("a bearer-only caller is 403 step_up_cookie_only even with the right passphrase; its GET reads null; nothing is elevated; each refusal is one warn line (L7)", async () => {
    const made = makeApp();
    ({ app } = made);
    const elevate = vi.spyOn(made.stepUp, "elevate");
    const res = await app.inject({ method: "POST", url: URL, headers: admin, payload: { passphrase: PASSWORD } });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "step_up_cookie_only" });
    expect(res.headers["cache-control"]).toBe("no-store");
    // The bearer plus a cookie the store does not know: still bearer-only.
    const stale = await app.inject({ method: "POST", url: URL, headers: { ...admin, cookie: `pantheon_session=${"0".repeat(64)}` }, payload: { passphrase: PASSWORD } });
    expect(stale.statusCode).toBe(403);
    expect(stale.json()).toEqual({ error: "step_up_cookie_only" });
    const revoke = await app.inject({ method: "POST", url: URL, headers: admin, payload: { revoke: true } });
    expect(revoke.statusCode).toBe(403);
    expect(revoke.json()).toEqual({ error: "step_up_cookie_only" });
    expect(elevate).not.toHaveBeenCalled();
    expect(made.log.info).not.toHaveBeenCalled();
    expect(made.log.warn.mock.calls.map((c) => c[0])).toEqual(
      Array.from({ length: 3 }, () => ({ event: "console.step_up", action: "refuse_cookie_only", correlationId: expect.stringMatching(UUID_RE) as string }))
    );
    expect(JSON.stringify(made.log.warn.mock.calls)).not.toContain(PASSWORD);
    expect(JSON.stringify(made.log.warn.mock.calls)).not.toContain("0".repeat(64));
    const get = await app.inject({ method: "GET", url: URL, headers: admin });
    expect(get.statusCode).toBe(200);
    expect(get.json()).toEqual({ elevatedUntil: null });
    expect(requireElevated(fakeReq(), made.sessions, made.stepUp)).toEqual({ ok: false, status: 403, reason: "step_up_cookie_only" });
  });

  it("a cross-site or same-site POST with a valid cookie and the right passphrase is refused by the app rule and never reaches the window", async () => {
    const made = makeApp();
    ({ app } = made);
    const { cookie, sid } = await login(app);
    const elevate = vi.spyOn(made.stepUp, "elevate");
    for (const site of ["cross-site", "same-site"]) {
      const res = await app.inject({ method: "POST", url: URL, headers: { cookie, "sec-fetch-site": site }, payload: { passphrase: PASSWORD } });
      expect(res.statusCode, site).toBe(403);
      expect(res.json()).toEqual({ error: "cross_origin_rejected" });
    }
    expect(elevate).not.toHaveBeenCalled();
    expect(made.stepUp.isElevated(sid)).toBe(false);
    expect((await app.inject({ method: "GET", url: URL, headers: { cookie } })).json()).toEqual({ elevatedUntil: null });
    // The browser's own same-origin label, or no label (a non-browser client), passes.
    const ok = await app.inject({ method: "POST", url: URL, headers: { cookie, "sec-fetch-site": "same-origin" }, payload: { passphrase: PASSWORD } });
    expect(ok.statusCode).toBe(200);
  });

  it("a body without a passphrase, a non-string passphrase, both passphrase and revoke, or revoke not true is 400 bad_request and the window stays closed", async () => {
    const made = makeApp();
    ({ app } = made);
    const { cookie, sid } = await login(app);
    const elevate = vi.spyOn(made.stepUp, "elevate");
    const revoke = vi.spyOn(made.stepUp, "revoke");
    const bodies: ReadonlyArray<readonly [label: string, payload: unknown]> = [
      ["empty object", {}],
      ["number passphrase", { passphrase: 42 }],
      ["null passphrase", { passphrase: null }],
      ["array passphrase", { passphrase: [PASSWORD] }],
      ["both", { passphrase: PASSWORD, revoke: true }],
      ["both, revoke false", { passphrase: PASSWORD, revoke: false }],
      ["revoke false", { revoke: false }],
      ["revoke string", { revoke: "true" }],
      ["array body", [PASSWORD]],
      ["unrelated key", { password: PASSWORD }]
    ];
    for (const [label, payload] of bodies) {
      const res = await app.inject({ method: "POST", url: URL, headers: { cookie }, payload: payload as never });
      expect(res.statusCode, label).toBe(400);
      expect(res.json()).toEqual({ error: "bad_request" });
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.body).not.toContain(PASSWORD);
    }
    // No body, or a form body, is not JSON (ruling T11-15): 415 before the route's own rules.
    const none = await app.inject({ method: "POST", url: URL, headers: { cookie } });
    expect(none.statusCode, "no body").toBe(415);
    expect(none.json()).toEqual({ error: "unsupported_media_type" });
    const form = await app.inject({ method: "POST", url: URL, headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, payload: `passphrase=${encodeURIComponent(PASSWORD)}` });
    expect(form.statusCode, "form body").toBe(415);
    expect(form.json()).toEqual({ error: "unsupported_media_type" });
    expect(elevate).not.toHaveBeenCalled();
    expect(revoke).not.toHaveBeenCalled();
    expect(made.stepUp.isElevated(sid)).toBe(false);
    expect(made.log.info).not.toHaveBeenCalled();
  });

  it("{ revoke: true } closes the window for every request on that session (204, no-store); revoking a closed window is still 204 (ruling P-1)", async () => {
    const made = makeApp();
    ({ app } = made);
    const { cookie, sid } = await login(app);
    expect((await app.inject({ method: "POST", url: URL, headers: { cookie }, payload: { passphrase: PASSWORD } })).statusCode).toBe(200);
    expect(made.stepUp.isElevated(sid)).toBe(true);
    const res = await app.inject({ method: "POST", url: URL, headers: { cookie, "sec-fetch-site": "same-origin" }, payload: { revoke: true } });
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe("");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(made.stepUp.isElevated(sid)).toBe(false);
    expect((await app.inject({ method: "GET", url: URL, headers: { cookie } })).json()).toEqual({ elevatedUntil: null });
    expect(requireElevated(fakeReq(cookie), made.sessions, made.stepUp)).toEqual({ ok: false, status: 403, reason: "step_up_required" });
    const again = await app.inject({ method: "POST", url: URL, headers: { cookie }, payload: { revoke: true } });
    expect(again.statusCode).toBe(204);
  });

  it("the window expires after 15 minutes: GET reads null and requireElevated refuses; a fresh passphrase re-arms it", async () => {
    const made = makeApp();
    ({ app } = made);
    const { cookie, sid } = await login(app);
    expect((await app.inject({ method: "POST", url: URL, headers: { cookie }, payload: { passphrase: PASSWORD } })).statusCode).toBe(200);
    made.clock.now = T0 + STEP_UP_TTL_MS - 1;
    expect((await app.inject({ method: "GET", url: URL, headers: { cookie } })).json()).toEqual({ elevatedUntil: iso(T0 + STEP_UP_TTL_MS) });
    made.clock.now = T0 + STEP_UP_TTL_MS;
    expect((await app.inject({ method: "GET", url: URL, headers: { cookie } })).json()).toEqual({ elevatedUntil: null });
    expect(requireElevated(fakeReq(cookie), made.sessions, made.stepUp)).toEqual({ ok: false, status: 403, reason: "step_up_required" });
    const again = await app.inject({ method: "POST", url: URL, headers: { cookie }, payload: { passphrase: PASSWORD } });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual({ elevatedUntil: iso(T0 + 2 * STEP_UP_TTL_MS) });
    expect(requireElevated(fakeReq(cookie), made.sessions, made.stepUp)).toEqual({ ok: true, sessionId: sid });
  });

  it("an expired operator session cannot use a window it opened: the guard sends it to /login and requireElevated says cookie-only", async () => {
    const made = makeApp({ sessionTtlMs: 60_000 });
    ({ app } = made);
    const { cookie, sid } = await login(app);
    expect((await app.inject({ method: "POST", url: URL, headers: { cookie }, payload: { passphrase: PASSWORD } })).statusCode).toBe(200);
    made.clock.now = T0 + 60_000; // the session expired; the window has 14 minutes left
    expect(made.stepUp.isElevated(sid)).toBe(true);
    const res = await app.inject({ method: "GET", url: URL, headers: { cookie } });
    expect(res.statusCode).toBe(401);
    expect(requireElevated(fakeReq(cookie), made.sessions, made.stepUp)).toEqual({ ok: false, status: 403, reason: "step_up_cookie_only" });
    // Logout likewise: the destroyed session's window is unreachable.
    made.clock.now = T0;
    const fresh = await login(app);
    expect((await app.inject({ method: "POST", url: URL, headers: { cookie: fresh.cookie }, payload: { passphrase: PASSWORD } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/logout", headers: { cookie: fresh.cookie } })).statusCode).toBe(302);
    expect(requireElevated(fakeReq(fresh.cookie), made.sessions, made.stepUp)).toEqual({ ok: false, status: 403, reason: "step_up_cookie_only" });
  });
});

describe("structured log", () => {
  it("refuse, elevate and revoke each emit one console.step_up line with the hashed session id and the request's uuid correlation id (C2) — never the passphrase, never the guess, never the raw id (ruling T3-1)", async () => {
    const made = makeApp();
    ({ app } = made);
    const { cookie, sid } = await login(app);
    const correlationId = expect.stringMatching(UUID_RE) as string;
    expect((await app.inject({ method: "POST", url: URL, headers: { cookie }, payload: { passphrase: "wrong" } })).statusCode).toBe(403);
    // A refusal is a warn line (L5, D13); an elevation and a revocation are info lines.
    expect(made.log.warn).toHaveBeenCalledTimes(1);
    expect(made.log.warn.mock.calls[0]?.[0]).toEqual({ event: "console.step_up", action: "refuse", sessionIdHash: expectedHash(sid), correlationId });
    expect((await app.inject({ method: "POST", url: URL, headers: { cookie }, payload: { passphrase: PASSWORD } })).statusCode).toBe(200);
    expect(made.log.info).toHaveBeenCalledTimes(1);
    expect(made.log.info.mock.calls[0]?.[0]).toEqual({ event: "console.step_up", action: "elevate", sessionIdHash: expectedHash(sid), correlationId });
    expect((await app.inject({ method: "POST", url: URL, headers: { cookie }, payload: { revoke: true } })).statusCode).toBe(204);
    expect(made.log.info).toHaveBeenCalledTimes(2);
    expect(made.log.info.mock.calls[1]?.[0]).toEqual({ event: "console.step_up", action: "revoke", sessionIdHash: expectedHash(sid), correlationId });
    // One fresh id per request.
    const ids = [...made.log.warn.mock.calls, ...made.log.info.mock.calls].map((c) => (c[0] as { correlationId: string }).correlationId);
    expect(new Set(ids).size).toBe(3);
    const everything = JSON.stringify([...made.log.info.mock.calls, ...made.log.warn.mock.calls, ...made.log.error.mock.calls]);
    expect(everything).not.toContain(PASSWORD);
    expect(everything).not.toContain("wrong");
    expect(everything).not.toContain(sid);
    expect(made.log.error).not.toHaveBeenCalled();
  });

  it("a logger that throws does not break the elevation: the line lands on stderr flagged loggerFailed (the poller's rule)", async () => {
    const made = makeApp();
    ({ app } = made);
    const { cookie, sid } = await login(app);
    made.log.info.mockImplementation(() => {
      throw new Error("sink down");
    });
    const lines: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
      lines.push(String(chunk));
      return true;
    }) as never);
    const res = await app.inject({ method: "POST", url: URL, headers: { cookie }, payload: { passphrase: PASSWORD } });
    expect(res.statusCode).toBe(200);
    expect(made.stepUp.isElevated(sid)).toBe(true);
    const line = lines.find((l) => l.includes("console.step_up"));
    expect(line).toBeDefined();
    expect(JSON.parse(line!)).toMatchObject({ event: "console.step_up", action: "elevate", sessionIdHash: expectedHash(sid), loggerFailed: true });
    expect(line).not.toContain(PASSWORD);
    expect(line).not.toContain(sid);
  });
});
