/**
 * Maestro Console routes (plan Task 10; spec §6, §9; ADR-0010). `GET /console` (the Task 11 page),
 * `GET /console/api/state` and `GET /console/api/cards/:id/expand` sit behind the SAME operator guard as
 * every harness route: no cookie → 302 /login for a browser, 401 for the API, 403 for a keycard bearer
 * (TM-011), and registration adds nothing to PUBLIC_PATHS. The state payload never carries a session's
 * `cwd`; every expand outcome is a labelled state with a first-party message (never user@host, never an
 * exception's text); the JSON routes are no-store. A fake exec plays the dev machine — nothing is dialled.
 *
 * F2 Task 6 adds `POST /console/api/cards/:id/submit` (behind the passphrase step-up; the one route that types into
 * a session) and `POST /console/api/cards/:id/dismiss`. The fake machine answers the deliver script with a result
 * record. Pinned here: nothing a session wrote is sent back (the command carries the request's text as base64 only,
 * never stripped or masked); every dial is preceded by an `attempted` row and followed by a `result` row; a replayed
 * key returns the stored outcome without a dial; the text never reaches a log line or an error body; rulings T6-2
 * (in-flight join), T6-3 (unresolved key → 409), T6-4 (audit write failure → result failed, then 500).
 *
 * F2 Task 8 adds `GET /console/api/machines/:name/projects` (the projects root's folders, `running` from a live
 * session row whose cwd is the folder; operator guard only) and `POST /console/api/machines/:name/sessions` (behind
 * the step-up: a tmux session running `claude` in an existing folder or a freshly made one). The fake machine answers
 * the live tmux list (collision suffixing), the project-list script and the create script. Pinned here: every refusal
 * writes an `attempted` row then a `refused_*` result row; every dialled path its `attempted` row BEFORE the first
 * dial and a result row after; the folder name travels only single-quoted inside the script and never reaches a log
 * line; rulings T8-2 (a server-minted key per request; the `has-session` miss is a labelled `failed`) and T8-3 (every
 * script failure a labelled record).
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, afterEach, vi, type Mock } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { buildApp, PUBLIC_PATHS } from "../src/http/app.js";
import { SessionStore } from "../src/http/auth/session.js";
import { sessionIdHash, StepUpWindow } from "../src/http/auth/step-up.js";
import { SqliteRegistry, seedDefaults } from "../src/registry/sqlite-repository.js";
import { RegistryService } from "../src/registry/service.js";
import { McpRegistrationService } from "../src/registry/mcp-registration.js";
import { SqliteKeycardStore } from "../src/keycard/sqlite-store.js";
import { KeycardService } from "../src/keycard/service.js";
import { SshConnectionError, type RemoteCommandOptions, type RemoteCommandResult } from "../src/devmachine/connection.js";
import { CustodyError } from "../src/devmachine/custody.js";
import type { SshTarget } from "../src/devmachine/provisioning.js";
import type { CardFace } from "../src/console/cards.js";
import { DELIVER_SENTINEL } from "../src/console/deliver-command.js";
import { maskSecrets, maskSubmitText } from "../src/console/masking.js";
import { createConsolePoller, type ConsolePoller } from "../src/console/poller.js";
import { buildPaneTailCommand, PROBE_MAX_OUTPUT_BYTES, PROBE_SENTINEL } from "../src/console/probe-command.js";
import { PROJECTS_SENTINEL, SESSION_SENTINEL } from "../src/console/session-command.js";
import { consoleSettingsFrom, DEFAULT_CONSOLE_SETTINGS, type ConsoleSettingsResult } from "../src/console/settings.js";
import { SqliteConsoleStore, type ConsoleCardRow, type ConsoleSessionRow, type SubmitLogInsert, type SubmitLogRow } from "../src/console/store.js";
import { splitTurns, type Turn } from "../src/console/transcript.js";
import { TMUX_LIST_SENTINEL } from "../src/devmachine/tmux.js";
import type { ConsoleRoutesDeps } from "../src/http/routes/console.js";

const TOKEN = "super-strong-admin-token-0123456789abcdef";
const PASSWORD = "correct horse";
const admin = { authorization: `Bearer ${TOKEN}` };
const html = { accept: "text/html" };
const PREFIX = { "x-forwarded-prefix": "/harness" };

const FILE = readFileSync(join(__dirname, "fixtures", "console", "transcript-basic.jsonl"));
/** CDF's approval render (F1 fixture): the question, the staged change and the hooks, as the pane shows them. */
const CDF_RENDER = readFileSync(join(__dirname, "fixtures", "console", "pane-cdf-render.txt"), "utf8");
const SID = "6e09d39d-0000-4000-8000-000000000001";
const T0 = "2026-10-17T10:00:00.000Z";
const T1 = "2026-10-17T11:00:00.000Z";
const T2 = "2026-10-17T12:00:00.000Z";
const HEX = "f".repeat(32);
const NO_NEEDS = { needsYou: false, needsKind: null } as const;
const ASKS = { needsYou: true, needsKind: "reply_question", asksYou: true, options: ["A1", "A2"] } as const;
const MAC_MINI: SshTarget = { logicalName: "Mac-Mini", host: "192.168.1.192", port: 22, user: "karl" };
const submitUrl = (id: string): string => `/console/api/cards/${id}/submit`;
const dismissUrl = (id: string): string => `/console/api/cards/${id}/dismiss`;

/** One deliver result record behind login-banner noise (deliver-command.ts grammar; the hashes of the recorded live run). */
const deliverRecord = (outcome: string, status = "idle", detail = "", before = "01ba4719c80b6fe9", after = "f09071c01900fe47"): string =>
  `Last login: banner\n${DELIVER_SENTINEL}result:${outcome}:${status}:${before}:${after}:${detail}\n`;

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

interface DeliverOptions {
  /** What the deliver script printed (default: a `sent` record, status idle, both hashes). */
  readonly stdout?: string;
  readonly code?: number;
  /** Reject the deliver command with this error instead (Review Focus 3: the SSH run dies after the write-ahead row). */
  readonly reject?: Error;
  /** Settle the deliver command this many ms later (ruling T6-2: a second request arrives while the first is in flight). */
  readonly delayMs?: number;
}

interface FakeMachineOptions {
  /** Exit code of the expand command (non-zero → `failed`). */
  readonly code?: number;
  /** Reject every command with an SshConnectionError (→ `unreachable`). */
  readonly reject?: boolean;
  /** How the deliver script (Task 5) answers. */
  readonly deliver?: DeliverOptions;
  /** The names the live tmux list reports (Task 8 collision suffixing); default none. */
  readonly tmuxSessions?: readonly string[];
  /** Reject the tmux list dial only (the create flow fails before its script). */
  readonly tmuxListReject?: boolean;
  /** What the project-list script (Task 8) prints and exits with; default nothing, 0. */
  readonly projects?: { readonly stdout?: string; readonly code?: number };
  /** What the create script (Task 8) prints (default: the `created` record of the command's own `-s` name), its exit code, or a rejection. */
  readonly create?: { readonly stdout?: string; readonly code?: number; readonly reject?: Error };
  /**
   * How the pane-tail command (Task 12) answers: by default one `tail` record for the command's own pane carrying `text`
   * (default: the CDF render fixture), then `end`; or `stdout` verbatim, an exit code, or a rejection.
   */
  readonly pane?: { readonly text?: string; readonly stdout?: string; readonly code?: number; readonly reject?: Error };
}

/**
 * A fake dev machine holding `file`: answers an expand command with the exact bytes of the asked range, a deliver
 * command with its record, the tmux list with its configured names, the project-list and create scripts (Task 8)
 * with what `over` says.
 */
function fakeMachine(file: Buffer, over: FakeMachineOptions = {}): Exec & { readonly calls: ExecCall[] } {
  const calls: ExecCall[] = [];
  const exec: Exec = (target, handle, command, opts) => {
    calls.push({ target, handle, command, opts });
    if (over.reject === true) return Promise.reject(new SshConnectionError(`SSH connection to ${target.logicalName} (${target.user}@${target.host}) failed`));
    if (command.includes("tmux load-buffer")) {
      // The deliver script is the one console command that writes to tmux (deliver-command.ts).
      const d = over.deliver ?? {};
      const settle = (): Promise<RemoteCommandResult> =>
        d.reject !== undefined ? Promise.reject(d.reject) : Promise.resolve({ code: d.code ?? 0, stdout: d.stdout ?? deliverRecord("sent"), stderr: "" });
      return d.delayMs !== undefined ? new Promise<void>((resolve) => setTimeout(resolve, d.delayMs)).then(settle) : settle();
    }
    if (command.includes("tmux list-sessions")) {
      if (over.tmuxListReject === true) return Promise.reject(new SshConnectionError(`SSH connection to ${target.logicalName} (${target.user}@${target.host}) failed`));
      const records = (over.tmuxSessions ?? []).map((n) => `${TMUX_LIST_SENTINEL}1:0:1760000000:${n}\n`).join("");
      return Promise.resolve<RemoteCommandResult>({ code: 0, stdout: `Last login: banner\n${records}`, stderr: "" });
    }
    if (command.includes(PROJECTS_SENTINEL)) {
      const p = over.projects ?? {};
      return Promise.resolve<RemoteCommandResult>({ code: p.code ?? 0, stdout: p.stdout ?? "", stderr: p.code !== undefined ? "karl@192.168.1.192: boom" : "" });
    }
    if (command.includes(SESSION_SENTINEL)) {
      const c = over.create ?? {};
      if (c.reject !== undefined) return Promise.reject(c.reject);
      const name = /tmux new-session -d -s '([^']*)'/.exec(command)?.[1] ?? "";
      return Promise.resolve<RemoteCommandResult>({ code: c.code ?? 0, stdout: c.stdout ?? `Last login: banner\n${SESSION_SENTINEL}created:${name}\n`, stderr: "" });
    }
    if (command.includes("tail_of '") && !command.includes("tmux list-panes")) {
      // The pane-tail command (Task 12): the probe's `tail_of` over one pane, then `end` — never the poller's probe.
      const p = over.pane ?? {};
      if (p.reject !== undefined) return Promise.reject(p.reject);
      const pane = /tail_of '(%\d+)'/.exec(command)?.[1] ?? "";
      const record = `${PROBE_SENTINEL}tail:${pane}:${Buffer.from(p.text ?? CDF_RENDER, "utf8").toString("base64")}\n${PROBE_SENTINEL}end\n`;
      return Promise.resolve<RemoteCommandResult>({ code: p.code ?? 0, stdout: p.stdout ?? `Last login: banner\n${record}`, stderr: p.code !== undefined ? "karl@192.168.1.192: boom" : "" });
    }
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

type Log = { info: Mock; warn: Mock; error: Mock };

