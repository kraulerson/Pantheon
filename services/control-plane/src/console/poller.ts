/**
 * Maestro Console poller (plan Task 8, spec §5–§6): every `pollSeconds` it probes each ready dev machine
 * over SSH, splits the new transcript bytes into turns, builds masked card faces, detects needs-you
 * signals and writes sessions and cards to the store. It only READS: the one remote command it runs is
 * `buildProbeCommand` (via `runProbe`), which is read-only by construction; nothing here sends keys to a
 * pane or writes on a machine.
 *
 * Per tick:
 * - every listed machine is resolved through `resolveConnectableMachine` (unknown / disabled /
 *   unprovisioned → `not_connectable`, never dialled); the ready ones are polled in parallel. A machine
 *   whose previous poll is still in flight is skipped and counted (per machine); the others are polled.
 *   A ready machine shows `pending` ("no data yet") until its first poll has a result;
 * - `probeLoop`: the main probe slices every stored live session from its stored `transcriptOffset` and
 *   tails the panes named by those sessions' tmux fields; up to {@link MAX_CATCH_UPS} catch-up probes
 *   follow, for truncated slices, sessions first seen this tick, and stored sessions that ended but were
 *   not read yet;
 * - offsets: `transcriptOffset = slice.offset + consumedBytes`, `transcriptSize = slice.size`; the carry
 *   is NOT kept, so an open turn is re-read from its start next tick (transcript.ts contract). A slice
 *   served from 0 for a stored offset past the file's end (R-pre-1) therefore resets the offset;
 * - `closeOpenTurn` (never for a truncated slice, whose open turn is not the file's last) when the session
 *   is IDLE and its size equals the stored `transcriptSize`, or when its process is gone: `alive` false (at
 *   once), or its session file absent on {@link MISSES_TO_END} ticks in a row (Claude Code removes it on a clean
 *   exit; one tick without it can be a rewrite caught mid-way). A gone process gains no bytes, so its final turn
 *   is carded instead of lost;
 * - an open turn larger than its slice (truncated, nothing consumed) gets ONE retry probe that carries only
 *   that session's slice at the one-slice budget; if that still consumes nothing, the offset skips past the
 *   slice's last complete line and `turnsTooLong` counts it (visible);
 * - `persistSession`: live sessions are upserted (`reachable` from `projectKeyFor`, false for an `sh-*`
 *   tmux session; `paneId` / `tmuxSession` keep their real values). Every face of the tick is stored with
 *   `needsYou: false` except the session's latest, which carries `kindFor` and the needs-you signal.
 *   Needs-you flags never go stale: with no signal, or when a new face arrives, the session's flagged cards
 *   are cleared first (`clearNeedsYou`, which also resets their kind to "reply"); a signal with no new face
 *   flags the session's latest stored card (`setCardNeeds`, only when flags or kind differ). F2: the last turn's
 *   reply text is asked for a `reply_question`; the latest card stores `asksYou` (reply questions only) and its
 *   option ids (a sentinel's or the reply's — none for a sentinel in a folder two live sessions share, triage 2);
 *   a reply question stays raised on ticks with no new face and no
 *   signal until the card is answered or dismissed. A stored live session whose pid a live file names with
 *   another `procStart` is ended at once (pid reuse); a busy session whose too-long open turn did not grow is
 *   not retried. Task 11 derives
 *   the NEEDS YOU state from the SESSION ROW (`state`); card flags only pin the card the signal belongs to;
 * - stored live sessions no longer reported alive are marked ended once they are gone (as above) and their
 *   last slice this tick was read AFTER that and was whole (offsets saved first); one read only while still
 *   alive, or not read whole, stays live and is read (and its final turn closed) next tick. A session seen alive
 *   earlier in the tick and gone by the last report keeps its turns and gets its row from the file seen live;
 * - a session record whose fields lack a valid pid or sessionId (`sessionsUnparsed`: the session-file format
 *   changed under us) makes the tick's session list unreliable (final review I3): the machine is `cant_read`
 *   ("session file format not recognised"), no open turn of an absent session is closed, nothing is ended and
 *   the missing-tick counts stand still;
 * - every failure becomes a labeled machine state (CC1); a store error is logged (pino-shaped, with the
 *   tick's correlation id) and counted, never thrown out of `tick()`; `lastOkAt` advances whenever an ok
 *   report arrived in the tick, even if a later catch-up failed;
 * - after a tick with no store error, `purgeExpired` runs at most once per hour.
 *
 * Budget (controller ruling 1, stricter form): the probe output cap is 2 MiB and base64 inflates by 4/3.
 * Tails are estimated at `panes × (60 rows + 40 history lines) × 200 B` (encoded); the slices get what is
 * left of a 1.4 MiB total, in raw bytes `(1.4 MiB − tails) × 3/4`, never more than 1.2 MiB raw, split evenly:
 * `maxBytesPerSlice = max(16 KiB, min(256 KiB, floor(min(1.2 MiB, (1.4 MiB − tails) × 3/4) / slices)))`.
 * Example: 1 slice + 1 pane → tails 20 000 B, room 1 086 004 B → 256 KiB. The oversize retry (1 slice, no
 * tails) gets the whole room: floor(1.4 MiB × 3/4) = 1 101 004 B, ~1.47 MiB encoded. 1.2 MiB of slices
 * alone would encode to ~1.6 MiB, hence the stricter bound. Around 50 tailed panes leave each slice at the
 * 16 KiB floor; a probe that still overflows the cap is `cant_read` (visible).
 *
 * Residuals (accepted, controller ruling 6):
 * - an open turn skipped as too long whose retry slice holds no newline at all resumes mid-line; the next
 *   split then reports "line is not JSON" as a session problem (visible, rare);
 * - more than 64 live sessions on one machine: the rest are sliced on catch-up probes (64 per probe, at
 *   most 3 catch-ups), and anything beyond waits for later ticks.
 */

