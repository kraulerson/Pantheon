/**
 * Maestro Console routes (plan Task 10; spec §6, §9; ADR-0010). Three GET routes, the F2 step-up pair and the F2
 * Submit / Dismiss pair, every one behind the operator guard `app.ts` runs before routing (302 → /login for a
 * browser, 401 for an API caller, 403 for a keycard bearer — TM-011); none of them joins PUBLIC_PATHS.
 *
 *   GET /console                        → the Task 11 page (text/html; the app's onSend hook makes it no-store)
 *   GET /console/api/state              → { machines, sessions, cards, settings }   Cache-Control: no-store
 *   GET /console/api/step-up            → { elevatedUntil: string | null }         Cache-Control: no-store
 *   POST /console/api/step-up           → { passphrase } opens the window: 200 { elevatedUntil };
 *                                         { revoke: true } closes it: 204           Cache-Control: no-store
 *   GET /console/api/cards/:id/expand   → ExpandResult                              Cache-Control: no-store
 *   GET /console/api/cards/:id/pane     → { tail, capturedAt, truncated } — a commit approval's session screen,
 *                                         masked (F2 Task 12); 400 / 404 / 409 / 502 labelled  Cache-Control: no-store
 *   POST /console/api/cards/:id/submit  → { text, key } types the reply into the card's session (step-up):
 *                                         200 { outcome, at, message } for every reported outcome;
 *                                         400 / 403 / 404 / 409 / 503 labelled      Cache-Control: no-store
 *   POST /console/api/cards/:id/dismiss → { dismissedAt } (no step-up: nothing is typed)   Cache-Control: no-store
 *   GET  /console/api/machines/:name/projects  → the projects root's folders (F2 Task 8; `console-sessions.ts`)
 *   POST /console/api/machines/:name/sessions  → New Session / New Project (step-up; `console-sessions.ts`)
 *
 * Passphrase step-up (F2 Task 3; spec R4, the first D6 consumer): the window `requireElevated` consults before any
 * route types into a session. Only an accepted cookie session can open it (a bearer-only caller is
 * `step_up_cookie_only`), the compare is `/login`'s `timingSafeEqualStr` with no artificial delay and no rate limit
 * (ruling T3-0), the body is exactly one of `passphrase` / `revoke: true` (ruling P-1), and every elevate, refuse
 * and revoke is one structured `console.step_up` line carrying the HASHED session id (ruling T3-1) and the request id
 * (C2) — never the passphrase, never a guess, never the id; a refusal, and a bearer-only POST (`refuse_cookie_only`),
 * is a warn line (D13). Without login (no session store, no passphrase) both answer 503, and so does Submit.
 *
 * Submit (F2 Task 6; spec §6.6, §9; R4, R6, TM-020): the one route that types into a session. JSON only (415
 * otherwise, ruling T11-15). In order: the step-up window (`requireElevated`), the card, the idempotency key, the text
 * (`validateSubmitText` refuses, never strips), a join on a Submit already in flight for the key (ruling T6-2: one
 * dial, identical answers — for the same card and text only, ruling T11-21), the replay of a stored result (R6: no
 * second dial; the key's own card only), reachability (a menu card, or a session showing a prompt, has no Submit; the
 * session row must be known, reachable, unended and not an `sh-` shell; the machine connectable), the write-ahead
 * `attempted` row with the audit-masked text (`maskSubmitText`, ruling T11-14; a UNIQUE clash is an unresolved key →
 * 409, ruling T6-3; any other append failure → a `failed` result row, ruling T6-4), the delivery script built from the
 * stored row (`procStart` raw, ruling T6-0) and run once, its record parsed (a send that may have reached the pane but
 * cannot be confirmed is `unconfirmed`, ruling T11-18), the `result` row (`pane_tail_hash` = the tail the script
 * verified, ruling T6-5; every machine- or operator-derived text field masked, ruling T11-6) — or, when that row
 * cannot be written after the dial, 409 `unresolved` (ruling T11-16) — `markAnswered` for a sent card that asks (and the
 * session's latest card when it asks, ruling T11-19), and the answer. Nothing a session wrote is ever sent back: the
 * script carries the request's own text as base64 and nothing else (TM-020). The text never reaches a log line, an
 * error body or a thrown error; the `console.submit` line carries `{ cardId, machine, outcome, bytes, correlationId,
 * sessionIdHash }`, the row's masked `reason` and, for a caught error, its class and code — never its message.
 *
 * Trust boundary (R1): the state payload is the store's masked faces plus the poller's health; a session's
 * `cwd`, `procStart` and `waitingFor` never leave the server (an explicit allow-list projection, so a column added
 * to the row type is a compile error here until it is deliberately exposed; the page uses none of the three, and
 * `stateReason` already carries the masked waitingFor — final review M1). The expand route dials the card's
 * machine on demand through `expandCard`, with the output cap derived from the card's own byte range; nothing is
 * persisted.
 * Every error outcome is a labelled state with a first-party message: a fixed text for a malformed or unknown
 * id, the gateway's own refusal for a machine that may not be dialled (logicalName only, never user@host),
 * and `expandCard`'s messages otherwise — never an exception's text (§8/TM-008).
 *
 * Pane view (F2 Task 12, spec §6.4 — a commit approval's second step): CDF answers the first id by showing the question,
 * the staged change and the hooks in the session and asking for the id again; the page shows that screen on the card.
 * Commit-approval cards only (409 `not_commit_approval`); the session must be one Submit could reach (`targetSession`
 * and the gateway's machine rule, 409 `not_reachable`). One dial of `buildPaneTailCommand` for the stored row's pane,
 * its record read with the probe's parser; the text passes the console mask WHOLE, then is cut to its last 60 lines and
 * 8 KiB. Operator guard only — it types nothing — and nothing of it is stored (R1): the answer and the page carry it, a
 * log line never (`console.pane_view`: card, machine, correlation id and size; a failure's reason and error class).
 */

