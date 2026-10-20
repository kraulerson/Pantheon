/**
 * Maestro Console new-session routes (F2 Task 8; spec §14.1, R4, R6, TM-020; ADR-0010), registered by
 * `registerConsoleRoutes` next to Submit and sharing its guard, step-up, machine-resolution and audit conventions:
 *
 *   GET  /console/api/machines/:name/projects → { root, projects: [{ name, path, running }], dropped }
 *                                               400 / 409 not_connectable / 409 no_projects_root / 502 labelled
 *   POST /console/api/machines/:name/sessions → { folder } | { newProject } (step-up): 200 { tmuxSession, path,
 *                                               outcome, message } for every reported outcome; 400 refused_root /
 *                                               refused_name / bad_request; 403 / 409 / 503 labelled
 * Both: operator guard (app.ts), JSON, `Cache-Control: no-store`, no HEAD; a cross-site POST is refused by the app
 * rule before the handler runs.
 *
 * The list needs the operator guard only (it reads); creation sits behind the passphrase step-up exactly as Submit
 * does. The projects root is the machine's `machines.<name>.projectsRoot` settings entry (Task 7): a machine without
 * one has no list and no new-session flow. The machine's listing is `trusted:false`: every path it reports goes
 * through the ONE admissibility rule `admissiblePath` (session-command.ts, ruling T8-7 — strictly under the root,
 * no hidden segment, the remote-directory rule, a `PROJECT_NAME_RE` basename) and a path it refuses is counted into
 * `dropped` with the parser's own drops, so a crafted record can put nothing outside the root into `projects`.
 * `running` is the `projectKey` of a live session row (`endedAt` null) of THIS machine whose `cwd` is the folder; an
 * `sh-<name>` machine shell never counts.
 *
 * Creation, in order: step-up → machine name shape → the registry's fail-closed rule → root → body (exactly one of
 * `folder` / `newProject`, a string) → the path resolved under the root (`path.posix.resolve`; not strictly under
 * `<root>/` is `refused_root` — lexical: a symlink inside the root may point outside it, a recorded residual) → an
 * existing `folder` through the same `admissiblePath` rule the list applied, so what was listed can be started
 * (`refused_name` otherwise); a `newProject` is one `PROJECT_NAME_RE` name placed directly under the root
 * (`assertProjectName`, then the same rule for the byte bound) → the tmux name (`tmuxNameForFolder`) → the
 * write-ahead `attempted` row (R6: before any dial; ruling T8-2: one server-minted key per request, so a second
 * identical request is a second creation) → the live tmux list, against which the name is suffixed `-2`, `-3`, … →
 * the create script, built and run once → its record (a `created` record naming any other session than the plan's
 * is a malformed record → `failed`) → the `result` row (`created_session` / `created_project` / `failed`, carrying
 * the FINAL name; the `attempted` row carries the base name, known before the list) → the answer. A refusal
 * (`refused_root`, `refused_name`) writes its `attempted` row and its `refused_*` result row and dials nothing. The
 * script's `has-session` miss is the race guard (`failed`, "session already exists"). A dial that throws before the
 * script was sent is `failed` with the lister's first-party wording (timeout / SSH failure / could not run); once it
 * was sent, or when no record comes back, the start is `unconfirmed` (ruling T11-18: "check the machine's tmux
 * sessions"). A path the console mask would alter is dropped from the list and refused `refused_name` (ruling T11-8);
 * the stored tmux name and reason pass the mask (ruling T11-6). An audit row that cannot be written fails loud (500):
 * nothing is dialled without its write-ahead row, and a dial that cannot be recorded is logged at error level.
 *
 * The `console.session_create` line carries `{ machine, outcome, correlationId, sessionIdHash }`, the row's masked
 * `reason` and, for a caught error, its class and code — nothing else: the folder name and path are operator-typed
 * values and reach no log line, no error body and no thrown error. The 200 body returns the server-resolved path and
 * the allow-listed tmux name only; every message is first-party text (§8/TM-008).
 */