import { randomUUID } from "node:crypto";
import { runRemoteCommand, type TerminalDeps } from "../devmachine/connection.js";
import { resolveConnectableMachine, type ConnectableMachine } from "../devmachine/terminal-gateway.js";
import { TMUX_SESSION_NAME_RE, type RemoteExec } from "../devmachine/tmux.js";
import type { DevMachine } from "../registry/types.js";
import { buildCardFaces, detectNeedsYou, detectReplyQuestion, kindFor, oneLine, pickLiveSession, projectKeyFor, stateFor, tmuxTarget, type NeedsYou, type ReplyQuestion } from "./cards.js";
import { maskSecrets } from "./masking.js";
import { PANE_ID_RE, PROBE_MAX_OUTPUT_BYTES, type ProbePlan } from "./probe-command.js";
import { runProbe, type ProbePane, type ProbeReport, type ProbeResult, type ProbeSessionFile, type ProbeSliceResult } from "./probe.js";
import type { ConsoleSettings } from "./settings.js";
import type { ConsoleCardRow, ConsoleSessionRow, SqliteConsoleStore } from "./store.js";
import { splitTurns, type Turn } from "./transcript.js";

export interface MachineHealth {
  readonly machine: string;
  /** `pending`: a ready machine whose first poll has no result yet ("no data yet"). */
  readonly state: "pending" | "ok" | "unreachable" | "cant_read" | "failed" | "not_connectable";
  /** When `state` last changed (UTC ISO). */
  readonly since: string;
  /** First-party text. */
  readonly message?: string;
  /** The machine's own stderr line on a `failed` probe — `trusted:false`, the page labels it. */
  readonly remoteDetail?: string;
  /** The latest tick's main-probe foreign lines plus the transcript lines it counted. */
  readonly ignoredLines: number;
  readonly lastOkAt?: string;
  /** Newest last, at most 20, de-duplicated (a repeat moves to the end). */
  readonly problems: readonly string[];
  /** Open turns skipped because they did not fit the retry slice, total for this machine. */
  readonly turnsTooLong: number;
  readonly turnsTooLongBySession: Readonly<Record<string, number>>;
  /** Store reads/writes that failed for this machine (each one logged). */
  readonly storeErrors: number;
  /** Ticks that skipped this machine because its previous poll was still in flight. */
  readonly skippedTicks: number;
}

/**
 * Pino-compatible logger shape (`app.log.child({ module: "console-poller" })` fits). Every entry the poller
 * writes carries `event`, `correlationId` (one per tick), `at` (the tick's UTC time) and, where it applies,
 * `machine` and `detail`.
 */
export interface PollerLogger {
  info(obj: object, msg?: string): void;
  info(msg: string): void;
  warn(obj: object, msg?: string): void;
  warn(msg: string): void;
  error(obj: object, msg?: string): void;
  error(msg: string): void;
}

/** Default sink: one JSON line per entry on stderr (`{ level, ...fields, msg }`). */
export const STDERR_LOGGER: PollerLogger = (() => {
  const line =
    (level: string) =>
    (a: object | string, msg?: string): void => {
      const fields = typeof a === "string" ? { msg: a } : { ...a, ...(msg !== undefined ? { msg } : {}) };
      process.stderr.write(`${JSON.stringify({ level, ...fields })}\n`);
    };
  return { info: line("info"), warn: line("warn"), error: line("error") };
})();

export interface ConsolePollerDeps {
  readonly registry: {
    listDevMachines(): DevMachine[];
    getDevMachineByLogicalName(n: string): DevMachine | undefined;
  };
  /** The probe transport; production passes {@link createProbeExec}. */
  readonly exec: RemoteExec;
  readonly store: SqliteConsoleStore;
  readonly settings: ConsoleSettings;
  readonly mask?: (t: string) => string;
  readonly now?: () => number;
  /** Repeating-timer semantics (default `setInterval`). */
  readonly setTimer?: (fn: () => void, ms: number) => { unref?: () => void };
  readonly clearTimer?: (h: unknown) => void;
  /** Structured logger (default: one JSON line per entry on stderr). */
  readonly log?: PollerLogger;
}

export interface ConsolePoller {
  start(): void;
  /**
   * Clears the timer (a timer callback that still fires afterwards runs no tick) and resolves once every
   * machine poll in flight has settled — their writes still land. The wiring task awaits this before
   * closing the store. Additive to the brief's `void` (controller ruling 5).
   */
  stop(): Promise<void>;
  /** Never rejects. Resolves when this tick's own machine polls have settled. */
  tick(): Promise<void>;
  health(): readonly MachineHealth[];
  /** Machine polls skipped because that machine's previous poll was still in flight (ruling R-pre-3). */
  skippedTicks(): number;
  /** Store errors across all machines plus failed purges. */
  storeErrors(): number;
}

/** Per-command budget for one probe: connect + run (ruling: 4 s, inside the 5 s poll). */
export const PROBE_TIMEOUT_MS = 4000;
/** Catch-up probes (retry or normal) per machine per tick, after the main probe. */
export const MAX_CATCH_UPS = 3;

const MAX_SLICES = 64;
const MAX_PANES = 256;
const MAX_SLICE_BYTES = 256 * 1024;
const MIN_SLICE_BYTES = 16 * 1024;
const SLICE_BUDGET_BYTES = Math.floor(1.2 * 1024 * 1024);
const TOTAL_BUDGET_BYTES = Math.floor(1.4 * 1024 * 1024);
const TAIL_LINES = 40;
/** Visible rows are unknown before the capture; a tall terminal is assumed. */
const PANE_ROWS_ESTIMATE = 60;
const BYTES_PER_PANE_LINE = 200;
const MAX_PROBLEMS = 20;
const PURGE_EVERY_MS = 60 * 60 * 1000;
const NEWLINE = 0x0a;
const PENDING_MESSAGE = "no data yet";
/** Ticks in a row a stored session's file must be missing before it is ended (final review I3). */
const MISSES_TO_END = 2;
/** What the store keeps of a session's status (the page's UNKNOWN STATUS shows it) and of its other free text. */
const MAX_STATUS_CHARS = 40;
const MAX_STORED_TEXT_CHARS = 512;
/** The machine's stderr line as health carries it to the page. */
const MAX_REMOTE_DETAIL_CHARS = 140;