interface Made {
  readonly app: FastifyInstance;
  readonly registry: RegistryService;
  readonly store: SqliteConsoleStore;
  readonly poller: ConsolePoller;
  readonly exec: ReturnType<typeof fakeMachine>;
  /** The routes' structured logger (step-up and submit lines). */
  readonly log: Log;
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
  const log: Log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const app = buildApp({
    adminToken: TOKEN,
    registry,
    mcp,
    keycards,
    console: { store, poller, settings, exec, mask: maskSecrets, stepUp: new StepUpWindow(), log },
    ...(o.login ? { operatorPassword: PASSWORD, sessions: new SessionStore() } : {})
  });
  return { app, registry, store, poller, exec, log };
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
  vi.restoreAllMocks();
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
    for (const url of ["/console/api/state", `/console/api/cards/${HEX}/expand`, "/console/api/machines/Mac-Mini/projects"]) {
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
    for (const url of ["/console/api/state", `/console/api/cards/${HEX}/expand`, "/console", "/console/api/machines/Mac-Mini/projects"]) {
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

describe("F1 carries (F2 Task 10)", () => {
  it("HEAD on the expand route is 404 and the fake exec is never called (exposeHeadRoute: false)", async () => {
    const made = makeApp();
    ({ app } = made);
    const card = made.store.upsertCard(faceOf(turns[0]!), NO_NEEDS, 90, T0);
    const res = await app.inject({ method: "HEAD", url: `/console/api/cards/${card.id}/expand`, headers: admin });
    expect(res.statusCode).toBe(404);
    expect(made.exec.calls).toEqual([]);
  });

  it("HEAD on the state route is 404 too", async () => {
    const made = makeApp();
    ({ app } = made);
    const res = await app.inject({ method: "HEAD", url: "/console/api/state", headers: admin });
    expect(res.statusCode).toBe(404);
  });

  it("an unknown path answers a fixed HTML page that echoes neither the path nor the query", async () => {
    const made = makeApp();
    ({ app } = made);
    const res = await app.inject({ method: "GET", url: "/nope?x=secret", headers: admin });
    expect(res.statusCode).toBe(404);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body).not.toContain("nope");
    expect(res.body).not.toContain("secret");
    expect(res.body.length).toBeGreaterThan(0);
  });

  it("an unknown path asked as JSON, or under an API prefix, answers { error: 'not_found' } without the path or query", async () => {
    const made = makeApp();
    ({ app } = made);
    const byAccept = await app.inject({ method: "GET", url: "/nope?x=secret", headers: { ...admin, accept: "application/json" } });
    const byPrefix = await app.inject({ method: "GET", url: "/console/api/nope?x=secret", headers: admin });
    const byApi = await app.inject({ method: "POST", url: "/api/nope?x=secret", headers: admin, payload: {} });
    for (const res of [byAccept, byPrefix, byApi]) {
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: "not_found" });
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.body).not.toContain("nope");
      expect(res.body).not.toContain("secret");
    }
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

// ---------------------------------------------------------------------------------------------------------------
// F2 Task 6: Submit (behind the passphrase step-up) and Dismiss.
// ---------------------------------------------------------------------------------------------------------------

type OutcomeBody = { readonly outcome: string; readonly at: string; readonly message: string };
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MSG_TARGET_CHANGED = "The session this card came from has ended or was cleared";
const MSG_MENU_VISIBLE = "This session is showing a prompt — open its Claude session";
const MSG_FAILED = "Send failed — the text is still in the box";
const MSG_UNRESOLVED = "A send with this key did not finish — check the session before retrying";
const MSG_COPY_MODE = "the session is in copy mode — press q in the Claude session, then Submit again";
const MSG_UNCONFIRMED = "Could not confirm the send — check the Claude session before sending again";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** What a log line carries for the operator session behind a cookie header: the hash, never the id (C2). */
const hashOf = (cookie: string): string => sessionIdHash(cookie.slice("pantheon_session=".length));
/** A reply carrying a token-shaped secret: the audit row must mask it; the command must carry the RAW text, as base64 only. */
const SECRET = `ghp_${"q".repeat(36)}`;
const TEXT = `A1 — rotate ${SECRET} after the trial\nthen hand off`;
const TEXT_BYTES = Buffer.byteLength(TEXT, "utf8");

/** Log in through the real form; the cookie header a browser sends back. */
async function login(app: FastifyInstance): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/login", headers: { "content-type": "application/x-www-form-urlencoded" }, payload: `password=${encodeURIComponent(PASSWORD)}` });
  expect(res.statusCode).toBe(302);
  return `pantheon_session=${res.cookies.find((c) => c.name === "pantheon_session")!.value}`;
}

/** Open the step-up window for that cookie session through the real route. */
async function elevate(app: FastifyInstance, cookie: string): Promise<void> {
  const res = await app.inject({ method: "POST", url: "/console/api/step-up", headers: { cookie }, payload: { passphrase: PASSWORD } });
  expect(res.statusCode).toBe(200);
}

interface Elevated {
  readonly made: Made;
  readonly cookie: string;
  /** The card of the one stored session (Mac-Mini, reachable, status idle): a reply question unless `needs` says otherwise. */
  readonly card: ConsoleCardRow;
  /** POST …/submit as the elevated browser tab; `payload` goes as given. */
  readonly submit: (payload: unknown, over?: { readonly id?: string; readonly headers?: Record<string, string> }) => Promise<LightMyRequestResponse>;
}

/** Login on, Mac-Mini provisioned, one reachable idle session with one card, the operator logged in and elevated. */
async function elevated(o: { exec?: ReturnType<typeof fakeMachine>; needs?: Parameters<SqliteConsoleStore["upsertCard"]>[1]; face?: Partial<CardFace> } = {}): Promise<Elevated> {
  const made = makeApp({ login: true, ...(o.exec ? { exec: o.exec } : {}) });
  app = made.app;
  addMachine(made.registry, "Mac-Mini");
  made.store.upsertSession(sessionRow({ status: "idle" }), T0);
  const card = made.store.upsertCard(faceOf(turns[0]!, o.face), o.needs ?? ASKS, 90, T0);
  const cookie = await login(made.app);
  await elevate(made.app, cookie);
  const submit: Elevated["submit"] = (payload, over = {}) =>
    made.app.inject({ method: "POST", url: submitUrl(over.id ?? card.id), headers: over.headers ?? { cookie }, payload: payload as never });
  return { made, cookie, card, submit };
}

/** The lines of one event a logger received, per level (default `console.submit`). */
function submitLines(log: Log, event = "console.submit"): { readonly info: object[]; readonly warn: object[]; readonly error: object[] } {
  const of = (m: Mock): object[] => m.mock.calls.map((c) => c[0] as object).filter((f) => (f as { event?: string }).event === event);
  return { info: of(log.info), warn: of(log.warn), error: of(log.error) };
}
const everythingLogged = (log: Log): string => JSON.stringify([...log.info.mock.calls, ...log.warn.mock.calls, ...log.error.mock.calls]);

describe("POST /console/api/cards/:id/submit", () => {
  it("is guarded (401), has no HEAD, is refused cross-site and same-site before any check, and joins nothing to PUBLIC_PATHS", async () => {
    const before = [...PUBLIC_PATHS].sort();
    const { made, cookie, card, submit } = await elevated();
    expect([...PUBLIC_PATHS].sort()).toEqual(before);
    const anon = await submit({ text: TEXT, key: randomUUID() }, { headers: {} });
    expect(anon.statusCode).toBe(401);
    expect(anon.json()).toEqual({ error: "unauthenticated" });
    const head = await made.app.inject({ method: "HEAD", url: submitUrl(card.id), headers: admin });
    expect(head.statusCode).toBe(404);
    for (const site of ["cross-site", "same-site"]) {
      const res = await submit({ text: TEXT, key: randomUUID() }, { headers: { cookie, "sec-fetch-site": site } });
      expect(res.statusCode, site).toBe(403);
      expect(res.json()).toEqual({ error: "cross_origin_rejected" });
    }
    expect(made.exec.calls).toEqual([]);
    expect(made.store.listSubmitLog(card.id)).toEqual([]);
    // The browser's own same-origin label passes the rule.
    const ok = await submit({ text: TEXT, key: randomUUID() }, { headers: { cookie, "sec-fetch-site": "same-origin" } });
    expect(ok.statusCode).toBe(200);
    expect(made.exec.calls).toHaveLength(1);
  });

  it("without login Submit answers 503 step_up_unavailable (no-store; nothing dialled or written); Dismiss still works", async () => {
    const made = makeApp();
    ({ app } = made);
    addMachine(made.registry, "Mac-Mini");
    made.store.upsertSession(sessionRow({ status: "idle" }), T0);
    const card = made.store.upsertCard(faceOf(turns[0]!), ASKS, 90, T0);
    const res = await made.app.inject({ method: "POST", url: submitUrl(card.id), headers: admin, payload: { text: TEXT, key: randomUUID() } });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: "step_up_unavailable" });
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(made.exec.calls).toEqual([]);
    expect(made.store.listSubmitLog(card.id)).toEqual([]);
    const dismissed = await made.app.inject({ method: "POST", url: dismissUrl(card.id), headers: admin, payload: {} });
    expect(dismissed.statusCode).toBe(200);
    expect((dismissed.json() as { dismissedAt: string }).dismissedAt).toMatch(ISO_RE);
  });

  it("a bearer-only caller is 403 step_up_cookie_only; a cookie session without the window is 403 step_up_required; nothing dialled or written — one warn line per denial (L7), never the text", async () => {
    const { made, card, submit } = await elevated();
    const payload = { text: TEXT, key: randomUUID() };
    const bearer = await submit(payload, { headers: admin });
    expect(bearer.statusCode).toBe(403);
    expect(bearer.json()).toEqual({ error: "step_up_cookie_only" });
    expect(bearer.headers["cache-control"]).toBe("no-store");
    // A second operator session: the first tab's window is not its window.
    const cold = await submit(payload, { headers: { cookie: await login(made.app) } });
    expect(cold.statusCode).toBe(403);
    expect(cold.json()).toEqual({ error: "step_up_required" });
    expect(cold.headers["cache-control"]).toBe("no-store");
    expect(made.exec.calls).toEqual([]);
    expect(made.store.listSubmitLog(card.id)).toEqual([]);
    expect(submitLines(made.log).info).toEqual([]);
    expect(submitLines(made.log, "console.submit_denied").warn).toEqual([
      { event: "console.submit_denied", reason: "step_up_cookie_only", correlationId: expect.stringMatching(UUID_RE) as string },
      { event: "console.submit_denied", reason: "step_up_required", correlationId: expect.stringMatching(UUID_RE) as string }
    ]);
    expect(everythingLogged(made.log)).not.toContain(SECRET);
  });

  it("happy path: write-ahead attempted row (masked text, the row's status), one dial carrying the RAW text as base64 only, a result row, the card answered, 200 'answered by you', one log line without the text", async () => {
    const { made, cookie, card, submit } = await elevated();
    const key = randomUUID();
    const res = await submit({ text: TEXT, key });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.headers["cache-control"]).toBe("no-store");
    const body = res.json() as OutcomeBody;
    expect(body).toEqual({ outcome: "sent", at: expect.stringMatching(ISO_RE) as string, message: "answered by you" });
    expect(res.body).not.toContain(SECRET);
    // Exactly one dial: the machine's target and key handle, the brief's budget, the deliver script built from the stored row.
    expect(made.exec.calls).toHaveLength(1);
    const call = made.exec.calls[0]!;
    expect(call.target).toEqual(MAC_MINI);
    expect(call.handle).toBe("harness");
    expect(call.opts).toEqual({ timeoutMs: 6000, maxOutputBytes: 65536 });
    expect(call.command).not.toContain(TEXT);
    expect(call.command).not.toContain(SECRET);
    expect(call.command).not.toContain("[masked]"); // never stripped or masked on its way to the session
    expect(call.command).toContain(`payload() { printf '%s' '${Buffer.from(TEXT, "utf8").toString("base64")}'; }`);
    expect(call.command).toContain('f="$HOME/.claude/sessions/4242.json"');
    expect(call.command).toContain(`[ "$(field sessionId)" = '${SID}' ]`);
    expect(call.command).toContain(`[ "$(field procStart)" = 'Fri Oct 17 09:00:00 2026' ]`);
    expect(call.command).toContain("kill -0 '4242'");
    expect(call.command).toContain("-t '%1'");
    // Triage 17 (IV-5): the tmux buffer is fresh per Submit, never derived from the card.
    expect(call.command).toMatch(/load-buffer -b console-[0-9a-f]{8} -/);
    expect(call.command).not.toContain(`console-${card.id.slice(0, 8)}`);
    expect(call.command).toContain("capture-pane -p -J -S -40");
    // Two audit rows, in order: attempted (write-ahead, the masked text) then result sent (the script's status and tail hash).
    const rows = made.store.listSubmitLog(card.id);
    expect(rows.map((r) => r.rowKind)).toEqual(["result", "attempted"]); // newest first
    const [result, attempted] = rows as [SubmitLogRow, SubmitLogRow];
    expect(attempted).toMatchObject({
      idempotencyKey: key, outcome: null, reason: null, machine: "Mac-Mini", tmuxSession: "pantheon-harness", paneId: "%1", claudePid: 4242,
      sessionId: SID, procStart: "Fri Oct 17 09:00:00 2026", statusAtSend: "idle", cardId: card.id, textMasked: maskSubmitText(TEXT), paneTailHash: null
    });
    expect(attempted.textMasked).toContain("[masked]");
    expect(attempted.textMasked).not.toContain(SECRET);
    expect(attempted.at).toMatch(ISO_RE);
    expect(result).toMatchObject({
      idempotencyKey: key, outcome: "sent", reason: null, machine: "Mac-Mini", tmuxSession: "pantheon-harness", paneId: "%1", claudePid: 4242,
      sessionId: SID, procStart: "Fri Oct 17 09:00:00 2026", statusAtSend: "idle", cardId: card.id, textMasked: null, paneTailHash: "01ba4719c80b6fe9", at: body.at
    });
    expect(Date.parse(result.at)).toBeGreaterThanOrEqual(Date.parse(attempted.at));
    // The reply question is answered: answered_at set, needs_you cleared, needs_kind kept.
    expect(made.store.getCard(card.id)).toMatchObject({ answeredAt: body.at, needsYou: false, needsKind: "reply_question" });
    // One structured line: the five fields, never the text.
    const lines = submitLines(made.log);
    // C2 (L4): the correlation id is a fresh uuid per request (`genReqId`), and the line names the operator session by its hash.
    expect(lines.info).toEqual([{ event: "console.submit", cardId: card.id, machine: "Mac-Mini", outcome: "sent", bytes: TEXT_BYTES, correlationId: expect.stringMatching(UUID_RE) as string, sessionIdHash: hashOf(cookie) }]);
    expect(everythingLogged(made.log)).not.toContain(cookie.slice("pantheon_session=".length));
    expect(lines.error).toEqual([]);
    expect(everythingLogged(made.log)).not.toContain(SECRET);
    expect(everythingLogged(made.log)).not.toContain("rotate");
  });

  it("triage 17 (IV-5): every Submit names its own tmux buffer — two sends to one card never share one", async () => {
    const { made, submit } = await elevated();
    expect((await submit({ text: "A1", key: randomUUID() })).statusCode).toBe(200);
    expect((await submit({ text: "A2", key: randomUUID() })).statusCode).toBe(200);
    const buffers = made.exec.calls.map((c) => /load-buffer -b (console-[0-9a-f]{8}) -/.exec(c.command)?.[1]);
    expect(buffers).toHaveLength(2);
    expect(buffers.every((b) => b !== undefined)).toBe(true);
    expect(buffers[0]).not.toBe(buffers[1]);
    // The same buffer is pasted and, on a failed paste, deleted: one name per script.
    for (const c of made.exec.calls) expect(new Set(c.command.match(/console-[0-9a-f]{8}/g)).size).toBe(1);
  });

  it("triage 19 (F-3): a pane in copy mode is refused_menu_visible with its own words — press q in the Claude session — and a replay says the same", async () => {
    const exec = fakeMachine(FILE, { deliver: { stdout: deliverRecord("refused_menu_visible", "idle", "pane in copy mode", "01ba4719c80b6fe9", "") } });
    const { made, card, submit } = await elevated({ exec });
    const key = randomUUID();
    const res = await submit({ text: TEXT, key });
    expect(res.statusCode).toBe(200);
    const body = res.json() as OutcomeBody;
    expect(body).toEqual({ outcome: "refused_menu_visible", at: expect.stringMatching(ISO_RE) as string, message: MSG_COPY_MODE });
    expect(made.store.findSubmitResult(key)).toMatchObject({ outcome: "refused_menu_visible", reason: "pane in copy mode" });
    expect(made.store.getCard(card.id)).toMatchObject({ answeredAt: null, needsYou: true });
    const again = await submit({ text: TEXT, key });
    expect(again.json()).toEqual(body);
    expect(made.exec.calls).toHaveLength(1);
  });

  it("a replayed key returns the stored outcome without a second dial, a new row or a new log line — even with different text", async () => {
    const { made, card, submit } = await elevated();
    const key = randomUUID();
    const first = await submit({ text: TEXT, key });
    expect(first.statusCode).toBe(200);
    const again = await submit({ text: TEXT, key });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual(first.json());
    const other = await submit({ text: "A2", key });
    expect(other.statusCode).toBe(200);
    expect(other.json()).toEqual(first.json());
    expect(made.exec.calls).toHaveLength(1);
    expect(made.store.listSubmitLog(card.id)).toHaveLength(2);
    expect(submitLines(made.log).info).toHaveLength(1);
  });

  it("Review Focus 3 + ruling T11-18: a dial that dies once the exec request was sent is unconfirmed — 200 with the check-first words, the row's reason names the failure, the card unanswered, a replay says the same, one warn line with the error's class only", async () => {
    const cases: ReadonlyArray<readonly [label: string, reject: Error, reason: string]> = [
      ["the command timed out", new SshConnectionError("remote command on Mac-Mini timed out after 6000 ms", "after_exec"), "timeout"],
      ["the connection dropped", new SshConnectionError("SSH connection to Mac-Mini (karl@192.168.1.192) failed", "after_exec"), "ssh_failed"],
      ["the exec channel failed", new SshConnectionError("failed to run a command on Mac-Mini", "after_exec"), "exec_error"]
    ];
    for (const [label, reject, reason] of cases) {
      const { made, cookie, card, submit } = await elevated({ exec: fakeMachine(FILE, { deliver: { reject } }) });
      const key = randomUUID();
      const res = await submit({ text: TEXT, key });
      expect(res.statusCode, label).toBe(200);
      const body = res.json() as OutcomeBody;
      expect(body, label).toEqual({ outcome: "unconfirmed", at: expect.stringMatching(ISO_RE) as string, message: MSG_UNCONFIRMED });
      expect(res.body).not.toContain("timed out");
      expectFirstParty(res.body);
      const rows = made.store.listSubmitLog(card.id);
      expect(rows.map((r) => r.rowKind)).toEqual(["result", "attempted"]);
      expect(rows[0], label).toMatchObject({ idempotencyKey: key, outcome: "unconfirmed", reason, statusAtSend: "idle", paneTailHash: null, textMasked: null, at: body.at });
      expect(rows[1]).toMatchObject({ idempotencyKey: key, outcome: null, textMasked: maskSubmitText(TEXT) });
      expect(made.store.getCard(card.id)).toMatchObject({ answeredAt: null, needsYou: true });
      const again = await submit({ text: TEXT, key });
      expect(again.json(), label).toEqual(body);
      expect(made.exec.calls).toHaveLength(1);
      expect(submitLines(made.log).warn, label).toEqual([
        { event: "console.submit", cardId: card.id, machine: "Mac-Mini", outcome: "unconfirmed", bytes: TEXT_BYTES, correlationId: expect.stringMatching(UUID_RE) as string, sessionIdHash: hashOf(cookie), reason, errName: "SshConnectionError" }
      ]);
      expect(submitLines(made.log).info).toEqual([]);
      for (const leak of [SECRET, "192.168", "timed out", "failed to run"]) expect(everythingLogged(made.log), label).not.toContain(leak);
      await made.app.close();
    }
  });

  it("ruling T11-18: a dial that fails before the exec request — refused connection, no key in custody, a non-SSH error — is failed connect_failed: the text is still in the box", async () => {
    const cases: ReadonlyArray<readonly [label: string, reject: Error, errName: string]> = [
      ["connect refused", new SshConnectionError("SSH connection to Mac-Mini (karl@192.168.1.192) failed", "before_exec"), "SshConnectionError"],
      ["no phase at all", new SshConnectionError("SSH client for Mac-Mini could not be created"), "SshConnectionError"],
      ["custody", new CustodyError("no usable private key for handle: harness (missing or a symlink)"), "CustodyError"],
      ["something else", new Error("boom"), "Error"]
    ];
    for (const [label, reject, errName] of cases) {
      const { made, card, submit } = await elevated({ exec: fakeMachine(FILE, { deliver: { reject } }) });
      const key = randomUUID();
      const res = await submit({ text: TEXT, key });
      expect(res.json(), label).toEqual({ outcome: "failed", at: expect.stringMatching(ISO_RE) as string, message: MSG_FAILED });
      expect(made.store.findSubmitResult(key), label).toMatchObject({ outcome: "failed", reason: "connect_failed", statusAtSend: "idle" });
      expect(made.store.getCard(card.id)).toMatchObject({ answeredAt: null, needsYou: true });
      expect(submitLines(made.log).warn, label).toEqual([expect.objectContaining({ outcome: "failed", reason: "connect_failed", errName })]);
      for (const leak of ["192.168", "private key", "boom", "could not be created"]) expect(everythingLogged(made.log), label).not.toContain(leak);
      await made.app.close();
    }
  });

