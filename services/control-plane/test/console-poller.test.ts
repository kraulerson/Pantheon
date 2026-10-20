/**
 * Maestro Console poller (plan Task 8). A fake `exec` plays the dev machine: it reads the slice offsets,
 * the per-slice cap and the tail panes out of the generated probe text and answers in the record grammar
 * the real probe emits (including the R-pre-1 reset when the stored offset exceeds the file size). The
 * store is a real `:memory:` SqliteConsoleStore; clock and timers are injected. Nothing is dialled.
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Fastify from "fastify";
import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";
import { SshConnectionError, type RemoteCommand } from "../src/devmachine/connection.js";
import type { SshTarget } from "../src/devmachine/provisioning.js";
import type { RemoteCommandResult, RemoteExec } from "../src/devmachine/tmux.js";
import type { DevMachine } from "../src/registry/types.js";
import { PROBE_MAX_OUTPUT_BYTES, PROBE_SENTINEL } from "../src/console/probe-command.js";
import { createConsolePoller, createProbeExec, type ConsolePollerDeps, type PollerLogger } from "../src/console/poller.js";
import { DEFAULT_CONSOLE_SETTINGS } from "../src/console/settings.js";
import { splitTurns } from "../src/console/transcript.js";
import { SqliteConsoleStore, type ConsoleSessionRow } from "../src/console/store.js";
import { maskSecrets } from "../src/console/masking.js";
import { registerConsoleRoutes } from "../src/http/routes/console.js";
import { StepUpWindow } from "../src/http/auth/step-up.js";
import { SessionStore } from "../src/http/auth/session.js";
import { DELIVER_SENTINEL } from "../src/console/deliver-command.js";
import { CONSOLE_CLIENT_JS, renderConsolePage } from "../src/http/console-page.js";

const FIX = join(__dirname, "fixtures", "console");
const fixture = (name: string): Buffer => readFileSync(join(FIX, name));
const BASIC = fixture("transcript-basic.jsonl");
/** transcript-basic.jsonl: turn 1 ends at 21621; turn 2 (bd252916…) is open until closed or followed. */
const BASIC_TURN1_END = 21621;
const BASIC_TURN1 = "792879cd";
const BASIC_TURN2 = "bd252916";

const S = PROBE_SENTINEL;
const SID = "0f1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b";
const SID2 = "11111111-2222-4333-8444-555555555555";
const CWD = "/Users/karl/Documents/Claude Projects/Pantheon/pantheon-harness";
const T0 = Date.parse("2026-10-17T10:00:00.000Z");
const b64 = (x: string | Buffer): string => Buffer.from(x).toString("base64");

const machine = (logicalName: string, over: Partial<DevMachine> = {}): DevMachine => ({
  id: `id-${logicalName}`,
  logicalName,
  host: `${logicalName.toLowerCase()}.lan`,
  port: 22,
  user: "karl",
  sshKeyHandle: `key-${logicalName}`,
  provisioned: true,
  enabled: true,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  ...over
});

const registryOf = (machines: DevMachine[]): ConsolePollerDeps["registry"] => ({
  listDevMachines: () => machines,
  getDevMachineByLogicalName: (n: string) => machines.find((m) => m.logicalName === n)
});

interface FakeSession {
  readonly sessionId: string;
  readonly pid?: number;
  readonly status?: string;
  readonly waitingFor?: string;
  readonly tmux?: string;
  readonly cwd?: string;
  readonly alive?: boolean;
  /** The key the file uses for the session id (default "sessionId"); another name plays a format change. */
  readonly idKey?: string;
  readonly procStart?: string;
  /** The pid exactly as written in the file (default: the bare number `pid`); a quoted value plays a format change. */
  readonly pidRaw?: string;
}

/** One simulated dev machine: what the probe script would find there. */
interface FakeMachine {
  sessions: FakeSession[];
  panes: { readonly session: string; readonly paneId: string }[];
  transcripts: Map<string, Buffer>;
  tails: Map<string, string>;
  sentinels: Map<string, string>;
  noEnd?: boolean;
}

const fakeMachine = (over: Partial<FakeMachine> = {}): FakeMachine => ({
  sessions: [],
  panes: [],
  transcripts: new Map(),
  tails: new Map(),
  sentinels: new Map(),
  ...over
});

function sessionFields(s: FakeSession): string {
  const lines = [`"pid": ${s.pidRaw ?? s.pid ?? 4242}`, `"${s.idKey ?? "sessionId"}": "${s.sessionId}"`, `"cwd": ${JSON.stringify(s.cwd ?? CWD)}`];
  if (s.status !== undefined) lines.push(`"status": "${s.status}"`);
  if (s.waitingFor !== undefined) lines.push(`"waitingFor": "${s.waitingFor}"`);
  if (s.tmux !== undefined) lines.push(`"tmux": "${s.tmux}"`);
  lines.push(`"procStart": "${s.procStart ?? "Sat Oct 17 01:41:52 2026"}"`, '"version": "2.1.302"');
  return lines.join("\n");
}

interface ProbeAsk {
  readonly slices: readonly { readonly sessionId: string; readonly offset: number }[];
  readonly max: number;
  readonly panes: readonly string[];
}

/** Read the plan back out of the generated probe text (the same values buildProbeCommand single-quoted). */
function readAsk(command: string): ProbeAsk {
  const slices = [...command.matchAll(/^slice '([0-9a-f-]{36})' '(\d+)'$/gm)].map((m) => ({ sessionId: m[1]!, offset: Number(m[2]) }));
  const max = Number(/-gt (\d+) \]; then trunc=1/.exec(command)?.[1] ?? "0");
  const panes = [...command.matchAll(/^tail_of '(%\d+)'$/gm)].map((m) => m[1]!);
  return { slices, max, panes };
}

/** Answer like the remote script: panes, session (+ sentinel) records, slices, tails, end. */
function respond(m: FakeMachine, command: string): string {
  const ask = readAsk(command);
  const out: string[] = ["Welcome to the machine"];
  for (const p of m.panes) out.push(`${S}pane:${b64(p.session)}:@1:${p.paneId}:999:${b64("node")}`);
  m.sessions.forEach((s, i) => {
    out.push(`${S}session:${1000 + i}.json:${s.alive === false ? 0 : 1}:${b64(sessionFields(s))}`);
    const sentinel = m.sentinels.get(s.sessionId);
    if (sentinel !== undefined) out.push(`${S}sentinel:${s.sessionId}:${b64(sentinel)}`);
  });
  for (const sl of ask.slices) {
    const t = m.transcripts.get(sl.sessionId);
    if (t === undefined) {
      out.push(`${S}slice:${sl.sessionId}:${sl.offset}:0:0:0:`);
      continue;
    }
    const off = t.length < sl.offset ? 0 : sl.offset;
    const trunc = t.length - off > ask.max ? 1 : 0;
    out.push(`${S}slice:${sl.sessionId}:${off}:${t.length}:${trunc}:1:${b64(t.subarray(off, off + ask.max))}`);
  }
  for (const p of ask.panes) out.push(`${S}tail:${p}:${b64(m.tails.get(p) ?? "")}`);
  if (m.noEnd !== true) out.push(`${S}end`);
  return `${out.join("\n")}\n`;
}

/** One call on the pino-shaped logger: `(obj, msg?)` or `(msg)`. */
interface LogCall {
  readonly level: "info" | "warn" | "error";
  readonly obj: Record<string, unknown> | undefined;
  readonly msg: string | undefined;
}

function fakeLogger(calls: LogCall[]): PollerLogger {
  const at =
    (level: LogCall["level"]) =>
    (a: object | string, b?: string): void => {
      calls.push(typeof a === "string" ? { level, obj: undefined, msg: a } : { level, obj: a as Record<string, unknown>, msg: b });
    };
  return { info: at("info"), warn: at("warn"), error: at("error") };
}

interface Harness {
  readonly poller: ReturnType<typeof createConsolePoller>;
  readonly store: SqliteConsoleStore;
  readonly exec: ReturnType<typeof vi.fn<RemoteExec>>;
  readonly asks: ProbeAsk[];
  readonly logs: LogCall[];
  readonly clock: { now: number };
}

function harness(
  machines: DevMachine[],
  fakes: Record<string, FakeMachine>,
  over: Partial<ConsolePollerDeps> = {}
): Harness {
  const store = over.store ?? new SqliteConsoleStore(":memory:");
  const asks: ProbeAsk[] = [];
  const logs: LogCall[] = [];
  const clock = { now: T0 };
  const exec = vi.fn<RemoteExec>(async (target: SshTarget, _handle: string, command: RemoteCommand): Promise<RemoteCommandResult> => {
    asks.push(readAsk(command));
    const m = fakes[target.logicalName];
    if (m === undefined) throw new Error(`test: no fake for ${target.logicalName}`);
    return { code: 0, stdout: respond(m, command), stderr: "" };
  });
  const poller = createConsolePoller({
    registry: registryOf(machines),
    exec,
    store,
    settings: DEFAULT_CONSOLE_SETTINGS,
    now: () => clock.now,
    log: fakeLogger(logs),
    ...over
  });
  return { poller, store, exec, asks, logs, clock };
}

type SeedRow = Omit<ConsoleSessionRow, "version" | "createdAt" | "updatedAt">;
const seedRow = (over: Partial<SeedRow> = {}): SeedRow => ({
  machine: "Mac-Mini",
  tmuxSession: "Pantheon",
  paneId: "%9",
  claudePid: 4242,
  sessionId: SID,
  procStart: "Sat Oct 17 01:41:52 2026",
  cwd: CWD,
  projectKey: "Pantheon",
  reachable: true,
  status: "busy",
  waitingFor: null,
  state: "working",
  stateReason: null,
  transcriptOffset: 0,
  transcriptSize: 0,
  lastSeenAt: "2026-10-17T09:00:00.000Z",
  endedAt: null,
  ...over
});

const iso = (ms: number): string => new Date(ms).toISOString();

/** A synthetic complete turn (prompt, reply with a TL;DR, turn_duration terminator). */
function turnLines(i: number, reply = `Reply ${i}.\n\n**TL;DR:** done ${i}`, pad = 0): string {
  const ts = iso(T0 - 60_000 + i);
  return [
    JSON.stringify({ type: "user", uuid: `u-${i}`, timestamp: ts, message: { role: "user", content: `prompt ${i}` } }),
    JSON.stringify({
      type: "assistant",
      uuid: `a-${i}`,
      timestamp: ts,
      message: { role: "assistant", content: [{ type: "text", text: `${reply}${pad > 0 ? `\n\n${"x".repeat(pad)}` : ""}` }] }
    }),
    JSON.stringify({ type: "system", subtype: "turn_duration", uuid: `d-${i}`, timestamp: ts, durationMs: 10 }),
    ""
  ].join("\n");
}