import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { NeedsKind } from "../../console/cards.js";
import { buildDeliverCommand, PANE_IN_COPY_MODE, parseDeliverOutput, type DeliverPlan, type DeliverReport } from "../../console/deliver-command.js";
import { expandCard, type ExpandResult } from "../../console/expand.js";
import { maskSubmitText } from "../../console/masking.js";
import { STDERR_LOGGER, type ConsolePoller, type MachineHealth, type PollerLogger } from "../../console/poller.js";
import { parseProbeOutput } from "../../console/probe.js";
import { buildPaneTailCommand, PROBE_MAX_OUTPUT_BYTES, ProbeError } from "../../console/probe-command.js";
import type { ConsoleSettingsResult, ProjectSettings } from "../../console/settings.js";
import type { ConsoleCardRow, ConsoleSessionRow, SqliteConsoleStore, SubmitLogFields, SubmitLogOutcome } from "../../console/store.js";
import { IDEMPOTENCY_KEY_RE, validateSubmitText, type SubmitOutcome } from "../../console/submit.js";
import { remoteCommandFailure, SshConnectionError, type RemoteCommand, type RemoteCommandOptions, type RemoteCommandResult } from "../../devmachine/connection.js";
import type { SshTarget } from "../../devmachine/provisioning.js";
import { resolveConnectableMachine, TerminalError, type ConnectableMachine } from "../../devmachine/terminal-gateway.js";
import type { RemoteExec } from "../../devmachine/tmux.js";
import { timingSafeEqualStr } from "../auth/operator-auth.js";
import type { SessionStore } from "../auth/session.js";
import { cookieSessionId, requireElevated, sessionIdHash, type StepUpWindow } from "../auth/step-up.js";
import { requestBase } from "../base-path.js";
import { renderConsolePage } from "../console-page.js";
import { registerConsoleSessionRoutes, type ConsoleRouteShared } from "./console-sessions.js";
import type { HarnessRoutesDeps } from "./harness.js";

/** A card id is the store's 32-hex digest; anything else is refused with a fixed message (never echoed). */
export const CARD_ID_RE = /^[0-9a-f]{32}$/;
/** Per-expand budget, connect + run (the probe's own 4 s). */
export const EXPAND_TIMEOUT_MS = 4000;
/** Per-Submit budget, connect + the delivery script (its own ~0.5 s settle before the second capture). */
const SUBMIT_TIMEOUT_MS = 6000;
/** The delivery script prints one record line; 64 KiB leaves room for any login banner around it. */
const SUBMIT_MAX_OUTPUT_BYTES = 65536;
/** History lines above the visible pane in the script's menu check and tail hashes. */
const SUBMIT_TAIL_LINES = 40;
/** A machine shell drawer's tmux session (`sh-<name>`, Task 7): never a Submit target. */
const SHELL_SESSION_PREFIX = "sh-";
/** The §9 messages for the outcomes other than `sent` (whose wording is `outcomeMessage`'s). */
const OUTCOME_MESSAGES: Readonly<Record<Exclude<SubmitOutcome, "sent">, string>> = {
  refused_target_changed: "The session this card came from has ended or was cleared",
  refused_menu_visible: "This session is showing a prompt — open its Claude session",
  failed: "Send failed — the text is still in the box",
  // Ruling T11-18: the text may already sit in the pane — a re-send would double it.
  unconfirmed: "Could not confirm the send — check the Claude session before sending again"
};
/** Triage 19 (F-3): a `refused_menu_visible` whose reason is the pane's copy mode gets its own words (the page shows them). */
const COPY_MODE_MESSAGE = "the session is in copy mode — press q in the Claude session, then Submit again";
/** Ruling T6-3: an `attempted` row without a result — the text may or may not have been pasted; only Karl can tell. */
const UNRESOLVED_MESSAGE = "A send with this key did not finish — check the session before retrying";
/**
 * A literal set, so TypeScript will not force it: every `SubmitOutcome` must be listed, or a replayed key whose stored
 * outcome is missing here answers 400 `invalid_key` (ruling T11-18 added `unconfirmed`).
 */
const SUBMIT_OUTCOMES: ReadonlySet<string> = new Set<SubmitOutcome>(["sent", "refused_target_changed", "refused_menu_visible", "failed", "unconfirmed"]);
/**
 * Cards in one state payload, per group: up to this many needs-you cards (newest first), then up to this many of
 * the newest cards not already listed — so a needs-you card older than the newest 200 still reaches the page
 * (final review I4).
 */
const STATE_CARD_LIMIT = 200;
/** Room for the login banner, the record prefix and the end marker around the base64 slice. */
const EXPAND_SLACK_BYTES = 4096;
/** Pane view (F2 Task 12): connect + capture, expand's budget; one tail record (base64) and `end` fit in 64 KiB. */
const PANE_VIEW_TIMEOUT_MS = 4000;
const PANE_VIEW_MAX_OUTPUT_BYTES = 65536;
/** History lines captured above the visible pane, so the view still has 60 lines when the visible rows are blank. */
const PANE_VIEW_HISTORY_LINES = 60;
/** What the card shows of the masked screen: its last 60 lines, and of those the last 8 KiB. */
const PANE_VIEW_MAX_LINES = 60;
const PANE_VIEW_MAX_BYTES = 8 * 1024;

/**
 * `runRemoteCommand` bound to key custody, with the per-command output cap and timeout left to the caller:
 * the expand route caps each dial to the card's own range (a `RemoteExec` carries no options).
 */
export type ConsoleRemoteRun = (
  target: SshTarget,
  handle: string,
  command: RemoteCommand,
  opts: Required<RemoteCommandOptions>
) => Promise<RemoteCommandResult>;