/** Bind `runRemoteCommand` to custody with the probe's output cap and timeout. */
export function createProbeExec(terminalDeps: TerminalDeps, run: typeof runRemoteCommand = runRemoteCommand): RemoteExec {
  return (target, handle, command) =>
    run(target, handle, command, terminalDeps, { maxOutputBytes: PROBE_MAX_OUTPUT_BYTES, timeoutMs: PROBE_TIMEOUT_MS });
}

/** Raw slice bytes left for `slices` slices next to `panes` tails, before the per-slice clamps (ruling 1). */
function sliceRoom(slices: number, panes: number): number {
  const paneBytes = panes * (PANE_ROWS_ESTIMATE + TAIL_LINES) * BYTES_PER_PANE_LINE;
  const room = Math.min(SLICE_BUDGET_BYTES, Math.floor((Math.max(0, TOTAL_BUDGET_BYTES - paneBytes) * 3) / 4));
  return Math.floor(room / Math.max(1, slices));
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
/**
 * Final review M1: machine text is masked WHOLE before any cut (the probe hands it over at up to 2048 chars), so a
 * token cannot be cut short of its pattern and stored or shown as an unmasked prefix. `maskClip` also flattens and
 * masks again, as cards.ts does for what the page shows on one line (`Bearer␠␠<token>` only matches once collapsed).
 */
const maskThenClip = (mask: (t: string) => string, s: string, max: number): string => mask(s).slice(0, max);
const maskClip = (mask: (t: string) => string, s: string, max: number): string => mask(oneLine(mask(s))).slice(0, max);
const short = (sessionId: string): string => sessionId.slice(0, 8);

interface Placement {
  readonly key: string;
  readonly reachable: boolean;
  /** The `tmux` field's pane id; "" only when the field is absent or invalid. */
  readonly paneId: string;
  /** The probed pane's session name, else the field's; "" only when neither is known. */
  readonly tmuxSession: string;
}

/**
 * `projectKeyFor`, except that a tmux session named `sh-*` (reserved for F2 machine shells) is never a
 * project key: such a session falls back to `<cwd basename>@<machine>` and is not reachable. `paneId` and
 * `tmuxSession` keep their real values either way; `reachable` alone says whether the console may target it.
 */
function placementOf(file: ProbeSessionFile, panes: readonly ProbePane[], machine: string): Placement {
  let pk = projectKeyFor(file, panes, machine);
  if (pk.reachable && pk.key.startsWith("sh-")) pk = { key: projectKeyFor(file, [], machine).key, reachable: false };
  const target = tmuxTarget(file);
  const pane = target !== undefined ? panes.find((p) => p.paneId === target.paneId) : undefined;
  const tmuxSession = pane !== undefined && TMUX_SESSION_NAME_RE.test(pane.session) ? pane.session : (target?.session ?? "");
  return { key: pk.key, reachable: pk.reachable, paneId: target?.paneId ?? "", tmuxSession };
}

/** First live file per session id (pickLiveSession keeps input order). */
function liveFiles(files: readonly ProbeSessionFile[]): Map<string, ProbeSessionFile> {
  const out = new Map<string, ProbeSessionFile>();
  for (const f of pickLiveSession(files).live) if (!out.has(f.sessionId)) out.set(f.sessionId, f);
  return out;
}

/** One session's read position during a tick. */
interface Cursor {
  offset: number;
  size: number;
  /** `transcriptSize` as stored before this tick; undefined for a session first seen now. */
  readonly storedSize: number | undefined;
  /**
   * The last slice read for it this tick was read AFTER the session was gone (no live file in that report)
   * and was whole (or found no transcript): only then may a gone session be marked ended (fix round 2, R1).
   */
  drained: boolean;
  readonly turns: Turn[];
}

/** What the next probe asks for. A retry carries exactly one slice and no tails. */
interface Ask {
  readonly retry: boolean;
  readonly slices: readonly string[];
  readonly panes: readonly string[];
}

/** One machine's poll: its inputs, what the probes returned and what is still to be read. */
interface MachineRun {
  readonly name: string;
  readonly at: string;
  /** The poller's mask: stored `procStart` values went through it, so file values are compared after it. */
  readonly mask: (t: string) => string;
  readonly stored: readonly ConsoleSessionRow[];
  readonly storedById: ReadonlyMap<string, ConsoleSessionRow>;
  readonly cursors: Map<string, Cursor>;
  /** Sessions sliced (or asked to be) at least once this tick. */
  readonly asked: Set<string>;
  readonly tails: Map<string, string>;
  readonly sentinels: Map<string, string>;
  /** The latest live session file seen for each session this tick, with that report's panes (R2). */
  readonly seen: Map<string, { readonly file: ProbeSessionFile; readonly panes: readonly ProbePane[] }>;
  readonly problems: string[];
  readonly tooLongHits: string[];
  readonly normalQueue: string[];
  readonly paneQueue: string[];
  readonly retryQueue: string[];
  ignored: number;
  report: ProbeReport | undefined;
  failure: Exclude<ProbeResult, { state: "ok" }> | undefined;
  /** How many ticks in a row (before this one) each tracked session's file was missing from a reliable report. */
  readonly missedBefore: ReadonlyMap<string, number>;
  /** The most session records any report of this tick could not parse; non-zero = an unreliable session list. */
  sessionsUnparsed: number;
  /** Sessions marked ended this tick. */
  readonly endedNow: Set<string>;
  /** Stored live sessions whose pid a live file now names with a different `procStart` (pid reuse): gone at once. */
  readonly superseded: Set<string>;
}

function newRun(
  name: string,
  at: string,
  stored: readonly ConsoleSessionRow[],
  mask: (t: string) => string,
  missedBefore: ReadonlyMap<string, number> = new Map()
): MachineRun {
  return {
    mask,
    name,
    at,
    stored,
    storedById: new Map(stored.map((r) => [r.sessionId, r])),
    cursors: new Map(),
    asked: new Set(),
    tails: new Map(),
    sentinels: new Map(),
    seen: new Map(),
    problems: [],
    tooLongHits: [],
    normalQueue: [],
    paneQueue: [],
    retryQueue: [],
    ignored: 0,
    report: undefined,
    failure: undefined,
    missedBefore,
    sessionsUnparsed: 0,
    endedNow: new Set(),
    superseded: new Set()
  };
}

function cursorFor(run: MachineRun, sessionId: string): Cursor {
  let c = run.cursors.get(sessionId);
  if (c === undefined) {
    const row = run.storedById.get(sessionId);
    c = { offset: row?.transcriptOffset ?? 0, size: row?.transcriptSize ?? 0, storedSize: row?.transcriptSize, drained: false, turns: [] };
    run.cursors.set(sessionId, c);
  }
  return c;
}

const enqueue = (queue: string[], item: string): void => {
  if (!queue.includes(item)) queue.push(item);
};

/** The probe plan for an ask: a normal probe within the shared budget, a retry with the one-slice room. */
function buildPlan(run: MachineRun, ask: Ask): ProbePlan {
  const max = ask.retry
    ? Math.min(sliceRoom(1, 0), PROBE_MAX_OUTPUT_BYTES)
    : ask.slices.length === 0
      ? MAX_SLICE_BYTES
      : Math.max(MIN_SLICE_BYTES, Math.min(MAX_SLICE_BYTES, sliceRoom(ask.slices.length, ask.panes.length)));
  return {
    slices: ask.slices.map((sessionId) => ({ sessionId, offset: cursorFor(run, sessionId).offset })),
    panes: ask.panes,
    maxBytesPerSlice: max,
    tailLines: TAIL_LINES
  };
}

/**
 * Whether a session with no live file in the report being read is gone for good (final review I3): never while
 * this tick's session list is unreliable (a record lacked a valid pid or sessionId); at once when its file is
 * listed with a dead pid; when its file is missing, only on the {@link MISSES_TO_END}th tick in a row — Claude Code
 * removes the file on a clean exit, but one tick without it can be a rewrite caught mid-way.
 */
function goneFor(run: MachineRun, sessionId: string, listed: ReadonlySet<string>): boolean {
  if (run.sessionsUnparsed > 0) return false;
  if (run.superseded.has(sessionId) || listed.has(sessionId)) return true;
  return (run.missedBefore.get(sessionId) ?? 0) + 1 >= MISSES_TO_END;
}

/** Split one slice, advance its cursor and queue whatever is left to read. */
function readSlice(
  run: MachineRun,
  slice: ProbeSliceResult,
  live: ReadonlyMap<string, ProbeSessionFile>,
  listed: ReadonlySet<string>,
  retry: boolean
): void {
  if (!run.asked.has(slice.sessionId)) {
    run.ignored++;
    return;
  }
  const c = cursorFor(run, slice.sessionId);
  // No live file and gone (dead pid, or no session file on a second tick in a row): it gains no more bytes.
  const file = live.get(slice.sessionId);
  const gone = file === undefined && goneFor(run, slice.sessionId, listed);
  c.drained = gone && (!slice.found || !slice.truncated);
  if (!slice.found) return; // no transcript: keep the stored position
  const idleUnchanged = file?.status === "idle" && c.storedSize !== undefined && slice.size === c.storedSize;
  const close = !slice.truncated && (gone || idleUnchanged);
  // `slice.offset` is 0 when the machine found the file shorter than the asked offset (R-pre-1): the split
  // then restarts from 0 and the stored offset is reset by the assignment below.
  const split = splitTurns(slice.bytes, slice.offset, undefined, close ? { closeOpenTurn: true } : undefined);
  run.ignored += split.ignoredLines;
  if (split.cantRead) run.problems.push(`session ${short(slice.sessionId)}: transcript unreadable — ${split.cantReadWhy ?? "unknown reason"}`);
  // F1 carry (retry starvation): a busy session whose size did not move since the last poll and whose open turn
  // does not fit the slice would be re-sliced, retried and re-read every tick for nothing. Skip it until the
  // file grows or the session goes idle; the offset stays, the pane is still tailed.
  if (slice.truncated && split.consumedBytes === 0 && !retry && file?.status === "busy" && c.storedSize !== undefined && slice.size === c.storedSize) return;
  c.turns.push(...split.turns);
  let offset = slice.offset + split.consumedBytes;
  if (slice.truncated) {
    if (split.consumedBytes === 0 && !retry) {
      enqueue(run.retryQueue, slice.sessionId);
    } else {
      if (split.consumedBytes === 0) {
        const nl = slice.bytes.lastIndexOf(NEWLINE);
        offset = slice.offset + (nl >= 0 ? nl + 1 : slice.bytes.length);
        run.tooLongHits.push(slice.sessionId);
        run.problems.push(`session ${short(slice.sessionId)}: a turn too long to read was skipped`);
      }
      enqueue(run.normalQueue, slice.sessionId);
    }
  }
  c.offset = offset;
  c.size = slice.size;
}

/** Fold one ok report into the run: tails, sentinels, slices, and the sessions still to be read. */
function absorbReport(run: MachineRun, report: ProbeReport, retry: boolean): void {
  run.report = report;
  // Before any slice is read: an unreliable list must not end a session or close its open turn (final review I3).
  run.sessionsUnparsed = Math.max(run.sessionsUnparsed, report.sessionsUnparsed);
  for (const [k, v] of report.tails) run.tails.set(k, v);
  for (const [k, v] of report.sentinels) run.sentinels.set(k, v);
  const live = liveFiles(report.sessions);
  const listed = new Set(report.sessions.map((f) => f.sessionId));
  // Pid reuse (F1 carry): a stored live session absent from the live files whose pid a live file now names with
  // another `procStart` is a different process — gone now, not after the missing-tick count. Masked against
  // masked: the stored value went through `maskThenClip`, so the file's value must take the same transform.
  if (run.sessionsUnparsed === 0) {
    for (const r of run.stored) {
      if (r.endedAt !== null || live.has(r.sessionId) || r.procStart === "") continue;
      for (const f of live.values()) {
        if (f.pid === r.claudePid && f.procStart !== undefined && maskThenClip(run.mask, f.procStart, MAX_STORED_TEXT_CHARS) !== r.procStart) run.superseded.add(r.sessionId);
      }
    }
  }
  for (const [sessionId, file] of live) run.seen.set(sessionId, { file, panes: report.panes });
  for (const slice of report.slices) readSlice(run, slice, live, listed, retry);
  // Sessions first seen this tick (or beyond the main probe's slice cap) are read on a catch-up.
  for (const [sessionId, file] of live) {
    if (run.asked.has(sessionId)) continue;
    enqueue(run.normalQueue, sessionId);
    const { paneId } = placementOf(file, report.panes, run.name);
    if (paneId !== "" && !run.tails.has(paneId)) enqueue(run.paneQueue, paneId);
  }
  // Stored live sessions that are gone but were never read this tick get their last slice too.
  for (const r of run.stored) {
    if (r.endedAt === null && !live.has(r.sessionId) && !run.asked.has(r.sessionId)) enqueue(run.normalQueue, r.sessionId);
  }
}

/** The next catch-up ask, or undefined when nothing is left: one retry at a time, retries first. */
function nextAsk(run: MachineRun): Ask | undefined {
  const retry = run.retryQueue.shift();
  if (retry !== undefined) return { retry: true, slices: [retry], panes: [] };
  if (run.normalQueue.length === 0) return undefined;
  const slices = run.normalQueue.splice(0, MAX_SLICES);
  const panes = run.paneQueue.splice(0, MAX_PANES);
  return { retry: false, slices, panes };
}

/** The main probe, then up to {@link MAX_CATCH_UPS} catch-ups, one probe in flight at a time. */
async function probeLoop(run: MachineRun, conn: ConnectableMachine, exec: RemoteExec): Promise<void> {
  const liveStored = run.stored.filter((r) => r.endedAt === null);
  let ask: Ask | undefined = {
    retry: false,
    slices: liveStored.slice(0, MAX_SLICES).map((r) => r.sessionId),
    // Panes named by the stored sessions' tmux fields (their real pane ids, reachable or not).
    panes: [...new Set(liveStored.map((r) => r.paneId).filter((p) => PANE_ID_RE.test(p)))].slice(0, MAX_PANES)
  };
  for (let probe = 0; ask !== undefined; probe++) {
    for (const s of ask.slices) run.asked.add(s);
    const result = await runProbe(conn.target, conn.handle, exec, buildPlan(run, ask));
    if (result.state !== "ok") {
      run.failure = result;
      return;
    }
    // Foreign lines (a login banner) repeat on every probe: only the main probe's count.
    if (probe === 0) run.ignored += result.report.ignoredLines;
    absorbReport(run, result.report, ask.retry);
    ask = probe < MAX_CATCH_UPS ? nextAsk(run) : undefined;
  }
}

class StoreAccessError extends Error {}

/** Run a store call; any failure becomes a {@link StoreAccessError} (reads and writes alike). */
function storeCall<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    throw new StoreAccessError(errText(err), { cause: err });
  }
}