import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ProbeError } from "../../console/probe-command.js";
import {
  LIST_PROJECTS_MAX_OUTPUT_BYTES,
  MALFORMED_RECORD_DETAIL,
  admissiblePath,
  assertProjectName,
  buildCreateSessionCommand,
  buildListProjectsCommand,
  parseCreateSessionOutput,
  parseListProjectsOutput,
  segmentsUnderRoot,
  tmuxNameForFolder,
  type ProjectEntry
} from "../../console/session-command.js";
import { projectsRootFor } from "../../console/settings.js";
import type { SubmitLogFields, SubmitLogOutcome } from "../../console/store.js";
import { remoteCommandFailure, SshConnectionError, type RemoteCommand, type RemoteCommandOptions, type RemoteCommandResult } from "../../devmachine/connection.js";
import { resolveConnectableMachine, TerminalError, type ConnectableMachine } from "../../devmachine/terminal-gateway.js";
import { listTmuxSessions, TMUX_SESSION_NAME_MAX, type RemoteExec } from "../../devmachine/tmux.js";
import { requireElevated, sessionIdHash } from "../auth/step-up.js";
import type { SessionStore } from "../auth/session.js";
import type { ConsoleRoutesDeps } from "./console.js";

/** What `registerConsoleRoutes` shares with these routes: the resolved step-up auth, its structured logger and the JSON-only rule. */
export interface ConsoleRouteShared {
  /** The app's session store while login is enabled; absent → creation answers 503 `step_up_unavailable`. */
  readonly stepUpAuth: { readonly sessions: SessionStore } | undefined;
  /**
   * One structured line; a throwing logger must not break the answer (the poller's rule — the fallback is stderr). A
   * caught `err` adds its class and code only (D13), never its message.
   */
  readonly logEvent: (level: "info" | "warn" | "error", entry: object, msg: string, err?: unknown) => void;
  /** Ruling T11-15: the `preValidation` hook of every console POST route — anything but `application/json` is 415. */
  readonly jsonOnly: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
}

/** A machine name as the registry admits it (`LOGICAL_NAME_RE`, capped like the settings key): anything else is refused with a fixed text, never echoed. */
const MACHINE_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/;
/** Per-list budget, connect + `find` over the root. */
const LIST_EXEC: Required<RemoteCommandOptions> = { timeoutMs: 6000, maxOutputBytes: LIST_PROJECTS_MAX_OUTPUT_BYTES };
/** Per-create budget, connect + the create script (one `mkdir`, one `tmux new-session`); its one record fits the 64 KiB default. */
const CREATE_EXEC: Required<RemoteCommandOptions> = { timeoutMs: 8000, maxOutputBytes: 65536 };
/** A machine shell drawer's tmux session (`sh-<name>`, Task 7): never a `running` project. */
const SHELL_SESSION_PREFIX = "sh-";
const MSG_STARTED = "session started";
const MSG_PROJECT_STARTED = "folder created and session started";
const failedMessage = (why: string): string => `Start failed — ${why}`;

/** Ruling T11-18: `unconfirmed` when the start may have happened (the script was sent, or no record came back). */
type CreateOutcome = Extract<SubmitLogOutcome, "created_session" | "created_project" | "failed" | "unconfirmed">;
type RefusedOutcome = Extract<SubmitLogOutcome, "refused_root" | "refused_name">;
/** Ruling T11-18: the start may have happened — the operator checks the machine before trying again. */
const MSG_START_UNCONFIRMED = "Could not confirm the start — check the machine's tmux sessions";

/** `POST …/sessions` takes exactly one of `folder: string` (an existing folder, relative to the root or absolute under it) or `newProject: string` (a name). */
type SessionRequest = { readonly folder: string } | { readonly newProject: string };