  const scriptOutcomes: ReadonlyArray<{
    readonly label: string;
    readonly deliver: DeliverOptions;
    readonly outcome: string;
    readonly message: string;
    readonly reason: string;
    /** The script's status when it reported one, else the row's. */
    readonly statusAtSend: string;
    readonly paneTailHash: string | null;
  }> = [
    { label: "refused_target_changed", deliver: { stdout: deliverRecord("refused_target_changed", "", "session file gone", "", "") }, outcome: "refused_target_changed", message: MSG_TARGET_CHANGED, reason: "session file gone", statusAtSend: "idle", paneTailHash: null },
    { label: "refused_menu_visible (anchor)", deliver: { stdout: deliverRecord("refused_menu_visible", "idle", "❯ 1. ", "01ba4719c80b6fe9", "") }, outcome: "refused_menu_visible", message: MSG_MENU_VISIBLE, reason: "❯ 1. ", statusAtSend: "idle", paneTailHash: "01ba4719c80b6fe9" },
    { label: "refused_menu_visible (status)", deliver: { stdout: deliverRecord("refused_menu_visible", "waiting", "status waiting", "", "") }, outcome: "refused_menu_visible", message: MSG_MENU_VISIBLE, reason: "status waiting", statusAtSend: "waiting", paneTailHash: null },
    { label: "failed at tmux step 2", deliver: { stdout: deliverRecord("failed", "busy", "tmux step 2", "01ba4719c80b6fe9", "") }, outcome: "failed", message: MSG_FAILED, reason: "tmux step 2", statusAtSend: "busy", paneTailHash: "01ba4719c80b6fe9" },
    // Ruling T11-18: Enter failed after the paste, so the text sits in Claude's input line — unconfirmed, never "still in the box".
    { label: "tmux step 3 (unconfirmed)", deliver: { stdout: deliverRecord("failed", "busy", "tmux step 3", "01ba4719c80b6fe9", "") }, outcome: "unconfirmed", message: MSG_UNCONFIRMED, reason: "tmux_step_3", statusAtSend: "busy", paneTailHash: "01ba4719c80b6fe9" },
    { label: "no record (unconfirmed)", deliver: { stdout: "Permission denied (publickey)\n", code: 255 }, outcome: "unconfirmed", message: MSG_UNCONFIRMED, reason: "no_record", statusAtSend: "idle", paneTailHash: null },
    { label: "the pre-read tool guard (126)", deliver: { stdout: "probe: base64 not found\n", code: 126 }, outcome: "failed", message: MSG_FAILED, reason: "the delivery script did not report back", statusAtSend: "idle", paneTailHash: null },
    { label: "non-zero exit beside a record", deliver: { stdout: deliverRecord("sent"), code: 1 }, outcome: "failed", message: MSG_FAILED, reason: "the delivery script exited with code 1", statusAtSend: "idle", paneTailHash: null }
  ];
  it.each(scriptOutcomes)("the script's $label outcome: attempted + result rows, the §9 message, 200, the card unanswered, one warn line with the row's reason", async ({ deliver, outcome, message, reason, statusAtSend, paneTailHash }) => {
    const { made, card, submit } = await elevated({ exec: fakeMachine(FILE, { deliver }) });
    const key = randomUUID();
    const res = await submit({ text: TEXT, key });
    expect(res.statusCode).toBe(200);
    const body = res.json() as OutcomeBody;
    expect(body).toEqual({ outcome, at: expect.stringMatching(ISO_RE) as string, message });
    expectFirstParty(res.body);
    expect(res.body).not.toContain("publickey");
    const rows = made.store.listSubmitLog(card.id);
    expect(rows.map((r) => r.rowKind)).toEqual(["result", "attempted"]);
    expect(rows[0]).toMatchObject({ idempotencyKey: key, outcome, reason, statusAtSend, paneTailHash, textMasked: null, at: body.at });
    expect(rows[1]).toMatchObject({ idempotencyKey: key, outcome: null, statusAtSend: "idle", textMasked: maskSubmitText(TEXT) });
    expect(made.store.getCard(card.id)).toMatchObject({ answeredAt: null, needsYou: true });
    expect(made.exec.calls).toHaveLength(1);
    // Ruling L5/L6 (D13): a refusal, a failure or an unconfirmed send is a warn line carrying the row's first-party reason.
    expect(submitLines(made.log).warn).toEqual([expect.objectContaining({ event: "console.submit", outcome, bytes: TEXT_BYTES, reason })]);
    expect(submitLines(made.log).info).toEqual([]);
    expect(everythingLogged(made.log)).not.toContain(SECRET);
  });

  it("'sent' wording: busy at send says queued (and a reply question is still answered); a reply question says answered by you; any other card says sent — waiting and is not marked answered", async () => {
    const busy = await elevated({ exec: fakeMachine(FILE, { deliver: { stdout: deliverRecord("sent", "busy") } }) });
    let res = await busy.submit({ text: "A1", key: randomUUID() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ outcome: "sent", message: "queued — the session is busy" });
    expect(busy.made.store.listSubmitLog(busy.card.id)[0]).toMatchObject({ rowKind: "result", outcome: "sent", statusAtSend: "busy" });
    expect(busy.made.store.getCard(busy.card.id)).toMatchObject({ answeredAt: (res.json() as OutcomeBody).at, needsYou: false });
    await busy.made.app.close();

    const plain = await elevated({ needs: NO_NEEDS });
    res = await plain.submit({ text: "A1", key: randomUUID() });
    expect(res.json()).toMatchObject({ outcome: "sent", message: "sent — waiting for the session" });
    expect(plain.made.store.getCard(plain.card.id)).toMatchObject({ answeredAt: null, needsYou: false });
    await plain.made.app.close();

    // A waiting signal is the session's own state: the send does not clear it (the poller will).
    const waiting = await elevated({ needs: { needsYou: true, needsKind: "waiting" } });
    res = await waiting.submit({ text: "A1", key: randomUUID() });
    expect(res.json()).toMatchObject({ outcome: "sent", message: "sent — waiting for the session" });
    expect(waiting.made.store.getCard(waiting.card.id)).toMatchObject({ answeredAt: null, needsYou: true, needsKind: "waiting" });
  });

