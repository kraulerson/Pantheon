/**
 * Maestro Console routes (plan Task 10; spec §6, §9; ADR-0010). `GET /console` (the Task 11 page),
 * `GET /console/api/state` and `GET /console/api/cards/:id/expand` sit behind the SAME operator guard as
 * every harness route: no cookie → 302 /login for a browser, 401 for the API, 403 for a keycard bearer
 * (TM-011), and registration adds nothing to PUBLIC_PATHS. The state payload never carries a session's
 * `cwd`; every expand outcome is a labelled state with a first-party message (never user@host, never an
 * exception's text); the JSON routes are no-store. A fake exec plays the dev machine — nothing is dialled.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, afterEach, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp, PUBLIC_PATHS } from "../src/http/app.js";
import { SessionStore } from "../src/http/auth/session.js";
import { SqliteRegistry, seedDefaults } from "../src/registry/sqlite-repository.js";
import { RegistryService } from "../src/registry/service.js";
import { McpRegistrationService } from "../src/registry/mcp-registration.js";
import { SqliteKeycardStore } from "../src/keycard/sqlite-store.js";
import { KeycardService } from "../src/keycard/service.js";
import { SshConnectionError, type RemoteCommandOptions, type RemoteCommandResult } from "../src/devmachine/connection.js";
import type { SshTarget } from "../src/devmachine/provisioning.js";
import type { CardFace } from "../src/console/cards.js";
import { maskSecrets } from "../src/console/masking.js";
import { createConsolePoller, type ConsolePoller } from "../src/console/poller.js";
import { PROBE_MAX_OUTPUT_BYTES, PROBE_SENTINEL } from "../src/console/probe-command.js";
import { consoleSettingsFrom, DEFAULT_CONSOLE_SETTINGS, type ConsoleSettingsResult } from "../src/console/settings.js";
import { SqliteConsoleStore, type ConsoleSessionRow } from "../src/console/store.js";
import { splitTurns, type Turn } from "../src/console/transcript.js";
import type { ConsoleRoutesDeps } from "../src/http/routes/console.js";

const TOKEN = "super-strong-admin-token-0123456789abcdef";
const admin = { authorization: `Bearer ${TOKEN}` };
const html = { accept: "text/html" };
const PREFIX = { "x-forwarded-prefix": "/harness" };

const FILE = readFileSync(join(__dirname, "fixtures", "console", "transcript-basic.jsonl"));
const SID = "6e09d39d-0000-4000-8000-000000000001";
const T0 = "2026-10-17T10:00:00.000Z";
const T1 = "2026-10-17T11:00:00.000Z";
const T2 = "2026-10-17T12:00:00.000Z";
const HEX = "f".repeat(32);
const NO_NEEDS = { needsYou: false, needsKind: null } as const;
const MAC_MINI: SshTarget = { logicalName: "Mac-Mini", host: "192.168.1.192", port: 22, user: "karl" };

type Exec = ConsoleRoutesDeps["exec"];
interface ExecCall {
  readonly target: SshTarget;
  readonly handle: string;
  readonly command: string;
  readonly opts: RemoteCommandOptions;
}

/** Every complete turn of the fixture (the last one closed explicitly: it has no terminator). */
const turns: readonly Turn[] = splitTurns(FILE, 0, undefined, { closeOpenTurn: true }).turns;

const faceOf = (turn: Turn, over: Partial<CardFace> = {}): CardFace => ({
  turnUuid: turn.turnUuid,
  sessionId: SID,
  machine: "Mac-Mini",
  projectKey: "pantheon-harness",
  createdAt: turn.endedAt,
  kind: "reply",
  title: "Committed",
  tldrMasked: "TL;DR: committed",
  byteStart: turn.byteStart,
  byteEnd: turn.byteEnd,
  toolCallCount: turn.toolCallCount,
  thinkingChars: turn.thinkingChars,
  ...over
});

const sessionRow = (over: Partial<Omit<ConsoleSessionRow, "version" | "createdAt" | "updatedAt">> = {}): Omit<ConsoleSessionRow, "version" | "createdAt" | "updatedAt"> => ({
  machine: "Mac-Mini",
  tmuxSession: "pantheon-harness",
  paneId: "%1",
  claudePid: 4242,
  sessionId: SID,
  procStart: "Fri Oct 17 09:00:00 2026",
  cwd: "/Users/karl/Documents/Claude Projects/Pantheon/pantheon-harness",
  projectKey: "pantheon-harness",
  reachable: true,
  status: "busy",
  waitingFor: null,
  state: "working",
  stateReason: null,
  transcriptOffset: 0,
  transcriptSize: FILE.length,
  lastSeenAt: T0,
  endedAt: null,
  ...over
});