/** Anything else — both keys, neither, a non-string, an array, no body — is a bad request (no audit row: nothing was asked for). */
function sessionRequest(body: unknown): SessionRequest | undefined {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
  const { folder, newProject } = body as { readonly folder?: unknown; readonly newProject?: unknown };
  if (typeof folder === "string" && newProject === undefined) return { folder };
  if (typeof newProject === "string" && folder === undefined) return { newProject };
  return undefined;
}

/** `POST …/sessions` answers 200 with this for every reported outcome: the outcome is the result, not a transport error. */
export interface SessionOutcomeBody {
  /** The tmux session the script was asked to create (suffixed against the live list). */
  readonly tmuxSession: string;
  /** The server-resolved working directory under the projects root. */
  readonly path: string;
  readonly outcome: CreateOutcome;
  readonly message: string;
}

export interface ProjectsPayload {
  readonly root: string;
  readonly projects: readonly (ProjectEntry & { readonly running: string | null })[];
  readonly dropped: number;
}

type MachineResolution =
  | { readonly ok: true; readonly conn: ConnectableMachine; readonly root: string }
  | { readonly ok: false; readonly status: 400 | 409; readonly body: { readonly error: string; readonly message?: string } };

/** The machine both routes dial, with its projects root: name shape, then the registry's fail-closed rule (TM-020), then the settings entry. */
function machineWithRoot(name: string, deps: ConsoleRoutesDeps): MachineResolution {
  if (!MACHINE_NAME_RE.test(name)) return { ok: false, status: 400, body: { error: "unexpected machine name" } };
  let conn: ConnectableMachine;
  try {
    conn = resolveConnectableMachine(name, deps.registry);
  } catch (err) {
    return { ok: false, status: 409, body: { error: "not_connectable", message: err instanceof TerminalError ? err.message : "machine is not connectable" } };
  }
  const root = deps.settings.ok ? projectsRootFor(deps.settings.settings, conn.target.logicalName) : undefined;
  if (root === undefined) return { ok: false, status: 409, body: { error: "no_projects_root" } };
  return { ok: true, conn, root };
}

/** First-party wording for a dial that threw (the tmux lister's rule): never the exception's text. */
function unreachableWhy(err: unknown, what: string): string {
  const ssh = err instanceof SshConnectionError;
  return ssh && /timed out/.test(err.message) ? "timed out waiting for the machine" : ssh ? "SSH connection failed" : `could not run the ${what} over SSH`;
}

/**
 * The request's working directory once it passed containment and the ONE admissibility rule (ruling T8-7: the
 * basename is held to `PROJECT_NAME_RE`, parent segments are free apart from the remote-directory rule), or the
 * refusal.
 */
type Resolution =
  | { readonly ok: true; readonly cwd: string; readonly mkdir: boolean }
  | { readonly ok: false; readonly outcome: RefusedOutcome };

/**
 * Containment first (`refused_root`: the resolved path is not strictly under the root — `..`, an absolute path
 * elsewhere, the root itself, a sibling), then `refused_name`: an existing `folder` must pass the ONE rule the list
 * applied, `admissiblePath` (ruling T8-7: no hidden segment, the remote-directory rule, a `PROJECT_NAME_RE`
 * basename; parents are free), so a quoted or hidden segment never reaches a command and what was listed can be
 * started; a `newProject` is one `PROJECT_NAME_RE` name directly under the root (`assertProjectName` — a valid name
 * has no slash, so the resolved path is exactly `<root>/<name>`), then the same rule for the byte bound. A path the
 * console mask would alter is `refused_name` too (ruling T11-8): the list never shows such a folder either.
 */
function resolveTarget(root: string, request: SessionRequest, mask: (t: string) => string): Resolution {
  const mkdir = "newProject" in request;
  const value = "newProject" in request ? request.newProject : request.folder;
  const cwd = posix.resolve(posix.resolve(root), value);
  if (segmentsUnderRoot(root, cwd) === undefined) return { ok: false, outcome: "refused_root" };
  if (mkdir) {
    try {
      assertProjectName(value);
    } catch (err) {
      if (err instanceof ProbeError) return { ok: false, outcome: "refused_name" };
      throw err;
    }
  }
  if (!admissiblePath(root, cwd) || mask(cwd) !== cwd) return { ok: false, outcome: "refused_name" };
  return { ok: true, cwd, mkdir };
}