/** One prompt and `n` ~540-byte assistant text lines, optionally closed by a turn_duration line. */
function bigTurn(tag: string, n: number, terminated: boolean): string {
  const ts = iso(T0 - 1000);
  const lines = [JSON.stringify({ type: "user", uuid: `u-${tag}`, timestamp: ts, message: { role: "user", content: tag } })];
  for (let i = 0; i < n; i++) {
    lines.push(JSON.stringify({ type: "assistant", uuid: `a-${tag}-${i}`, timestamp: ts, message: { role: "assistant", content: [{ type: "text", text: "y".repeat(450) }] } }));
  }
  if (terminated) lines.push(JSON.stringify({ type: "system", subtype: "turn_duration", uuid: `d-${tag}`, timestamp: ts, durationMs: 10 }));
  return `${lines.join("\n")}\n`;
}

/** The retry probe's slice cap: the whole 1.4 MiB budget for one slice and no tails, in raw bytes. */
const RETRY_MAX = Math.floor((Math.floor(1.4 * 1024 * 1024) * 3) / 4);

const PANTHEON_PANE = { session: "Pantheon", paneId: "%9" } as const;
const live = (over: Partial<FakeSession> = {}): FakeSession => ({ sessionId: SID, status: "busy", tmux: "Pantheon:@9.%9", ...over });

describe("createConsolePoller — dialling", () => {
  it("one tick probes each ready machine exactly once", async () => {
    const h = harness([machine("Mac-Mini"), machine("Studio")], { "Mac-Mini": fakeMachine(), Studio: fakeMachine() });
    await h.poller.tick();
    expect(h.exec).toHaveBeenCalledTimes(2);
    const targets = h.exec.mock.calls.map((c) => c[0].logicalName).sort();
    expect(targets).toEqual(["Mac-Mini", "Studio"]);
    expect(h.exec.mock.calls.map((c) => c[1]).sort()).toEqual(["key-Mac-Mini", "key-Studio"]);
    expect(h.poller.health().map((x) => [x.machine, x.state])).toEqual([
      ["Mac-Mini", "ok"],
      ["Studio", "ok"]
    ]);
    expect(h.poller.health()[0]?.lastOkAt).toBe(iso(T0));
  });

  it("a disabled or unprovisioned machine is never dialled", async () => {
    const h = harness(
      [machine("Mac-Mini"), machine("Old", { enabled: false }), machine("New", { provisioned: false, sshKeyHandle: "" })],
      { "Mac-Mini": fakeMachine() }
    );
    await h.poller.tick();
    expect(h.exec).toHaveBeenCalledTimes(1);
    expect(h.exec.mock.calls[0]?.[0].logicalName).toBe("Mac-Mini");
    const byName = new Map(h.poller.health().map((x) => [x.machine, x]));
    expect(byName.get("Old")?.state).toBe("not_connectable");
    expect(byName.get("Old")?.message).toMatch(/disabled/);
    expect(byName.get("New")?.state).toBe("not_connectable");
    expect(byName.get("New")?.message).toMatch(/not provisioned/);
  });

  it("a second tick while one is running is skipped and counted", async () => {
    let release: (r: RemoteCommandResult) => void = () => undefined;
    const exec = vi.fn<RemoteExec>(() => new Promise<RemoteCommandResult>((res) => (release = res)));
    const h = harness([machine("Mac-Mini")], {}, { exec });
    const first = h.poller.tick();
    await h.poller.tick();
    expect(h.poller.skippedTicks()).toBe(1);
    expect(exec).toHaveBeenCalledTimes(1);
    release({ code: 0, stdout: `${S}end\n`, stderr: "" });
    await first;
    expect(h.poller.health()[0]?.state).toBe("ok");
    exec.mockResolvedValue({ code: 0, stdout: `${S}end\n`, stderr: "" });
    await h.poller.tick();
    expect(exec).toHaveBeenCalledTimes(2);
    expect(h.poller.skippedTicks()).toBe(1);
  });

  it("an exec rejection marks the machine unreachable and keeps its cards", async () => {
    const m = fakeMachine({ sessions: [live()], panes: [PANTHEON_PANE], transcripts: new Map([[SID, BASIC]]) });
    const h = harness([machine("Mac-Mini")], { "Mac-Mini": m });
    await h.poller.tick();
    expect(h.store.listCards({ machine: "Mac-Mini" })).toHaveLength(1);

    h.exec.mockRejectedValue(new SshConnectionError("connect timed out"));
    h.clock.now += 5000;
    await h.poller.tick();
    const health = h.poller.health()[0];
    expect(health?.state).toBe("unreachable");
    expect(health?.message).toBe("Mac-Mini unreachable — timed out waiting for the machine");
    expect(health?.since).toBe(iso(T0 + 5000));
    expect(health?.lastOkAt).toBe(iso(T0));
    expect(h.store.listCards({ machine: "Mac-Mini" })).toHaveLength(1);
    expect(h.store.listSessions("Mac-Mini")[0]?.endedAt).toBeNull();
  });

  it("a report without end marks the machine cant_read", async () => {
    const h = harness([machine("Mac-Mini")], { "Mac-Mini": fakeMachine({ noEnd: true }) });
    await h.poller.tick();
    expect(h.poller.health()[0]?.state).toBe("cant_read");
    expect(h.poller.health()[0]?.message).toMatch(/no end marker/);
  });

  it("each probe goes through exec with the probe output cap and a 4 s timeout (createProbeExec)", async () => {
    const run = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
    const exec = createProbeExec({ custody: { resolvePrivateKey: async () => "k" } as never }, run as never);
    const target = { logicalName: "Mac-Mini", host: "h", port: 22, user: "karl" };
    await exec(target, "handle", "true" as RemoteCommand);
    expect(run).toHaveBeenCalledWith(target, "handle", "true", expect.anything(), { maxOutputBytes: PROBE_MAX_OUTPUT_BYTES, timeoutMs: 4000 });
  });
});