interface FakeMachineOptions {
  /** Exit code of the expand command (non-zero → `failed`). */
  readonly code?: number;
  /** Reject every command with an SshConnectionError (→ `unreachable`). */
  readonly reject?: boolean;
}

/** A fake dev machine holding `file`: answers an expand command with the exact bytes of the asked range. */
function fakeMachine(file: Buffer, over: FakeMachineOptions = {}): Exec & { readonly calls: ExecCall[] } {
  const calls: ExecCall[] = [];
  const exec: Exec = (target, handle, command, opts) => {
    calls.push({ target, handle, command, opts });
    if (over.reject === true) return Promise.reject(new SshConnectionError(`SSH connection to ${target.logicalName} (${target.user}@${target.host}) failed`));
    const m = /tail -c \+(\d+) \| head -c (\d+)/.exec(command);
    if (!m) return Promise.reject(new SshConnectionError(`fake machine ${target.logicalName}: not an expand command`));
    const start = Number(m[1]) - 1;
    const end = start + Number(m[2]);
    const payload = file.subarray(start, Math.min(end, file.length)).toString("base64");
    const stdout = `Last login: banner\n${PROBE_SENTINEL}slice:${SID}:${start}:${file.length}:0:1:${payload}\n${PROBE_SENTINEL}end\n`;
    return Promise.resolve<RemoteCommandResult>({ code: over.code ?? 0, stdout, stderr: over.code !== undefined ? "karl@192.168.1.192: boom" : "" });
  };
  return Object.assign(exec, { calls });
}

interface Made {
  readonly app: FastifyInstance;
  readonly registry: RegistryService;
  readonly store: SqliteConsoleStore;
  readonly poller: ConsolePoller;
  readonly exec: ReturnType<typeof fakeMachine>;
}

function makeApp(o: { login?: boolean; settings?: ConsoleSettingsResult; exec?: ReturnType<typeof fakeMachine> } = {}): Made {
  const repo = new SqliteRegistry(":memory:");
  seedDefaults(repo);
  const registry = new RegistryService(repo);
  const mcp = new McpRegistrationService({ createServer: vi.fn(), getServers: vi.fn(async () => ({ success: true, servers: [] })) } as never);
  const keycards = new KeycardService(new SqliteKeycardStore(":memory:"));
  const store = new SqliteConsoleStore();
  const settings: ConsoleSettingsResult = o.settings ?? { ok: true, settings: DEFAULT_CONSOLE_SETTINGS };
  const exec = o.exec ?? fakeMachine(FILE);
  const poller = createConsolePoller({
    registry,
    exec: (target, handle, command) => exec(target, handle, command, { maxOutputBytes: PROBE_MAX_OUTPUT_BYTES, timeoutMs: 4000 }),
    store,
    settings: settings.ok ? settings.settings : DEFAULT_CONSOLE_SETTINGS,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  });
  const app = buildApp({
    adminToken: TOKEN,
    registry,
    mcp,
    keycards,
    console: { store, poller, settings, exec, mask: maskSecrets },
    ...(o.login ? { operatorPassword: "correct horse", sessions: new SessionStore() } : {})
  });
  return { app, registry, store, poller, exec };
}

function addMachine(registry: RegistryService, logicalName: string, over: { provisioned?: boolean; enabled?: boolean } = {}): void {
  const m = registry.createDevMachine({ logicalName, host: "192.168.1.192", user: "karl", enabled: over.enabled ?? true });
  if (over.provisioned ?? true) registry.markProvisioned(m.id, "harness");
}