/**
 * `base`, or the first `base-N` (N ≥ 2, the base cut so the name fits) absent from the live list. Ruling T11-13
 * applies T8-5 to each FINAL candidate: one that lands in the machine-shell namespace (`sh` + `-2` is `sh-2`) is
 * prefixed `p-` and cut to {@link TMUX_SESSION_NAME_MAX}, never skipped — skipping would never end for base `sh`.
 * Terminates: every candidate is distinct and the list is finite.
 */
function freeName(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    let candidate = `${base.slice(0, TMUX_SESSION_NAME_MAX - suffix.length)}${suffix}`;
    if (candidate.startsWith(SHELL_SESSION_PREFIX)) candidate = `p-${candidate}`.slice(0, TMUX_SESSION_NAME_MAX);
    if (!taken.has(candidate)) return candidate;
  }
}

/** What one dialled creation resolved to: the row's outcome and first-party reason, the body's message. */
interface CreateReport {
  readonly outcome: CreateOutcome;
  readonly tmuxName: string;
  readonly reason?: string;
  readonly message: string;
  /** The error when the create dial threw: the log line names its class only. */
  readonly thrown?: unknown;
}

interface CreateAnswer {
  readonly status: 200 | 400;
  readonly body: SessionOutcomeBody | { readonly error: RefusedOutcome };
}

/** The fields of a `console.session_create` line — and nothing else: never the name, never the path, never the session id. */
interface CreateLogLine {
  readonly machine: string;
  readonly outcome: CreateOutcome | RefusedOutcome;
  readonly correlationId: string;
  /** C2 (L4): the elevated operator session that asked, as `sessionIdHash` — never the id (the cookie secret). */
  readonly sessionIdHash: string;
  /** D13 (L6): the row's first-party reason, masked as stored. */
  readonly reason?: string;
}

/** D13 (L5): a created session is info; a refusal, a failure or a start that cannot be confirmed is warn. */
const createLevel = (outcome: CreateOutcome | RefusedOutcome): "info" | "warn" => (outcome === "created_session" || outcome === "created_project" ? "info" : "warn");