  it("400 for a malformed id (fixed text), 404 for an unknown card, 400 invalid_key before the text is read, 400 refusals that never echo the text; nothing dialled, written or logged", async () => {
    const { made, cookie, card, submit } = await elevated();
    const key = randomUUID();
    for (const id of ["not-hex", "A".repeat(32), "0".repeat(31), "0".repeat(33), `${"0".repeat(31)}g`]) {
      const res = await submit({ text: TEXT, key }, { id });
      expect(res.statusCode, id).toBe(400);
      expect(res.json()).toEqual({ error: "unexpected card id" });
      expect(res.headers["cache-control"]).toBe("no-store");
    }
    const missing = await submit({ text: TEXT, key }, { id: HEX });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: "no such card" });
    expect(missing.headers["cache-control"]).toBe("no-store");
    // The key is checked before the text: an ESC text beside a bad key is invalid_key.
    for (const bad of [undefined, "", 42, key.toUpperCase(), `${key}\n`, key.replace(/-/g, ""), `{${key}}`]) {
      const res = await submit({ text: "\x1b[31m hello", key: bad });
      expect(res.statusCode, JSON.stringify(bad)).toBe(400);
      expect(res.json()).toEqual({ error: "invalid_key" });
    }
    // No body at all is not JSON (ruling T11-15).
    const none = await made.app.inject({ method: "POST", url: submitUrl(card.id), headers: { cookie } });
    expect(none.statusCode, "no body").toBe(415);
    expect(none.json()).toEqual({ error: "unsupported_media_type" });
    const array = await submit([TEXT, key]);
    expect(array.statusCode, "array body").toBe(400);
    expect(array.json()).toEqual({ error: "invalid_key" });
    // Refusals: the labelled reason alone, never the text.
    const refusals: ReadonlyArray<readonly [label: string, text: unknown, reason: string]> = [
      ["ESC", "\x1b[31m hello", "escape"],
      ["BEL", "ring\x07ring", "control_char"],
      ["CRLF", "one\r\ntwo", "control_char"],
      ["lone surrogate", "\ud800x", "invalid_utf8"],
      ["4097 bytes", "x".repeat(4097), "too_long"],
      ["empty", "", "empty"],
      ["whitespace only", " \n\t ", "empty"],
      ["number", 42, "not_text"],
      ["missing", undefined, "not_text"],
      ["array", ["A1"], "not_text"]
    ];
    for (const [label, text, reason] of refusals) {
      const res = await submit({ text, key });
      expect(res.statusCode, label).toBe(400);
      expect(res.body, label).toBe(JSON.stringify({ error: reason }));
      expect(res.headers["cache-control"]).toBe("no-store");
    }
    expect(made.exec.calls).toEqual([]);
    expect(made.store.listSubmitLog(card.id)).toEqual([]);
    expect(submitLines(made.log).info).toEqual([]);
    expect(everythingLogged(made.log)).not.toContain("hello");
    expect(everythingLogged(made.log)).not.toContain(SECRET);
  });

  it("409 not_reachable — no session row, reachable false, ended, an sh- shell, an unconnectable machine — dials nothing and writes nothing", async () => {
    const { made, card, submit } = await elevated();
    const expectNotReachable = async (label: string, id = card.id): Promise<void> => {
      const res = await submit({ text: "A1", key: randomUUID() }, { id });
      expect(res.statusCode, label).toBe(409);
      expect(res.json()).toEqual({ error: "not_reachable" });
      expect(res.headers["cache-control"]).toBe("no-store");
    };
    const orphan = made.store.upsertCard(faceOf(turns[1]!, { sessionId: "6e09d39d-0000-4000-8000-000000000002" }), ASKS, 90, T0);
    await expectNotReachable("no session row", orphan.id);
    made.store.upsertSession(sessionRow({ status: "idle", reachable: false }), T1);
    await expectNotReachable("reachable false");
    made.store.upsertSession(sessionRow({ status: "idle", endedAt: T1 }), T1);
    await expectNotReachable("ended");
    made.store.upsertSession(sessionRow({ status: "idle", tmuxSession: "sh-Mac-Mini" }), T1);
    await expectNotReachable("sh- shell");
    // Reachable by the row, but on a machine the registry cannot dial (the expand route's fail-closed rule).
    made.store.upsertSession(sessionRow({ status: "idle", machine: "Ghost" }), T1);
    const ghost = made.store.upsertCard(faceOf(turns[1]!, { turnUuid: "ghost-turn", machine: "Ghost" }), ASKS, 90, T0);
    await expectNotReachable("unconnectable machine", ghost.id);
    expect(made.exec.calls).toEqual([]);
    for (const id of [card.id, orphan.id, ghost.id]) expect(made.store.listSubmitLog(id)).toEqual([]);
    expect(submitLines(made.log).info).toEqual([]);
    // Restored, the same card sends.
    made.store.upsertSession(sessionRow({ status: "idle" }), T2);
    expect((await submit({ text: "A1", key: randomUUID() })).json()).toMatchObject({ outcome: "sent" });
    expect(made.exec.calls).toHaveLength(1);
  });

  it("409 menu_card for a menu card: nothing dialled or written (menu cards have no Submit)", async () => {
    const { made, card, submit } = await elevated({ face: { kind: "menu" }, needs: { needsYou: true, needsKind: "menu_on_screen" } });
    const res = await submit({ text: "1", key: randomUUID() });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "menu_card" });
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(made.exec.calls).toEqual([]);
    expect(made.store.listSubmitLog(card.id)).toEqual([]);
  });

  it("ruling T6-2: two Submits in flight with one key (two tabs, Review Focus 4) make one dial, write two rows and get identical answers; afterwards the key replays from the store", async () => {
    const { made, card, submit } = await elevated({ exec: fakeMachine(FILE, { deliver: { delayMs: 25 } }) });
    const key = randomUUID();
    const [a, b] = await Promise.all([submit({ text: TEXT, key }), submit({ text: TEXT, key })]);
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    expect(a.json()).toEqual({ outcome: "sent", at: expect.stringMatching(ISO_RE) as string, message: "answered by you" });
    expect(b.json()).toEqual(a.json());
    expect(made.exec.calls).toHaveLength(1);
    expect(made.store.listSubmitLog(card.id).map((r) => r.rowKind)).toEqual(["result", "attempted"]);
    expect(submitLines(made.log).info).toHaveLength(1);
    const c = await submit({ text: TEXT, key });
    expect(c.json()).toEqual(a.json());
    expect(made.exec.calls).toHaveLength(1);
  });

  it("ruling T6-3: a key with an attempted row and no result is 409 unresolved (nothing dialled, nothing written); a key with a result replays it without touching the log", async () => {
    const { made, card, submit } = await elevated();
    const key = randomUUID();
    const base = { idempotencyKey: key, machine: "Mac-Mini", cardId: card.id } as const;
    made.store.appendSubmitLog({ ...base, at: T1, rowKind: "attempted", textMasked: "A1" });
    const res = await submit({ text: TEXT, key });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "unresolved", message: MSG_UNRESOLVED });
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(made.exec.calls).toEqual([]);
    expect(made.store.listSubmitLog(card.id)).toHaveLength(1);
    expect(submitLines(made.log).info).toEqual([]);
    // L8 (D13): the only runtime sign that an earlier dial died mid-flight is one warn line — never the text or the key.
    expect(submitLines(made.log, "console.submit_unresolved").warn).toEqual([
      { event: "console.submit_unresolved", cardId: card.id, machine: "Mac-Mini", bytes: TEXT_BYTES, correlationId: expect.stringMatching(UUID_RE) as string, sessionIdHash: expect.stringMatching(/^[0-9a-f]{12}$/) as string }
    ]);
    expect(everythingLogged(made.log)).not.toContain(key);
    // Once a result exists for the key it is replayed: the stored outcome and its own `at`, the §9 message, no dial.
    made.store.appendSubmitLog({ ...base, at: T2, rowKind: "result", outcome: "refused_target_changed", reason: "session file gone", statusAtSend: "idle" });
    const replay = await submit({ text: TEXT, key });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual({ outcome: "refused_target_changed", at: T2, message: MSG_TARGET_CHANGED });
    expect(made.exec.calls).toEqual([]);
    expect(made.store.listSubmitLog(card.id)).toHaveLength(2);
    // A stored busy `sent` replays as queued (the message is recomputed from the stored row, never guessed).
    const busyKey = randomUUID();
    made.store.appendSubmitLog({ ...base, idempotencyKey: busyKey, at: T2, rowKind: "result", outcome: "sent", statusAtSend: "busy" });
    expect((await submit({ text: TEXT, key: busyKey })).json()).toEqual({ outcome: "sent", at: T2, message: "queued — the session is busy" });
    expect(made.exec.calls).toEqual([]);
    expect(submitLines(made.log).info).toEqual([]);
  });

  it("ruling T6-4: a write-ahead append that fails for another reason → a result failed audit_write_failed row (no text), 200 failed, replay failed; both appends failing → 500 internal_error, one error line, the text nowhere", async () => {
    const { made, cookie, card, submit } = await elevated();
    const spy = vi.spyOn(made.store, "appendSubmitLog");
    spy.mockImplementationOnce(() => {
      throw new Error("SQLITE_IOERR: disk I/O error");
    });
    const key = randomUUID();
    const res = await submit({ text: TEXT, key });
    expect(res.statusCode).toBe(200);
    const body = res.json() as OutcomeBody;
    expect(body).toEqual({ outcome: "failed", at: expect.stringMatching(ISO_RE) as string, message: MSG_FAILED });
    expect(made.exec.calls).toEqual([]);
    const rows = made.store.listSubmitLog(card.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ idempotencyKey: key, rowKind: "result", outcome: "failed", reason: "audit_write_failed", textMasked: null, statusAtSend: "idle", paneTailHash: null, at: body.at });
    expect(made.store.getCard(card.id)).toMatchObject({ answeredAt: null, needsYou: true });
    // L5 (D13): an audit store refusing writes is an error line, with the error's class (never its message).
    const auditLine = { event: "console.submit", cardId: card.id, machine: "Mac-Mini", outcome: "failed", bytes: TEXT_BYTES, correlationId: expect.stringMatching(UUID_RE) as string, sessionIdHash: hashOf(cookie), reason: "audit_write_failed", errName: "Error" };
    expect(submitLines(made.log).error).toEqual([auditLine]);
    expect(submitLines(made.log).info).toEqual([]);
    const replay = await submit({ text: TEXT, key });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(body);
    expect(made.exec.calls).toEqual([]);
    // Both appends fail: fail loud — 500 through the app's error handler, one error-level line, nothing written.
    spy.mockImplementation(() => {
      throw new Error("SQLITE_IOERR: disk I/O error");
    });
    const key2 = randomUUID();
    const dead = await submit({ text: TEXT, key: key2 });
    expect(dead.statusCode).toBe(500);
    expect(dead.json()).toEqual({ error: "internal_error" });
    expect(dead.body).not.toContain("disk");
    expect(made.exec.calls).toEqual([]);
    expect(made.store.listSubmitLog(card.id)).toHaveLength(1);
    expect(submitLines(made.log).error).toEqual([auditLine, auditLine]);
    expect(made.log.error.mock.calls.map((c) => c[1])).toEqual(["console submit: failed (audit_write_failed)", "console submit: audit write failed twice"]);
    expect(everythingLogged(made.log)).not.toContain(SECRET);
    expect(everythingLogged(made.log)).not.toContain("rotate");
    expect(everythingLogged(made.log)).not.toContain("disk I/O");
    // Nothing was recorded for that key, so once the store recovers the same key sends.
    spy.mockRestore();
    expect((await submit({ text: TEXT, key: key2 })).json()).toMatchObject({ outcome: "sent" });
    expect(made.exec.calls).toHaveLength(1);
  });

  it("ruling T11-14 (DI-2(b)): the audit copy is maskSubmitText — a bare unprefixed secret never reaches text_masked, while the RAW text still reaches the session", async () => {
    const { made, card, submit } = await elevated();
    const bare = "Zq8".repeat(13) + "x"; // a Cloudflare / AWS-secret shape with no context word, built at runtime
    const text = `A1 — the new value is ${bare}`;
    expect(maskSecrets(text)).toBe(text); // the shared mask alone keeps it (no context word)
    expect((await submit({ text, key: randomUUID() })).statusCode).toBe(200);
    const attempted = made.store.listSubmitLog(card.id).find((r) => r.rowKind === "attempted");
    expect(attempted?.textMasked).toBe("A1 — the new value is [masked]");
    expect(made.exec.calls[0]!.command).toContain(Buffer.from(text, "utf8").toString("base64"));
  });

  it("ruling T11-6 (DI-1, DI-3): every machine- or operator-derived text field of a submit-log row is masked before storage — status_at_send, reason, tmux_session", async () => {
    const token = "ghp_" + "Q".repeat(24); // token-shaped and inside the record's own allow-lists
    const exec = fakeMachine(FILE, { deliver: { stdout: deliverRecord("refused_menu_visible", token, `status ${token}`, "", "") } });
    const { made, card, submit } = await elevated({ exec });
    made.store.upsertSession(sessionRow({ status: token, tmuxSession: token }), T1);
    const res = await submit({ text: "A1", key: randomUUID() });
    expect(res.json()).toMatchObject({ outcome: "refused_menu_visible", message: MSG_MENU_VISIBLE });
    const rows = made.store.listSubmitLog(card.id);
    expect(rows.map((r) => r.rowKind)).toEqual(["result", "attempted"]);
    expect(rows[0]).toMatchObject({ statusAtSend: "[masked]", reason: "status [masked]", tmuxSession: "[masked]" });
    expect(rows[1]).toMatchObject({ statusAtSend: "[masked]", tmuxSession: "[masked]" });
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(everythingLogged(made.log)).not.toContain(token);
  });

  it("ruling T11-10 (L1): a markAnswered failure after a recorded sent is logged at error and the answer stays 200 sent", async () => {
    const { made, card, submit } = await elevated();
    vi.spyOn(made.store, "markAnswered").mockImplementation(() => {
      throw new Error("SQLITE_BUSY: database is locked");
    });
    const key = randomUUID();
    const res = await submit({ text: "A1", key });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ outcome: "sent", message: "answered by you" });
    expect(made.store.findSubmitResult(key)).toMatchObject({ outcome: "sent" });
    expect(submitLines(made.log).info).toEqual([expect.objectContaining({ outcome: "sent", cardId: card.id })]);
    expect(submitLines(made.log).error).toEqual([expect.objectContaining({ outcome: "sent", cardId: card.id, errName: "Error" })]);
    expect(made.log.error.mock.calls.map((c) => c[1])).toEqual(["console submit: sent, but the card was not marked answered"]);
    expect(everythingLogged(made.log)).not.toContain("SQLITE_BUSY");
  });

  it("ruling T11-16 + triage 51: a result row that cannot be written after the dial answers 409 unresolved (logged at error, never a bare 500); a retry with the same key is 409 unresolved and dials nothing", async () => {
    const { made, card, submit } = await elevated();
    vi.spyOn(made.store, "appendSubmitLog").mockImplementation((row: SubmitLogInsert) => {
      if (row.rowKind === "result") throw new Error("SQLITE_FULL: database or disk is full");
      return SqliteConsoleStore.prototype.appendSubmitLog.call(made.store, row);
    });
    const key = randomUUID();
    const first = await submit({ text: TEXT, key });
    expect(first.statusCode).toBe(409);
    expect(first.json()).toEqual({ error: "unresolved", message: MSG_UNRESOLVED });
    expect(made.exec.calls).toHaveLength(1);
    expect(made.store.listSubmitLog(card.id).map((r) => r.rowKind)).toEqual(["attempted"]);
    expect(submitLines(made.log).error).toEqual([expect.objectContaining({ event: "console.submit", outcome: "sent", errName: "Error" })]);
    const again = await submit({ text: TEXT, key });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toEqual({ error: "unresolved", message: MSG_UNRESOLVED });
    expect(made.exec.calls).toHaveLength(1);
    expect(made.store.listSubmitLog(card.id).map((r) => r.rowKind)).toEqual(["attempted"]);
    expect(made.store.getCard(card.id)).toMatchObject({ answeredAt: null });
    expect(everythingLogged(made.log)).not.toContain("SQLITE_FULL");
  });

  it("ruling T11-19 (I-2): a sent Submit marks a card answered whenever it asks — a sentinel flag stays until its file goes — and marks the session's latest card too when that one asks", async () => {
    const { made, card, submit } = await elevated({ needs: { needsYou: true, needsKind: "sentinel", asksYou: true, options: ["A1", "A2"] } });
    const first = await submit({ text: "A1", key: randomUUID() });
    expect(first.json()).toMatchObject({ outcome: "sent", message: "sent — waiting for the session" });
    expect(made.store.getCard(card.id)).toMatchObject({ answeredAt: (first.json() as OutcomeBody).at, needsYou: true, needsKind: "sentinel" });
    // Karl answers from an older card of the same session; the session's newest card is the open question.
    const newer = made.store.upsertCard(faceOf(turns[1]!), ASKS, 90, T1);
    expect(made.store.latestCard("Mac-Mini", SID)?.id).toBe(newer.id);
    const second = await submit({ text: "A2", key: randomUUID() });
    expect(made.store.getCard(newer.id)).toMatchObject({ answeredAt: (second.json() as OutcomeBody).at, needsYou: false, needsKind: "reply_question" });
    await made.app.close();
    // A card that asks nothing is never marked.
    const plain = await elevated({ needs: NO_NEEDS });
    await plain.submit({ text: "A1", key: randomUUID() });
    expect(plain.made.store.getCard(plain.card.id)?.answeredAt).toBeNull();
  });

  it("ruling T11-20 (M-1): a session showing a prompt (its row's status is waiting) has no Submit — 409 menu_card, nothing dialled or written", async () => {
    const { made, card, submit } = await elevated();
    made.store.upsertSession(sessionRow({ status: "waiting", waitingFor: "R-1" }), T1);
    const res = await submit({ text: "A1", key: randomUUID() });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "menu_card" });
    expect(made.exec.calls).toEqual([]);
    expect(made.store.listSubmitLog(card.id)).toEqual([]);
  });

  it("ruling T11-21 (IV-4): a key is bound to its card and text — a request joining the flight with another text or for another card is 400 invalid_key (one dial); a stored key replays only for its own card", async () => {
    const { made, card, submit } = await elevated({ exec: fakeMachine(FILE, { deliver: { delayMs: 150 } }) });
    const other = made.store.upsertCard(faceOf(turns[1]!), ASKS, 90, T1);
    const key = randomUUID();
    const first = submit({ text: "A1 — go ahead", key });
    await vi.waitFor(() => expect(made.exec.calls).toHaveLength(1), { interval: 2 });
    const [otherText, otherCard] = await Promise.all([submit({ text: "STOP, do not merge", key }), submit({ text: "A1 — go ahead", key }, { id: other.id })]);
    const a = await first;
    expect(a.json()).toMatchObject({ outcome: "sent" });
    expect(otherText.statusCode).toBe(400);
    expect(otherText.json()).toEqual({ error: "invalid_key" });
    expect(otherCard.statusCode).toBe(400);
    expect(otherCard.json()).toEqual({ error: "invalid_key" });
    expect(made.exec.calls).toHaveLength(1);
    // Stored: the same card replays (the replay checks the card, not the text); another card is refused.
    expect((await submit({ text: "A1 — go ahead", key })).json()).toEqual(a.json());
    const wrongCard = await submit({ text: "A1 — go ahead", key }, { id: other.id });
    expect(wrongCard.statusCode).toBe(400);
    expect(wrongCard.json()).toEqual({ error: "invalid_key" });
    expect(made.exec.calls).toHaveLength(1);
    // Exactly one send was recorded, for the key's own card.
    expect(made.store.listSubmitLog(other.id)).toEqual([]);
    expect(made.store.listSubmitLog(card.id).map((r) => r.rowKind)).toEqual(["result", "attempted"]);
  });

  it("triage 52: only better-sqlite3's SQLITE_CONSTRAINT_UNIQUE code makes the write-ahead clash unresolved — an error that merely mentions the words is the T6-4 audit failure", async () => {
    const { made, submit } = await elevated();
    vi.spyOn(made.store, "appendSubmitLog").mockImplementationOnce(() => {
      throw new Error("UNIQUE constraint failed: console_submit_log.idempotency_key, console_submit_log.row_kind");
    });
    const key = randomUUID();
    const res = await submit({ text: TEXT, key });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ outcome: "failed", message: MSG_FAILED });
    expect(made.store.findSubmitResult(key)).toMatchObject({ outcome: "failed", reason: "audit_write_failed" });
    expect(made.exec.calls).toEqual([]);
  });
});

describe("POST /console/api/cards/:id/dismiss", () => {
  it("needs no step-up: a bearer-only caller dismisses a card (200 { dismissedAt }, no-store); needs_you is cleared for a reply question only; nothing is dialled; one info line per dismissal (L8)", async () => {
    const made = makeApp({ login: true });
    ({ app } = made);
    const question = made.store.upsertCard(faceOf(turns[0]!), ASKS, 90, T0);
    const waiting = made.store.upsertCard(faceOf(turns[1]!), { needsYou: true, needsKind: "waiting" }, 90, T1);
    const res = await made.app.inject({ method: "POST", url: dismissUrl(question.id), headers: admin, payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.headers["cache-control"]).toBe("no-store");
    const body = res.json() as { dismissedAt: string };
    expect(body).toEqual({ dismissedAt: expect.stringMatching(ISO_RE) as string });
    expect(made.store.getCard(question.id)).toMatchObject({ dismissedAt: body.dismissedAt, needsYou: false, needsKind: "reply_question", answeredAt: null });
    // A cookie session without the window works too: no session is touched.
    const cookie = await login(made.app);
    const res2 = await made.app.inject({ method: "POST", url: dismissUrl(waiting.id), headers: { cookie }, payload: {} });
    expect(res2.statusCode).toBe(200);
    expect(made.store.getCard(waiting.id)).toMatchObject({ dismissedAt: (res2.json() as { dismissedAt: string }).dismissedAt, needsYou: true, needsKind: "waiting" });
    expect(made.exec.calls).toEqual([]);
    expect(made.store.listSubmitLog(question.id)).toEqual([]);
    expect(submitLines(made.log).info).toEqual([]);
    expect(submitLines(made.log, "console.card_dismissed").info).toEqual([
      { event: "console.card_dismissed", cardId: question.id, correlationId: expect.stringMatching(UUID_RE) as string },
      { event: "console.card_dismissed", cardId: waiting.id, correlationId: expect.stringMatching(UUID_RE) as string }
    ]);
  });

  it("400 for a malformed id, 404 for an unknown card, 401 without a credential, 403 cross-site and same-site, no HEAD; the card stays undismissed", async () => {
    const made = makeApp({ login: true });
    ({ app } = made);
    const card = made.store.upsertCard(faceOf(turns[0]!), ASKS, 90, T0);
    const cookie = await login(made.app);
    for (const id of ["not-hex", "A".repeat(32), "0".repeat(31)]) {
      const res = await made.app.inject({ method: "POST", url: dismissUrl(id), headers: admin, payload: {} });
      expect(res.statusCode, id).toBe(400);
      expect(res.json()).toEqual({ error: "unexpected card id" });
      expect(res.headers["cache-control"]).toBe("no-store");
    }
    const missing = await made.app.inject({ method: "POST", url: dismissUrl(HEX), headers: admin, payload: {} });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: "no such card" });
    const anon = await made.app.inject({ method: "POST", url: dismissUrl(card.id), payload: {} });
    expect(anon.statusCode).toBe(401);
    expect(anon.json()).toEqual({ error: "unauthenticated" });
    for (const site of ["cross-site", "same-site"]) {
      const res = await made.app.inject({ method: "POST", url: dismissUrl(card.id), headers: { cookie, "sec-fetch-site": site }, payload: {} });
      expect(res.statusCode, site).toBe(403);
      expect(res.json()).toEqual({ error: "cross_origin_rejected" });
    }
    const head = await made.app.inject({ method: "HEAD", url: dismissUrl(card.id), headers: admin });
    expect(head.statusCode).toBe(404);
    expect(made.store.getCard(card.id)?.dismissedAt).toBeNull();
  });
});