describe("createConsolePoller — transcripts and cards", () => {
  it("after a tick the store holds the fixture's turns as card faces with masked TL;DRs", async () => {
    const secret = "ghp_" + "A".repeat(36);
    const transcript = Buffer.concat([BASIC, Buffer.from(turnLines(1, `Pushed.\n\n**TL;DR:** pushed with ${secret} to gitea`))]);
    const m = fakeMachine({ sessions: [live()], panes: [PANTHEON_PANE], transcripts: new Map([[SID, transcript]]) });
    const h = harness([machine("Mac-Mini")], { "Mac-Mini": m });
    await h.poller.tick();
    const cards = h.store.listCards({ machine: "Mac-Mini" });
    expect(cards.map((c) => c.turnUuid.slice(0, 8)).sort()).toEqual([BASIC_TURN1, BASIC_TURN2, "a-1"].sort());
    const last = cards.find((c) => c.turnUuid === "a-1");
    expect(last?.tldrMasked).toBe("pushed with [masked] to gitea");
    expect(cards.every((c) => !c.tldrMasked.includes("ghp_"))).toBe(true);
    expect(last?.projectKey).toBe("Pantheon");
    const row = h.store.listSessions("Mac-Mini")[0];
    expect(row?.transcriptOffset).toBe(transcript.length);
    expect(row?.transcriptSize).toBe(transcript.length);
    expect(row?.state).toBe("working");
    expect(row?.paneId).toBe("%9");
    expect(row?.tmuxSession).toBe("Pantheon");
    expect(row?.reachable).toBe(true);
  });

  it("a new session is discovered on the first probe and read on the immediate catch-up probe", async () => {
    const m = fakeMachine({ sessions: [live()], panes: [PANTHEON_PANE], transcripts: new Map([[SID, BASIC]]) });
    const h = harness([machine("Mac-Mini")], { "Mac-Mini": m });
    await h.poller.tick();
    expect(h.asks).toHaveLength(2);
    expect(h.asks[0]?.slices).toEqual([]);
    expect(h.asks[1]?.slices).toEqual([{ sessionId: SID, offset: 0 }]);
    expect(h.asks[1]?.panes).toEqual(["%9"]);
    // Next tick the session is known: one probe, sliced from the stored offset, tailing its pane.
    h.clock.now += 5000;
    await h.poller.tick();
    expect(h.asks).toHaveLength(3);
    expect(h.asks[2]?.slices).toEqual([{ sessionId: SID, offset: BASIC_TURN1_END }]);
    expect(h.asks[2]?.panes).toEqual(["%9"]);
  });

  it("the stored offset advances to baseOffset + consumedBytes and the open turn is re-read next tick", async () => {
    const m = fakeMachine({ sessions: [live()], panes: [PANTHEON_PANE], transcripts: new Map([[SID, BASIC]]) });
    const h = harness([machine("Mac-Mini")], { "Mac-Mini": m });
    await h.poller.tick();
    let row = h.store.listSessions("Mac-Mini")[0];
    expect(row?.transcriptOffset).toBe(BASIC_TURN1_END);
    expect(row?.transcriptSize).toBe(BASIC.length);
    expect(h.store.listCards({}).map((c) => c.turnUuid.slice(0, 8))).toEqual([BASIC_TURN1]);

    const grown = Buffer.concat([BASIC, Buffer.from(turnLines(2))]);
    m.transcripts.set(SID, grown);
    h.clock.now += 5000;
    await h.poller.tick();
    row = h.store.listSessions("Mac-Mini")[0];
    expect(row?.transcriptOffset).toBe(grown.length);
    expect(h.store.listCards({}).map((c) => c.turnUuid.slice(0, 8)).sort()).toEqual([BASIC_TURN1, BASIC_TURN2, "a-2"].sort());
  });

  it("size below the stored offset resets the offset to 0", async () => {
    const store = new SqliteConsoleStore(":memory:");
    store.upsertSession(seedRow({ transcriptOffset: 99_999, transcriptSize: 99_999 }), iso(T0 - 5000));
    const m = fakeMachine({ sessions: [live()], panes: [PANTHEON_PANE], transcripts: new Map([[SID, BASIC]]) });
    const h = harness([machine("Mac-Mini")], { "Mac-Mini": m }, { store });
    await h.poller.tick();
    expect(h.asks[0]?.slices).toEqual([{ sessionId: SID, offset: 99_999 }]);
    const row = h.store.listSessions("Mac-Mini")[0];
    expect(row?.transcriptOffset).toBe(BASIC_TURN1_END);
    expect(row?.transcriptSize).toBe(BASIC.length);
    expect(h.store.listCards({}).map((c) => c.turnUuid.slice(0, 8))).toEqual([BASIC_TURN1]);
  });

  it("closes the open turn only when the session is idle and the transcript size is unchanged", async () => {
    // Busy, size unchanged: stays open.
    const m = fakeMachine({ sessions: [live({ status: "busy" })], panes: [PANTHEON_PANE], transcripts: new Map([[SID, BASIC]]) });
    const h = harness([machine("Mac-Mini")], { "Mac-Mini": m });
    await h.poller.tick();
    h.clock.now += 5000;
    await h.poller.tick();
    expect(h.store.listCards({})).toHaveLength(1);
    expect(h.store.listSessions("Mac-Mini")[0]?.transcriptOffset).toBe(BASIC_TURN1_END);

    // Idle, but the size changed since the stored poll (seeded row with another size): stays open.
    const store2 = new SqliteConsoleStore(":memory:");
    store2.upsertSession(seedRow({ transcriptOffset: 0, transcriptSize: 100 }), iso(T0 - 5000));
    const m2 = fakeMachine({ sessions: [live({ status: "idle" })], panes: [PANTHEON_PANE], transcripts: new Map([[SID, BASIC]]) });
    const h2 = harness([machine("Mac-Mini")], { "Mac-Mini": m2 }, { store: store2 });
    await h2.poller.tick();
    expect(h2.store.listCards({})).toHaveLength(1);
    expect(h2.store.listSessions("Mac-Mini")[0]?.transcriptSize).toBe(BASIC.length);

    // Idle and the size is now unchanged: the open turn is closed and consumed.
    h2.clock.now += 5000;
    await h2.poller.tick();
    expect(h2.store.listCards({}).map((c) => c.turnUuid.slice(0, 8)).sort()).toEqual([BASIC_TURN1, BASIC_TURN2].sort());
    expect(h2.store.listSessions("Mac-Mini")[0]?.transcriptOffset).toBe(BASIC.length);
  });

  it("a truncated slice triggers one immediate catch-up probe for that machine", async () => {
    // ~300 KiB of complete turns: more than one 256 KiB slice.
    const transcript = Buffer.from(Array.from({ length: 300 }, (_, i) => turnLines(i, `Reply ${i}.\n\n**TL;DR:** done ${i}`, 800)).join(""));
    expect(transcript.length).toBeGreaterThan(256 * 1024);
    expect(transcript.length).toBeLessThan(512 * 1024);
    const store = new SqliteConsoleStore(":memory:");
    store.upsertSession(seedRow(), iso(T0 - 5000));
    const m = fakeMachine({ sessions: [live()], panes: [PANTHEON_PANE], transcripts: new Map([[SID, transcript]]) });
    const h = harness([machine("Mac-Mini")], { "Mac-Mini": m }, { store });
    await h.poller.tick();
    expect(h.exec).toHaveBeenCalledTimes(2);
    expect(h.asks[0]?.max).toBe(256 * 1024);
    expect(h.asks[1]?.slices[0]?.offset).toBeGreaterThan(0);
    expect(h.store.listCards({}, 1000)).toHaveLength(300);
    expect(h.store.listSessions("Mac-Mini")[0]?.transcriptOffset).toBe(transcript.length);
  });

  it("catch-up probes stop at three per tick and the rest is read next tick", async () => {
    const transcript = Buffer.from(Array.from({ length: 1100 }, (_, i) => turnLines(i, `Reply ${i}.\n\n**TL;DR:** done ${i}`, 800)).join(""));
    expect(transcript.length).toBeGreaterThan(4 * 256 * 1024);
    const store = new SqliteConsoleStore(":memory:");
    store.upsertSession(seedRow(), iso(T0 - 5000));
    const m = fakeMachine({ sessions: [live()], panes: [PANTHEON_PANE], transcripts: new Map([[SID, transcript]]) });
    const h = harness([machine("Mac-Mini")], { "Mac-Mini": m }, { store });
    await h.poller.tick();
    expect(h.exec).toHaveBeenCalledTimes(4);
    const offset = h.store.listSessions("Mac-Mini")[0]?.transcriptOffset ?? 0;
    expect(offset).toBeGreaterThan(0);
    expect(offset).toBeLessThan(transcript.length);
    h.clock.now += 5000;
    await h.poller.tick();
    expect(h.store.listSessions("Mac-Mini")[0]?.transcriptOffset).toBe(transcript.length);
    expect(h.store.listCards({}, 2000)).toHaveLength(1100);
  });

  it("an oversize turn gets one retry probe carrying only its slice at the one-slice budget, and is carded", async () => {
    // One ~700 KiB turn (prompt, many assistant text lines, terminator): larger than a 256 KiB slice.
    const transcript = Buffer.from(bigTurn("big", 1300, true));
    expect(transcript.length).toBeGreaterThan(640 * 1024);
    expect(transcript.length).toBeLessThan(RETRY_MAX);
    const store = new SqliteConsoleStore(":memory:");
    store.upsertSession(seedRow(), iso(T0 - 5000));
    store.upsertSession(seedRow({ sessionId: SID2, paneId: "%2", tmuxSession: "Other" }), iso(T0 - 5000));
    const m = fakeMachine({
      sessions: [live(), live({ sessionId: SID2, tmux: "Other:@2.%2" })],
      panes: [PANTHEON_PANE, { session: "Other", paneId: "%2" }],
      transcripts: new Map([
        [SID, transcript],
        [SID2, BASIC]
      ])
    });
    const h = harness([machine("Mac-Mini")], { "Mac-Mini": m }, { store });
    await h.poller.tick();
    expect(h.asks[0]?.max).toBe(256 * 1024);
    expect(h.asks[0]?.slices.map((x) => x.sessionId).sort()).toEqual([SID, SID2].sort());
    expect(h.asks[1]).toEqual({ slices: [{ sessionId: SID, offset: 0 }], max: RETRY_MAX, panes: [] });
    expect(h.asks).toHaveLength(2);
    expect(h.store.listCards({}).map((c) => c.turnUuid)).toContain("a-big-1299");
    expect(h.poller.health()[0]?.turnsTooLong).toBe(0);
    expect(h.store.listSessions("Mac-Mini").find((r) => r.sessionId === SID)?.transcriptOffset).toBe(transcript.length);
  });

  it("an open turn larger than the retry budget is skipped past its last complete line and counted", async () => {
    // One prompt and ~1.2 MiB of assistant lines with no terminator: does not fit even the retry slice.
    const transcript = Buffer.from(bigTurn("huge", 2300, false));
    expect(transcript.length).toBeGreaterThan(RETRY_MAX);
    const store = new SqliteConsoleStore(":memory:");
    store.upsertSession(seedRow(), iso(T0 - 5000));
    const m = fakeMachine({ sessions: [live()], panes: [PANTHEON_PANE], transcripts: new Map([[SID, transcript]]) });
    const h = harness([machine("Mac-Mini")], { "Mac-Mini": m }, { store });
    await h.poller.tick();
    expect(h.asks[1]?.max).toBe(RETRY_MAX);
    const advanced = h.asks[2]?.slices[0]?.offset ?? 0;
    expect(advanced).toBeGreaterThan(0);
    expect(advanced).toBeLessThanOrEqual(RETRY_MAX);
    expect(transcript[advanced - 1]).toBe(0x0a);
    expect(h.asks[2]?.max).toBe(256 * 1024);
    const health = h.poller.health()[0];
    expect(health?.turnsTooLong).toBe(1);
    expect(health?.turnsTooLongBySession[SID]).toBe(1);
    expect(health?.problems).toContain(`session ${SID.slice(0, 8)}: a turn too long to read was skipped`);
    expect(h.store.listSessions("Mac-Mini")[0]?.transcriptOffset).toBe(transcript.length);
  });

  it("a waiting session with an unchanged size keeps its open turn open", async () => {
    const m = fakeMachine({ sessions: [live({ status: "waiting" })], panes: [PANTHEON_PANE], transcripts: new Map([[SID, BASIC]]) });
    const h = harness([machine("Mac-Mini")], { "Mac-Mini": m });
    await h.poller.tick();
    h.clock.now += 5000;
    await h.poller.tick();
    expect(h.store.listCards({}).map((c) => c.turnUuid.slice(0, 8))).toEqual([BASIC_TURN1]);
    expect(h.store.listSessions("Mac-Mini")[0]?.transcriptOffset).toBe(BASIC_TURN1_END);
  });

  it("the final turn of a session whose process died is carded once and the session ends", async () => {
    const m = fakeMachine({ sessions: [live({ status: "busy" })], panes: [PANTHEON_PANE], transcripts: new Map([[SID, BASIC]]) });
    const h = harness([machine("Mac-Mini")], { "Mac-Mini": m });
    await h.poller.tick();
    // Idle, but the transcript gained bytes (a tool-only assistant line): the turn stays open.
    const extra = JSON.stringify({ type: "assistant", uuid: "a-tool", timestamp: iso(T0), message: { role: "assistant", content: [{ type: "tool_use", id: "t", name: "Bash", input: {} }] } });
    m.transcripts.set(SID, Buffer.concat([BASIC, Buffer.from(`${extra}\n`)]));
    m.sessions = [live({ status: "idle" })];
    h.clock.now += 5000;
    await h.poller.tick();
    expect(h.store.listCards({})).toHaveLength(1);
    // The process is dead (kill -0 fails): a dead process gains no bytes, so the open turn is closed.
    m.sessions = [live({ status: "idle", alive: false })];
    h.clock.now += 5000;
    await h.poller.tick();
    expect(h.store.listCards({}).map((c) => c.turnUuid.slice(0, 8)).sort()).toEqual([BASIC_TURN1, BASIC_TURN2].sort());
    expect(h.store.listSessions("Mac-Mini")[0]?.endedAt).toBe(iso(T0 + 10_000));
    // Not rewritten once ended (turn 1's reply asks Karl, so its flag was cleared on the way: compare, not 1).
    const versions = h.store.listCards({}).map((c) => c.version);
    h.clock.now += 5000;
    await h.poller.tick();
    expect(h.store.listCards({})).toHaveLength(2);
    expect(h.store.listCards({}).map((c) => c.version)).toEqual(versions);
  });

  it("the final turn of a session whose file vanished (clean exit) is carded once and the session ends", async () => {
    const m = fakeMachine({ sessions: [live({ status: "busy" })], panes: [PANTHEON_PANE], transcripts: new Map([[SID, BASIC]]) });
    const h = harness([machine("Mac-Mini")], { "Mac-Mini": m });
    await h.poller.tick();
    expect(h.store.listCards({})).toHaveLength(1);
    m.sessions = [];
    h.clock.now += 5000;
    await h.poller.tick();
    // One tick without the file is not an end yet (final review I3: a file caught mid-rewrite): nothing is closed.
    expect(h.store.listCards({})).toHaveLength(1);
    expect(h.store.listSessions("Mac-Mini")[0]?.endedAt).toBeNull();
    h.clock.now += 5000;
    await h.poller.tick();
    expect(h.store.listCards({}).map((c) => c.turnUuid.slice(0, 8)).sort()).toEqual([BASIC_TURN1, BASIC_TURN2].sort());
    const row = h.store.listSessions("Mac-Mini")[0];
    expect(row?.endedAt).toBe(iso(T0 + 10_000));
    expect(row?.transcriptOffset).toBe(BASIC.length);
    h.clock.now += 5000;
    await h.poller.tick();
    expect(h.store.listCards({})).toHaveLength(2);
  });

  it("a session read while alive that exits before the catch-up stays live, then its final turn is carded next tick", async () => {
    const store = new SqliteConsoleStore(":memory:");
    store.upsertSession(seedRow(), iso(T0 - 5000));
    // A (stored, busy) is read in the main probe; B is new, so a catch-up follows; A exits in between.
    const m = fakeMachine({
      sessions: [live(), live({ sessionId: SID2, tmux: "Other:@2.%2" })],
      panes: [PANTHEON_PANE],
      transcripts: new Map([[SID, BASIC]])
    });
    let calls = 0;
    const exec = vi.fn<RemoteExec>(async (_t, _h, command) => {
      const out = respond(m, command);
      calls++;
      if (calls === 1) m.sessions = m.sessions.filter((x) => x.sessionId !== SID);
      return { code: 0, stdout: out, stderr: "" };
    });
    const h = harness([machine("Mac-Mini")], { "Mac-Mini": m }, { store, exec });
    await h.poller.tick();
    expect(exec).toHaveBeenCalledTimes(2);
    let a = h.store.listSessions("Mac-Mini").find((r) => r.sessionId === SID);
    // Its last slice was read while it was still alive (open final turn), so it is not ended yet.
    expect(a?.endedAt).toBeNull();
    expect(a?.transcriptOffset).toBe(BASIC_TURN1_END);
    expect(h.store.listCards({ machine: "Mac-Mini" }).map((c) => c.turnUuid.slice(0, 8))).toEqual([BASIC_TURN1]);
    h.clock.now += 5000;
    await h.poller.tick();
    a = h.store.listSessions("Mac-Mini").find((r) => r.sessionId === SID);
    expect(a?.endedAt).toBe(iso(T0 + 5000));
    expect(a?.transcriptOffset).toBe(BASIC.length);
    expect(h.store.listCards({}).map((c) => c.turnUuid.slice(0, 8)).sort()).toEqual([BASIC_TURN1, BASIC_TURN2].sort());
  });

  it("a new session seen in the main probe and gone by the catch-up keeps its turns, its row and its project key", async () => {
    const m = fakeMachine({ sessions: [live()], panes: [PANTHEON_PANE], transcripts: new Map([[SID, BASIC]]) });
    let calls = 0;
    const exec = vi.fn<RemoteExec>(async (_t, _h, command) => {
      const out = respond(m, command);
      calls++;
      if (calls === 1) m.sessions = [];
      return { code: 0, stdout: out, stderr: "" };
    });
    const h = harness([machine("Mac-Mini")], { "Mac-Mini": m }, { exec });
    await h.poller.tick();
    expect(exec).toHaveBeenCalledTimes(2);
    // Gone from the catch-up's list once is not an end yet (final review I3): its row is kept from the file seen live.
    expect(h.store.listCards({}).map((c) => c.turnUuid.slice(0, 8))).toEqual([BASIC_TURN1]);
    expect(h.store.listSessions("Mac-Mini")[0]).toMatchObject({ sessionId: SID, projectKey: "Pantheon", reachable: true, paneId: "%9", transcriptOffset: BASIC_TURN1_END, endedAt: null });
    h.clock.now += 5000;
    await h.poller.tick();
    const cards = h.store.listCards({});
    expect(cards.map((c) => c.turnUuid.slice(0, 8)).sort()).toEqual([BASIC_TURN1, BASIC_TURN2].sort());
    expect(cards.every((c) => c.projectKey === "Pantheon" && !c.needsYou)).toBe(true);
    const row = h.store.listSessions("Mac-Mini")[0];
    expect(row).toMatchObject({ sessionId: SID, projectKey: "Pantheon", reachable: true, paneId: "%9", transcriptOffset: BASIC.length, endedAt: iso(T0 + 5000) });
  });

  it("a session that reappears after being marked ended is live again and continues from its offset", async () => {
    const m = fakeMachine({ sessions: [live()], panes: [PANTHEON_PANE], transcripts: new Map([[SID, BASIC]]) });
    const h = harness([machine("Mac-Mini")], { "Mac-Mini": m });
    await h.poller.tick();
    m.sessions = [];
    h.clock.now += 5000;
    await h.poller.tick();
    expect(h.store.listSessions("Mac-Mini")[0]?.endedAt).toBeNull(); // one missing tick is not an end (final review I3)
    h.clock.now += 5000;
    await h.poller.tick();
    expect(h.store.listSessions("Mac-Mini")[0]?.endedAt).not.toBeNull();
    const grown = Buffer.concat([BASIC, Buffer.from(turnLines(5))]);
    m.transcripts.set(SID, grown);
    m.sessions = [live()];
    h.clock.now += 5000;
    await h.poller.tick();
    // The ended row is not in the main probe; the live file brings it back on the catch-up from its stored offset.
    expect(h.asks.at(-1)?.slices).toEqual([{ sessionId: SID, offset: BASIC.length }]);
    const row = h.store.listSessions("Mac-Mini")[0];
    expect(row?.endedAt).toBeNull();
    expect(row?.transcriptOffset).toBe(grown.length);
    expect(h.store.listCards({}).map((c) => c.turnUuid.slice(0, 8)).sort()).toEqual([BASIC_TURN1, BASIC_TURN2, "a-5"].sort());
  });

  it("a catch-up failure after an ok probe keeps what was read and labels the machine", async () => {
    const transcript = Buffer.from(Array.from({ length: 300 }, (_, i) => turnLines(i, `Reply ${i}.\n\n**TL;DR:** done ${i}`, 800)).join(""));
    const store = new SqliteConsoleStore(":memory:");
    store.upsertSession(seedRow(), iso(T0 - 5000));
    const m = fakeMachine({ sessions: [live()], panes: [PANTHEON_PANE], transcripts: new Map([[SID, transcript]]) });
    let calls = 0;
    const exec = vi.fn<RemoteExec>(async (_t, _h, command) => {
      calls++;
      if (calls === 2) throw new SshConnectionError("connect timed out");
      return { code: 0, stdout: respond(m, command), stderr: "" };
    });
    const h = harness([machine("Mac-Mini")], { "Mac-Mini": m }, { store, exec });
    await h.poller.tick();
    expect(exec).toHaveBeenCalledTimes(2);
    const health = h.poller.health()[0];
    expect(health?.state).toBe("unreachable");
    expect(health?.lastOkAt).toBe(iso(T0));
    const cards = h.store.listCards({}, 1000).length;
    expect(cards).toBeGreaterThan(0);
    expect(cards).toBeLessThan(300);
    const row = h.store.listSessions("Mac-Mini")[0];
    expect(row?.transcriptOffset).toBeGreaterThan(0);
    expect(row?.transcriptOffset).toBeLessThan(transcript.length);
    expect(row?.endedAt).toBeNull();
  });
});