interface PersistDeps {
  readonly store: SqliteConsoleStore;
  readonly mask: (t: string) => string;
  readonly retentionDays: number;
}

/** The store's bounds for a card's option ids (store.ts `OPTION_ID_RE`, `MAX_CARD_OPTIONS`). */
const OPTION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,7}$/;
const MAX_OPTION_IDS = 12;

/** Ids of a schema-2 sentinel's options: validated against the store's bounds, de-duplicated, never any option text. */
function sentinelOptionIds(sentinelJson: string): string[] {
  let doc: unknown;
  try {
    doc = JSON.parse(sentinelJson);
  } catch {
    return [];
  }
  const raw = typeof doc === "object" && doc !== null ? (doc as { options?: unknown }).options : undefined;
  if (!Array.isArray(raw)) return [];
  const ids: string[] = [];
  for (const o of raw as unknown[]) {
    const id = typeof o === "object" && o !== null ? (o as { id?: unknown }).id : undefined;
    if (typeof id === "string" && OPTION_ID_RE.test(id) && !ids.includes(id)) ids.push(id);
    if (ids.length >= MAX_OPTION_IDS) break;
  }
  return ids;
}

/**
 * T10-3: the ids the page's buttons send — a sentinel's while one is raised, else the reply question's, else none.
 * Triage 2 (DI-5): a sentinel belongs to a folder, not a session; when more than one live session on the machine
 * shares its folder, a send button could type the id into the wrong session, so its ids are not stored (no send
 * buttons) while the needs-you flag stays — the operator answers in the Claude session.
 */