describe("ruling T11-15: the four console POST routes take JSON only; a body that is not UTF-8 is refused", () => {
  it("step-up, submit, dismiss and sessions answer 415 unsupported_media_type to a form body, a text body and no body — nothing elevated, dialled or written; JSON with a charset parameter passes", async () => {
    const { made, cookie, card } = await elevated();
    const append = vi.spyOn(made.store, "appendSubmitLog");
    const key = randomUUID();
    for (const url of ["/console/api/step-up", submitUrl(card.id), dismissUrl(card.id), sessionsUrl("Mac-Mini")]) {
      const variants: ReadonlyArray<readonly [label: string, headers: Record<string, string>, payload: string | undefined]> = [
        ["a form body", { cookie, "content-type": "application/x-www-form-urlencoded" }, `text=A1&key=${key}&revoke=true&newProject=x`],
        ["a text body", { cookie, "content-type": "text/plain" }, "A1"],
        ["no body", { cookie }, undefined]
      ];
      for (const [label, headers, payload] of variants) {
        const res = await made.app.inject({ method: "POST", url, headers, ...(payload !== undefined ? { payload } : {}) });
        expect(res.statusCode, `${url}: ${label}`).toBe(415);
        expect(res.json(), `${url}: ${label}`).toEqual({ error: "unsupported_media_type" });
        expect(res.headers["cache-control"], `${url}: ${label}`).toBe("no-store");
      }
    }
    expect(made.exec.calls).toEqual([]);
    expect(append).not.toHaveBeenCalled();
    expect(made.store.getCard(card.id)?.dismissedAt).toBeNull();
    // The window opened by `elevated()` is still open: the form body's `revoke=true` never reached the route.
    expect((await made.app.inject({ method: "GET", url: "/console/api/step-up", headers: { cookie } })).json()).toMatchObject({ elevatedUntil: expect.stringMatching(ISO_RE) as string });
    const ok = await made.app.inject({ method: "POST", url: dismissUrl(card.id), headers: { cookie, "content-type": "application/json; charset=utf-8" }, payload: "{}" });
    expect(ok.statusCode).toBe(200);
  });

  it("IV-2: a Submit whose JSON carries invalid UTF-8 is 400 invalid_utf8 — never delivered with U+FFFD; nothing dialled or written", async () => {
    const { made, cookie, card } = await elevated();
    const key = randomUUID();
    for (const bytes of [[0xff], [0xed, 0xa0, 0x80], [0xc0, 0xaf]]) {
      const payload = Buffer.concat([Buffer.from(`{"key":"${key}","text":"A`), Buffer.from(bytes), Buffer.from('B"}')]);
      const res = await made.app.inject({ method: "POST", url: submitUrl(card.id), headers: { cookie, "content-type": "application/json" }, payload });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: "invalid_utf8" });
    }
    expect(made.exec.calls).toEqual([]);
    expect(made.store.listSubmitLog(card.id)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// F2 Task 8: the new-session flow — the projects root's folders and session creation (behind the step-up).
// ---------------------------------------------------------------------------------------------------------------

const ROOT = "/Users/karl/Documents/Claude Projects";
const NEW_NAME = "My App 2";
const projectsUrl = (machine: string): string => `/console/api/machines/${machine}/projects`;
const sessionsUrl = (machine: string): string => `/console/api/machines/${machine}/sessions`;
const rootSettings = (): ConsoleSettingsResult => consoleSettingsFrom(JSON.stringify({ machines: { "Mac-Mini": { projectsRoot: ROOT } } }));
const projectRecord = (path: string): string => `${PROJECTS_SENTINEL}${Buffer.from(path, "utf8").toString("base64")}\n`;
const sessionRecord = (outcome: "created" | "failed", value: string): string => `Last login: banner\n${SESSION_SENTINEL}${outcome}:${value}\n`;
const LIST_BUDGET = { timeoutMs: 6000, maxOutputBytes: 262144 };
const CREATE_BUDGET = { timeoutMs: 8000, maxOutputBytes: 65536 };
const MSG_STARTED = "session started";
const MSG_PROJECT_STARTED = "folder created and session started";
type SessionBody = { readonly tmuxSession: string; readonly path: string; readonly outcome: string; readonly message: string };
type Project = { readonly name: string; readonly path: string; readonly running: string | null };

/** The `console.session_create` lines a logger received, per level. */
function createLines(log: Log): { readonly info: object[]; readonly warn: object[]; readonly error: object[] } {
  return submitLines(log, "console.session_create");
}

/** Every occurrence of `value` in `text` sits inside a single-quoted token. */
function occursOnlySingleQuoted(text: string, value: string): boolean {
  const total = text.split(value).length - 1;
  const quoted = (text.match(new RegExp(`'[^']*${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^']*'`, "g")) ?? []).length;
  return total > 0 && total === quoted;
}

interface MachineReady {
  readonly made: Made;
  readonly cookie: string;
  /** The `appendSubmitLog` spy (calls through): the inserts, in order, and the stored rows. */
  readonly append: ReturnType<typeof vi.spyOn<SqliteConsoleStore, "appendSubmitLog">>;
  /** POST …/sessions as the elevated browser tab; `payload` goes as given. */
  readonly create: (payload: unknown, over?: { readonly machine?: string; readonly headers?: Record<string, string> }) => Promise<LightMyRequestResponse>;
}

/** Login on, Mac-Mini provisioned with a projects root, the operator logged in and elevated, the audit append spied. */
async function machineReady(o: { exec?: ReturnType<typeof fakeMachine>; settings?: ConsoleSettingsResult } = {}): Promise<MachineReady> {
  const made = makeApp({ login: true, settings: o.settings ?? rootSettings(), ...(o.exec ? { exec: o.exec } : {}) });
  app = made.app;
  addMachine(made.registry, "Mac-Mini");
  const cookie = await login(made.app);
  await elevate(made.app, cookie);
  const append = vi.spyOn(made.store, "appendSubmitLog");
  const create: MachineReady["create"] = (payload, over = {}) =>
    made.app.inject({ method: "POST", url: sessionsUrl(over.machine ?? "Mac-Mini"), headers: over.headers ?? { cookie }, payload: payload as never });
  return { made, cookie, append, create };
}

/** The inserts the spy saw, in order. */
const inserts = (append: MachineReady["append"]): SubmitLogInsert[] => append.mock.calls.map((c) => c[0]);

/** The `index`-th refusal's rows: an `attempted` row then a `refused_*` result row, both without a name, a text or a card; nothing dialled. */
function expectRefusalAudit(r: MachineReady, outcome: "refused_root" | "refused_name", index: number): void {
  const rows = inserts(r.append).slice(index * 2);
  expect(rows).toHaveLength(2);
  const [attempted, result] = rows as [SubmitLogInsert, SubmitLogInsert];
  expect(attempted).toMatchObject({ rowKind: "attempted", machine: "Mac-Mini" });
  expect(result).toMatchObject({ rowKind: "result", outcome, machine: "Mac-Mini", idempotencyKey: attempted.idempotencyKey });
  for (const row of [attempted, result]) {
    expect(row.cardId).toBeUndefined();
    expect(row.textMasked).toBeUndefined();
    expect(row.tmuxSession).toBeUndefined();
  }
  expect(r.made.store.findSubmitResult(attempted.idempotencyKey)).toMatchObject({ outcome, cardId: null, textMasked: null, tmuxSession: null });
  expect(r.made.exec.calls).toEqual([]);
}

describe("GET /console/api/machines/:name/projects", () => {
  it("has no HEAD, needs no step-up (a bearer answers), refuses a malformed machine name with a fixed text and a machine that may not be dialled with 409; nothing dialled", async () => {
    const made = makeApp({ login: true, settings: rootSettings() });
    ({ app } = made);
    addMachine(made.registry, "Old-Box", { provisioned: false });
    addMachine(made.registry, "Parked", { enabled: false });
    const head = await app.inject({ method: "HEAD", url: projectsUrl("Mac-Mini"), headers: admin });
    expect(head.statusCode).toBe(404);
    for (const name of ["a b", "-x", ".x", "x".repeat(65), "a'b", "a;b", "a$b"]) {
      const res = await app.inject({ method: "GET", url: projectsUrl(encodeURIComponent(name)), headers: admin });
      expect(res.statusCode, name).toBe(400);
      expect(res.json()).toEqual({ error: "unexpected machine name" });
      expect(res.headers["cache-control"]).toBe("no-store");
    }
    const cases: ReadonlyArray<readonly [machine: string, message: string]> = [
      ["Old-Box", "dev machine 'Old-Box' is not provisioned"],
      ["Parked", "dev machine 'Parked' is disabled"],
      ["Ghost", "no dev machine with logicalName 'Ghost'"]
    ];
    for (const [machine, message] of cases) {
      const res = await app.inject({ method: "GET", url: projectsUrl(machine), headers: admin });
      expect(res.statusCode, machine).toBe(409);
      expect(res.json()).toEqual({ error: "not_connectable", message });
      expect(res.headers["cache-control"]).toBe("no-store");
      expectFirstParty(res.body);
    }
    expect(made.exec.calls).toEqual([]);
  });

  it("409 no_projects_root for a machine without a settings entry, and when the settings file is refused; nothing dialled", async () => {
    const made = makeApp({ login: true });
    ({ app } = made);
    addMachine(made.registry, "Mac-Mini");
    const res = await app.inject({ method: "GET", url: projectsUrl("Mac-Mini"), headers: admin });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "no_projects_root" });
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(made.exec.calls).toEqual([]);
    await app.close();
    const refused = makeApp({ settings: consoleSettingsFrom('{"pollSeconds": 1}') });
    ({ app } = refused);
    addMachine(refused.registry, "Mac-Mini");
    const res2 = await app.inject({ method: "GET", url: projectsUrl("Mac-Mini"), headers: admin });
    expect(res2.statusCode).toBe(409);
    expect(res2.json()).toEqual({ error: "no_projects_root" });
    expect(refused.exec.calls).toEqual([]);
  });

  it("lists the root's folders sorted by name with `running` from a live session row whose cwd is the folder — never an ended row, an sh- shell or another machine's row; a path outside the root or with a hidden segment is dropped (T8-7) and every drop counted; one dial with the list budget", async () => {
    // The last four records are hostile or unusable: outside the root, a hidden parent, a parent the name rule
    // does not cover but the path rule admits (listed), a parent with a quote (the remote-directory rule).
    const stdout = `Last login: banner\n${projectRecord(`${ROOT}/pantheon-harness`)}${projectRecord(`${ROOT}/Pantheon/pantheon-harness`)}${projectRecord(`${ROOT}/Pantheon`)}${projectRecord(`${ROOT}/${NEW_NAME}`)}${projectRecord(`${ROOT}/it's`)}${projectRecord("/etc/cron.d")}${projectRecord(`${ROOT}/.hidden/x`)}${projectRecord(`${ROOT}/Parent & Co/child`)}${projectRecord(`${ROOT}/it's/x`)}`;
    const made = makeApp({ login: true, settings: rootSettings(), exec: fakeMachine(FILE, { projects: { stdout } }) });
    ({ app } = made);
    addMachine(made.registry, "Mac-Mini");
    // Live in the depth-2 folder; ended in My App 2; a machine shell sitting in Pantheon; another machine's live session in pantheon-harness.
    made.store.upsertSession(sessionRow({ cwd: `${ROOT}/Pantheon/pantheon-harness`, projectKey: "pantheon-harness" }), T0);
    made.store.upsertSession(sessionRow({ sessionId: "6e09d39d-0000-4000-8000-000000000002", tmuxSession: "my-app-2", cwd: `${ROOT}/${NEW_NAME}`, projectKey: "my-app-2", endedAt: T1 }), T1);
    made.store.upsertSession(sessionRow({ sessionId: "6e09d39d-0000-4000-8000-000000000003", tmuxSession: "sh-Mac-Mini", cwd: `${ROOT}/Pantheon`, projectKey: "sh-Mac-Mini", reachable: false, state: "shell" }), T1);
    made.store.upsertSession(sessionRow({ sessionId: "6e09d39d-0000-4000-8000-000000000004", machine: "Other", cwd: `${ROOT}/pantheon-harness`, projectKey: "pantheon-harness" }), T1);
    const res = await app.inject({ method: "GET", url: projectsUrl("Mac-Mini"), headers: admin });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.headers["cache-control"]).toBe("no-store");
    const body = res.json() as { root: string; projects: Project[]; dropped: number };
    expect(body).toEqual({
      root: ROOT,
      projects: [
        { name: "child", path: `${ROOT}/Parent & Co/child`, running: null },
        { name: NEW_NAME, path: `${ROOT}/${NEW_NAME}`, running: null },
        { name: "Pantheon", path: `${ROOT}/Pantheon`, running: null },
        { name: "pantheon-harness", path: `${ROOT}/Pantheon/pantheon-harness`, running: "pantheon-harness" },
        { name: "pantheon-harness", path: `${ROOT}/pantheon-harness`, running: null }
      ],
      dropped: 4
    });
    expect(res.body).not.toContain("it's");
    expect(res.body).not.toContain("cron.d");
    expect(res.body).not.toContain(".hidden");
    expect(made.exec.calls).toHaveLength(1);
    const call = made.exec.calls[0]!;
    expect(call.target).toEqual(MAC_MINI);
    expect(call.handle).toBe("harness");
    expect(call.opts).toEqual(LIST_BUDGET);
    expect(call.command).toContain(`find '${ROOT}' -mindepth 1 -maxdepth 1 -type d`);
    expect(call.command).toContain(`find '${ROOT}' -mindepth 2 -maxdepth 2 -type d`);
    expect(occursOnlySingleQuoted(call.command, ROOT)).toBe(true);
    // An empty root lists nothing.
    await app.close();
    const empty = makeApp({ login: true, settings: rootSettings() });
    ({ app } = empty);
    addMachine(empty.registry, "Mac-Mini");
    const none = await app.inject({ method: "GET", url: projectsUrl("Mac-Mini"), headers: admin });
    expect(none.statusCode).toBe(200);
    expect(none.json()).toEqual({ root: ROOT, projects: [], dropped: 0 });
  });

  it("ruling T11-8 (DI-3): a listed path the console mask would alter is dropped and counted — never shown; a hyphenated sk- folder is kept", async () => {
    const hostile = [`${ROOT}/${"ghp_" + "Q".repeat(24)}`, `${ROOT}/${"ghp_" + "Q".repeat(24)}/notes`, `${ROOT}/Pantheon/sk-${"T3BlbkFJ".repeat(3)}`].map(projectRecord).join("");
    const made = makeApp({ login: true, settings: rootSettings(), exec: fakeMachine(FILE, { projects: { stdout: `${hostile}${projectRecord(`${ROOT}/sk-learn-tools`)}` } }) });
    ({ app } = made);
    addMachine(made.registry, "Mac-Mini");
    const res = await app.inject({ method: "GET", url: projectsUrl("Mac-Mini"), headers: admin });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ root: ROOT, projects: [{ name: "sk-learn-tools", path: `${ROOT}/sk-learn-tools`, running: null }], dropped: 3 });
    expect(res.body).not.toContain("ghp_");
    expect(res.body).not.toContain("T3Blbk");
  });

  it("ruling T11-5: a listed path whose parent carries a tmux format ('#S', '##', '#{', '#(') is dropped and counted — it could never be started", async () => {
    const hostile = ["C#Sharp", "a##b", "a#{session_name}", "a#(id)"].map((parent) => projectRecord(`${ROOT}/${parent}/notes2`)).join("");
    const made = makeApp({ login: true, settings: rootSettings(), exec: fakeMachine(FILE, { projects: { stdout: `${hostile}${projectRecord(`${ROOT}/ok`)}` } }) });
    ({ app } = made);
    addMachine(made.registry, "Mac-Mini");
    const res = await app.inject({ method: "GET", url: projectsUrl("Mac-Mini"), headers: admin });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ root: ROOT, projects: [{ name: "ok", path: `${ROOT}/ok`, running: null }], dropped: 4 });
    expect(res.body).not.toContain("#");
  });

  it("502 labelled: an unreachable machine, a failed listing (exit 1), a root that is not a directory (exit 2) — first-party text only", async () => {
    const down = makeApp({ login: true, settings: rootSettings(), exec: fakeMachine(FILE, { reject: true }) });
    ({ app } = down);
    addMachine(down.registry, "Mac-Mini");
    const unreachable = await app.inject({ method: "GET", url: projectsUrl("Mac-Mini"), headers: admin });
    expect(unreachable.statusCode).toBe(502);
    expect(unreachable.json()).toEqual({ error: "unreachable", message: "Mac-Mini unreachable — SSH connection failed" });
    expect(unreachable.headers["cache-control"]).toBe("no-store");
    expectFirstParty(unreachable.body);
    await app.close();
    for (const [code, message] of [
      [1, "listing projects on Mac-Mini failed (exit 1)"],
      [2, "projects root is not a directory on Mac-Mini"],
      [126, "listing projects on Mac-Mini failed (exit 126)"]
    ] as const) {
      const broken = makeApp({ login: true, settings: rootSettings(), exec: fakeMachine(FILE, { projects: { code, stdout: projectRecord(`${ROOT}/partial`) } }) });
      ({ app } = broken);
      addMachine(broken.registry, "Mac-Mini");
      const res = await app.inject({ method: "GET", url: projectsUrl("Mac-Mini"), headers: admin });
      expect(res.statusCode, String(code)).toBe(502);
      expect(res.json()).toEqual({ error: "list_failed", message });
      expect(res.body).not.toContain("partial");
      expectFirstParty(res.body);
      await app.close();
    }
  });
});