describe("createConsolePoller — sessions, needs-you and health", () => {
  it("a session no longer reported alive is marked ended", async () => {
    const m = fakeMachine({ sessions: [live(), live({ sessionId: SID2, tmux: "Other:@2.%2" })], transcripts: new Map([[SID, BASIC]]) });
    const h = harness([machine("Mac-Mini")], { "Mac-Mini": m });
    await h.poller.tick();
    expect(h.store.listSessions("Mac-Mini").every((r) => r.endedAt === null)).toBe(true);

    m.sessions = [live({ alive: false }), live({ sessionId: SID2, tmux: "Other:@2.%2" })];
    h.clock.now += 5000;
    await h.poller.tick();
    const rows = new Map(h.store.listSessions("Mac-Mini").map((r) => [r.sessionId, r]));
    expect(rows.get(SID)?.endedAt).toBe(iso(T0 + 5000));
    expect(rows.get(SID2)?.endedAt).toBeNull();

    // SID2's file is missing: ended on the second tick in a row without it (final review I3); a dead pid ends at once.
    m.sessions = [];
    h.clock.now += 5000;
    await h.poller.tick();
    expect(h.store.listSessions("Mac-Mini").find((r) => r.sessionId === SID2)?.endedAt).toBeNull();
    h.clock.now += 5000;
    await h.poller.tick();
    expect(h.store.listSessions("Mac-Mini").find((r) => r.sessionId === SID2)?.endedAt).toBe(iso(T0 + 15_000));
    // Ended stays ended (never resurrected by an upsert) and the cards remain; the dead session's open
    // final turn was closed and carded when it died (ruling: a gone process gains no bytes).
    expect(h.store.listSessions("Mac-Mini").find((r) => r.sessionId === SID)?.endedAt).toBe(iso(T0 + 5000));
    expect(h.store.listCards({}).map((c) => c.turnUuid.slice(0, 8)).sort()).toEqual([BASIC_TURN1, BASIC_TURN2].sort());
  });

  it("only the latest face carries needsYou and the card kind; the session is NEEDS YOU", async () => {
    const transcript = Buffer.concat([BASIC, Buffer.from(turnLines(3))]);
    const m = fakeMachine({
      sessions: [live({ status: "waiting", waitingFor: "permission prompt" })],
      panes: [PANTHEON_PANE],
      transcripts: new Map([[SID, transcript]]),
      tails: new Map([["%9", fixture("pane-permission-prompt.txt").toString("utf8")]]),
      sentinels: new Map([[SID, fixture("sentinel-schema2.json").toString("utf8")]])
    });
    const h = harness([machine("Mac-Mini")], { "Mac-Mini": m });
    await h.poller.tick();
    const cards = new Map(h.store.listCards({}).map((c) => [c.turnUuid.slice(0, 8), c]));
    expect(cards.size).toBe(3);
    const latest = cards.get("a-3");
    expect(latest?.needsYou).toBe(true);
    expect(latest?.needsKind).toBe("waiting");
    expect(latest?.kind).toBe("commit_approval");
    for (const k of [BASIC_TURN1, BASIC_TURN2]) {
      expect(cards.get(k)?.needsYou).toBe(false);
      expect(cards.get(k)?.needsKind).toBeNull();
      expect(cards.get(k)?.kind).toBe("reply");
    }
    const row = h.store.listSessions("Mac-Mini")[0];
    expect(row?.state).toBe("needs_you");
    expect(row?.stateReason).toBe("permission prompt");
    expect(row?.waitingFor).toBe("permission prompt");
  });

  it("a malformed sentinel is a health problem, not a failure", async () => {
    const m = fakeMachine({ sessions: [live()], panes: [PANTHEON_PANE], transcripts: new Map([[SID, BASIC]]), sentinels: new Map([[SID, "{not json"]]) });
    const h = harness([machine("Mac-Mini")], { "Mac-Mini": m });
    await h.poller.tick();
    const health = h.poller.health()[0];
    expect(health?.state).toBe("ok");
    expect(health?.problems).toEqual([`session ${SID.slice(0, 8)}: sentinel: invalid JSON`]);
    await h.poller.tick();
    expect(h.poller.health()[0]?.problems).toHaveLength(1);
  });

  it("an sh-* tmux session is never a project key", async () => {
    const m = fakeMachine({ sessions: [live({ tmux: "sh-1:@4.%4" })], panes: [{ session: "sh-1", paneId: "%4" }], transcripts: new Map([[SID, BASIC]]) });
    const h = harness([machine("Mac-Mini")], { "Mac-Mini": m });
    await h.poller.tick();
    const row = h.store.listSessions("Mac-Mini")[0];
    expect(row?.projectKey).toBe("pantheon-harness@Mac-Mini");
    expect(row?.reachable).toBe(false);
    // Real values are kept; only reachability says the console must not target it.
    expect(row?.tmuxSession).toBe("sh-1");
    expect(row?.paneId).toBe("%4");
    expect(h.store.listCards({})[0]?.projectKey).toBe("pantheon-harness@Mac-Mini");
  });

  it("a session whose pane was not probed is unreachable and keeps the tmux field's values", async () => {
    const m = fakeMachine({ sessions: [live({ tmux: "Other:@2.%2" })], panes: [PANTHEON_PANE], transcripts: new Map([[SID, BASIC]]) });
    const h = harness([machine("Mac-Mini")], { "Mac-Mini": m });
    await h.poller.tick();
    const row = h.store.listSessions("Mac-Mini")[0];
    expect(row).toMatchObject({ projectKey: "pantheon-harness@Mac-Mini", reachable: false, tmuxSession: "Other", paneId: "%2" });
  });

  it("needs-you flags are cleared from the cards when the signals go away", async () => {
    const m = fakeMachine({
      sessions: [live({ status: "waiting", waitingFor: "permission prompt" })],
      panes: [PANTHEON_PANE],
      // A reply that asks nothing (BASIC's replies raise a reply question, which stays by design).
      transcripts: new Map([[SID, Buffer.from(turnLines(1))]])
    });
    const h = harness([machine("Mac-Mini")], { "Mac-Mini": m });
    await h.poller.tick();
    expect(h.store.listCards({ needsYouOnly: true })).toHaveLength(1);
    m.sessions = [live({ status: "busy" })];
    h.clock.now += 5000;
    await h.poller.tick();
    expect(h.store.listCards({ needsYouOnly: true })).toEqual([]);
    expect(h.store.listSessions("Mac-Mini")[0]?.state).toBe("working");
  });

  it("a newer face takes the needs-you flag and the older latest card loses it", async () => {
    const m = fakeMachine({
      sessions: [live({ status: "waiting", waitingFor: "permission prompt" })],
      panes: [PANTHEON_PANE],
      transcripts: new Map([[SID, Buffer.concat([BASIC, Buffer.from(turnLines(3))])]])
    });
    const h = harness([machine("Mac-Mini")], { "Mac-Mini": m });
    await h.poller.tick();
    expect(h.store.listCards({ needsYouOnly: true }).map((c) => c.turnUuid)).toEqual(["a-3"]);
    m.transcripts.set(SID, Buffer.concat([BASIC, Buffer.from(turnLines(3)), Buffer.from(turnLines(4))]));
    h.clock.now += 5000;
    await h.poller.tick();
    expect(h.store.listCards({ needsYouOnly: true }).map((c) => c.turnUuid)).toEqual(["a-4"]);
  });

  it("signals that appear with no new face flag the session's latest stored card", async () => {
    // A reply that asks nothing (BASIC's replies say "Waiting on Karl", which F2 raises as a reply question).
    const m = fakeMachine({ sessions: [live({ status: "busy" })], panes: [PANTHEON_PANE], transcripts: new Map([[SID, Buffer.from(turnLines(1))]]) });
    const h = harness([machine("Mac-Mini")], { "Mac-Mini": m });
    await h.poller.tick();
    expect(h.store.listCards({ needsYouOnly: true })).toEqual([]);
    m.tails.set("%9", fixture("pane-permission-prompt.txt").toString("utf8"));
    h.clock.now += 5000;
    await h.poller.tick();
    const flagged = h.store.listCards({ needsYouOnly: true });
    expect(flagged.map((c) => c.turnUuid)).toEqual(["a-1"]);
    expect(flagged[0]?.needsKind).toBe("menu_on_screen");
    expect(flagged[0]?.kind).toBe("menu");
    const version = flagged[0]?.version;
    // Unchanged signals on the next tick do not rewrite the card.
    h.clock.now += 5000;
    await h.poller.tick();
    expect(h.store.listCards({ needsYouOnly: true })[0]?.version).toBe(version);
    // The menu goes away: flags cleared and the kind is back to a plain reply.
    m.tails.set("%9", "");
    h.clock.now += 5000;
    await h.poller.tick();
    expect(h.store.listCards({ needsYouOnly: true })).toEqual([]);
    expect(h.store.listCards({})[0]?.kind).toBe("reply");
  });

  it("an empty status is UNKNOWN, never idle", async () => {
    const m = fakeMachine({ sessions: [live({ status: undefined })], panes: [PANTHEON_PANE], transcripts: new Map([[SID, Buffer.from(turnLines(1))]]) });
    const h = harness([machine("Mac-Mini")], { "Mac-Mini": m });
    await h.poller.tick();
    expect(h.store.listSessions("Mac-Mini")[0]?.state).toBe("unknown");
  });

  it("ignoredLines counts the main probe's foreign lines plus the tick's transcript lines", async () => {
    const m = fakeMachine({ sessions: [live()], panes: [PANTHEON_PANE], transcripts: new Map([[SID, BASIC]]) });
    const h = harness([machine("Mac-Mini")], { "Mac-Mini": m });
    await h.poller.tick();
    // The main probe's banner line (the catch-up's repeat is not counted) plus the consumed transcript lines.
    expect(h.poller.health()[0]?.ignoredLines).toBe(1 + splitTurns(BASIC, 0).ignoredLines);
    h.clock.now += 5000;
    await h.poller.tick();
    // One probe, one banner line; the open turn was not consumed, so no transcript lines counted.
    expect(h.poller.health()[0]?.ignoredLines).toBe(1);
  });

  it("a store error is logged and counted, never thrown out of tick", async () => {
    class BrokenStore extends SqliteConsoleStore {
      override upsertCard(): never {
        throw new Error("disk I/O error");
      }
    }
    const m = fakeMachine({ sessions: [live()], panes: [PANTHEON_PANE], transcripts: new Map([[SID, BASIC]]) });
    const h = harness([machine("Mac-Mini")], { "Mac-Mini": m }, { store: new BrokenStore(":memory:") });
    await expect(h.poller.tick()).resolves.toBeUndefined();
    const health = h.poller.health()[0];
    expect(health?.state).toBe("failed");
    expect(health?.message).toBe("console store access failed for Mac-Mini");
    expect(health?.storeErrors).toBe(1);
    expect(h.poller.storeErrors()).toBe(1);
    expect(h.logs).toHaveLength(1);
    expect(h.logs[0]?.level).toBe("error");
    expect(h.logs[0]?.msg).toBe("console store access failed");
    expect(h.logs[0]?.obj).toMatchObject({ event: "console.store_access_failed", machine: "Mac-Mini", detail: "disk I/O error", at: iso(T0) });
    expect(h.logs[0]?.obj?.["correlationId"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("without a logger, a store error is one JSON line on stderr", async () => {
    class BrokenStore extends SqliteConsoleStore {
      override upsertSession(): never {
        throw new Error("disk full");
      }
    }
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const m = fakeMachine({ sessions: [live()], panes: [PANTHEON_PANE], transcripts: new Map([[SID, BASIC]]) });
      const h = harness([machine("Mac-Mini")], { "Mac-Mini": m }, { store: new BrokenStore(":memory:"), log: undefined });
      await h.poller.tick();
      expect(write).toHaveBeenCalledTimes(1);
      const line = String(write.mock.calls[0]?.[0]);
      expect(line.endsWith("\n")).toBe(true);
      expect(JSON.parse(line)).toMatchObject({ level: "error", msg: "console store access failed", event: "console.store_access_failed", machine: "Mac-Mini", detail: "disk full", at: iso(T0) });
    } finally {
      write.mockRestore();
    }
  });

  it("a logger that throws falls back to the stderr line and tick still resolves", async () => {
    class BrokenStore extends SqliteConsoleStore {
      override upsertSession(): never {
        throw new Error("disk full");
      }
    }
    const boom = (): never => {
      throw new Error("logger down");
    };
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const m = fakeMachine({ sessions: [live()], panes: [PANTHEON_PANE], transcripts: new Map([[SID, BASIC]]) });
      const h = harness([machine("Mac-Mini")], { "Mac-Mini": m }, { store: new BrokenStore(":memory:"), log: { info: boom, warn: boom, error: boom } });
      await expect(h.poller.tick()).resolves.toBeUndefined();
      expect(write).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(write.mock.calls[0]?.[0]))).toMatchObject({ level: "error", event: "console.store_access_failed", loggerFailed: true });
    } finally {
      write.mockRestore();
    }
  });

  it("a failed purge is logged and counted in storeErrors()", async () => {
    class NoPurge extends SqliteConsoleStore {
      override purgeExpired(): never {
        throw new Error("database is locked");
      }
    }
    const h = harness([machine("Mac-Mini")], { "Mac-Mini": fakeMachine() }, { store: new NoPurge(":memory:") });
    await h.poller.tick();
    expect(h.poller.storeErrors()).toBe(1);
    expect(h.logs.map((l) => l.obj?.["event"])).toEqual(["console.purge_failed"]);
    expect(h.poller.health()[0]?.state).toBe("ok");
  });

  it("a hung machine is skipped (and counted) while the others keep being polled; it shows pending until its first result", async () => {
    const a = fakeMachine();
    const b = fakeMachine();
    let release: (r: RemoteCommandResult) => void = () => undefined;
    const exec = vi.fn<RemoteExec>(async (target, _h, command) => {
      if (target.logicalName === "A") return new Promise<RemoteCommandResult>((res) => (release = res));
      return { code: 0, stdout: respond(b, command), stderr: "" };
    });
    const h = harness([machine("A"), machine("B")], { A: a, B: b }, { exec });
    const first = h.poller.tick();
    await vi.waitFor(() => expect(h.poller.health().find((x) => x.machine === "B")?.state).toBe("ok"));
    expect(h.poller.health().find((x) => x.machine === "A")).toMatchObject({ state: "pending", message: "no data yet" });
    h.clock.now += 5000;
    await h.poller.tick();
    h.clock.now += 5000;
    await h.poller.tick();
    expect(exec.mock.calls.filter((c) => c[0].logicalName === "A")).toHaveLength(1);
    expect(exec.mock.calls.filter((c) => c[0].logicalName === "B")).toHaveLength(3);
    expect(h.poller.skippedTicks()).toBe(2);
    expect(h.poller.health().find((x) => x.machine === "A")?.skippedTicks).toBe(2);
    expect(h.poller.health().find((x) => x.machine === "B")).toMatchObject({ state: "ok", skippedTicks: 0 });
    release({ code: 0, stdout: `${S}end\n`, stderr: "" });
    await first;
    expect(h.poller.health().find((x) => x.machine === "A")?.state).toBe("ok");
  });

  it("purgeExpired runs after a successful tick and then at most once per hour", async () => {
    const store = new SqliteConsoleStore(":memory:");
    const purge = vi.spyOn(store, "purgeExpired");
    const h = harness([machine("Mac-Mini")], { "Mac-Mini": fakeMachine() }, { store });
    await h.poller.tick();
    expect(purge).toHaveBeenCalledTimes(1);
    expect(purge).toHaveBeenLastCalledWith(iso(T0));
    h.clock.now += 30 * 60_000;
    await h.poller.tick();
    expect(purge).toHaveBeenCalledTimes(1);
    h.clock.now += 30 * 60_000;
    await h.poller.tick();
    expect(purge).toHaveBeenCalledTimes(2);
  });
});