function optionIdsFor(signals: readonly NeedsYou[], sentinelJson: string | undefined, reply: ReplyQuestion | undefined, sentinelShared: boolean): readonly string[] {
  if (sentinelJson !== undefined && signals.some((s) => s.kind === "sentinel")) return sentinelShared ? [] : sentinelOptionIds(sentinelJson);
  return reply?.options ?? [];
}

/** The session's latest card when it asks Karl something and he has neither answered nor dismissed it. */
function unansweredReplyQuestion(store: SqliteConsoleStore, machine: string, sessionId: string): ConsoleCardRow | undefined {
  const latest = storeCall(() => store.latestCard(machine, sessionId));
  return latest !== undefined && latest.asksYou && latest.answeredAt === null && latest.dismissedAt === null ? latest : undefined;
}

/**
 * Cards, needs-you flags and the session row for one session alive in the latest report. `sharesCwd`: another live
 * session of the report runs in the same folder (triage 2).
 */
function persistSession(run: MachineRun, d: PersistDeps, report: ProbeReport, sessionId: string, file: ProbeSessionFile, sharesCwd: boolean): void {
  const { name, at } = run;
  const c = cursorFor(run, sessionId);
  const place = placementOf(file, report.panes, name);
  const sentinelJson = run.sentinels.get(sessionId);
  // O1: only the LAST turn's reply is asked about; a tick that read no turn has no reply text (the sticky
  // re-flag below carries an earlier reply question across such ticks).
  const lastTurn = c.turns[c.turns.length - 1];
  const needs = detectNeedsYou({
    status: file.status,
    ...(file.waitingFor !== undefined ? { waitingFor: file.waitingFor } : {}),
    paneTail: place.paneId !== "" ? (run.tails.get(place.paneId) ?? "") : "",
    ...(sentinelJson !== undefined ? { sentinelJson } : {}),
    ...(lastTurn !== undefined ? { replyText: lastTurn.replyText } : {}),
    mask: d.mask
  });
  for (const p of needs.problems) run.problems.push(`session ${short(sessionId)}: ${p}`);
  const faces = buildCardFaces(c.turns, { machine: name, projectKey: place.key, sessionId }, d.mask);
  const needsKind = needs.signals[0]?.kind ?? null;
  const kind = kindFor(needs.signals);
  // T10-3: asksYou comes from the reply itself, whatever other signal is up (so the sticky return always works).
  const reply = lastTurn !== undefined ? detectReplyQuestion(lastTurn.replyText, d.mask) : undefined;
  const asksYou = reply !== undefined;
  const hasSentinel = needs.signals.some((s) => s.kind === "sentinel");
  const options = optionIdsFor(needs.signals, sentinelJson, reply, sharesCwd);
  // T10-2: no new face and no signal — an unanswered, undismissed reply question stays raised.
  const sticky = needs.signals.length === 0 && faces.length === 0 ? unansweredReplyQuestion(d.store, name, sessionId) : undefined;
  const alreadyRaised = sticky !== undefined && sticky.needsYou && sticky.needsKind === "reply_question";
  // No stale flags (ruling 4): clear before a new latest face takes them, or when the signal is gone.
  if (!alreadyRaised && (needs.signals.length === 0 || faces.length > 0)) storeCall(() => d.store.clearNeedsYou(name, sessionId, at));
  if (sticky !== undefined && !alreadyRaised) {
    storeCall(() => d.store.setCardNeeds(sticky.id, { needsYou: true, needsKind: "reply_question", kind: kindFor([]), options: sticky.options }, at));
  }
  if (needs.signals.length > 0 && faces.length === 0) {
    const latest = storeCall(() => d.store.latestCard(name, sessionId));
    const idsDiffer = latest !== undefined && hasSentinel && JSON.stringify(latest.options) !== JSON.stringify(options);
    if (latest !== undefined && (!latest.needsYou || latest.needsKind !== needsKind || latest.kind !== kind || idsDiffer)) {
      // While a sentinel is up its ids are the card's options, always (the buttons send them). Residual: when it
      // vanishes the sticky reply_question returns with those stored ids, not the reply's letters.
      storeCall(() => d.store.setCardNeeds(latest.id, { needsYou: true, needsKind, kind, ...(hasSentinel ? { options } : {}) }, at));
    }
  }
  faces.forEach((face, i) => {
    const latest = i === faces.length - 1;
    const card = latest ? { ...face, kind } : face;
    // Every upsert passes asksYou/options: the store resets them when omitted.
    const flags = latest
      ? { needsYou: needs.signals.length > 0, needsKind, asksYou, options }
      : { needsYou: false, needsKind: null, asksYou: false, options: [] };
    storeCall(() => d.store.upsertCard(card, flags, d.retentionDays, at));
  });
  const view = stateFor(file.status, file.waitingFor, needs.signals.length > 0 || sticky !== undefined);
  storeCall(() => d.store.upsertSession(sessionRow(run, d, sessionId, file, place, c, view), at));
}