describe("POST /console/api/machines/:name/sessions", () => {
  it("is guarded (401), has no HEAD, is refused cross-site and same-site before any check; the browser's same-origin label passes", async () => {
    const r = await machineReady();
    const anon = await r.create({ newProject: NEW_NAME }, { headers: {} });
    expect(anon.statusCode).toBe(401);
    expect(anon.json()).toEqual({ error: "unauthenticated" });
    const head = await r.made.app.inject({ method: "HEAD", url: sessionsUrl("Mac-Mini"), headers: admin });
    expect(head.statusCode).toBe(404);
    for (const site of ["cross-site", "same-site"]) {
      const res = await r.create({ newProject: NEW_NAME }, { headers: { cookie: r.cookie, "sec-fetch-site": site } });
      expect(res.statusCode, site).toBe(403);
      expect(res.json()).toEqual({ error: "cross_origin_rejected" });
    }
    expect(r.made.exec.calls).toEqual([]);
    expect(inserts(r.append)).toEqual([]);
    const ok = await r.create({ newProject: NEW_NAME }, { headers: { cookie: r.cookie, "sec-fetch-site": "same-origin" } });
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as SessionBody).outcome).toBe("created_project");
  });

  it("without login answers 503 step_up_unavailable; a bearer-only caller is 403 step_up_cookie_only; a cold cookie session is 403 step_up_required — nothing dialled, written or logged", async () => {
    const made = makeApp({ settings: rootSettings() });
    ({ app } = made);
    addMachine(made.registry, "Mac-Mini");
    const append = vi.spyOn(made.store, "appendSubmitLog");
    const res = await app.inject({ method: "POST", url: sessionsUrl("Mac-Mini"), headers: admin, payload: { newProject: NEW_NAME } });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: "step_up_unavailable" });
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(made.exec.calls).toEqual([]);
    expect(append).not.toHaveBeenCalled();
    await app.close();

    const r = await machineReady();
    const bearer = await r.create({ newProject: NEW_NAME }, { headers: admin });
    expect(bearer.statusCode).toBe(403);
    expect(bearer.json()).toEqual({ error: "step_up_cookie_only" });
    expect(bearer.headers["cache-control"]).toBe("no-store");
    const cold = await r.create({ newProject: NEW_NAME }, { headers: { cookie: await login(r.made.app) } });
    expect(cold.statusCode).toBe(403);
    expect(cold.json()).toEqual({ error: "step_up_required" });
    expect(r.made.exec.calls).toEqual([]);
    expect(inserts(r.append)).toEqual([]);
    expect(createLines(r.made.log).info).toEqual([]);
    // L7 (D13): one warn line per denial on the typing routes.
    expect(submitLines(r.made.log, "console.session_create_denied").warn).toEqual([
      { event: "console.session_create_denied", reason: "step_up_cookie_only", correlationId: expect.stringMatching(UUID_RE) as string },
      { event: "console.session_create_denied", reason: "step_up_required", correlationId: expect.stringMatching(UUID_RE) as string }
    ]);
    expect(everythingLogged(r.made.log)).not.toContain(NEW_NAME);
  });

  it("400 unexpected machine name, 409 not_connectable, 409 no_projects_root, 400 bad_request for a body that is not exactly one of folder / newProject — no audit row, nothing dialled or logged", async () => {
    const r = await machineReady();
    addMachine(r.made.registry, "Parked", { enabled: false });
    for (const name of ["a b", "-x", ".x", "x".repeat(65), "a'b"]) {
      const res = await r.create({ newProject: NEW_NAME }, { machine: encodeURIComponent(name) });
      expect(res.statusCode, name).toBe(400);
      expect(res.json()).toEqual({ error: "unexpected machine name" });
      expect(res.headers["cache-control"]).toBe("no-store");
    }
    for (const [machine, message] of [
      ["Parked", "dev machine 'Parked' is disabled"],
      ["Ghost", "no dev machine with logicalName 'Ghost'"]
    ] as const) {
      const res = await r.create({ newProject: NEW_NAME }, { machine });
      expect(res.statusCode, machine).toBe(409);
      expect(res.json()).toEqual({ error: "not_connectable", message });
      expectFirstParty(res.body);
    }
    // Known and connectable, but no projects root for it.
    addMachine(r.made.registry, "Studio");
    const noRoot = await r.create({ newProject: NEW_NAME }, { machine: "Studio" });
    expect(noRoot.statusCode).toBe(409);
    expect(noRoot.json()).toEqual({ error: "no_projects_root" });
    const bodies: unknown[] = [[NEW_NAME], {}, { folder: "a", newProject: "b" }, { folder: 42 }, { newProject: null }, { newProject: ["a"] }, { name: "a" }, "a", null];
    for (const body of bodies) {
      // A JSON string or null body goes through the raw request; objects through the helper.
      const raw = { method: "POST" as const, url: sessionsUrl("Mac-Mini"), headers: { cookie: r.cookie, "content-type": "application/json" } };
      const res = typeof body === "string" || body === null ? await r.made.app.inject({ ...raw, payload: JSON.stringify(body) }) : await r.create(body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      expect(res.json()).toEqual({ error: "bad_request" });
      expect(res.headers["cache-control"]).toBe("no-store");
    }
    // No body at all is not JSON (ruling T11-15).
    const none = await r.made.app.inject({ method: "POST", url: sessionsUrl("Mac-Mini"), headers: { cookie: r.cookie } });
    expect(none.statusCode).toBe(415);
    expect(none.json()).toEqual({ error: "unsupported_media_type" });
    expect(r.made.exec.calls).toEqual([]);
    expect(inserts(r.append)).toEqual([]);
    expect(createLines(r.made.log).info).toEqual([]);
  });

  it("refused_root: a newProject or folder resolving outside the root, or to the root itself → 400, an attempted row then a refused_root result row, no dial, one log line without the value", async () => {
    const r = await machineReady();
    const refused: ReadonlyArray<readonly [label: string, body: unknown]> = [
      ["newProject ..", { newProject: "../x" }],
      ["newProject ../../", { newProject: "../../etc" }],
      ["newProject .", { newProject: "." }],
      ["newProject empty", { newProject: "" }],
      ["folder /etc", { folder: "/etc" }],
      ["folder ..", { folder: "../Secret-Client" }],
      ["folder empty", { folder: "" }],
      ["folder root", { folder: ROOT }],
      ["folder root slash", { folder: `${ROOT}/` }],
      ["folder escaping sibling", { folder: `${ROOT}-other/x` }],
      ["folder deep escape", { folder: "a/../../x" }]
    ];
    let n = 0;
    for (const [label, body] of refused) {
      const res = await r.create(body);
      expect(res.statusCode, label).toBe(400);
      expect(res.body, label).toBe(JSON.stringify({ error: "refused_root" }));
      expect(res.headers["cache-control"]).toBe("no-store");
      expectRefusalAudit(r, "refused_root", n++);
    }
    const lines = createLines(r.made.log);
    // L5 (D13): a refusal is a warn line.
    expect(lines.info).toEqual([]);
    expect(lines.warn).toHaveLength(refused.length);
    expect(lines.warn[0]).toEqual({ event: "console.session_create", machine: "Mac-Mini", outcome: "refused_root", correlationId: expect.stringMatching(UUID_RE) as string, sessionIdHash: hashOf(r.cookie) });
    const logged = everythingLogged(r.made.log);
    for (const value of ["Secret-Client", "etc", "../", ROOT]) expect(logged).not.toContain(value);
  });

  it("refused_name: a newProject failing the allow-list, or a folder with a segment failing it → 400, attempted + refused_name rows, no dial, the value nowhere", async () => {
    const r = await machineReady();
    const refused: ReadonlyArray<readonly [label: string, body: unknown]> = [
      ["hidden", { newProject: ".hidden" }],
      ["slash", { newProject: "a/b" }],
      ["65 chars", { newProject: "x".repeat(65) }],
      ["quote", { newProject: "it's" }],
      ["control", { newProject: "a\x01b" }],
      ["leading space", { newProject: " lead" }],
      ["leading dash", { newProject: "-lead" }],
      ["newline", { newProject: "a\nb" }],
      ["unicode", { newProject: "Café" }],
      ["folder hidden segment", { folder: "Pantheon/.git" }],
      ["folder hidden parent", { folder: ".archive/old" }],
      ["folder hidden parent (T8-7)", { folder: ".hidden/x" }],
      ["folder quote", { folder: "Pantheon/it's" }],
      ["folder quoted parent (T8-7: the remote-directory rule)", { folder: "it's/x" }],
      ["folder 65-char basename", { folder: `Pantheon/${"x".repeat(65)}` }],
      // Ruling T11-8 (DI-3): a name or a path the console mask would alter is refused — it would be stored or shown masked.
      ["newProject token-shaped", { newProject: "ghp_" + "Q".repeat(24) }],
      ["folder with a token-shaped parent", { folder: `${"ghp_" + "Q".repeat(24)}/notes` }],
      ["folder with a key-shaped basename", { folder: `Pantheon/sk-${"T3BlbkFJ".repeat(3)}` }]
    ];
    let n = 0;
    for (const [label, body] of refused) {
      const res = await r.create(body);
      expect(res.statusCode, label).toBe(400);
      expect(res.body, label).toBe(JSON.stringify({ error: "refused_name" }));
      expectRefusalAudit(r, "refused_name", n++);
    }
    expect(createLines(r.made.log).info).toEqual([]);
    expect(createLines(r.made.log).warn).toHaveLength(refused.length);
    expect(createLines(r.made.log).warn.every((l) => (l as { outcome: string }).outcome === "refused_name")).toBe(true);
    const logged = everythingLogged(r.made.log);
    for (const value of ["hidden", "it's", "Café", ".archive", "Pantheon", "ghp_", "T3Blbk"]) expect(logged).not.toContain(value);
    // A hyphenated sk- folder is a folder, not a key: it is started (T11-14).
    const plain = await r.create({ newProject: "sk-learn-tools" });
    expect(plain.json()).toMatchObject({ tmuxSession: "sk-learn-tools", outcome: "created_project" });
  });

  it("happy path newProject: the attempted row (base name) before the first dial, the live tmux list, one create dial with the create budget carrying the folder only single-quoted and a plain mkdir, a created_project result row, 200, one log line without the name", async () => {
    const exec = fakeMachine(FILE);
    const spied = Object.assign(vi.fn(exec), { calls: exec.calls });
    const r = await machineReady({ exec: spied });
    const res = await r.create({ newProject: NEW_NAME });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.json()).toEqual({ tmuxSession: "My-App-2", path: `${ROOT}/${NEW_NAME}`, outcome: "created_project", message: MSG_PROJECT_STARTED });
    // Two dials: the live list (collision check), then the create script — each with its budget, to the machine's target.
    expect(r.made.exec.calls).toHaveLength(2);
    const [list, create] = r.made.exec.calls as [ExecCall, ExecCall];
    expect(list.target).toEqual(MAC_MINI);
    expect(list.handle).toBe("harness");
    expect(list.command).toContain("tmux list-sessions -F");
    expect(list.opts).toEqual(LIST_BUDGET);
    expect(create.target).toEqual(MAC_MINI);
    expect(create.handle).toBe("harness");
    expect(create.opts).toEqual(CREATE_BUDGET);
    expect(create.command).toContain(`[ -e '${ROOT}/${NEW_NAME}' ] && result failed "folder exists"`);
    expect(create.command).toContain(`mkdir '${ROOT}/${NEW_NAME}' || result failed "mkdir failed"`);
    expect(create.command).not.toContain("mkdir -p");
    expect(create.command).toContain("tmux has-session -t '=My-App-2' 2>/dev/null");
    expect(create.command).toContain(`tmux new-session -d -s 'My-App-2' -c '${ROOT}/${NEW_NAME}' -e "PATH=$PATH" claude`);
    expect(occursOnlySingleQuoted(create.command, `${ROOT}/${NEW_NAME}`)).toBe(true);
    expect(occursOnlySingleQuoted(create.command, "My-App-2")).toBe(true);
    // The write-ahead row went in before the first dial (R6).
    const rows = inserts(r.append);
    expect(rows.map((row) => row.rowKind)).toEqual(["attempted", "result"]);
    expect(r.append.mock.invocationCallOrder[0]!).toBeLessThan(spied.mock.invocationCallOrder[0]!);
    const [attempted, result] = rows as [SubmitLogInsert, SubmitLogInsert];
    expect(attempted).toEqual({ rowKind: "attempted", idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/) as string, at: expect.stringMatching(ISO_RE) as string, machine: "Mac-Mini", tmuxSession: "My-App-2" });
    expect(result).toEqual({ rowKind: "result", outcome: "created_project", idempotencyKey: attempted.idempotencyKey, at: expect.stringMatching(ISO_RE) as string, machine: "Mac-Mini", tmuxSession: "My-App-2" });
    expect(r.made.store.findSubmitResult(attempted.idempotencyKey)).toMatchObject({ outcome: "created_project", tmuxSession: "My-App-2", cardId: null, textMasked: null, reason: null, paneId: null, sessionId: null });
    // One structured line: the three fields, never the name or the path.
    const lines = createLines(r.made.log);
    // C2 (L4): a uuid correlation id and the operator session's hash, never the id.
    expect(lines.info).toEqual([{ event: "console.session_create", machine: "Mac-Mini", outcome: "created_project", correlationId: expect.stringMatching(UUID_RE) as string, sessionIdHash: hashOf(r.cookie) }]);
    expect(lines.error).toEqual([]);
    const logged = everythingLogged(r.made.log);
    expect(logged).not.toContain(NEW_NAME);
    expect(logged).not.toContain("My-App-2");
    expect(logged).not.toContain(ROOT);
    // A second identical request is a second creation (ruling T8-2): its own key, its own rows, a fresh dial pair.
    const again = await r.create({ newProject: NEW_NAME });
    expect(again.statusCode).toBe(200);
    expect(r.made.exec.calls).toHaveLength(4);
    const keys = new Set(inserts(r.append).map((row) => row.idempotencyKey));
    expect(keys.size).toBe(2);
  });

  it("happy path folder (relative or absolute under the root, a depth-2 path too): created_session, no mkdir, the folder must exist on the machine", async () => {
    const r = await machineReady();
    for (const folder of ["Pantheon/pantheon-harness", `${ROOT}/Pantheon/pantheon-harness`, "Pantheon/pantheon-harness/", "./Pantheon/pantheon-harness"]) {
      const res = await r.create({ folder });
      expect(res.statusCode, folder).toBe(200);
      expect(res.json()).toEqual({ tmuxSession: "pantheon-harness", path: `${ROOT}/Pantheon/pantheon-harness`, outcome: "created_session", message: MSG_STARTED });
      const create = r.made.exec.calls.at(-1)!;
      expect(create.command).not.toContain("mkdir");
      expect(create.command).toContain(`[ -d '${ROOT}/Pantheon/pantheon-harness' ] || result failed "folder missing"`);
      expect(create.command).toContain(`tmux new-session -d -s 'pantheon-harness' -c '${ROOT}/Pantheon/pantheon-harness' -e "PATH=$PATH" claude`);
      expect(occursOnlySingleQuoted(create.command, `${ROOT}/Pantheon/pantheon-harness`)).toBe(true);
    }
    expect(r.made.exec.calls).toHaveLength(8);
    const rows = inserts(r.append);
    expect(rows.map((row) => row.rowKind)).toEqual(["attempted", "result", "attempted", "result", "attempted", "result", "attempted", "result"]);
    expect(rows[1]).toMatchObject({ outcome: "created_session", tmuxSession: "pantheon-harness", machine: "Mac-Mini" });
    expect(createLines(r.made.log).info).toHaveLength(4);
    // A folder name with a space maps to a dashed tmux name.
    const spaced = await r.create({ folder: NEW_NAME });
    expect(spaced.json()).toMatchObject({ tmuxSession: "My-App-2", path: `${ROOT}/${NEW_NAME}`, outcome: "created_session" });
    expect(everythingLogged(r.made.log)).not.toContain(NEW_NAME);
  });

  it("collision suffixing against the live list: -2, then -3; a 64-character base is cut so the suffix fits; the result row carries the final name", async () => {
    const taken = await machineReady({ exec: fakeMachine(FILE, { tmuxSessions: ["My-App-2", "pantheon-harness", "pantheon-harness-2", "x".repeat(64), `${"x".repeat(62)}-2`] }) });
    let res = await taken.create({ newProject: NEW_NAME });
    expect(res.json()).toMatchObject({ tmuxSession: "My-App-2-2", outcome: "created_project" });
    expect(taken.made.exec.calls.at(-1)!.command).toContain("tmux new-session -d -s 'My-App-2-2'");
    expect(inserts(taken.append).at(-2)).toMatchObject({ rowKind: "attempted", tmuxSession: "My-App-2" });
    expect(inserts(taken.append).at(-1)).toMatchObject({ rowKind: "result", outcome: "created_project", tmuxSession: "My-App-2-2" });
    res = await taken.create({ folder: "pantheon-harness" });
    expect(res.json()).toMatchObject({ tmuxSession: "pantheon-harness-3", outcome: "created_session" });
    res = await taken.create({ newProject: "x".repeat(64) });
    expect(res.json()).toMatchObject({ tmuxSession: `${"x".repeat(62)}-3`, outcome: "created_project" });
    expect(taken.made.exec.calls.at(-1)!.command).toContain(`-s '${"x".repeat(62)}-3'`);
    // Other names never block a candidate — not even a live name the lister shows cut with an ellipsis.
    await taken.made.app.close();
    const free = await machineReady({ exec: fakeMachine(FILE, { tmuxSessions: ["other", "sh-Mac-Mini", "x".repeat(70)] }) });
    res = await free.create({ newProject: NEW_NAME });
    expect(res.json()).toMatchObject({ tmuxSession: "My-App-2" });
    res = await free.create({ newProject: "x".repeat(64) });
    expect(res.json()).toMatchObject({ tmuxSession: "x".repeat(64) });
  });

  it("ruling T8-7: a listed folder is a startable one — a parent segment outside PROJECT_NAME_RE (`Parent & Co`) is fine, the command carries the path single-quoted; a new project is still one name directly under the root", async () => {
    const r = await machineReady();
    const res = await r.create({ folder: "Parent & Co/child" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ tmuxSession: "child", path: `${ROOT}/Parent & Co/child`, outcome: "created_session", message: MSG_STARTED });
    const create = r.made.exec.calls.at(-1)!;
    expect(create.command).toContain(`tmux new-session -d -s 'child' -c '${ROOT}/Parent & Co/child' -e "PATH=$PATH" claude`);
    expect(occursOnlySingleQuoted(create.command, `${ROOT}/Parent & Co/child`)).toBe(true);
    // Depth is not limited either: every parent is free, only the folder being started is named.
    const deep = await r.create({ folder: "a b/c d/e" });
    expect(deep.json()).toMatchObject({ tmuxSession: "e", path: `${ROOT}/a b/c d/e`, outcome: "created_session" });
    // A new project is placed directly under the root: a path-shaped name is refused by the name rule.
    const nested = await r.create({ newProject: "Parent & Co/new" });
    expect(nested.statusCode).toBe(400);
    expect(nested.json()).toEqual({ error: "refused_name" });
    expect(r.made.exec.calls).toHaveLength(4);
    expect(everythingLogged(r.made.log)).not.toContain("Parent");
  });

  it("ruling T11-5: a folder whose parent carries a tmux format ('#S', '##', '#{', '#(') is refused_name — attempted + refused_name rows, nothing dialled", async () => {
    const r = await machineReady();
    let n = 0;
    for (const parent of ["C#Sharp", "a##b", "a#{session_name}", "a#(id)"]) {
      for (const folder of [`${parent}/notes2`, `${ROOT}/${parent}/notes2`]) {
        const res = await r.create({ folder });
        expect(res.statusCode, folder).toBe(400);
        expect(res.body, folder).toBe(JSON.stringify({ error: "refused_name" }));
        expectRefusalAudit(r, "refused_name", n++);
      }
    }
    expect(everythingLogged(r.made.log)).not.toContain("#");
  });

  it("ruling T11-6 (DI-3): a derived tmux name the mask would alter is stored masked in both audit rows (the answer keeps the real name the page opens)", async () => {
    const r = await machineReady();
    const folder = `sk ant ${"a".repeat(24)}`; // the folder itself is not secret-shaped; its tmux name is
    const res = await r.create({ newProject: folder });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ tmuxSession: `sk-ant-${"a".repeat(24)}`, outcome: "created_project" });
    const rows = inserts(r.append);
    expect(rows.map((row) => [row.rowKind, row.tmuxSession])).toEqual([["attempted", "[masked]"], ["result", "[masked]"]]);
    expect(everythingLogged(r.made.log)).not.toContain("sk-ant-");
  });

  it("ruling T11-13: the collision suffix keeps a project out of the machine-shell namespace — base `sh` with `sh` taken is p-sh-2, then p-sh-3, and the call returns at once", async () => {
    const r = await machineReady({ exec: fakeMachine(FILE, { tmuxSessions: ["sh", "p-sh-2"] }) });
    const started = performance.now();
    const res = await r.create({ newProject: "sh" });
    expect(performance.now() - started).toBeLessThan(2000);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ tmuxSession: "p-sh-3", path: `${ROOT}/sh`, outcome: "created_project" });
    expect(r.made.exec.calls.at(-1)!.command).toContain("tmux new-session -d -s 'p-sh-3'");
    expect(r.made.exec.calls.at(-1)!.command).not.toMatch(/-s 'sh-/);
    expect(inserts(r.append).at(-1)).toMatchObject({ rowKind: "result", outcome: "created_project", tmuxSession: "p-sh-3" });
    await r.made.app.close();
    const once = await machineReady({ exec: fakeMachine(FILE, { tmuxSessions: ["sh"] }) });
    const folder = await once.create({ folder: "sh" });
    expect(folder.json()).toMatchObject({ tmuxSession: "p-sh-2", path: `${ROOT}/sh`, outcome: "created_session" });
  });

  it("ruling T8-5: a folder in the machine-shell namespace gets the p- prefixed tmux name — never an sh- session, for a folder or a new project", async () => {
    const r = await machineReady();
    const res = await r.create({ folder: "sh-foo" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ tmuxSession: "p-sh-foo", path: `${ROOT}/sh-foo`, outcome: "created_session", message: MSG_STARTED });
    const create = r.made.exec.calls.at(-1)!;
    expect(create.command).toContain("tmux has-session -t '=p-sh-foo'");
    expect(create.command).toContain(`tmux new-session -d -s 'p-sh-foo' -c '${ROOT}/sh-foo'`);
    expect(create.command).not.toMatch(/-s 'sh-/);
    expect(inserts(r.append).at(-2)).toMatchObject({ rowKind: "attempted", tmuxSession: "p-sh-foo" });
    expect(inserts(r.append).at(-1)).toMatchObject({ rowKind: "result", outcome: "created_session", tmuxSession: "p-sh-foo" });
    const made = await r.create({ newProject: "sh-tools" });
    expect(made.json()).toMatchObject({ tmuxSession: "p-sh-tools", path: `${ROOT}/sh-tools`, outcome: "created_project" });
    expect(r.made.exec.calls.at(-1)!.command).toContain("-s 'p-sh-tools'");
  });

  const MSG_START_UNCONFIRMED = "Could not confirm the start — check the machine's tmux sessions";
  const scriptFailures: ReadonlyArray<{
    readonly label: string;
    readonly create: NonNullable<FakeMachineOptions["create"]>;
    readonly reason: string;
    /** Default `failed`; ruling T11-18 makes a start that may have happened `unconfirmed`. */
    readonly outcome?: "failed" | "unconfirmed";
    /** The body's message when it is not `Start failed — <reason>`. */
    readonly message?: string;
    /** The thrown error's class, logged beside the reason (never its message). */
    readonly errName?: string;
  }> = [
    { label: "session already exists (ruling T8-2: the has-session race guard)", create: { stdout: sessionRecord("failed", "session already exists") }, reason: "session already exists" },
    { label: "claude not found (ruling T8-3)", create: { stdout: sessionRecord("failed", "claude not found") }, reason: "claude not found" },
    { label: "folder exists", create: { stdout: sessionRecord("failed", "folder exists") }, reason: "folder exists" },
    { label: "mkdir failed", create: { stdout: sessionRecord("failed", "mkdir failed") }, reason: "mkdir failed" },
    { label: "tmux new-session failed", create: { stdout: sessionRecord("failed", "tmux new-session failed") }, reason: "tmux new-session failed" },
    { label: "no record (unconfirmed: the record comes after new-session)", create: { stdout: "Permission denied (publickey)\n", code: 255 }, reason: "no_record", outcome: "unconfirmed", message: MSG_START_UNCONFIRMED },
    { label: "the pre-read tool guard (126)", create: { stdout: "session: tmux not found\n", code: 126 }, reason: "the session script did not report back" },
    { label: "non-zero exit beside a record", create: { stdout: sessionRecord("created", "My-App-2"), code: 1 }, reason: "the session script exited with code 1" },
    { label: "unrecognised detail", create: { stdout: sessionRecord("failed", `ghp_${"q".repeat(36)}`) }, reason: "the session script reported an unrecognised detail" },
    { label: "a created record naming another session than the plan's (fix round 1, item 4)", create: { stdout: sessionRecord("created", "not-the-plan") }, reason: "the session script reported a malformed record" },
    {
      label: "the script was sent and the run timed out (unconfirmed)",
      create: { reject: new SshConnectionError("remote command on Mac-Mini timed out after 8000 ms", "after_exec") },
      reason: "timeout",
      outcome: "unconfirmed",
      message: MSG_START_UNCONFIRMED,
      errName: "SshConnectionError"
    },
    {
      label: "the script was sent and the connection dropped (unconfirmed)",
      create: { reject: new SshConnectionError("SSH connection to Mac-Mini (karl@192.168.1.192) failed", "after_exec") },
      reason: "ssh_failed",
      outcome: "unconfirmed",
      message: MSG_START_UNCONFIRMED,
      errName: "SshConnectionError"
    },
    {
      label: "the handshake timed out before the script was sent (item 5: the timeout reads as a timeout)",
      create: { reject: new SshConnectionError("remote command on Mac-Mini timed out after 8000 ms", "before_exec") },
      reason: "connect_failed",
      message: "Start failed — Mac-Mini unreachable — timed out waiting for the machine",
      errName: "SshConnectionError"
    },
    {
      label: "the connection was refused before the script was sent",
      create: { reject: new SshConnectionError("SSH connection to Mac-Mini (karl@192.168.1.192) failed", "before_exec") },
      reason: "connect_failed",
      message: "Start failed — Mac-Mini unreachable — SSH connection failed",
      errName: "SshConnectionError"
    },
    {
      label: "exec throws something else",
      create: { reject: new Error("boom") },
      reason: "connect_failed",
      message: "Start failed — Mac-Mini unreachable — could not run the script over SSH",
      errName: "Error"
    }
  ];
  it.each(scriptFailures)("$label → attempted + result rows, 200 with a first-party message, one warn line with the row's reason", async ({ create, reason, outcome = "failed", message, errName }) => {
    const r = await machineReady({ exec: fakeMachine(FILE, { create }) });
    const res = await r.create({ newProject: NEW_NAME });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ tmuxSession: "My-App-2", path: `${ROOT}/${NEW_NAME}`, outcome, message: message ?? `Start failed — ${reason}` });
    expect(res.body).not.toContain("publickey");
    expect(res.body).not.toContain("ghp_");
    expect(res.body).not.toContain("8000 ms"); // the exception's own text never travels
    expect(res.body).not.toContain("not-the-plan");
    expectFirstParty(res.body);
    expect(r.made.exec.calls).toHaveLength(2);
    const rows = inserts(r.append);
    expect(rows.map((row) => row.rowKind)).toEqual(["attempted", "result"]);
    expect(rows[1]).toMatchObject({ outcome, reason, tmuxSession: "My-App-2", machine: "Mac-Mini" });
    expect(createLines(r.made.log).info).toEqual([]);
    expect(createLines(r.made.log).warn).toEqual([
      { event: "console.session_create", machine: "Mac-Mini", outcome, correlationId: expect.stringMatching(UUID_RE) as string, sessionIdHash: hashOf(r.cookie), reason, ...(errName !== undefined ? { errName } : {}) }
    ]);
    const logged = everythingLogged(r.made.log);
    for (const leak of [NEW_NAME, "192.168", "boom", "8000 ms"]) expect(logged).not.toContain(leak);
  });

  it("the live tmux list failing → failed before the script (one dial), attempted + result rows with the list's first-party message", async () => {
    const r = await machineReady({ exec: fakeMachine(FILE, { tmuxListReject: true }) });
    const res = await r.create({ newProject: NEW_NAME });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ tmuxSession: "My-App-2", path: `${ROOT}/${NEW_NAME}`, outcome: "failed", message: "Start failed — Mac-Mini unreachable — SSH connection failed" });
    expectFirstParty(res.body);
    expect(r.made.exec.calls).toHaveLength(1);
    expect(r.made.exec.calls[0]!.command).toContain("tmux list-sessions");
    const rows = inserts(r.append);
    expect(rows.map((row) => row.rowKind)).toEqual(["attempted", "result"]);
    expect(rows[1]).toMatchObject({ outcome: "failed", reason: "tmux_list_failed", tmuxSession: "My-App-2" });
    expect(createLines(r.made.log).warn).toEqual([expect.objectContaining({ outcome: "failed", reason: "tmux_list_failed" })]);
  });

  it("audit: an attempted row that cannot be written → 500, nothing dialled; a result row that cannot be written after the dial → 500; one error line each, the name nowhere", async () => {
    const r = await machineReady();
    r.append.mockImplementationOnce(() => {
      throw new Error("SQLITE_IOERR: disk I/O error");
    });
    const dead = await r.create({ newProject: NEW_NAME });
    expect(dead.statusCode).toBe(500);
    expect(dead.json()).toEqual({ error: "internal_error" });
    expect(r.made.exec.calls).toEqual([]);
    expect(createLines(r.made.log).error).toEqual([{ event: "console.session_create", machine: "Mac-Mini", outcome: "failed", correlationId: expect.stringMatching(UUID_RE) as string, sessionIdHash: hashOf(r.cookie), errName: "Error" }]);
    expect(createLines(r.made.log).info).toEqual([]);
    // The result row fails after the dial: fail loud; the attempted row stands alone.
    r.append
      .mockImplementationOnce((row) => SqliteConsoleStore.prototype.appendSubmitLog.call(r.made.store, row))
      .mockImplementationOnce(() => {
        throw new Error("SQLITE_IOERR: disk I/O error");
      });
    const late = await r.create({ newProject: NEW_NAME });
    expect(late.statusCode).toBe(500);
    expect(late.json()).toEqual({ error: "internal_error" });
    expect(late.body).not.toContain("disk");
    expect(r.made.exec.calls).toHaveLength(2);
    expect(createLines(r.made.log).error).toHaveLength(2);
    expect(createLines(r.made.log).error[1]).toMatchObject({ outcome: "created_project" });
    const logged = everythingLogged(r.made.log);
    expect(logged).not.toContain(NEW_NAME);
    expect(logged).not.toContain("disk");
  });
});