export interface ConsoleRoutesDeps {
  readonly registry: HarnessRoutesDeps["registry"];
  readonly store: SqliteConsoleStore;
  readonly poller: ConsolePoller;
  /** The loaded settings file; a refused file disables the page (banner naming the entry) and the API says so. */
  readonly settings: ConsoleSettingsResult;
  readonly exec: ConsoleRemoteRun;
  readonly mask: (t: string) => string;
  /** Whether operator login is enabled (controls the Log out control on the page). */
  readonly loginEnabled: boolean;
  /** The passphrase step-up window (F2 Task 3, R4): ONE per process, shared with every route that consults it. */
  readonly stepUp: StepUpWindow;
  /**
   * The app's RESOLVED session store and the operator passphrase, both present only while login is enabled: the
   * step-up routes consult the store the guard and `/login` share and compare against the same passphrase. Absent →
   * both step-up routes answer 503 `step_up_unavailable` (no silent fallback; the page says login is disabled).
   */
  readonly sessions?: SessionStore;
  readonly operatorPassword?: string;
  /** Structured logger for the step-up audit lines (default: one JSON line per entry on stderr). */
  readonly log?: PollerLogger;
}

/** What `server.ts` supplies through `AppOptions.console`; `app.ts` adds the registry, `loginEnabled`, `sessions` and `operatorPassword`. */
export type ConsoleWiring = Pick<ConsoleRoutesDeps, "store" | "poller" | "settings" | "exec" | "mask" | "stepUp" | "log">;

/**
 * Ruling T11-15 (IV-2, F-7): the console's four POST routes (step-up, Submit, Dismiss, New Session) take JSON only —
 * a form body, a text body or no body at all is 415 before the route's own rules (formbody stays for `/login`), so a
 * same-site form post can never reach them and the strict UTF-8 JSON parser is the only door to their bodies.
 */
async function jsonOnly(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const mediaType = (req.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") {
    reply.header("Cache-Control", "no-store");
    await reply.code(415).send({ error: "unsupported_media_type" });
  }
}

/** `POST /console/api/step-up` takes exactly one of `passphrase: string` or `revoke: true` (ruling P-1). */
type StepUpRequest = { readonly passphrase: string } | { readonly revoke: true };

/** Anything else — both keys, neither, a non-string passphrase, `revoke` not `true`, an array, no body — is a bad request. */
function stepUpRequest(body: unknown): StepUpRequest | undefined {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
  const { passphrase, revoke } = body as { readonly passphrase?: unknown; readonly revoke?: unknown };
  if (typeof passphrase === "string" && revoke === undefined) return { passphrase };
  if (revoke === true && passphrase === undefined) return { revoke: true };
  return undefined;
}

/** A session as the API shows it: the stored row minus `cwd`, `procStart` and `waitingFor` (final review M1). */
export type ConsoleApiSession = Omit<ConsoleSessionRow, "cwd" | "procStart" | "waitingFor">;

export type ConsoleApiSettings =
  | { readonly pollSeconds: number; readonly allTabAreas: readonly string[]; readonly projects: Readonly<Record<string, ProjectSettings>> }
  | { readonly disabled: true; readonly entry: string };

export interface ConsoleStatePayload {
  readonly machines: readonly MachineHealth[];
  readonly sessions: readonly ConsoleApiSession[];
  /** Needs-you cards first, then the rest; newest first within each group. */
  readonly cards: readonly ConsoleCardRow[];
  readonly settings: ConsoleApiSettings;
}

/** An explicit allow-list, not a rest spread: a field added to `ConsoleSessionRow` fails to compile here until it is deliberately exposed. */
function apiSession(r: ConsoleSessionRow): ConsoleApiSession {
  return {
    machine: r.machine,
    tmuxSession: r.tmuxSession,
    paneId: r.paneId,
    claudePid: r.claudePid,
    sessionId: r.sessionId,
    projectKey: r.projectKey,
    reachable: r.reachable,
    status: r.status,
    state: r.state,
    stateReason: r.stateReason,
    transcriptOffset: r.transcriptOffset,
    transcriptSize: r.transcriptSize,
    lastSeenAt: r.lastSeenAt,
    endedAt: r.endedAt,
    version: r.version,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt
  };
}

/** The card's range as base64 (4/3) plus the probe's framing, never above the probe's own cap. */
const expandOutputCap = (card: ConsoleCardRow): number =>
  Math.min(PROBE_MAX_OUTPUT_BYTES, Math.ceil(((card.byteEnd - card.byteStart) * 4) / 3) + EXPAND_SLACK_BYTES);

/** `POST …/submit` answers 200 with this for every reported outcome: the outcome is the result, not a transport error. */
export interface SubmitOutcomeBody {
  readonly outcome: SubmitOutcome;
  /** The result row's `at`. */
  readonly at: string;
  readonly message: string;
}

/** What one Submit resolves to — the status and the body every request joined on its key returns verbatim (ruling T6-2). */
interface SubmitAnswer {
  readonly status: 200 | 400 | 409;
  readonly body: SubmitOutcomeBody | { readonly error: string; readonly message?: string };
}

/** The fields of a `console.submit` line — and nothing else: never the text, never the key, never the session id. */
interface SubmitLogLine {
  readonly cardId: string;
  readonly machine: string;
  readonly outcome: SubmitOutcome;
  readonly bytes: number;
  readonly correlationId: string;
  /** C2 (L4): the elevated operator session that authorised the send, as `sessionIdHash` — never the id (the cookie secret). */
  readonly sessionIdHash: string;
  /** D13 (L6): the row's first-party reason, masked as stored. */
  readonly reason?: string;
}

/** D13 (L5): a send that went is info; a refusal, a failure or a send that cannot be confirmed is warn. */
const submitLevel = (outcome: SubmitOutcome): "info" | "warn" => (outcome === "sent" ? "info" : "warn");