export function registerConsoleSessionRoutes(app: FastifyInstance, deps: ConsoleRoutesDeps, shared: ConsoleRouteShared): void {
  const logCreate = (level: "info" | "warn" | "error", fields: CreateLogLine, msg: string, err?: unknown): void =>
    shared.logEvent(level, { event: "console.session_create", ...fields }, msg, err);
  const now = (): string => new Date().toISOString();

  // ---- The projects root's folders (guarded; JSON; no-store; no HEAD; no step-up: nothing is typed) ----
  app.get<{ Params: { name: string } }>("/console/api/machines/:name/projects", { exposeHeadRoute: false }, async (req, reply): Promise<ProjectsPayload | { readonly error: string; readonly message?: string }> => {
    reply.header("Cache-Control", "no-store");
    const m = machineWithRoot(req.params.name, deps);
    if (!m.ok) {
      reply.code(m.status);
      return m.body;
    }
    const machine = m.conn.target.logicalName;
    let run: RemoteCommandResult;
    try {
      run = await deps.exec(m.conn.target, m.conn.handle, buildListProjectsCommand(m.root), LIST_EXEC);
    } catch (err) {
      reply.code(502);
      return { error: "unreachable", message: `${machine} unreachable — ${unreachableWhy(err, "listing")}` };
    }
    if (run.code !== 0) {
      reply.code(502);
      return { error: "list_failed", message: run.code === 2 ? `projects root is not a directory on ${machine}` : `listing projects on ${machine} failed (exit ${run.code})` };
    }
    const listing = parseListProjectsOutput(run.stdout);
    // The parser has no root: the ONE admissibility rule (T8-7) runs here over every reported path, and what it
    // refuses — a path outside the root, a hidden segment — joins the parser's drops in `dropped`; so does a path the
    // console mask would alter (ruling T11-8): it would be shown, and could only be started, under a masked name.
    const admitted = listing.projects.filter((p) => admissiblePath(m.root, p.path) && deps.mask(p.path) === p.path);
    const live = deps.store.listSessions(machine).filter((s) => s.endedAt === null && !s.tmuxSession.startsWith(SHELL_SESSION_PREFIX));
    return {
      root: m.root,
      projects: admitted.map((p) => ({ ...p, running: live.find((s) => s.cwd === p.path)?.projectKey ?? null })),
      dropped: listing.dropped + (listing.projects.length - admitted.length)
    };
  });

  /**
   * The live list, the suffix, the script, the record — after the write-ahead row. Never throws for a value outside
   * the builder's allow-list (`ProbeError`) or a dial that dies, so the result row always follows the `attempted` row.
   * Ruling T11-18 sorts a create dial that threw by whether the script had been sent: before it nothing ran (`failed`,
   * reason `connect_failed`, the lister's wording); after it the session may exist (`unconfirmed`, reason `timeout` /
   * `ssh_failed` / `exec_error`); a script that sent no record at all is `unconfirmed` too (`no_record`). A builder
   * throw that is not a `ProbeError` is a defect and stays loud.
   */
  async function runCreate(conn: ConnectableMachine, baseName: string, cwd: string, mkdir: boolean): Promise<CreateReport> {
    const failed = (tmuxName: string, reason: string, message = failedMessage(reason)): CreateReport => ({ outcome: "failed", tmuxName, reason, message });
    const unconfirmed = (tmuxName: string, reason: string): CreateReport => ({ outcome: "unconfirmed", tmuxName, reason, message: MSG_START_UNCONFIRMED });
    const listExec: RemoteExec = (target, handle, command) => deps.exec(target, handle, command, LIST_EXEC);
    const live = await listTmuxSessions(conn.target, conn.handle, listExec);
    if (live.state !== "ok") return failed(baseName, "tmux_list_failed", failedMessage(live.message));
    const tmuxName = freeName(baseName, new Set(live.sessions.map((s) => s.name)));
    let command: RemoteCommand;
    try {
      command = buildCreateSessionCommand({ tmuxName, cwd, mkdir });
    } catch (err) {
      if (err instanceof ProbeError) return failed(tmuxName, "plan_refused", failedMessage("the plan was refused"));
      throw err;
    }
    let run: RemoteCommandResult;
    try {
      run = await deps.exec(conn.target, conn.handle, command, CREATE_EXEC);
    } catch (err) {
      const failure = remoteCommandFailure(err);
      if (failure.mayHaveRun) return { ...unconfirmed(tmuxName, failure.reason), thrown: err };
      // The lister's wording: a handshake timeout reads as a timeout, a refused handshake as an SSH failure.
      return { ...failed(tmuxName, failure.reason, failedMessage(`${conn.target.logicalName} unreachable — ${unreachableWhy(err, "script")}`)), thrown: err };
    }
    const report = parseCreateSessionOutput(run.stdout, run.code);
    if (report.outcome === "unconfirmed") return unconfirmed(tmuxName, report.detail);
    if (report.outcome === "failed") return failed(tmuxName, report.detail);
    // A `created` record must name the plan's own session: anything else is not this script's record.
    if (report.tmuxName !== tmuxName) return failed(tmuxName, MALFORMED_RECORD_DETAIL);
    return mkdir ? { outcome: "created_project", tmuxName, message: MSG_PROJECT_STARTED } : { outcome: "created_session", tmuxName, message: MSG_STARTED };
  }

  /**
   * One creation once step-up, machine, root and body have passed: the audit rows around a refusal or a dial. The
   * tmux name and the reason pass the console mask before storage (ruling T11-6: a folder whose name is not
   * secret-shaped can still map to a tmux name that is); the answer keeps the real name, which the page opens.
   */
  async function createOnce(conn: ConnectableMachine, root: string, request: SessionRequest, correlationId: string, operator: string): Promise<CreateAnswer> {
    const machine = conn.target.logicalName;
    const who = { machine, correlationId, sessionIdHash: operator };
    // Ruling T8-2: one key per request, minted here — the body carries none and nothing replays.
    const fields: Omit<SubmitLogFields, "at"> = { idempotencyKey: randomUUID(), machine };
    const resolved = resolveTarget(root, request, deps.mask);
    if (!resolved.ok) {
      try {
        deps.store.appendSubmitLog({ ...fields, at: now(), rowKind: "attempted" });
        deps.store.appendSubmitLog({ ...fields, at: now(), rowKind: "result", outcome: resolved.outcome });
      } catch (err) {
        logCreate("error", { ...who, outcome: resolved.outcome }, "console session: audit write failed", err);
        throw err;
      }
      logCreate(createLevel(resolved.outcome), { ...who, outcome: resolved.outcome }, `console session: ${resolved.outcome}`);
      return { status: 400, body: { error: resolved.outcome } };
    }
    const baseName = tmuxNameForFolder(resolved.cwd);
    // Write-ahead (R6): the `attempted` row, with the base name, goes in before any dial — or nothing is dialled.
    try {
      deps.store.appendSubmitLog({ ...fields, at: now(), rowKind: "attempted", tmuxSession: deps.mask(baseName) });
    } catch (err) {
      logCreate("error", { ...who, outcome: "failed" }, "console session: audit write failed", err);
      throw err;
    }
    const report = await runCreate(conn, baseName, resolved.cwd, resolved.mkdir);
    const reason = report.reason !== undefined ? deps.mask(report.reason) : undefined;
    const line: CreateLogLine = { ...who, outcome: report.outcome, ...(reason !== undefined ? { reason } : {}) };
    try {
      deps.store.appendSubmitLog({
        ...fields,
        at: now(),
        rowKind: "result",
        outcome: report.outcome,
        tmuxSession: deps.mask(report.tmuxName),
        ...(reason !== undefined ? { reason } : {})
      });
    } catch (err) {
      // The dial happened and cannot be recorded: fail loud; the poller will show whatever was started.
      logCreate("error", line, "console session: result row not written", err);
      throw err;
    }
    logCreate(createLevel(report.outcome), line, `console session: ${report.outcome}`, report.thrown);
    return { status: 200, body: { tmuxSession: report.tmuxName, path: resolved.cwd, outcome: report.outcome, message: report.message } };
  }

  // ---- New Session / New Project (guarded; JSON only; step-up; no-store; no HEAD). Checks in order: step-up →
  // machine → root → body → containment and names → write-ahead → list → build → exec → parse → result row → answer. ----
  app.post<{ Params: { name: string } }>("/console/api/machines/:name/sessions", { exposeHeadRoute: false, preValidation: shared.jsonOnly }, async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    if (shared.stepUpAuth === undefined) {
      reply.code(503);
      return { error: "step_up_unavailable" };
    }
    const elevation = requireElevated(req, shared.stepUpAuth.sessions, deps.stepUp);
    if (!elevation.ok) {
      // D13 (L7): a denial on a typing route is one warn line — the reason and the request id, nothing else.
      shared.logEvent("warn", { event: "console.session_create_denied", reason: elevation.reason, correlationId: req.id }, "console session: denied");
      reply.code(elevation.status);
      return { error: elevation.reason };
    }
    const m = machineWithRoot(req.params.name, deps);
    if (!m.ok) {
      reply.code(m.status);
      return m.body;
    }
    const request = sessionRequest(req.body);
    if (request === undefined) {
      reply.code(400);
      return { error: "bad_request" };
    }
    const answer = await createOnce(m.conn, m.root, request, req.id, sessionIdHash(elevation.sessionId));
    reply.code(answer.status);
    return answer.body;
  });
}