// ---------------------------------------------------------------------------------------------------------------
// F2 Task 12 (spec §6.4): the commit approval's second step — `GET /console/api/cards/:id/pane` reads the session's
// screen on demand (operator guard only: it reads; masked, capped, never stored — R1, the expand posture).
// ---------------------------------------------------------------------------------------------------------------

const paneUrl = (id: string): string => `/console/api/cards/${id}/pane`;
const PANE_BUDGET = { timeoutMs: 4000, maxOutputBytes: 65536 };
const COMMIT_NEEDS = { needsYou: true, needsKind: "sentinel", asksYou: true, options: ["A1", "A2"] } as const;
/** CDF's render with a token-shaped secret on screen: the route must mask it before anything leaves the server. */
const PANE_TEXT = `     token: ${SECRET}\n${CDF_RENDER}`;
type PaneBody = { readonly tail: string; readonly capturedAt: string; readonly truncated: boolean };

interface PaneReady {
  readonly made: Made;
  /** A commit approval of the one stored session (Mac-Mini, reachable, idle, pane %1). */
  readonly card: ConsoleCardRow;
  /** GET …/pane as the admin bearer (or with `headers`). */
  readonly get: (id?: string, headers?: Record<string, string>) => Promise<LightMyRequestResponse>;
}

function paneReady(o: { exec?: ReturnType<typeof fakeMachine>; login?: boolean } = {}): PaneReady {
  const made = makeApp({ ...(o.exec ? { exec: o.exec } : {}), ...(o.login ? { login: true } : {}) });
  app = made.app;
  addMachine(made.registry, "Mac-Mini");
  made.store.upsertSession(sessionRow({ status: "idle" }), T0);
  const card = made.store.upsertCard(faceOf(turns[0]!, { kind: "commit_approval" }), COMMIT_NEEDS, 90, T0);
  const get: PaneReady["get"] = (id = card.id, headers = admin) => made.app.inject({ method: "GET", url: paneUrl(id), headers });
  return { made, card, get };
}