/** The row for a session seen alive this tick (`endedAt` null; `markEnded` follows separately if it is gone). */
function sessionRow(
  run: MachineRun,
  d: PersistDeps,
  sessionId: string,
  file: ProbeSessionFile,
  place: Placement,
  c: Cursor,
  view: ReturnType<typeof stateFor>
): Omit<ConsoleSessionRow, "version" | "createdAt" | "updatedAt"> {
  return {
    machine: run.name,
    tmuxSession: place.tmuxSession,
    paneId: place.paneId,
    claudePid: file.pid,
    sessionId,
    procStart: maskThenClip(d.mask, file.procStart ?? "", MAX_STORED_TEXT_CHARS),
    cwd: maskThenClip(d.mask, file.cwd, MAX_STORED_TEXT_CHARS),
    projectKey: place.key,
    reachable: place.reachable,
    // The page shows an unknown status as `UNKNOWN STATUS <this value>`: masked and clipped here, as stored.
    status: maskClip(d.mask, file.status, MAX_STATUS_CHARS),
    waitingFor: file.waitingFor !== undefined ? maskThenClip(d.mask, file.waitingFor, MAX_STORED_TEXT_CHARS) : null,
    state: view.state,
    stateReason: view.reason ?? null,
    transcriptOffset: c.offset,
    transcriptSize: c.size,
    lastSeenAt: run.at,
    endedAt: null
  };
}