/** D13 (L6): what a log line may say about a caught error — its class and a code-shaped `code`, never its message. */
function errorClass(err: unknown): { readonly errName: string; readonly errCode?: string } {
  const errName = err instanceof Error ? err.name : typeof err;
  const code = typeof err === "object" && err !== null ? (err as { readonly code?: unknown }).code : undefined;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? { errName, errCode: code } : { errName };
}

/** The Submit body's two fields as received: `text` is judged by `validateSubmitText` (never trimmed), `key` by `IDEMPOTENCY_KEY_RE`. */
function submitRequest(body: unknown): { readonly text: unknown; readonly key: unknown } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { text: undefined, key: undefined };
  const { text, key } = body as { readonly text?: unknown; readonly key?: unknown };
  return { text, key };
}

/**
 * The card's status line for an outcome. A `sent` while the session was busy at send is "queued" (Claude Code queues
 * typed input — spec §6.6 6); otherwise a reply question is answered and any other card waits for the session. A
 * refusal because the pane is in copy mode says how to leave it (triage 19). The row's `reason` is passed, so a
 * replay recomputes the same words.
 */
function outcomeMessage(outcome: SubmitOutcome, statusAtSend: string | null, needsKind: NeedsKind | null, reason: string | null): string {
  if (outcome === "refused_menu_visible" && reason === PANE_IN_COPY_MODE) return COPY_MODE_MESSAGE;
  if (outcome !== "sent") return OUTCOME_MESSAGES[outcome];
  if (statusAtSend === "busy") return "queued — the session is busy";
  return needsKind === "reply_question" ? "answered by you" : "sent — waiting for the session";
}

const outcomeBody = (outcome: SubmitOutcome, at: string, statusAtSend: string | null, needsKind: NeedsKind | null, reason: string | null): SubmitOutcomeBody => ({
  outcome,
  at,
  message: outcomeMessage(outcome, statusAtSend, needsKind, reason)
});

/** A stored result row's outcome when it is a Submit's (Tasks 7–8 record their own outcomes under their own keys). */
const isSubmitOutcome = (outcome: SubmitLogOutcome | null): outcome is SubmitOutcome => outcome !== null && SUBMIT_OUTCOMES.has(outcome);

/** better-sqlite3's `SqliteError` for the unique `(idempotency_key, row_kind)` index (ruling T4-3), by its code (triage 52). */
const isUniqueViolation = (err: unknown): boolean =>
  typeof err === "object" && err !== null && (err as { readonly code?: unknown }).code === "SQLITE_CONSTRAINT_UNIQUE";

/** The card's session row when the console may type into it: known, reachable, not ended, not a machine shell. */
function targetSession(store: SqliteConsoleStore, card: ConsoleCardRow): ConsoleSessionRow | undefined {
  const row = store.listSessions(card.machine).find((s) => s.sessionId === card.sessionId);
  if (row === undefined || !row.reachable || row.endedAt !== null || row.tmuxSession.startsWith(SHELL_SESSION_PREFIX)) return undefined;
  return row;
}

/**
 * The delivery plan from the stored row: `procStart` RAW (ruling T6-0: the mask is transparent for timestamps), the
 * text as base64, and a tmux buffer named fresh for this Submit (triage 17, IV-5): two sends to one card never share
 * a buffer, so an interleaved `load-buffer` cannot paste the other send's text.
 */
const deliverPlan = (session: ConsoleSessionRow, text: string): DeliverPlan => ({
  sessionFile: `${session.claudePid}.json`,
  sessionId: session.sessionId,
  procStart: session.procStart,
  pid: session.claudePid,
  paneId: session.paneId,
  textB64: Buffer.from(text, "utf8").toString("base64"),
  bufferId: `console-${randomBytes(4).toString("hex")}`,
  tailLines: SUBMIT_TAIL_LINES
});

/** What one delivery resolved to: the report, and the error when the dial threw (the log line names its class only). */
interface Delivery {
  readonly report: DeliverReport;
  readonly thrown?: unknown;
}

/**
 * Build, dial and parse — never throws for a stored value outside the builder's allow-list (`ProbeError`, `failed`
 * `plan_refused`) or a dial that dies (Review Focus 3), so the result row always follows the write-ahead row. Ruling
 * T11-18 sorts a dial that threw by whether the exec request had been sent: before it nothing ran (`failed`, reason
 * `connect_failed` — the text is still in the box); after it the text may sit in the pane (`unconfirmed`, reason
 * `timeout` / `ssh_failed` / `exec_error` — check the session before sending again). The script's own outcomes come
 * from `parseDeliverOutput`. A builder throw that is not a `ProbeError` is a defect and stays loud.
 */
async function runDelivery(deps: ConsoleRoutesDeps, conn: ConnectableMachine, plan: DeliverPlan): Promise<Delivery> {
  let command: RemoteCommand;
  try {
    command = buildDeliverCommand(plan);
  } catch (err) {
    if (err instanceof ProbeError) return { report: { outcome: "failed", statusAtSend: "", detail: "plan_refused" } };
    throw err;
  }
  try {
    const run = await deps.exec(conn.target, conn.handle, command, { timeoutMs: SUBMIT_TIMEOUT_MS, maxOutputBytes: SUBMIT_MAX_OUTPUT_BYTES });
    return { report: parseDeliverOutput(run.stdout, run.code) };
  } catch (err) {
    const failure = remoteCommandFailure(err);
    return { report: { outcome: failure.mayHaveRun ? "unconfirmed" : "failed", statusAtSend: "", detail: failure.reason }, thrown: err };
  }
}

/** `GET …/pane` answers 200 with this (F2 Task 12): the masked, capped screen, when it was read, and whether it was cut. */
export interface PaneViewBody {
  readonly tail: string;
  /** ISO time the machine's answer arrived. */
  readonly capturedAt: string;
  readonly truncated: boolean;
}