describe("GET /console/api/cards/:id/pane (Task 12)", () => {
  it("Task 12: is guarded — 401 without a credential, 403 for a keycard bearer — has no HEAD (404) and adds nothing to PUBLIC_PATHS; nothing dialled", async () => {
    const before = [...PUBLIC_PATHS].sort();
    const locked = paneReady({ login: true });
    const anon = await locked.get(locked.card.id, {});
    expect(anon.statusCode).toBe(401);
    expect(anon.json()).toEqual({ error: "unauthenticated" });
    expect(locked.made.exec.calls).toEqual([]);
    await app!.close();

    const { made, card, get } = paneReady();
    expect([...PUBLIC_PATHS].sort()).toEqual(before);
    const minted = await made.app.inject({ method: "POST", url: "/api/keycards", headers: admin, payload: { principal: "cli-mac-mini", scopes: ["sessions:read"] } });
    expect(minted.statusCode).toBe(201);
    const keycard = await get(card.id, { authorization: `Bearer ${minted.json().token as string}` });
    expect(keycard.statusCode).toBe(403);
    expect(keycard.json()).toEqual({ error: "invalid_token" });
    const head = await made.app.inject({ method: "HEAD", url: paneUrl(card.id), headers: admin });
    expect(head.statusCode).toBe(404);
    expect(made.exec.calls).toEqual([]);
  });

  it("Task 12: 400 for a malformed id (fixed text) and 404 for an unknown card — no-store; nothing dialled or logged", async () => {
    const { made, get } = paneReady();
    for (const id of ["not-hex", "A".repeat(32), "0".repeat(31), "0".repeat(33), `${"0".repeat(31)}g`]) {
      const res = await get(id);
      expect(res.statusCode, id).toBe(400);
      expect(res.json()).toEqual({ error: "unexpected card id" });
      expect(res.headers["cache-control"]).toBe("no-store");
    }
    const missing = await get(HEX);
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: "no such card" });
    expect(missing.headers["cache-control"]).toBe("no-store");
    expect(made.exec.calls).toEqual([]);
    expect(everythingLogged(made.log)).toBe("[]");
  });

  it("Task 12: 409 not_commit_approval for a reply card and a menu card — nothing dialled", async () => {
    const { made, get } = paneReady();
    const reply = made.store.upsertCard(faceOf(turns[1]!), ASKS, 90, T0);
    const menu = made.store.upsertCard(faceOf(turns[1]!, { turnUuid: "menu-turn", kind: "menu" }), { needsYou: true, needsKind: "menu_on_screen" }, 90, T0);
    for (const c of [reply, menu]) {
      const res = await get(c.id);
      expect(res.statusCode, c.kind).toBe(409);
      expect(res.json()).toEqual({ error: "not_commit_approval" });
      expect(res.headers["cache-control"]).toBe("no-store");
    }
    expect(made.exec.calls).toEqual([]);
  });

  it("Task 12: 409 not_reachable — no session row, reachable false, ended, an sh- shell, an unconnectable or disabled machine — nothing dialled; a session showing a prompt is still read (reading types nothing)", async () => {
    const { made, card, get } = paneReady();
    const expectNotReachable = async (label: string, id = card.id): Promise<void> => {
      const res = await get(id);
      expect(res.statusCode, label).toBe(409);
      expect(res.json(), label).toEqual({ error: "not_reachable" });
      expect(res.headers["cache-control"]).toBe("no-store");
    };
    const orphan = made.store.upsertCard(faceOf(turns[1]!, { sessionId: "6e09d39d-0000-4000-8000-000000000002", kind: "commit_approval" }), COMMIT_NEEDS, 90, T0);
    await expectNotReachable("no session row", orphan.id);
    made.store.upsertSession(sessionRow({ status: "idle", reachable: false }), T1);
    await expectNotReachable("reachable false");
    made.store.upsertSession(sessionRow({ status: "idle", endedAt: T1 }), T1);
    await expectNotReachable("ended");
    made.store.upsertSession(sessionRow({ status: "idle", tmuxSession: "sh-Mac-Mini" }), T1);
    await expectNotReachable("sh- shell");
    made.store.upsertSession(sessionRow({ status: "idle", machine: "Ghost" }), T1);
    const ghost = made.store.upsertCard(faceOf(turns[1]!, { turnUuid: "ghost-turn", machine: "Ghost", kind: "commit_approval" }), COMMIT_NEEDS, 90, T0);
    await expectNotReachable("unconnectable machine", ghost.id);
    addMachine(made.registry, "Parked", { enabled: false });
    made.store.upsertSession(sessionRow({ status: "idle", machine: "Parked" }), T1);
    const parked = made.store.upsertCard(faceOf(turns[1]!, { turnUuid: "parked-turn", machine: "Parked", kind: "commit_approval" }), COMMIT_NEEDS, 90, T0);
    await expectNotReachable("disabled machine", parked.id);
    expect(made.exec.calls).toEqual([]);
    expect(everythingLogged(made.log)).toBe("[]");
    // Restored — and showing a prompt — the same card reads the screen: one dial.
    made.store.upsertSession(sessionRow({ status: "waiting" }), T2);
    expect((await get()).statusCode).toBe(200);
    expect(made.exec.calls).toHaveLength(1);
  });

  it("Task 12: happy path — one dial with the pane-tail command for the row's pane and the stated budget; CDF's render comes back masked and whole; nothing stored; one info line without the text", async () => {
    const { made, card, get } = paneReady({ exec: fakeMachine(FILE, { pane: { text: PANE_TEXT } }) });
    const res = await get();
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.headers["cache-control"]).toBe("no-store");
    const body = res.json() as PaneBody;
    expect(Object.keys(body).sort()).toEqual(["capturedAt", "tail", "truncated"]);
    expect(body.capturedAt).toMatch(ISO_RE);
    expect(body.truncated).toBe(false);
    expect(body.tail).toBe(maskSecrets(PANE_TEXT).replace(/\n+$/, ""));
    expect(body.tail).toContain("token: [masked]");
    expect(res.body).not.toContain(SECRET);
    for (const part of ["Commit the staged example change?", "Staged change:", "1 file changed, 40 insertions(+)", "Hooks that will run at commit: pre-commit", "Reply with the option id again (for example: A1) to confirm."]) {
      expect(body.tail).toContain(part);
    }
    // One dial: the machine's target and key handle, the pane-tail command for the stored row's pane, the budget.
    expect(made.exec.calls).toHaveLength(1);
    const call = made.exec.calls[0]!;
    expect(call.target).toEqual(MAC_MINI);
    expect(call.handle).toBe("harness");
    expect(call.command).toBe(buildPaneTailCommand("%1", 60));
    expect(call.opts).toEqual(PANE_BUDGET);
    // R1: nothing of the screen is stored — no audit row, no card or session field carries it.
    expect(made.store.listSubmitLog(card.id)).toEqual([]);
    expect(JSON.stringify([made.store.listCards({}, 50), made.store.listSessions()])).not.toContain("Staged change");
    // One info line: the four fields, never the text, a path on the screen or the mask's mark.
    const lines = submitLines(made.log, "console.pane_view");
    expect(lines.info).toEqual([
      { event: "console.pane_view", cardId: card.id, machine: "Mac-Mini", correlationId: expect.stringMatching(UUID_RE) as string, bytes: Buffer.byteLength(body.tail, "utf8") }
    ]);
    expect(lines.warn).toEqual([]);
    const logged = everythingLogged(made.log);
    for (const never of [SECRET, "[masked]", "Staged change", "services/control-plane", "token"]) expect(logged).not.toContain(never);
  });

  it("Task 12: the screen is masked WHOLE, then cut to its last 60 lines (trailing blank rows dropped first) and its last 8 KiB on a character boundary — truncated says so", async () => {
    const screen = { text: "" };
    const { get } = paneReady({
      exec: fakeMachine(FILE, {
        pane: {
          get text(): string {
            return screen.text;
          }
        }
      })
    });
    const read = async (text: string): Promise<PaneBody> => {
      screen.text = text;
      const res = await get();
      expect(res.statusCode).toBe(200);
      return res.json() as PaneBody;
    };
    const rows = Array.from({ length: 100 }, (_, i) => `row ${String(i + 1).padStart(3, "0")}`);
    // tmux prints every row of a tall pane: the empty bottom is dropped, so the text keeps its 60 lines.
    expect(await read(`${rows.join("\n")}\n${"\n".repeat(40)}   \n`)).toMatchObject({ tail: rows.slice(40).join("\n"), truncated: true });
    expect(await read(`${rows.slice(0, 60).join("\n")}\n`)).toMatchObject({ tail: rows.slice(0, 60).join("\n"), truncated: false });
    // 8 KiB of three-byte characters: the cut never starts inside one.
    const wide = Array.from({ length: 10 }, () => "─".repeat(400)).join("\n");
    const cut = await read(`${wide}\n`);
    expect(cut.truncated).toBe(true);
    expect(Buffer.byteLength(cut.tail, "utf8")).toBeLessThanOrEqual(8192);
    expect(Buffer.byteLength(cut.tail, "utf8")).toBeGreaterThan(8192 - 3);
    expect(wide.endsWith(cut.tail)).toBe(true);
    expect(cut.tail).not.toContain("\uFFFD");
    // Masked BEFORE the cut: a token straddling the 8 KiB boundary is masked, never cut into an unmasked remainder.
    const straddle = await read(`${SECRET}\n${"y".repeat(8192 - 20)}\n`);
    expect(straddle).toMatchObject({ tail: `[masked]\n${"y".repeat(8192 - 20)}`, truncated: false });
    expect(straddle.tail).not.toContain("qqqq");
  });

  it("Task 12: a dial that throws is 502 unreachable with first-party words — never the error's text; one warn line with the error's class only", async () => {
    const cases: ReadonlyArray<readonly [err: Error, message: string, errName: string, reason: string]> = [
      [new SshConnectionError("SSH connection to Mac-Mini (karl@192.168.1.192) failed", "before_exec"), "Mac-Mini unreachable — SSH connection failed", "SshConnectionError", "connect_failed"],
      [new SshConnectionError("remote command on Mac-Mini timed out after 4000 ms", "after_exec"), "Mac-Mini unreachable — timed out waiting for the machine", "SshConnectionError", "timeout"],
      [new CustodyError("no usable private key for handle: harness (missing or a symlink)"), "Mac-Mini unreachable — could not read the session's screen over SSH", "CustodyError", "connect_failed"]
    ];
    for (const [err, message, errName, reason] of cases) {
      await app?.close(); // the previous case's app; afterEach closes the last one
      const { made, get } = paneReady({ exec: fakeMachine(FILE, { pane: { reject: err } }) });
      const res = await get();
      expect(res.statusCode, errName).toBe(502);
      expect(res.json()).toEqual({ error: "unreachable", message });
      expect(res.headers["cache-control"]).toBe("no-store");
      expectFirstParty(res.body);
      expect(res.body).not.toContain(err.message);
      expect(made.exec.calls).toHaveLength(1);
      const lines = submitLines(made.log, "console.pane_view");
      expect(lines.info).toEqual([]);
      expect(lines.warn).toEqual([expect.objectContaining({ event: "console.pane_view", machine: "Mac-Mini", reason, errName, correlationId: expect.stringMatching(UUID_RE) as string })]);
      expect(everythingLogged(made.log)).not.toContain(err.message);
    }
  });

  it("Task 12: a dial that returns no record is 502 unreachable — a non-zero exit, no end marker, no tail record for the pane, an empty capture (fix round 1, M-1), a stored pane id the builder refuses (never dialled); first-party words only", async () => {
    const tailOf = (pane: string, text: string): string => `${PROBE_SENTINEL}tail:${pane}:${Buffer.from(text, "utf8").toString("base64")}\n`;
    const cases: ReadonlyArray<readonly [label: string, pane: NonNullable<FakeMachineOptions["pane"]>, message: string, logged: object]> = [
      ["exit 1", { code: 1 }, "reading the session's screen on Mac-Mini failed (exit 1)", { reason: "exit_nonzero", exitCode: 1 }],
      ["no end marker", { stdout: `Last login: banner\n${tailOf("%1", CDF_RENDER)}` }, "the session's screen from Mac-Mini ended early — no end marker (cut at the output cap or interrupted)", { reason: "cut_short" }],
      ["another pane's record", { stdout: `${tailOf("%2", CDF_RENDER)}${PROBE_SENTINEL}end\n` }, "the session's screen did not come back from Mac-Mini", { reason: "no_record" }],
      ["no record at all", { stdout: `Last login: banner\n${PROBE_SENTINEL}end\n` }, "the session's screen did not come back from Mac-Mini", { reason: "no_record" }],
      // A pane that is gone captures nothing: the record is there, its screen empty (or blank rows only).
      ["an empty capture", { text: "" }, "the session's screen came back empty from Mac-Mini — the pane may have closed", { reason: "empty_capture" }],
      ["a blank capture", { text: "\n   \n\n" }, "the session's screen came back empty from Mac-Mini — the pane may have closed", { reason: "empty_capture" }]
    ];
    for (const [label, pane, message, logged] of cases) {
      await app?.close(); // the previous case's app; afterEach closes the last one
      const { made, get } = paneReady({ exec: fakeMachine(FILE, { pane }) });
      const res = await get();
      expect(res.statusCode, label).toBe(502);
      expect(res.json(), label).toEqual({ error: "unreachable", message });
      expect(res.headers["cache-control"]).toBe("no-store");
      expectFirstParty(res.body);
      expect(res.body).not.toContain("Staged change");
      expect(submitLines(made.log, "console.pane_view").warn, label).toEqual([
        expect.objectContaining({ event: "console.pane_view", cardId: expect.any(String) as string, machine: "Mac-Mini", correlationId: expect.stringMatching(UUID_RE) as string, ...logged })
      ]);
      expect(everythingLogged(made.log)).not.toContain("Staged change");
      expect(everythingLogged(made.log)).not.toContain("boom"); // the machine's stderr never reaches a log line
    }
    // A stored pane id outside the allow-list: the builder refuses it before any command exists — nothing is dialled.
    await app?.close();
    const { made, get } = paneReady();
    made.store.upsertSession(sessionRow({ status: "idle", paneId: "%1; id" }), T1);
    const refused = await get();
    expect(refused.statusCode).toBe(502);
    expect(refused.json()).toEqual({ error: "unreachable", message: "the screen request for Mac-Mini was refused — invalid pane id — expected '%' followed by 1–6 digits" });
    expect(refused.body).not.toContain("%1; id");
    expect(made.exec.calls).toEqual([]);
    expect(submitLines(made.log, "console.pane_view").warn).toEqual([expect.objectContaining({ reason: "plan_refused" })]);
  });
});