/** A labelled message is first-party: it names the machine's logicalName and never `user@host`. */
function expectFirstParty(body: string): void {
  expect(body).not.toContain("@");
  expect(body).not.toContain("boom");
}

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("guard (TM-011)", () => {
  it("the console routes are guarded: no cookie → 302 /login for HTML, 401 for the API", async () => {
    ({ app } = makeApp({ login: true }));
    const page = await app.inject({ method: "GET", url: "/console", headers: html });
    expect(page.statusCode).toBe(302);
    expect(page.headers.location).toBe("/login");
    const under = await app.inject({ method: "GET", url: "/console", headers: { ...html, ...PREFIX } });
    expect(under.statusCode).toBe(302);
    expect(under.headers.location).toBe("/harness/login");
    for (const url of ["/console/api/state", `/console/api/cards/${HEX}/expand`]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(401);
      expect(res.json()).toEqual({ error: "unauthenticated" });
    }
  });

  it("a keycard bearer is refused on /console/api/state (403)", async () => {
    ({ app } = makeApp());
    const minted = await app.inject({ method: "POST", url: "/api/keycards", headers: admin, payload: { principal: "cli-mac-mini", scopes: ["sessions:read"] } });
    expect(minted.statusCode).toBe(201);
    const keycard = { authorization: `Bearer ${minted.json().token as string}` };
    for (const url of ["/console/api/state", `/console/api/cards/${HEX}/expand`, "/console"]) {
      const res = await app.inject({ method: "GET", url, headers: keycard });
      expect(res.statusCode, url).toBe(403);
      expect(res.json()).toEqual({ error: "invalid_token" });
    }
  });

  it("registration adds nothing to PUBLIC_PATHS (no console path is ever guard-exempt)", async () => {
    const before = [...PUBLIC_PATHS].sort();
    ({ app } = makeApp({ login: true }));
    await app.ready();
    const after = [...PUBLIC_PATHS].sort();
    expect(after).toEqual(before);
    expect(after.filter((p) => p.startsWith("/console"))).toEqual([]);
  });
});

describe("GET /console (page)", () => {
  it("serves the Task 11 page behind the guard, no-store, framed only by itself, with every URL under the base", async () => {
    ({ app } = makeApp({ login: true }));
    const res = await app.inject({ method: "GET", url: "/console", headers: { ...admin, ...PREFIX } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["content-security-policy"]).toBe("frame-ancestors 'self'");
    expect(res.body).toContain('data-base="/harness"');
    expect(res.body).toContain("<title>Console</title>");
    expect(res.body).toContain("data-cards");
    // No server-rendered disabled banner (the client script merely names the selector).
    expect(res.body).not.toMatch(/<p[^>]*data-console-disabled=/);
    const urls = Array.from(res.body.matchAll(/(?:^|[\s<])(?:href|action|src)="([^"]*)"/g)).map((m) => m[1] ?? "");
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.filter((u) => !(u.startsWith("#") || /^https?:\/\//.test(u) || u.startsWith("/harness/")))).toEqual([]);
    // Root mount: no prefix anywhere.
    const root = await app.inject({ method: "GET", url: "/console", headers: admin });
    expect(root.body).toContain('data-base=""');
    expect(root.body).not.toContain("/harness/console");
  });
});

describe("GET /console/api/state", () => {
  it("state lists machines, sessions and cards, needs-you first, with no-store", async () => {
    const exec = fakeMachine(FILE, { reject: true });
    const made = makeApp({ exec });
    ({ app } = made);
    addMachine(made.registry, "Mac-Mini");
    await made.poller.tick(); // one poll: the fake machine refuses the connection → a labelled machine state
    made.store.upsertSession(sessionRow(), T0);
    const older = made.store.upsertCard(faceOf(turns[0]!, { createdAt: T0 }), { needsYou: true, needsKind: "waiting" }, 90, T0);
    const middle = made.store.upsertCard(faceOf(turns[1]!, { createdAt: T1 }), NO_NEEDS, 90, T1);
    const newest = made.store.upsertCard(faceOf(turns[0]!, { turnUuid: "11111111-2222-4333-8444-555555555555", createdAt: T2 }), NO_NEEDS, 90, T2);

    const res = await app.inject({ method: "GET", url: "/console/api/state", headers: admin });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.headers["cache-control"]).toBe("no-store");
    const body = res.json() as { machines: { machine: string; state: string }[]; sessions: Record<string, unknown>[]; cards: { id: string; needsYou: boolean }[]; settings: unknown };
    expect(body.machines).toEqual(made.poller.health());
    expect(body.machines).toHaveLength(1);
    expect(body.machines[0]).toMatchObject({ machine: "Mac-Mini", state: "unreachable" });
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0]).toMatchObject({ machine: "Mac-Mini", sessionId: SID, tmuxSession: "pantheon-harness", state: "working", version: 1 });
    expect(body.cards.map((c) => c.id)).toEqual([older.id, newest.id, middle.id]);
    expect(body.cards.map((c) => c.needsYou)).toEqual([true, false, false]);
    expect(body.settings).toEqual({ pollSeconds: 5, allTabAreas: ["fleet-sessions", "general"], projects: {} });
    expectFirstParty(res.body);
  });

  // Final review I4: the payload held only the newest 200 cards, so a needs-you card older than those never reached
  // the page while the tab said NEEDS YOU.
  it("a needs-you card older than the newest 200 is still in the payload, first; a flagged card among the newest is listed once", async () => {
    const made = makeApp();
    ({ app } = made);
    const base = turns[0]!;
    const old = made.store.upsertCard(faceOf(base, { turnUuid: "flagged-old", createdAt: "2026-10-16T08:00:00.000Z" }), { needsYou: true, needsKind: "menu_on_screen" }, 90, T0);
    const newer = Array.from({ length: 200 }, (_, i) =>
      made.store.upsertCard(faceOf(base, { turnUuid: `newer-${i}`, createdAt: new Date(Date.parse(T1) + i * 1000).toISOString() }), NO_NEEDS, 90, T1)
    );
    const state = async (): Promise<{ id: string; needsYou: boolean }[]> => {
      const res = await app!.inject({ method: "GET", url: "/console/api/state", headers: admin });
      expect(res.statusCode).toBe(200);
      return (res.json() as { cards: { id: string; needsYou: boolean }[] }).cards;
    };
    let cards = await state();
    expect(cards[0]?.id).toBe(old.id);
    expect(cards).toHaveLength(201);
    expect(cards.slice(1).map((c) => c.id)).toEqual(newer.map((c) => c.id).reverse()); // then the newest, newest first
    // The newest card gets flagged too: both flagged cards lead (newest first) and nothing is listed twice.
    const newest = newer[199]!;
    made.store.setCardNeeds(newest.id, { needsYou: true, needsKind: "waiting", kind: "reply" }, T2);
    cards = await state();
    expect(cards.slice(0, 2).map((c) => c.id)).toEqual([newest.id, old.id]);
    expect(cards).toHaveLength(201);
    expect(new Set(cards.map((c) => c.id)).size).toBe(201);
    expect(cards.slice(2).every((c) => !c.needsYou)).toBe(true);
  });

  it("never serialises a session's cwd", async () => {
    const made = makeApp();
    ({ app } = made);
    made.store.upsertSession(sessionRow({ cwd: "/Users/karl/Documents/Claude Projects/Secret-Client" }), T0);
    const res = await app.inject({ method: "GET", url: "/console/api/state", headers: admin });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { sessions: Record<string, unknown>[] };
    expect(body.sessions).toHaveLength(1);
    expect(Object.keys(body.sessions[0]!)).not.toContain("cwd");
    expect(res.body).not.toContain("Secret-Client");
    expect(res.body).not.toContain("cwd");
  });
});