/** One pane read: the screen as the machine sent it (NOT masked yet), or a first-party failure and its log fields. */
type PaneRead =
  | { readonly ok: true; readonly text: string; readonly capturedAt: string }
  | { readonly ok: false; readonly message: string; readonly reason: string; readonly exitCode?: number; readonly thrown?: unknown };

/**
 * Build, dial and parse one pane-tail command (F2 Task 12). Never throws for a stored pane id outside the builder's
 * allow-list (`plan_refused`, nothing dialled) or a dial that dies; a builder throw that is not a `ProbeError` is a
 * defect and stays loud. The record is the probe's own (`parseProbeOutput`), trusted only with its `end` marker. Every
 * message is first-party in expand's wording and names the machine's logicalName only — never user@host, an error's
 * text or the machine's stderr (§8/TM-008).
 */
async function readPane(deps: ConsoleRoutesDeps, conn: ConnectableMachine, paneId: string): Promise<PaneRead> {
  const name = conn.target.logicalName;
  let command: RemoteCommand;
  try {
    command = buildPaneTailCommand(paneId, PANE_VIEW_HISTORY_LINES);
  } catch (err) {
    if (err instanceof ProbeError) return { ok: false, message: `the screen request for ${name} was refused — ${err.message}`, reason: "plan_refused" };
    throw err;
  }
  let run: RemoteCommandResult;
  try {
    run = await deps.exec(conn.target, conn.handle, command, { timeoutMs: PANE_VIEW_TIMEOUT_MS, maxOutputBytes: PANE_VIEW_MAX_OUTPUT_BYTES });
  } catch (err) {
    const ssh = err instanceof SshConnectionError;
    const why = ssh && /timed out/.test(err.message) ? "timed out waiting for the machine" : ssh ? "SSH connection failed" : "could not read the session's screen over SSH";
    return { ok: false, message: `${name} unreachable — ${why}`, reason: remoteCommandFailure(err).reason, thrown: err };
  }
  const capturedAt = new Date().toISOString();
  if (run.code !== 0) return { ok: false, message: `reading the session's screen on ${name} failed (exit ${run.code})`, reason: "exit_nonzero", exitCode: run.code };
  const report = parseProbeOutput(run.stdout);
  if (!report.ended) {
    return { ok: false, message: `the session's screen from ${name} ended early — no end marker (cut at the output cap or interrupted)`, reason: "cut_short" };
  }
  const text = report.tails.get(paneId);
  if (text === undefined) return { ok: false, message: `the session's screen did not come back from ${name}`, reason: "no_record" };
  // A pane that is gone captures nothing (`capture-pane` fails into /dev/null): an empty screen is a failed read (M-1).
  if (text.trim() === "") return { ok: false, message: `the session's screen came back empty from ${name} — the pane may have closed`, reason: "empty_capture" };
  return { ok: true, text, capturedAt };
}

/**
 * What the card shows of an ALREADY MASKED screen (F2 Task 12). Masking comes first, so a cut can only shorten masked
 * text — never leave a token short of its pattern. Trailing blank rows go first (tmux prints every row of the visible
 * pane: a tall pane's empty bottom would push the text out of the view), then the last 60 lines are kept, then their
 * last 8 KiB, cut on a UTF-8 character boundary. `truncated` says whether either cut took anything.
 */
function capPaneTail(masked: string): { readonly tail: string; readonly truncated: boolean } {
  const lines = masked.split("\n");
  while (lines.length > 0 && (lines[lines.length - 1] ?? "").trim() === "") lines.pop();
  let truncated = lines.length > PANE_VIEW_MAX_LINES;
  let tail = lines.slice(-PANE_VIEW_MAX_LINES).join("\n");
  const bytes = Buffer.from(tail, "utf8");
  if (bytes.length > PANE_VIEW_MAX_BYTES) {
    let start = bytes.length - PANE_VIEW_MAX_BYTES;
    // A UTF-8 continuation byte is 10xxxxxx: step past it to the first byte of the next character.
    while (start < bytes.length && ((bytes[start] ?? 0) & 0xc0) === 0x80) start++;
    tail = bytes.subarray(start).toString("utf8");
    truncated = true;
  }
  return { tail, truncated };
}