/** Everything the run read: live sessions, the last turns of gone ones, then the ends. */
function persistRun(run: MachineRun, d: PersistDeps, report: ProbeReport): void {
  const { name, at } = run;
  const live = liveFiles(report.sessions);
  // An unreliable session list ends nothing this tick (final review I3).
  const mayEnd = run.sessionsUnparsed === 0;
  // Triage 2 (DI-5): how many live sessions run in each folder — a sentinel there is the folder's, not one session's.
  const perCwd = new Map<string, number>();
  for (const f of live.values()) perCwd.set(f.cwd, (perCwd.get(f.cwd) ?? 0) + 1);
  for (const [sessionId, file] of live) persistSession(run, d, report, sessionId, file, (perCwd.get(file.cwd) ?? 0) > 1);
  for (const [sessionId, c] of run.cursors) {
    if (live.has(sessionId)) continue;
    const row = run.storedById.get(sessionId);
    if (c.turns.length > 0) {
      // Key source: the last report's (dead) file, else the file seen live earlier this tick (R2), else the row.
      const lastFile = report.sessions.find((f) => f.sessionId === sessionId);
      const src = lastFile !== undefined ? { file: lastFile, panes: report.panes } : run.seen.get(sessionId);
      const key = src !== undefined ? placementOf(src.file, src.panes, name).key : row?.projectKey;
      if (key !== undefined) {
        for (const face of buildCardFaces(c.turns, { machine: name, projectKey: key, sessionId }, d.mask)) {
          storeCall(() => d.store.upsertCard(face, { needsYou: false, needsKind: null, asksYou: false, options: [] }, d.retentionDays, at));
        }
      }
    }
    // Save how far a gone (still stored-live) session was read, so a reappearance continues from there.
    if (row !== undefined && row.endedAt === null && run.asked.has(sessionId)) {
      storeCall(() =>
        d.store.upsertSession(
          {
            machine: row.machine,
            tmuxSession: row.tmuxSession,
            paneId: row.paneId,
            claudePid: row.claudePid,
            sessionId: row.sessionId,
            procStart: row.procStart,
            cwd: row.cwd,
            projectKey: row.projectKey,
            reachable: row.reachable,
            status: row.status,
            waitingFor: row.waitingFor,
            state: row.state,
            stateReason: row.stateReason,
            transcriptOffset: c.offset,
            transcriptSize: c.size,
            lastSeenAt: row.lastSeenAt,
            endedAt: null
          },
          at
        )
      );
    }
  }
  // Seen alive earlier this tick but gone by the last report, with no stored live row (new, or reappeared
  // after an end): store its row from the file seen live (R2), then end it once drained.
  for (const [sessionId, seen] of run.seen) {
    if (live.has(sessionId) || run.storedById.get(sessionId)?.endedAt === null) continue;
    const c = cursorFor(run, sessionId);
    const place = placementOf(seen.file, seen.panes, name);
    const view = stateFor(seen.file.status, seen.file.waitingFor, false);
    storeCall(() => d.store.upsertSession(sessionRow(run, d, sessionId, seen.file, place, c, view), at));
    if (mayEnd && c.drained) {
      storeCall(() => d.store.markEnded(name, sessionId, at));
      run.endedNow.add(sessionId);
    }
  }
  for (const r of run.stored) {
    if (!mayEnd || r.endedAt !== null || live.has(r.sessionId)) continue;
    // Ended only once its last slice this tick was read after it was gone, and whole (R1); otherwise it stays
    // live and is read again next tick.
    if (run.cursors.get(r.sessionId)?.drained !== true) continue;
    storeCall(() => d.store.clearNeedsYou(name, r.sessionId, at));
    storeCall(() => d.store.markEnded(name, r.sessionId, at));
    run.endedNow.add(r.sessionId);
  }
}

/**
 * The missing-tick counts after a tick whose session list was reliable: each session that still has a live row
 * (stored live, or given one from a file seen live this tick) and whose file the last report did not list at all
 * counts one more; a listed (live or dead) or ended session drops out (final review I3).
 */
function nextMisses(run: MachineRun, report: ProbeReport): Map<string, number> {
  const listed = new Set(report.sessions.map((f) => f.sessionId));
  const tracked = new Set<string>(run.seen.keys());
  for (const r of run.stored) if (r.endedAt === null) tracked.add(r.sessionId);
  const out = new Map<string, number>();
  for (const sessionId of tracked) {
    if (listed.has(sessionId) || run.endedNow.has(sessionId)) continue;
    out.set(sessionId, (run.missedBefore.get(sessionId) ?? 0) + 1);
  }
  return out;
}

const unparsedCount = (n: number): string => `${n} ${n === 1 ? "file" : "files"}`;

interface MachineMemory {
  state: MachineHealth["state"];
  since: string;
  message: string | undefined;
  remoteDetail: string | undefined;
  ignoredLines: number;
  lastOkAt: string | undefined;
  readonly problems: string[];
  readonly turnsTooLong: Map<string, number>;
  storeErrors: number;
  skippedTicks: number;
  /** Per session: ticks in a row its file was missing from a reliable report (final review I3). */
  missedTicks: ReadonlyMap<string, number>;
}