describe("GET /console/api/cards/:id/expand", () => {
  it("expand of an unknown id is 404 and a non-hex id is 400 with a fixed message", async () => {
    const made = makeApp();
    ({ app } = made);
    const missing = await app.inject({ method: "GET", url: `/console/api/cards/${HEX}/expand`, headers: admin });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ state: "failed", message: "no such card" });
    expect(missing.headers["cache-control"]).toBe("no-store");
    for (const id of ["not-hex", "A".repeat(32), "0".repeat(31), "0".repeat(33), `${"0".repeat(31)}g`]) {
      const res = await app.inject({ method: "GET", url: `/console/api/cards/${id}/expand`, headers: admin });
      expect(res.statusCode, id).toBe(400);
      expect(res.json()).toEqual({ state: "failed", message: "unexpected card id" });
      expect(res.headers["cache-control"]).toBe("no-store");
    }
    expect(made.exec.calls).toEqual([]);
  });

  it("expand returns the view from the fake exec", async () => {
    const made = makeApp();
    ({ app } = made);
    addMachine(made.registry, "Mac-Mini");
    const first = turns[0]!;
    const card = made.store.upsertCard(faceOf(first), NO_NEEDS, 90, T0);
    const res = await app.inject({ method: "GET", url: `/console/api/cards/${card.id}/expand`, headers: admin });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const body = res.json() as { state: string; view: { fullText: string; why: string; whatItDid: { tool: string }[]; agentRuns: number } };
    expect(body.state).toBe("ok");
    expect(body.view.fullText.startsWith("Committed as `9f640cd`")).toBe(true);
    expect(body.view.whatItDid.map((w) => w.tool)).toEqual(["Bash", "Bash", "Bash"]);
    expect(body.view.agentRuns).toBe(0);
    // One dial, to the machine's SSH target with its key handle, capped to the card's own range (+ base64 and slack).
    expect(made.exec.calls).toHaveLength(1);
    const call = made.exec.calls[0]!;
    expect(call.target).toEqual(MAC_MINI);
    expect(call.handle).toBe("harness");
    expect(call.opts).toEqual({ maxOutputBytes: Math.min(PROBE_MAX_OUTPUT_BYTES, Math.ceil(((first.byteEnd - first.byteStart) * 4) / 3) + 4096), timeoutMs: 4000 });
  });

  it("a card whose turn moved is 200 'changed'; an unreachable machine and a failed expand are 502 — first-party messages only", async () => {
    const made = makeApp();
    ({ app } = made);
    addMachine(made.registry, "Mac-Mini");
    const moved = made.store.upsertCard(faceOf(turns[0]!, { turnUuid: "00000000-dead-beef-0000-000000000000" }), NO_NEEDS, 90, T0);
    const changed = await app.inject({ method: "GET", url: `/console/api/cards/${moved.id}/expand`, headers: admin });
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toMatchObject({ state: "changed" });
    expect((changed.json() as { message: string }).message).toContain("Mac-Mini");
    expectFirstParty(changed.body);
    await app.close();

    const down = makeApp({ exec: fakeMachine(FILE, { reject: true }) });
    ({ app } = down);
    addMachine(down.registry, "Mac-Mini");
    const card = down.store.upsertCard(faceOf(turns[0]!), NO_NEEDS, 90, T0);
    const unreachable = await app.inject({ method: "GET", url: `/console/api/cards/${card.id}/expand`, headers: admin });
    expect(unreachable.statusCode).toBe(502);
    expect(unreachable.json()).toEqual({ state: "unreachable", message: "Mac-Mini unreachable — SSH connection failed" });
    expect(unreachable.headers["cache-control"]).toBe("no-store");
    expectFirstParty(unreachable.body);
    await app.close();

    const broken = makeApp({ exec: fakeMachine(FILE, { code: 1 }) });
    ({ app } = broken);
    addMachine(broken.registry, "Mac-Mini");
    const card2 = broken.store.upsertCard(faceOf(turns[0]!), NO_NEEDS, 90, T0);
    const failed = await app.inject({ method: "GET", url: `/console/api/cards/${card2.id}/expand`, headers: admin });
    expect(failed.statusCode).toBe(502);
    expect(failed.json()).toEqual({ state: "failed", message: "expand on Mac-Mini failed (exit 1)" });
    expectFirstParty(failed.body);
  });

  it("a machine that is not connectable is 409 and is never dialled", async () => {
    const made = makeApp();
    ({ app } = made);
    addMachine(made.registry, "Old-Box", { provisioned: false });
    addMachine(made.registry, "Parked", { enabled: false });
    const cases: ReadonlyArray<readonly [machine: string, message: string]> = [
      ["Old-Box", "dev machine 'Old-Box' is not provisioned"],
      ["Parked", "dev machine 'Parked' is disabled"],
      ["Ghost", "no dev machine with logicalName 'Ghost'"]
    ];
    for (const [machine, message] of cases) {
      const card = made.store.upsertCard(faceOf(turns[0]!, { machine, turnUuid: `turn-${machine}` }), NO_NEEDS, 90, T0);
      const res = await app.inject({ method: "GET", url: `/console/api/cards/${card.id}/expand`, headers: admin });
      expect(res.statusCode, machine).toBe(409);
      expect(res.json()).toEqual({ state: "failed", message });
      expect(res.headers["cache-control"]).toBe("no-store");
      expectFirstParty(res.body);
    }
    expect(made.exec.calls).toEqual([]);
  });
});

describe("invalid settings", () => {
  it("with invalid settings the page carries the disabled banner naming the entry and the API answers { disabled: true, entry }", async () => {
    const refused = consoleSettingsFrom('{"pollSeconds": 1}');
    expect(refused.ok).toBe(false);
    const made = makeApp({ settings: refused });
    ({ app } = made);
    const page = await app.inject({ method: "GET", url: "/console", headers: admin });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('data-console-disabled="pollSeconds"');
    expect(page.body).toContain("Console disabled");
    const state = await app.inject({ method: "GET", url: "/console/api/state", headers: admin });
    expect(state.statusCode).toBe(200);
    expect(state.headers["cache-control"]).toBe("no-store");
    const body = state.json() as { settings: unknown; machines: unknown[]; sessions: unknown[]; cards: unknown[] };
    expect(body.settings).toEqual({ disabled: true, entry: "pollSeconds" });
    expect(body).toMatchObject({ machines: [], sessions: [], cards: [] });
  });
});