export function registerConsoleRoutes(app: FastifyInstance, deps: ConsoleRoutesDeps): void {
  const settings = deps.settings;

  // ---- The page (guarded; text/html → the app's onSend hook adds no-store and frame-ancestors 'self') ----
  app.get("/console", async (req, reply) => {
    reply
      .type("text/html")
      .send(renderConsolePage({ base: requestBase(req), loginEnabled: deps.loginEnabled, ...(settings.ok ? {} : { disabled: { entry: settings.entry } }) }));
  });

  // ---- State the page polls (guarded; JSON; no-store) ----
  app.get("/console/api/state", { exposeHeadRoute: false }, async (_req, reply): Promise<ConsoleStatePayload> => {
    reply.header("Cache-Control", "no-store");
    const flagged = deps.store.listCards({ needsYouOnly: true }, STATE_CARD_LIMIT);
    const listed = new Set(flagged.map((c) => c.id));
    const newest = deps.store.listCards({}, STATE_CARD_LIMIT).filter((c) => !listed.has(c.id));
    return {
      machines: deps.poller.health(),
      sessions: deps.store.listSessions().map(apiSession),
      cards: [...flagged, ...newest],
      settings: settings.ok
        ? { pollSeconds: settings.settings.pollSeconds, allTabAreas: settings.settings.allTabAreas, projects: settings.settings.projects }
        : { disabled: true, entry: settings.entry }
    };
  });

  // ---- Passphrase step-up (F2 Task 3, R4; rulings P-1, T3-0, T3-1): the window the typing routes consult. Guarded;
  // JSON; no-store; no HEAD. Both routes need the app's session store and the operator passphrase: without login
  // they answer 503, never a silently open or closed window. ----
  const stepUpAuth =
    deps.sessions !== undefined && deps.operatorPassword !== undefined ? { sessions: deps.sessions, operatorPassword: deps.operatorPassword } : undefined;
  const log = deps.log ?? STDERR_LOGGER;
  /**
   * One structured line; a throwing logger must not break the answer (the poller's rule) — shared with the Task 8
   * routes. A caught error adds its class and code only (D13), never its message: an SSH error names user@host.
   */
  const logEvent: ConsoleRouteShared["logEvent"] = (level, entry, msg, err) => {
    const fields = err === undefined ? entry : { ...entry, ...errorClass(err) };
    const write = (sink: PollerLogger, e: object): void => (level === "error" ? sink.error(e, msg) : level === "warn" ? sink.warn(e, msg) : sink.info(e, msg));
    try {
      write(log, fields);
    } catch {
      write(STDERR_LOGGER, { ...fields, loggerFailed: true });
    }
  };
  /**
   * One audit line per outcome with the HASHED session id (none for a bearer-only caller) and the request id as
   * correlation id (C2). A refusal is a warn line (D13: L5, L7); an elevation or a revocation is info.
   */
  const logStepUp = (action: "elevate" | "refuse" | "revoke" | "refuse_cookie_only", correlationId: string, sessionId?: string): void => {
    const level = action === "refuse" || action === "refuse_cookie_only" ? "warn" : "info";
    const who = sessionId !== undefined ? { sessionIdHash: sessionIdHash(sessionId) } : {};
    logEvent(level, { event: "console.step_up", action, ...who, correlationId }, `console step-up: ${action}`);
  };

  app.get("/console/api/step-up", { exposeHeadRoute: false }, async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    if (stepUpAuth === undefined) {
      reply.code(503);
      return { error: "step_up_unavailable" };
    }
    // A bearer-only caller has no session and so no window: null, not an error — the page's dialog decides.
    const sid = cookieSessionId(req, stepUpAuth.sessions);
    return { elevatedUntil: sid !== undefined ? (deps.stepUp.elevatedUntil(sid) ?? null) : null };
  });

  app.post("/console/api/step-up", { exposeHeadRoute: false, preValidation: jsonOnly }, async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    if (stepUpAuth === undefined) {
      reply.code(503);
      return { error: "step_up_unavailable" };
    }
    // The session before the body: a bearer-only caller never reaches the body rules or the compare.
    const sid = cookieSessionId(req, stepUpAuth.sessions);
    if (sid === undefined) {
      logStepUp("refuse_cookie_only", req.id);
      reply.code(403);
      return { error: "step_up_cookie_only" };
    }
    const body = stepUpRequest(req.body);
    if (body === undefined) {
      reply.code(400);
      return { error: "bad_request" };
    }
    if ("revoke" in body) {
      deps.stepUp.revoke(sid);
      logStepUp("revoke", req.id, sid);
      return reply.code(204).send();
    }
    // Ruling T3-0: the timing-safe compare is the whole defence here — no artificial delay, no rate limit.
    if (!timingSafeEqualStr(body.passphrase, stepUpAuth.operatorPassword)) {
      logStepUp("refuse", req.id, sid);
      reply.code(403);
      return { error: "step_up_refused" };
    }
    const elevatedUntil = deps.stepUp.elevate(sid);
    logStepUp("elevate", req.id, sid);
    return { elevatedUntil };
  });

  // ---- On-demand expand of one card (guarded; JSON; no-store; labelled states) ----
  app.get<{ Params: { id: string } }>("/console/api/cards/:id/expand", { exposeHeadRoute: false }, async (req, reply): Promise<ExpandResult> => {
    reply.header("Cache-Control", "no-store");
    const id = req.params.id;
    if (!CARD_ID_RE.test(id)) {
      reply.code(400);
      return { state: "failed", message: "unexpected card id" };
    }
    const card = deps.store.getCard(id);
    if (card === undefined) {
      reply.code(404);
      return { state: "failed", message: "no such card" };
    }
    let conn: ConnectableMachine;
    try {
      // The same fail-closed rule as opening a terminal: unknown / disabled / unprovisioned never dials (TM-020).
      conn = resolveConnectableMachine(card.machine, deps.registry);
    } catch (err) {
      reply.code(409);
      return { state: "failed", message: err instanceof TerminalError ? err.message : "machine is not connectable" };
    }
    const opts = { maxOutputBytes: expandOutputCap(card), timeoutMs: EXPAND_TIMEOUT_MS };
    const exec: RemoteExec = (target, handle, command) => deps.exec(target, handle, command, opts);
    const result = await expandCard(card, conn.target, conn.handle, exec, deps.mask);
    reply.code(result.state === "ok" || result.state === "changed" ? 200 : 502);
    return result;
  });

  // ---- The commit approval's second step (F2 Task 12, spec §6.4): the session's screen on demand. Guarded (operator
  // guard only: it types nothing; masked, capped and never stored — R1, the expand posture); JSON; no-store; no HEAD. ----
  app.get<{ Params: { id: string } }>("/console/api/cards/:id/pane", { exposeHeadRoute: false }, async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const id = req.params.id;
    if (!CARD_ID_RE.test(id)) {
      reply.code(400);
      return { error: "unexpected card id" };
    }
    const card = deps.store.getCard(id);
    if (card === undefined) {
      reply.code(404);
      return { error: "no such card" };
    }
    if (card.kind !== "commit_approval") {
      reply.code(409);
      return { error: "not_commit_approval" };
    }
    // Submit's reachability: a live, targetable Claude pane on a machine the gateway may dial (TM-020).
    const session = targetSession(deps.store, card);
    let conn: ConnectableMachine | undefined;
    try {
      conn = session !== undefined ? resolveConnectableMachine(card.machine, deps.registry) : undefined;
    } catch (err) {
      if (!(err instanceof TerminalError)) throw err;
    }
    if (session === undefined || conn === undefined) {
      reply.code(409);
      return { error: "not_reachable" };
    }
    const line = { cardId: card.id, machine: card.machine, correlationId: req.id };
    const read = await readPane(deps, conn, session.paneId);
    if (!read.ok) {
      const exit = read.exitCode !== undefined ? { exitCode: read.exitCode } : {};
      logEvent("warn", { event: "console.pane_view", ...line, reason: read.reason, ...exit }, `console pane view: ${read.reason}`, read.thrown);
      reply.code(502);
      return { error: "unreachable", message: read.message };
    }
    const view = capPaneTail(deps.mask(read.text));
    logEvent("info", { event: "console.pane_view", ...line, bytes: Buffer.byteLength(view.tail, "utf8") }, "console pane view");
    const body: PaneViewBody = { tail: view.tail, capturedAt: read.capturedAt, truncated: view.truncated };
    return body;
  });

  // ---- Submit (F2 Task 6; spec §6.6, R4, R6, TM-020): the one route that types into a session. Guarded; JSON only;
  // step-up; no-store; no HEAD. Checks in order: step-up → card → key → text → (join) → replay → reachability →
  // write-ahead → build → exec → parse → result row → answer. ----
  /** One `console.submit` line per recorded outcome: the line's fields only (never the text, the key or the session id). */
  const logSubmit = (level: "info" | "warn" | "error", fields: SubmitLogLine, msg: string, err?: unknown): void =>
    logEvent(level, { event: "console.submit", ...fields }, msg, err);

  /**
   * In-flight Submits by idempotency key (ruling T6-2): a second request for a key awaits the first's answer — only
   * for the same card and the same text (ruling T11-21, IV-4), compared through the text's SHA-256.
   */
  const inFlight = new Map<string, { readonly cardId: string; readonly textHash: string; readonly answer: Promise<SubmitAnswer> }>();

  /**
   * Karl's `sent` reached the session (ruling T11-19, I-2): the submitted card and the session's latest card are each
   * marked answered when they ask him something, so the poller's sticky reply question does not come back while
   * Claude works; a sentinel or waiting flag still up stays raised (store.ts `markAnswered`). A failure here is logged
   * at error and never changes the answer (ruling T11-10): the send is recorded.
   */
  function markAnsweredAfterSend(card: ConsoleCardRow, at: string, line: Omit<SubmitLogLine, "outcome">): void {
    try {
      if (card.asksYou) deps.store.markAnswered(card.id, at);
      const latest = deps.store.latestCard(card.machine, card.sessionId);
      if (latest !== undefined && latest.id !== card.id && latest.asksYou) deps.store.markAnswered(latest.id, at);
    } catch (err) {
      logSubmit("error", { ...line, outcome: "sent" }, "console submit: sent, but the card was not marked answered", err);
    }
  }

  /**
   * One Submit once step-up, card, key and text have passed. Every dial is preceded by an `attempted` row and followed
   * by a `result` row (R6); the text reaches `maskSubmitText` (the audit copy) and the script (as base64) exactly as
   * received, and nothing else — not a log line, not a body, not an error. Every machine- or operator-derived text
   * field of a row (`status_at_send`, `reason`, `tmux_session`) passes the console mask first (ruling T11-6).
   */
  async function submitOnce(card: ConsoleCardRow, key: string, text: string, bytes: number, correlationId: string, operator: string): Promise<SubmitAnswer> {
    // Replay (R6): a key with a stored result answers from the log, whatever the session does now — for its own card
    // only (ruling T11-21).
    const stored = deps.store.findSubmitResult(key);
    if (stored !== undefined) {
      if (!isSubmitOutcome(stored.outcome) || stored.cardId !== card.id) return { status: 400, body: { error: "invalid_key" } };
      return { status: 200, body: outcomeBody(stored.outcome, stored.at, stored.statusAtSend, card.needsKind, stored.reason) };
    }
    // Reachability: a menu card has no Submit (its answer would be a choice the session drew — TM-020), nor has a
    // session showing a prompt (status `waiting`, ruling T11-20 — the script would refuse it); the session must be a
    // live, targetable Claude pane on a machine the gateway may dial (the expand route's fail-closed rule).
    if (card.kind === "menu") return { status: 409, body: { error: "menu_card" } };
    const session = targetSession(deps.store, card);
    if (session === undefined) return { status: 409, body: { error: "not_reachable" } };
    if (session.status === "waiting") return { status: 409, body: { error: "menu_card" } };
    let conn: ConnectableMachine;
    try {
      conn = resolveConnectableMachine(card.machine, deps.registry);
    } catch {
      return { status: 409, body: { error: "not_reachable" } };
    }
    const line = { cardId: card.id, machine: card.machine, bytes, correlationId, sessionIdHash: operator };
    const fields: Omit<SubmitLogFields, "at"> = {
      idempotencyKey: key,
      machine: card.machine,
      tmuxSession: deps.mask(session.tmuxSession),
      paneId: session.paneId,
      claudePid: session.claudePid,
      sessionId: session.sessionId,
      procStart: session.procStart,
      statusAtSend: deps.mask(session.status),
      cardId: card.id
    };
    // Write-ahead (R6): the `attempted` row, carrying the audit-masked text (ruling T11-14), goes in before any dial.
    try {
      deps.store.appendSubmitLog({ ...fields, at: new Date().toISOString(), rowKind: "attempted", textMasked: maskSubmitText(text) });
    } catch (err) {
      // Ruling T6-3: this key's `attempted` row exists without a result — a request that died mid-flight, or one
      // that missed the join. Nothing is dialled; the text stays in the box. The only runtime sign of it: one warn line.
      if (isUniqueViolation(err)) {
        logEvent("warn", { event: "console.submit_unresolved", ...line }, "console submit: the key has an attempted row and no result");
        return { status: 409, body: { error: "unresolved", message: UNRESOLVED_MESSAGE } };
      }
      // Ruling T6-4: no dial without its write-ahead row — record the failure as the key's result, or fail loud.
      const at = new Date().toISOString();
      const failure = { ...line, outcome: "failed" as const, reason: "audit_write_failed" };
      try {
        deps.store.appendSubmitLog({ ...fields, at, rowKind: "result", outcome: "failed", reason: "audit_write_failed" });
      } catch (second) {
        logSubmit("error", failure, "console submit: audit write failed twice", second);
        throw second;
      }
      logSubmit("error", failure, "console submit: failed (audit_write_failed)", err);
      return { status: 200, body: outcomeBody("failed", at, fields.statusAtSend ?? null, card.needsKind, "audit_write_failed") };
    }
    const { report, thrown } = await runDelivery(deps, conn, deliverPlan(session, text));
    // The status the script verified at send (the row's when it reported none), and the row's reason: masked, stored
    // and shown alike, so a replay recomputes the same wording.
    const statusAtSend = deps.mask(report.statusAtSend !== "" ? report.statusAtSend : session.status);
    const reason = report.detail !== "" ? deps.mask(report.detail) : undefined;
    const outcomeLine: SubmitLogLine = { ...line, outcome: report.outcome, ...(reason !== undefined ? { reason } : {}) };
    const at = new Date().toISOString();
    try {
      deps.store.appendSubmitLog({
        ...fields,
        at,
        rowKind: "result",
        outcome: report.outcome,
        statusAtSend,
        ...(reason !== undefined ? { reason } : {}),
        // Ruling T6-5: the tail the script verified; the after-paste hash is advisory and not persisted.
        ...(report.tailHashBefore !== undefined ? { paneTailHash: report.tailHashBefore } : {})
      });
    } catch (err) {
      // Ruling T11-16: the dial happened and cannot be recorded. The key stays unresolved (T6-3), and this first
      // answer already says so — a retry with the key meets the same 409, never a second paste.
      logSubmit("error", outcomeLine, "console submit: result row not written", err);
      return { status: 409, body: { error: "unresolved", message: UNRESOLVED_MESSAGE } };
    }
    logSubmit(submitLevel(report.outcome), outcomeLine, `console submit: ${report.outcome}`, thrown);
    if (report.outcome === "sent") markAnsweredAfterSend(card, at, line);
    return { status: 200, body: outcomeBody(report.outcome, at, statusAtSend, card.needsKind, reason ?? null) };
  }

  app.post<{ Params: { id: string } }>("/console/api/cards/:id/submit", { exposeHeadRoute: false, preValidation: jsonOnly }, async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    if (stepUpAuth === undefined) {
      reply.code(503);
      return { error: "step_up_unavailable" };
    }
    const elevation = requireElevated(req, stepUpAuth.sessions, deps.stepUp);
    if (!elevation.ok) {
      // D13 (L7): a denial on a typing route is one warn line — the reason and the request id, nothing else.
      logEvent("warn", { event: "console.submit_denied", reason: elevation.reason, correlationId: req.id }, "console submit: denied");
      reply.code(elevation.status);
      return { error: elevation.reason };
    }
    const id = req.params.id;
    if (!CARD_ID_RE.test(id)) {
      reply.code(400);
      return { error: "unexpected card id" };
    }
    const card = deps.store.getCard(id);
    if (card === undefined) {
      reply.code(404);
      return { error: "no such card" };
    }
    const { text, key } = submitRequest(req.body);
    if (typeof key !== "string" || !IDEMPOTENCY_KEY_RE.test(key)) {
      reply.code(400);
      return { error: "invalid_key" };
    }
    // Refuses, never strips: the 400 names the reason and nothing else — the text is never echoed.
    const valid = validateSubmitText(text);
    if (!valid.ok) {
      reply.code(400);
      return { error: valid.reason };
    }
    // Ruling T6-2 (Review Focus 4): a Submit already in flight for this key answers this request too — one dial — but
    // only for the same card and text (ruling T11-21): anything else reusing the key is 400 invalid_key.
    const textHash = createHash("sha256").update(valid.text).digest("hex");
    let flight = inFlight.get(key);
    if (flight !== undefined && (flight.cardId !== card.id || flight.textHash !== textHash)) {
      reply.code(400);
      return { error: "invalid_key" };
    }
    if (flight === undefined) {
      const answer = submitOnce(card, key, valid.text, valid.bytes, req.id, sessionIdHash(elevation.sessionId)).finally(() => inFlight.delete(key));
      flight = { cardId: card.id, textHash, answer };
      inFlight.set(key, flight);
    }
    const answer = await flight.answer;
    reply.code(answer.status);
    return answer.body;
  });

  // ---- Dismiss (F2 Task 6): the card's own flag; no session is touched, so no step-up. Guarded; JSON only; no-store;
  // no HEAD. One info line per dismissal (D13, L8). ----
  app.post<{ Params: { id: string } }>("/console/api/cards/:id/dismiss", { exposeHeadRoute: false, preValidation: jsonOnly }, async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const id = req.params.id;
    if (!CARD_ID_RE.test(id)) {
      reply.code(400);
      return { error: "unexpected card id" };
    }
    const card = deps.store.markDismissed(id, new Date().toISOString());
    if (card === undefined) {
      reply.code(404);
      return { error: "no such card" };
    }
    logEvent("info", { event: "console.card_dismissed", cardId: card.id, correlationId: req.id }, "console card dismissed");
    return { dismissedAt: card.dismissedAt };
  });

  // ---- New-session flow (F2 Task 8): the projects root's folders and New Session / New Project, behind the same
  // step-up window and logger. ----
  registerConsoleSessionRoutes(app, deps, { stepUpAuth, logEvent, jsonOnly });
}