export function createConsolePoller(deps: ConsolePollerDeps): ConsolePoller {
  const now = deps.now ?? Date.now;
  const mask = deps.mask ?? maskSecrets;
  const logger = deps.log ?? STDERR_LOGGER;
  const memory = new Map<string, MachineMemory>();
  /** One poll in flight per machine. */
  const inFlight = new Map<string, Promise<boolean>>();
  let order: string[] = [];
  let skipped = 0;
  let storeErrorTotal = 0;
  let lastPurgeMs: number | undefined;
  let timer: { unref?: () => void } | undefined;

  /** A logger that throws must not break the tick: the entry then goes to the stderr sink instead. */
  const logError = (fields: Record<string, unknown>, msg: string): void => {
    try {
      logger.error(fields, msg);
    } catch {
      STDERR_LOGGER.error({ ...fields, loggerFailed: true }, msg);
    }
  };

  const memFor = (machine: string, at: string): MachineMemory => {
    let m = memory.get(machine);
    if (m === undefined) {
      m = {
        state: "pending",
        since: at,
        message: PENDING_MESSAGE,
        remoteDetail: undefined,
        ignoredLines: 0,
        lastOkAt: undefined,
        problems: [],
        turnsTooLong: new Map(),
        storeErrors: 0,
        skippedTicks: 0,
        missedTicks: new Map()
      };
      memory.set(machine, m);
    }
    return m;
  };

  const setState = (machine: string, at: string, state: MachineHealth["state"], message?: string, remoteDetail?: string): MachineMemory => {
    const m = memFor(machine, at);
    if (m.state !== state) m.since = at;
    m.state = state;
    m.message = message;
    m.remoteDetail = remoteDetail;
    return m;
  };

  const addProblem = (m: MachineMemory, text: string): void => {
    const i = m.problems.indexOf(text);
    if (i >= 0) m.problems.splice(i, 1);
    m.problems.push(text);
    if (m.problems.length > MAX_PROBLEMS) m.problems.splice(0, m.problems.length - MAX_PROBLEMS);
  };

  /** Problems, too-long counts and ignored lines reach health on every path, success or not. */
  const flush = (run: MachineRun): MachineMemory => {
    const m = memFor(run.name, run.at);
    for (const sid of run.tooLongHits) m.turnsTooLong.set(sid, (m.turnsTooLong.get(sid) ?? 0) + 1);
    for (const p of run.problems) addProblem(m, p);
    m.ignoredLines = run.ignored;
    if (run.report !== undefined) m.lastOkAt = run.at;
    return m;
  };

  /** Poll one ready machine. Resolves false when a store call failed or the poll broke (no purge then). */
  async function pollMachine(name: string, conn: ConnectableMachine, at: string, correlationId: string): Promise<boolean> {
    const mem = memFor(name, at); // seeds `pending` on the first poll
    let run = newRun(name, at, [], mask);
    try {
      run = newRun(name, at, storeCall(() => deps.store.listSessions(name)), mask, mem.missedTicks);
      await probeLoop(run, conn, deps.exec);
      if (run.sessionsUnparsed > 0) {
        run.problems.push(`session file format not recognised: ${unparsedCount(run.sessionsUnparsed)} without a valid pid or sessionId — no session ended this poll`);
      }
      if (run.report !== undefined) {
        persistRun(run, { store: deps.store, mask, retentionDays: deps.settings.retention.cardsDays }, run.report);
        if (run.sessionsUnparsed === 0) mem.missedTicks = nextMisses(run, run.report);
      }
      flush(run);
      if (run.failure !== undefined) {
        // The machine's stderr is masked whole, then clipped for the page (final review M1).
        const detail = run.failure.state === "failed" && run.failure.remoteDetail !== undefined ? maskClip(mask, run.failure.remoteDetail, MAX_REMOTE_DETAIL_CHARS) : "";
        setState(name, at, run.failure.state, run.failure.message, detail !== "" ? detail : undefined);
      } else if (run.sessionsUnparsed > 0) {
        setState(name, at, "cant_read", `session file format not recognised (${unparsedCount(run.sessionsUnparsed)})`);
      } else {
        setState(name, at, "ok");
      }
      return true;
    } catch (err) {
      flush(run);
      if (err instanceof StoreAccessError) {
        storeErrorTotal++;
        setState(name, at, "failed", `console store access failed for ${name}`).storeErrors++;
        logError({ event: "console.store_access_failed", correlationId, at, machine: name, detail: errText(err) }, "console store access failed");
      } else {
        setState(name, at, "failed", `console poll failed for ${name} (internal error)`);
        logError({ event: "console.poll_failed", correlationId, at, machine: name, detail: errText(err) }, "console poll failed");
      }
      return false;
    }
  }

  async function tick(): Promise<void> {
    const correlationId = randomUUID();
    let at = "";
    try {
      const nowMs = now();
      at = new Date(nowMs).toISOString();
      const machines = deps.registry.listDevMachines();
      order = machines.map((m) => m.logicalName);
      for (const k of [...memory.keys()]) if (!order.includes(k) && !inFlight.has(k)) memory.delete(k);
      const polls = machines.map((dm): Promise<boolean> => {
        const name = dm.logicalName;
        let conn: ConnectableMachine;
        try {
          conn = resolveConnectableMachine(name, deps.registry);
        } catch (err) {
          setState(name, at, "not_connectable", errText(err)).ignoredLines = 0;
          return Promise.resolve(true);
        }
        if (inFlight.has(name)) {
          skipped++;
          memFor(name, at).skippedTicks++;
          return Promise.resolve(true);
        }
        const p = pollMachine(name, conn, at, correlationId).finally(() => {
          if (inFlight.get(name) === p) inFlight.delete(name);
        });
        inFlight.set(name, p);
        return p;
      });
      const results = await Promise.all(polls);
      if (results.every(Boolean) && (lastPurgeMs === undefined || nowMs - lastPurgeMs >= PURGE_EVERY_MS)) {
        try {
          deps.store.purgeExpired(at);
          lastPurgeMs = nowMs;
        } catch (err) {
          storeErrorTotal++;
          logError({ event: "console.purge_failed", correlationId, at, detail: errText(err) }, "console purge failed");
        }
      }
    } catch (err) {
      logError({ event: "console.tick_failed", correlationId, at: at || "(no clock)", detail: errText(err) }, "console tick failed");
    }
  }

  return {
    start(): void {
      if (timer !== undefined) return;
      const set = deps.setTimer ?? ((fn: () => void, ms: number) => setInterval(fn, ms));
      const handle = set(() => {
        if (timer === handle) void tick();
      }, deps.settings.pollSeconds * 1000);
      timer = handle;
      handle.unref?.();
    },
    async stop(): Promise<void> {
      if (timer !== undefined) {
        const clear = deps.clearTimer ?? ((h: unknown) => clearInterval(h as ReturnType<typeof setInterval>));
        clear(timer);
        timer = undefined;
      }
      await Promise.all([...inFlight.values()]);
    },
    tick,
    health(): readonly MachineHealth[] {
      return order.flatMap((machine) => {
        const m = memory.get(machine);
        if (m === undefined) return [];
        return [
          {
            machine,
            state: m.state,
            since: m.since,
            ...(m.message !== undefined ? { message: m.message } : {}),
            ...(m.remoteDetail !== undefined ? { remoteDetail: m.remoteDetail } : {}),
            ignoredLines: m.ignoredLines,
            ...(m.lastOkAt !== undefined ? { lastOkAt: m.lastOkAt } : {}),
            problems: [...m.problems],
            turnsTooLong: [...m.turnsTooLong.values()].reduce((a, b) => a + b, 0),
            turnsTooLongBySession: Object.fromEntries(m.turnsTooLong),
            storeErrors: m.storeErrors,
            skippedTicks: m.skippedTicks
          }
        ];
      });
    },
    skippedTicks: () => skipped,
    storeErrors: () => storeErrorTotal
  };
}