describe("createConsolePoller — scheduling", () => {
  it("start schedules a timer and stop clears it (unref called)", async () => {
    const unref = vi.fn();
    const handle = { unref };
    let fire: () => void = () => undefined;
    const setTimer = vi.fn((fn: () => void, _ms: number) => {
      fire = fn;
      return handle;
    });
    const clearTimer = vi.fn();
    const h = harness([machine("Mac-Mini")], { "Mac-Mini": fakeMachine() }, { setTimer, clearTimer });
    h.poller.start();
    expect(setTimer).toHaveBeenCalledTimes(1);
    expect(setTimer.mock.calls[0]?.[1]).toBe(DEFAULT_CONSOLE_SETTINGS.pollSeconds * 1000);
    expect(unref).toHaveBeenCalledTimes(1);
    h.poller.start();
    expect(setTimer).toHaveBeenCalledTimes(1);
    fire();
    await vi.waitFor(() => expect(h.exec).toHaveBeenCalledTimes(1));
    await h.poller.stop();
    expect(clearTimer).toHaveBeenCalledWith(handle);
    await h.poller.stop();
    expect(clearTimer).toHaveBeenCalledTimes(1);
  });

  it("stop resolves only after the in-flight tick settles, and no tick runs after it", async () => {
    let release: (r: RemoteCommandResult) => void = () => undefined;
    const exec = vi.fn<RemoteExec>(() => new Promise<RemoteCommandResult>((res) => (release = res)));
    let fire: () => void = () => undefined;
    const setTimer = (fn: () => void): { unref?: () => void } => {
      fire = fn;
      return {};
    };
    const h = harness([machine("Mac-Mini")], {}, { exec, setTimer, clearTimer: () => undefined });
    h.poller.start();
    fire();
    expect(exec).toHaveBeenCalledTimes(1);
    let stopped = false;
    const done = h.poller.stop().then(() => {
      stopped = true;
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(stopped).toBe(false);
    release({ code: 0, stdout: `${S}end\n`, stderr: "" });
    await done;
    expect(stopped).toBe(true);
    expect(h.poller.health()[0]?.state).toBe("ok");
    fire();
    await new Promise((r) => setTimeout(r, 10));
    expect(exec).toHaveBeenCalledTimes(1);
  });
});

/**
 * Final review M1: what one poll leaves where a person can see it — the store's session rows, the state API's JSON
 * (the real route) and the page the console client renders from that JSON (text and markup, scripts removed).
 */
async function surfaces(h: Harness, machines: DevMachine[]): Promise<{ readonly rows: string; readonly payload: string; readonly page: string }> {
  const app = Fastify();
  registerConsoleRoutes(app, {
    registry: registryOf(machines),
    store: h.store,
    poller: h.poller,
    settings: { ok: true, settings: DEFAULT_CONSOLE_SETTINGS },
    exec: async () => {
      throw new Error("test: no expand");
    },
    mask: maskSecrets,
    loginEnabled: false,
    stepUp: new StepUpWindow()
  });
  const res = await app.inject({ method: "GET", url: "/console/api/state" });
  await app.close();
  const dom = new JSDOM(renderConsolePage({ base: "", loginEnabled: false }), { runScripts: "outside-only" });
  const w = dom.window as unknown as { fetch: unknown; eval(js: string): unknown; __console: { refresh(): Promise<void>; stop(): void }; document: Document };
  w.fetch = async () => ({ ok: true, status: 200, json: async () => JSON.parse(res.body) as unknown });
  w.eval(CONSOLE_CLIENT_JS);
  await w.__console.refresh();
  w.__console.stop();
  for (const script of Array.from(w.document.querySelectorAll("script"))) script.remove();
  const page = `${w.document.body.textContent ?? ""}\n${w.document.body.innerHTML}`;
  dom.window.close();
  return { rows: JSON.stringify(h.store.listSessions()), payload: res.body, page };
}

function expectNowhere(found: { readonly rows: string; readonly payload: string; readonly page: string }, fragment: string): void {
  expect(found.rows, "store rows").not.toContain(fragment);
  expect(found.payload, "state API").not.toContain(fragment);
  expect(found.page, "page").not.toContain(fragment);
}

describe("createConsolePoller — final review fixes", () => {
  it("M5: a slice record with an offset beyond the builder's bound is dropped and the next tick still dials", async () => {
    const m = fakeMachine({ sessions: [live()], panes: [PANTHEON_PANE], transcripts: new Map([[SID, BASIC]]) });
    let hostile = true;
    const exec = vi.fn<RemoteExec>(async (_t, _h, command) => {
      const out = respond(m, command);
      return { code: 0, stdout: hostile ? out.replace(/^(PANTHEON_PROBE:slice:[0-9a-f-]{36}):\d+:/gm, "$1:9999999999999:") : out, stderr: "" };
    });
    const h = harness([machine("Mac-Mini")], { "Mac-Mini": m }, { exec });
    await h.poller.tick();
    expect(exec).toHaveBeenCalledTimes(2); // the main probe, then the catch-up for the new session
    expect(h.store.listSessions("Mac-Mini")[0]?.transcriptOffset).toBe(0);
    expect(h.store.listCards({})).toEqual([]);
    h.clock.now += 5000;
    await h.poller.tick();
    expect(exec).toHaveBeenCalledTimes(3); // dialled again: the plan was not refused
    expect(h.poller.health()[0]).toMatchObject({ state: "ok" });
    hostile = false;
    h.clock.now += 5000;
    await h.poller.tick();
    expect(h.store.listSessions("Mac-Mini")[0]?.transcriptOffset).toBe(BASIC_TURN1_END);
    expect(h.store.listCards({}).map((c) => c.turnUuid.slice(0, 8))).toEqual([BASIC_TURN1]);
  });

  it("M1(a): a status is masked, then clipped to 40, before it is stored; the page's UNKNOWN STATUS shows that stored value", async () => {
    const token = "ghp_" + "Z".repeat(36);
    const m = fakeMachine({ sessions: [live({ status: "x".repeat(30) + token })], panes: [PANTHEON_PANE], transcripts: new Map([[SID, Buffer.from(turnLines(1))]]) });
    const h = harness([machine("Mac-Mini")], { "Mac-Mini": m });
    await h.poller.tick();
    const row = h.store.listSessions("Mac-Mini")[0];
    expect(row?.state).toBe("unknown");
    expect(row?.status).toBe("x".repeat(30) + "[masked]");
    const found = await surfaces(h, [machine("Mac-Mini")]);
    expectNowhere(found, "ghp_");
    expect(found.page).toContain("? UNKNOWN STATUS " + "x".repeat(30) + "[masked]");
  });

  it("M1(b): procStart is masked before it is stored, and the state API carries neither procStart nor waitingFor", async () => {
    const token = "ghp_" + "P".repeat(36);
    const m = fakeMachine({
      sessions: [live({ status: "waiting", waitingFor: "permission prompt", procStart: token })],
      panes: [PANTHEON_PANE],
      transcripts: new Map([[SID, BASIC]])
    });
    const h = harness([machine("Mac-Mini")], { "Mac-Mini": m });
    await h.poller.tick();
    expect(h.store.listSessions("Mac-Mini")[0]?.procStart).toBe("[masked]");
    const found = await surfaces(h, [machine("Mac-Mini")]);
    expectNowhere(found, "ghp_");
    const session = (JSON.parse(found.payload) as { sessions: Record<string, unknown>[] }).sessions[0] ?? {};
    expect(Object.keys(session)).not.toContain("procStart");
    expect(Object.keys(session)).not.toContain("waitingFor");
    // The (masked) waitingFor still reaches the page, as the session's reason.
    expect(session["stateReason"]).toBe("permission prompt");
    expect(found.page).toContain("waiting for: permission prompt");
  });

  it("M1(c): waitingFor and cwd reach the poller whole and are masked, then clipped to 512 — a token across the old 512 cut never shows", async () => {
    const token = "ghp_" + "W".repeat(36);
    const waitingFor = "w".repeat(500) + " " + token; // the token starts at 501: the old probe clip cut it to ghp_ + 7
    const cwd = "/" + "d".repeat(490) + "/" + token; // the basename (the project key of a session with no pane) starts at 492
    const m = fakeMachine({ sessions: [live({ status: "waiting", waitingFor, cwd, tmux: undefined })], transcripts: new Map([[SID, BASIC]]) });
    const h = harness([machine("Mac-Mini")], { "Mac-Mini": m });
    await h.poller.tick();
    const row = h.store.listSessions("Mac-Mini")[0];
    expect(row?.waitingFor).toBe("w".repeat(500) + " [masked]");
    expect(row?.cwd).toBe("/" + "d".repeat(490) + "/[masked]");
    expect(row?.projectKey).toBe("[masked]@Mac-Mini");
    expect(h.store.listCards({}).map((c) => c.projectKey)).toEqual(["[masked]@Mac-Mini"]);
    expectNowhere(await surfaces(h, [machine("Mac-Mini")]), "ghp_");
  });

  it("M1(d): the machine's stderr line is masked, then clipped to 140, before it reaches health — a token across the old 140 cut never shows", async () => {
    const token = "ghp_" + "E".repeat(36);
    const exec = vi.fn<RemoteExec>(async () => ({ code: 1, stdout: "", stderr: `${"e".repeat(130)}${token} (from ~/.zshenv)\nsecond line\n` }));
    const h = harness([machine("Mac-Mini")], {}, { exec });
    await h.poller.tick();
    const health = h.poller.health()[0];
    expect(health?.state).toBe("failed");
    expect(health?.remoteDetail).toBe(`${"e".repeat(130)}[masked] (from ~/.zshenv)`.slice(0, 140));
    const found = await surfaces(h, [machine("Mac-Mini")]);
    expectNowhere(found, "ghp_");
    expect(found.page).toContain(`machine said: "${"e".repeat(130)}[masked] (`);
  });

  it("I3: a session file whose sessionId key was renamed (a format change) is CAN'T READ — nothing ends and no open turn is carded", async () => {
    const m = fakeMachine({ sessions: [live({ status: "busy" })], panes: [PANTHEON_PANE], transcripts: new Map([[SID, BASIC]]) });
    const h = harness([machine("Mac-Mini")], { "Mac-Mini": m });
    await h.poller.tick();
    expect(h.store.listCards({}).map((c) => c.turnUuid.slice(0, 8))).toEqual([BASIC_TURN1]);
    m.sessions = [live({ status: "busy", idKey: "session_id" })];
    for (let i = 1; i <= 3; i++) {
      h.clock.now += 5000;
      await h.poller.tick();
      const health = h.poller.health()[0];
      expect(health?.state, `tick ${i}`).toBe("cant_read");
      expect(health?.message).toBe("session file format not recognised (1 file)");
      expect(health?.problems.filter((p) => p.startsWith("session file format not recognised"))).toHaveLength(1);
      const rows = h.store.listSessions("Mac-Mini");
      expect(rows).toHaveLength(1);
      expect(rows[0]?.endedAt, `tick ${i}`).toBeNull();
      expect(rows[0]?.transcriptOffset).toBe(BASIC_TURN1_END);
      // the in-progress turn (prompt + narration, no terminator) is not carded as finished
      expect(h.store.listCards({}).map((c) => c.turnUuid.slice(0, 8))).toEqual([BASIC_TURN1]);
    }
    // The format is read again: health is ok and the session was never ended.
    m.sessions = [live({ status: "busy" })];
    h.clock.now += 5000;
    await h.poller.tick();
    expect(h.poller.health()[0]?.state).toBe("ok");
    expect(h.store.listSessions("Mac-Mini")[0]?.endedAt).toBeNull();
    expect(h.store.listCards({})).toHaveLength(1);
  });

  it("I3 (ruling): a pid written as a JSON string (a future format) is CAN'T READ, not a dead session that ends", async () => {
    const m = fakeMachine({ sessions: [live({ status: "busy" })], panes: [PANTHEON_PANE], transcripts: new Map([[SID, BASIC]]) });
    const h = harness([machine("Mac-Mini")], { "Mac-Mini": m });
    await h.poller.tick();
    // The machine's liveness check reads a bare-number pid only, so a quoted pid comes back with alive 0.
    m.sessions = [live({ status: "busy", pidRaw: '"4242"', alive: false })];
    h.clock.now += 5000;
    await h.poller.tick();
    const health = h.poller.health()[0];
    expect(health?.state).toBe("cant_read");
    expect(health?.message).toBe("session file format not recognised (1 file)");
    const rows = h.store.listSessions("Mac-Mini");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.endedAt).toBeNull();
    expect(rows[0]?.transcriptOffset).toBe(BASIC_TURN1_END);
    expect(h.store.listCards({}).map((c) => c.turnUuid.slice(0, 8))).toEqual([BASIC_TURN1]);
  });

  it("I3: a session whose file is missing for one tick and back the next is not ended, and its open turn is not carded early", async () => {
    const m = fakeMachine({ sessions: [live({ status: "busy" })], panes: [PANTHEON_PANE], transcripts: new Map([[SID, BASIC]]) });
    const h = harness([machine("Mac-Mini")], { "Mac-Mini": m });
    await h.poller.tick();
    // Twice: the count of missing ticks starts again once the file is back.
    for (let round = 1; round <= 2; round++) {
      m.sessions = []; // e.g. sessions/<pid>.json caught mid-rewrite
      h.clock.now += 5000;
      await h.poller.tick();
      let row = h.store.listSessions("Mac-Mini")[0];
      expect(row?.endedAt, `round ${round}, missing`).toBeNull();
      expect(row?.transcriptOffset).toBe(BASIC_TURN1_END);
      expect(h.store.listCards({}).map((c) => c.turnUuid.slice(0, 8))).toEqual([BASIC_TURN1]);
      m.sessions = [live({ status: "busy" })];
      h.clock.now += 5000;
      await h.poller.tick();
      row = h.store.listSessions("Mac-Mini")[0];
      expect(row?.endedAt, `round ${round}, back`).toBeNull();
      expect(h.store.listCards({})).toHaveLength(1);
    }
    expect(h.poller.health()[0]?.state).toBe("ok");
  });

  it("I3: a session whose file is missing on two ticks in a row is ended on the second, its final turn read then", async () => {
    const m = fakeMachine({ sessions: [live({ status: "busy" })], panes: [PANTHEON_PANE], transcripts: new Map([[SID, BASIC]]) });
    const h = harness([machine("Mac-Mini")], { "Mac-Mini": m });
    await h.poller.tick();
    m.sessions = [];
    h.clock.now += 5000;
    await h.poller.tick();
    expect(h.store.listSessions("Mac-Mini")[0]?.endedAt).toBeNull();
    expect(h.store.listCards({})).toHaveLength(1);
    h.clock.now += 5000;
    await h.poller.tick();
    const row = h.store.listSessions("Mac-Mini")[0];
    expect(row?.endedAt).toBe(iso(T0 + 10_000));
    expect(row?.transcriptOffset).toBe(BASIC.length);
    expect(h.store.listCards({}).map((c) => c.turnUuid.slice(0, 8)).sort()).toEqual([BASIC_TURN1, BASIC_TURN2].sort());
    const versions = h.store.listCards({}).map((c) => c.version);
    h.clock.now += 5000;
    await h.poller.tick();
    expect(h.store.listCards({})).toHaveLength(2);
    expect(h.store.listCards({}).map((c) => c.version)).toEqual(versions);
  });
});

describe("createConsolePoller — reply-question flag and F1 carries (F2 Task 10)", () => {
  const ASKING = (i: number): string => turnLines(i, "Which way?\n\nA1: keep it\nA2: change it\n\n**TL;DR:** Waiting on you: reply A1 or A2.");
  const SCHEMA2 = fixture("sentinel-schema2.json").toString("utf8");
  const latestOf = (h: Harness): NonNullable<ReturnType<SqliteConsoleStore["latestCard"]>> => {
    const c = h.store.latestCard("Mac-Mini", SID);
    if (c === undefined) throw new Error("test: no card");
    return c;
  };
  const asking = (): { h: Harness; m: FakeMachine } => {
    const m = fakeMachine({ sessions: [live({ status: "idle" })], panes: [PANTHEON_PANE], transcripts: new Map([[SID, Buffer.from(ASKING(1))]]) });
    return { h: harness([machine("Mac-Mini")], { "Mac-Mini": m }), m };
  };
  const next = async (h: Harness): Promise<void> => {
    h.clock.now += 5000;
    await h.poller.tick();
  };

  it("a last reply that waits on Karl flags the latest card reply_question with its lettered ids; the session is NEEDS YOU", async () => {
    const { h } = asking();
    await h.poller.tick();
    const c = latestOf(h);
    expect(c).toMatchObject({ needsYou: true, needsKind: "reply_question", asksYou: true, options: ["A1", "A2"], kind: "reply", answeredAt: null, dismissedAt: null });
    expect(h.store.listSessions("Mac-Mini")[0]?.state).toBe("needs_you");
  });

  it("the flag is sticky: ticks with no new bytes keep it, without rewriting the card each time", async () => {
    const { h } = asking();
    await h.poller.tick();
    const v = latestOf(h).version;
    await next(h);
    await next(h);
    expect(latestOf(h)).toMatchObject({ needsYou: true, needsKind: "reply_question", asksYou: true, options: ["A1", "A2"], version: v });
    expect(h.store.listSessions("Mac-Mini")[0]?.state).toBe("needs_you");
  });

  it("markAnswered: the next tick does not flag the card again", async () => {
    const { h } = asking();
    await h.poller.tick();
    h.store.markAnswered(latestOf(h).id, iso(T0 + 1000));
    await next(h);
    expect(latestOf(h)).toMatchObject({ needsYou: false, asksYou: true, options: ["A1", "A2"] });
    expect(latestOf(h).answeredAt).not.toBeNull();
    expect(h.store.listSessions("Mac-Mini")[0]?.state).not.toBe("needs_you");
  });

  it("markDismissed: the next ticks do not flag the card again", async () => {
    const { h } = asking();
    await h.poller.tick();
    h.store.markDismissed(latestOf(h).id, iso(T0 + 1000));
    await next(h);
    await next(h);
    expect(latestOf(h).needsYou).toBe(false);
    expect(latestOf(h).dismissedAt).not.toBeNull();
    expect(h.store.listSessions("Mac-Mini")[0]?.state).not.toBe("needs_you");
  });

  it("a stronger signal wins while present and reply_question returns when it disappears", async () => {
    const { h, m } = asking();
    await h.poller.tick();
    m.sentinels.set(SID, SCHEMA2);
    await next(h);
    expect(latestOf(h)).toMatchObject({ needsYou: true, needsKind: "sentinel", kind: "commit_approval", asksYou: true, options: ["A1", "A2"] });
    m.sentinels.delete(SID);
    await next(h);
    expect(latestOf(h)).toMatchObject({ needsYou: true, needsKind: "reply_question", kind: "reply", asksYou: true, options: ["A1", "A2"] });
  });

  it("T10-3: a non-commit sentinel with other ids: its ids are the options while up, asksYou stays, reply_question returns after", async () => {
    const other = JSON.stringify({
      schema: 2,
      question: "Pick one?",
      options: [
        { id: "B1", text: "first", approves: "none" },
        { id: "B2", text: "second", approves: "none" }
      ]
    });
    const { h, m } = asking();
    await h.poller.tick();
    expect(latestOf(h).options).toEqual(["A1", "A2"]);
    m.sentinels.set(SID, other);
    await next(h);
    expect(latestOf(h)).toMatchObject({ needsKind: "sentinel", asksYou: true, options: ["B1", "B2"] });
    m.sentinels.delete(SID);
    await next(h);
    // Residual (accepted): the sticky return keeps the stored ids, which are the sentinel's.
    expect(latestOf(h)).toMatchObject({ needsYou: true, needsKind: "reply_question", asksYou: true, options: ["B1", "B2"] });
    // A fresh card with the sentinel already up on its first tick: asksYou from the reply, ids from the sentinel.
    const m2 = fakeMachine({
      sessions: [live({ status: "idle" })],
      panes: [PANTHEON_PANE],
      transcripts: new Map([[SID, Buffer.from(ASKING(1))]]),
      sentinels: new Map([[SID, other]])
    });
    const h2 = harness([machine("Mac-Mini")], { "Mac-Mini": m2 });
    await h2.poller.tick();
    expect(latestOf(h2)).toMatchObject({ needsKind: "sentinel", asksYou: true, options: ["B1", "B2"] });
  });

  it("T10-3: a new non-asking card never keeps stale ids from the previous card", async () => {
    const { h, m } = asking();
    await h.poller.tick();
    m.transcripts.set(SID, Buffer.concat([Buffer.from(ASKING(1)), Buffer.from(turnLines(2))]));
    await next(h);
    expect(latestOf(h)).toMatchObject({ turnUuid: "a-2", asksYou: false, options: [] });
  });

  it("F1 carry, pid reuse: a procStart the mask alters still matches its own stored row (no spurious end)", async () => {
    const token = "ghp_" + "Q".repeat(36);
    const m = fakeMachine({ sessions: [live({ procStart: token })], panes: [PANTHEON_PANE], transcripts: new Map([[SID, BASIC]]) });
    const h = harness([machine("Mac-Mini")], { "Mac-Mini": m });
    await h.poller.tick();
    expect(h.store.listSessions("Mac-Mini")[0]?.procStart).toBe("[masked]");
    m.sessions = [live({ sessionId: SID2, tmux: "Other:@2.%2", procStart: token })];
    await next(h);
    expect(h.store.listSessions("Mac-Mini").find((r) => r.sessionId === SID)?.endedAt).toBeNull();
  });

  it("ruling T11-19 (I-2): a sent Submit through the real route answers a sentinel question — the card stays raised while the sentinel is up; once CDF removes it, the next tick leaves the card and the session out of NEEDS YOU", async () => {
    const { h, m } = asking();
    m.sentinels.set(SID, SCHEMA2);
    await h.poller.tick();
    const card = latestOf(h);
    expect(card).toMatchObject({ needsYou: true, needsKind: "sentinel", asksYou: true });
    // The Submit route over the poller's own store; the machine's delivery script reports `sent`.
    const sessions = new SessionStore();
    const sid = sessions.create();
    const stepUp = new StepUpWindow();
    stepUp.elevate(sid);
    const app = Fastify();
    registerConsoleRoutes(app, {
      registry: registryOf([machine("Mac-Mini")]),
      store: h.store,
      poller: h.poller,
      settings: { ok: true, settings: DEFAULT_CONSOLE_SETTINGS },
      exec: async () => ({ code: 0, stdout: `${DELIVER_SENTINEL}result:sent:idle:${"0".repeat(16)}:${"1".repeat(16)}:\n`, stderr: "" }),
      mask: maskSecrets,
      loginEnabled: true,
      stepUp,
      sessions,
      operatorPassword: "unused here",
      log: fakeLogger([])
    });
    const res = await app.inject({ method: "POST", url: `/console/api/cards/${card.id}/submit`, headers: { cookie: `pantheon_session=${sid}` }, payload: { text: "A1", key: randomUUID() } });
    await app.close();
    expect(res.json()).toMatchObject({ outcome: "sent" });
    // While the sentinel is up the card keeps its flag: a sentinel leaves when its file does.
    expect(latestOf(h)).toMatchObject({ needsYou: true, needsKind: "sentinel", answeredAt: expect.any(String) as string });
    m.sentinels.delete(SID);
    await next(h);
    expect(latestOf(h).needsYou).toBe(false);
    expect(h.store.listSessions("Mac-Mini")[0]?.state).not.toBe("needs_you");
    await next(h);
    expect(latestOf(h).needsYou).toBe(false);
  });

  it("triage 2 (DI-5): a sentinel in a folder two live sessions share gives neither card send buttons (options []) — the needs-you flag stays; one session in the folder keeps the ids", async () => {
    const OTHER_PANE = { session: "Other", paneId: "%2" } as const;
    const both = (cwd2: string): FakeMachine =>
      fakeMachine({
        sessions: [live({ status: "idle" }), live({ sessionId: SID2, status: "idle", tmux: "Other:@2.%2", pid: 4343, cwd: cwd2 })],
        panes: [PANTHEON_PANE, OTHER_PANE],
        transcripts: new Map([
          [SID, Buffer.from(turnLines(1))],
          [SID2, Buffer.from(turnLines(2))]
        ]),
        // The probe reads `<cwd>/.claude/pending-approval.json` for every session, so a shared folder reports it twice.
        sentinels: new Map([
          [SID, SCHEMA2],
          [SID2, SCHEMA2]
        ])
      });
    const shared = harness([machine("Mac-Mini")], { "Mac-Mini": both(CWD) });
    await shared.poller.tick();
    for (const sid of [SID, SID2]) {
      expect(shared.store.latestCard("Mac-Mini", sid), sid).toMatchObject({ needsYou: true, needsKind: "sentinel", options: [] });
    }
    expect(shared.store.listSessions("Mac-Mini").every((s) => s.state === "needs_you")).toBe(true);
    // Another folder for the second session: the sentinel is the first session's alone, and its ids are its buttons.
    const apart = both("/Users/karl/Documents/Claude Projects/Other");
    apart.sentinels.delete(SID2);
    const h = harness([machine("Mac-Mini")], { "Mac-Mini": apart });
    await h.poller.tick();
    expect(h.store.latestCard("Mac-Mini", SID)).toMatchObject({ needsYou: true, needsKind: "sentinel", options: ["A1", "A2"] });
  });

  it("a stronger signal does not bring a reply_question back once the card was answered", async () => {
    const { h, m } = asking();
    await h.poller.tick();
    m.sentinels.set(SID, SCHEMA2);
    await next(h);
    h.store.markAnswered(latestOf(h).id, iso(T0 + 7000));
    m.sentinels.delete(SID);
    await next(h);
    expect(latestOf(h).needsYou).toBe(false);
    await next(h);
    expect(latestOf(h).needsYou).toBe(false);
  });

  it("T10-1: a sentinel on a card that asks nothing stores the sentinel's option ids and is not asksYou", async () => {
    const m = fakeMachine({
      sessions: [live({ status: "idle" })],
      panes: [PANTHEON_PANE],
      transcripts: new Map([[SID, Buffer.from(turnLines(1))]]),
      sentinels: new Map([[SID, SCHEMA2]])
    });
    const h = harness([machine("Mac-Mini")], { "Mac-Mini": m });
    await h.poller.tick();
    expect(latestOf(h)).toMatchObject({ needsYou: true, needsKind: "sentinel", asksYou: false, options: ["A1", "A2"] });
    // Appearing later, with no new face, stores them too.
    const m2 = fakeMachine({ sessions: [live({ status: "idle" })], panes: [PANTHEON_PANE], transcripts: new Map([[SID, Buffer.from(turnLines(1))]]) });
    const h2 = harness([machine("Mac-Mini")], { "Mac-Mini": m2 });
    await h2.poller.tick();
    expect(latestOf(h2).options).toEqual([]);
    m2.sentinels.set(SID, SCHEMA2);
    await next(h2);
    expect(latestOf(h2)).toMatchObject({ needsKind: "sentinel", asksYou: false, options: ["A1", "A2"] });
  });

  it("a newer turn supersedes: the old card is unflagged and the new latest gets its own flags", async () => {
    const { h, m } = asking();
    await h.poller.tick();
    const oldId = latestOf(h).id;
    m.transcripts.set(SID, Buffer.concat([Buffer.from(ASKING(1)), Buffer.from(turnLines(2))]));
    await next(h);
    expect(h.store.getCard(oldId)).toMatchObject({ needsYou: false, needsKind: null });
    expect(latestOf(h)).toMatchObject({ turnUuid: "a-2", needsYou: false, asksYou: false, options: [] });
    await next(h);
    expect(h.store.getCard(oldId)?.needsYou).toBe(false);
    expect(latestOf(h).needsYou).toBe(false);
  });

  it("only the LAST turn's reply is asked: a question in an earlier turn of the same tick raises nothing", async () => {
    const m = fakeMachine({
      sessions: [live({ status: "idle" })],
      panes: [PANTHEON_PANE],
      transcripts: new Map([[SID, Buffer.concat([Buffer.from(ASKING(1)), Buffer.from(turnLines(2))])]])
    });
    const h = harness([machine("Mac-Mini")], { "Mac-Mini": m });
    await h.poller.tick();
    expect(h.store.listCards({}).some((c) => c.needsYou || c.asksYou)).toBe(false);
  });

  it("F1 carry, pid reuse: a live file with the same pid and a new procStart ends the old row at once and starts a new one", async () => {
    const m = fakeMachine({ sessions: [live()], panes: [PANTHEON_PANE], transcripts: new Map([[SID, BASIC]]) });
    const h = harness([machine("Mac-Mini")], { "Mac-Mini": m });
    await h.poller.tick();
    m.sessions = [live({ sessionId: SID2, tmux: "Other:@2.%2", procStart: "Sun Oct 18 09:00:00 2026" })];
    await next(h);
    const rows = new Map(h.store.listSessions("Mac-Mini").map((r) => [r.sessionId, r]));
    expect(rows.size).toBe(2);
    expect(rows.get(SID)?.endedAt).toBe(iso(T0 + 5000));
    expect(rows.get(SID2)?.endedAt).toBeNull();
    expect(h.store.listCards({}).map((c) => c.turnUuid.slice(0, 8)).sort()).toEqual([BASIC_TURN1, BASIC_TURN2].sort());
  });

  it("F1 carry, pid reuse: the same pid with the same procStart under another session id does not end the old row", async () => {
    const m = fakeMachine({ sessions: [live()], panes: [PANTHEON_PANE], transcripts: new Map([[SID, BASIC]]) });
    const h = harness([machine("Mac-Mini")], { "Mac-Mini": m });
    await h.poller.tick();
    m.sessions = [live({ sessionId: SID2, tmux: "Other:@2.%2" })];
    await next(h);
    expect(h.store.listSessions("Mac-Mini").find((r) => r.sessionId === SID)?.endedAt).toBeNull();
  });

  it("F1 carry, retry starvation: a busy session whose too-long open turn did not grow gets no retry probe", async () => {
    const transcript = Buffer.from(bigTurn("big", 600, false));
    expect(transcript.length).toBeGreaterThan(256 * 1024);
    const store = new SqliteConsoleStore(":memory:");
    store.upsertSession(seedRow({ transcriptSize: transcript.length }), iso(T0 - 5000));
    const m = fakeMachine({ sessions: [live()], panes: [PANTHEON_PANE], transcripts: new Map([[SID, transcript]]) });
    const h = harness([machine("Mac-Mini")], { "Mac-Mini": m }, { store });
    await h.poller.tick();
    expect(h.exec).toHaveBeenCalledTimes(1);
    expect(h.asks[0]?.panes).toEqual(["%9"]);
    expect(h.store.listSessions("Mac-Mini")[0]?.transcriptOffset).toBe(0);
    expect(h.poller.health()[0]?.turnsTooLong).toBe(0);
  });

  it("F1 carry, retry starvation: the same open turn after it grew is still retried", async () => {
    const transcript = Buffer.from(bigTurn("big", 600, false));
    const store = new SqliteConsoleStore(":memory:");
    store.upsertSession(seedRow({ transcriptSize: transcript.length - 100 }), iso(T0 - 5000));
    const m = fakeMachine({ sessions: [live()], panes: [PANTHEON_PANE], transcripts: new Map([[SID, transcript]]) });
    const h = harness([machine("Mac-Mini")], { "Mac-Mini": m }, { store });
    await h.poller.tick();
    expect(h.exec.mock.calls.length).toBeGreaterThan(1);
  });
});
