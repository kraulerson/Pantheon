/**
 * Claude-CLI terminal WebSocket route (Task #16c, ADR-0005 / §9 C.6).
 *
 * `GET /terminal/:logicalName` (WebSocket). Behind the admin guard like every other non-public route
 * (TM-020: terminal access is gated by #9 auth). On connect it opens a key-only SSH PTY to the named
 * DevMachine and bridges it to the socket; the first frame is `{t:"ready", id}` (the reconnect
 * handle). A `?session=<id>` query reattaches to a still-live terminal (reconnectable, §9 C.6) —
 * ONLY if that terminal was opened for the same machine and the same target; otherwise a labeled
 * error frame (never a silent swap to another machine's shell).
 *
 * tmux-aware launcher (M1 task 1): `?tmux=<name>` attaches the PTY to that EXACT tmux session
 * (`tmux attach-session -t =<name>`); `?tmux=<name>&create=1` runs the ruled attach-or-create line.
 * The name is allow-list validated BEFORE any SSH dial — an unsafe name (or a repeated query key)
 * gets a labeled error frame and never reaches a remote command (TM-020, CC2).
 *
 * Machine shells (F2 Task 7): `?shell=1` attaches the PTY to the machine's ONE shared plain-shell tmux
 * session, `sh-<logicalName>`, created on demand in the machine's configured projects root
 * (`machines.<name>.projectsRoot` in the console settings → `tmux new-session -A -s 'sh-<name>' -c '<root>'`).
 * `shell` is a flag (exactly `1`) and never travels with `tmux` or `create`: that upgrade is refused
 * with 400 before the handler runs. A machine without a root, or whose name cannot pass the tmux
 * allow-list, gets a labelled error frame — never a 500. A machine shell is created only through
 * `?shell=1`: `?tmux=sh-<…>&create=1` is a labelled refusal (a plain `?tmux=sh-<…>` attach stays, the
 * recorded D18 terminal-access residual).
 *
 * Every `?shell=1` open that dials (rulings T11-12, T11-17) is audited write-ahead in the console store, like
 * Submit: the machine is resolved first (a refused machine writes nothing); a mount without `consoleStore` refuses
 * the shell (fail closed); an `attempted` row (machine, `sh-<name>`, a fresh uuid key) goes in BEFORE the dial — no
 * row, no dial; once the PTY is up a `result` row `opened_shell` follows (tmux cannot tell a creation from a
 * re-attach before `new-session -A` runs), and a dial that fails writes `result failed`. A `result` row that cannot
 * be written after the PTY is up closes the PTY (the `attempted` row records the open). A reattach to a live
 * terminal (`?session=<id>`, no new dial) writes nothing. Audit failures are logged at error level through the
 * route's structured logger (`log`, default stderr) BEFORE the PTY closes, with the request id as correlation id,
 * and the frame is labelled (never the error text). `server.ts` has the one production mount and passes the store.
 *
 * Every failed open — terminal or shell — is one `warn` line `terminal.open_failed` (triage 14): the machine, the
 * correlation id, whether it was a shell, a fixed reason and the error's class name; never its message, a path or
 * user@host.
 *
 * The heavy lifting (resolve/fail-closed/connect, scrollback, framing) is the unit-tested gateway;
 * this file is the thin ws⇄DuplexSocket adapter. Mount it on an app that already has the #9/admin
 * auth hook (onRequest hooks apply to routes registered afterwards): `await registerTerminalRoute(...)`
 * after `buildApp` and before `listen`.
 */

import { randomUUID } from "node:crypto";
import websocketPlugin from "@fastify/websocket";
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { STDERR_LOGGER, type PollerLogger } from "../../console/poller.js";
import type { SqliteConsoleStore } from "../../console/store.js";
import { SshConnectionError, type RemoteCommand, type TerminalSession } from "../../devmachine/connection.js";
import type { SshTarget } from "../../devmachine/provisioning.js";
import {
  attachSocket,
  openTerminalForMachine,
  resolveConnectableMachine,
  TerminalError,
  TerminalRegistry,
  type DuplexSocket,
  type MachineLookup,
  type ManagedTerminal
} from "../../devmachine/terminal-gateway.js";
import { buildTmuxAttachCommand, isSafeTmuxSessionName, TMUX_SESSION_NAME_MAX, TmuxError } from "../../devmachine/tmux.js";

export interface TerminalRouteDeps {
  readonly registry: MachineLookup;
  readonly terminals: TerminalRegistry;
  /** Inject the SSH connect step (real: `connectTerminal` bound to custody). */
  readonly connect: (target: SshTarget, handle: string, command?: RemoteCommand) => Promise<TerminalSession>;
  /**
   * Machine shells (F2 Task 7): the machine's configured projects root, bound to the loaded console settings.
   * Absent, or answering undefined → `?shell=1` gets the labelled "no projects root configured" frame.
   */
  readonly projectsRootFor?: (logicalName: string) => string | undefined;
  /**
   * Audit sink for the machine-shell rows (`attempted`, then `opened_shell` or `failed`: rulings T11-12, T11-17).
   * Absent → `?shell=1` is refused with a labelled frame (fail closed). Test harnesses mount this route without the
   * store for plain terminals; `server.ts` has the one production mount and passes it.
   */
  readonly consoleStore?: Pick<SqliteConsoleStore, "appendSubmitLog">;
  /** Structured logger for the audit-failure and failed-open lines (production: `stderrLogger({ module: "terminal-route" })`); default {@link STDERR_LOGGER}. */
  readonly log?: PollerLogger;
}

/** Query values may arrive as arrays when a key is repeated — every consumer narrows explicitly. */
interface TerminalQuery {
  session?: string | string[];
  tmux?: string | string[];
  create?: string | string[];
  shell?: string | string[];
}

/** Adapt a `ws` WebSocket to the transport-agnostic {@link DuplexSocket} the gateway speaks. */
function adaptWs(socket: WebSocket): DuplexSocket {
  return {
    send: (data) => socket.send(data),
    onMessage: (cb) => socket.on("message", (data: Buffer) => cb(data.toString())),
    onClose: (cb) => socket.on("close", () => cb()),
    close: () => socket.close()
  };
}

/**
 * The remote command for this connection, or undefined for a plain login shell. Throws TmuxError on an unsafe name,
 * and on `create=1` for a name in the machine-shell namespace: a machine shell is created only through `?shell=1`,
 * where it is audited (ruling T11-17).
 */
function remoteCommandFor(query: TerminalQuery): RemoteCommand | undefined {
  if (query.tmux === undefined) return undefined;
  if (typeof query.tmux !== "string") throw new TmuxError("invalid tmux session name — expected exactly one value");
  const create = query.create === "1";
  if (create && query.tmux.startsWith(SHELL_PREFIX)) throw new TmuxError("a machine shell (sh-…) is opened only through ?shell=1");
  return buildTmuxAttachCommand(query.tmux, { create });
}

/** True when `shell` is present but is not the bare flag `1`, or travels with `tmux` / `create` (those name a tmux tab). */
function isContradictoryShellQuery(query: TerminalQuery): boolean {
  if (query.shell === undefined) return false;
  return query.shell !== "1" || query.tmux !== undefined || query.create !== undefined;
}

/** Every machine shell is the tmux session `sh-<logicalName>`. */
const SHELL_PREFIX = "sh-";

/** A labelled refusal that keeps its cause for debugging; the socket frame carries the message only, never the cause. */
function refusal(message: string, cause: unknown): TerminalError {
  const err = new TerminalError(message);
  err.cause = cause;
  return err;
}

/** Prefix and logical name must together fit the tmux session-name cap, so a machine name has at most this many characters. */
const MAX_SHELL_MACHINE_NAME_CHARS = TMUX_SESSION_NAME_MAX - SHELL_PREFIX.length;

/** What the socket attaches to: the remote command (undefined = login shell) and, for `?shell=1`, the shell's tmux session name. */
interface TerminalTarget {
  readonly command: RemoteCommand | undefined;
  readonly shell?: string;
}

/**
 * The machine shell's target. The name is allow-listed BEFORE the root is looked up or any command text exists; both
 * refusals are labelled frames (the handler's catch) naming the machine — never an error escaping toward the browser.
 */
function shellTargetFor(logicalName: string, deps: TerminalRouteDeps): TerminalTarget {
  const shell = `${SHELL_PREFIX}${logicalName}`;
  if (!isSafeTmuxSessionName(shell)) {
    throw new TmuxError(
      `machine name ${logicalName} cannot name a tmux shell session (letters, digits, '_' and '-' only, at most ${MAX_SHELL_MACHINE_NAME_CHARS} characters)`
    );
  }
  const cwd = deps.projectsRootFor?.(logicalName);
  if (cwd === undefined) {
    throw new TerminalError(`no projects root configured for ${logicalName} — add machines.${logicalName}.projectsRoot to the console settings file`);
  }
  return { command: buildTmuxAttachCommand(shell, { create: true, cwd }), shell };
}

export async function registerTerminalRoute(app: FastifyInstance, deps: TerminalRouteDeps): Promise<void> {
  await app.register(websocketPlugin);
  const log = deps.log ?? STDERR_LOGGER;
  const now = (): string => new Date().toISOString();

  /** One structured line; a throwing logger must not break the answer (the poller's rule — the fallback is stderr). */
  const logLine = (level: "warn" | "error", fields: Record<string, unknown>, msg: string): void => {
    try {
      if (level === "error") log.error(fields, msg);
      else log.warn(fields, msg);
    } catch {
      if (level === "error") STDERR_LOGGER.error({ ...fields, loggerFailed: true }, msg);
      else STDERR_LOGGER.warn({ ...fields, loggerFailed: true }, msg);
    }
  };

  /**
   * One `console.shell_audit_failed` line per audit row that could not be written: machine, which row, the request id
   * as correlation id and the error's name + message (a SQLite error carries no secrets; an Error would JSON-serialise
   * to `{}`, so it is flattened; the root path and frame text are never logged).
   */
  const logAuditFailed = (logicalName: string, correlationId: string, row: "attempted" | "result", err: unknown, msg: string): void => {
    const error = err instanceof Error ? { name: err.name, message: err.message } : { message: String(err) };
    logLine("error", { event: "console.shell_audit_failed", machine: logicalName, row, correlationId, err: error }, msg);
  };

  /**
   * Triage 14 (L12): one warn line per failed open — a fixed reason and the error's class, never its message (an SSH
   * error carries user@host), a path or the frame text.
   */
  const logOpenFailed = (logicalName: string, correlationId: string, shell: boolean, err: unknown): void => {
    const reason = err instanceof TerminalError || err instanceof TmuxError ? "refused" : err instanceof SshConnectionError ? "connect_failed" : "open_failed";
    const errName = err instanceof Error ? err.name : typeof err;
    logLine("warn", { event: "terminal.open_failed", machine: logicalName, shell, reason, errName, correlationId }, "terminal open failed");
  };

  /**
   * A new machine-shell PTY, audited write-ahead (rulings T11-12, T11-17): the machine first (a refused machine writes
   * nothing), the store (absent → refused), the `attempted` row (no row → no dial), the dial (a failure → `result
   * failed`), then `result opened_shell` (a failure → the error line, THEN the PTY closed, a labelled refusal).
   */
  async function openShell(logicalName: string, command: RemoteCommand, shell: string, correlationId: string): Promise<ManagedTerminal> {
    resolveConnectableMachine(logicalName, deps.registry);
    const store = deps.consoleStore;
    if (store === undefined) throw new TerminalError("machine shell refused — this terminal mount keeps no audit log");
    const fields = { idempotencyKey: randomUUID(), machine: logicalName, tmuxSession: shell };
    try {
      store.appendSubmitLog({ ...fields, at: now(), rowKind: "attempted" });
    } catch (err) {
      logAuditFailed(logicalName, correlationId, "attempted", err, "console shell: audit row not written; nothing dialled");
      throw refusal("machine shell refused — its audit row could not be written", err);
    }
    let term: ManagedTerminal;
    try {
      term = await openTerminalForMachine(logicalName, deps, { command });
    } catch (err) {
      try {
        store.appendSubmitLog({ ...fields, at: now(), rowKind: "result", outcome: "failed", reason: "open_failed" });
      } catch (second) {
        logAuditFailed(logicalName, correlationId, "result", second, "console shell: audit row not written; the open failed");
      }
      throw err;
    }
    try {
      store.appendSubmitLog({ ...fields, at: now(), rowKind: "result", outcome: "opened_shell" });
    } catch (err) {
      // Triage 61: the line goes out before the PTY closes.
      logAuditFailed(logicalName, correlationId, "result", err, "console shell: audit row not written; session closed");
      term.close();
      throw refusal("machine shell closed — its audit row could not be written", err);
    }
    return term;
  }

  app.get<{ Params: { logicalName: string }; Querystring: TerminalQuery }>(
    "/terminal/:logicalName",
    {
      websocket: true,
      // A contradictory query refuses the UPGRADE itself (400): the socket never opens, so nothing is dialled.
      preValidation: async (req, reply) => {
        if (isContradictoryShellQuery(req.query)) await reply.code(400).send({ error: "bad_request" });
      }
    },
    async (socket, req) => {
      const ws = adaptWs(socket);
      const { logicalName } = req.params;
      const reconnectId = typeof req.query.session === "string" ? req.query.session : undefined;
      try {
        // Validate the target FIRST so an unsafe name (or an unusable shell) never reaches openTerminalForMachine.
        const target: TerminalTarget = req.query.shell === undefined ? { command: remoteCommandFor(req.query) } : shellTargetFor(logicalName, deps);
        // Reattach to a still-live terminal if a valid session id was supplied; else open a new one.
        const existing = reconnectId ? deps.terminals.get(reconnectId) : undefined;
        let term: ManagedTerminal;
        if (existing && !existing.isClosed) {
          const origin = existing.origin;
          if (origin && (origin.logicalName !== logicalName || origin.command !== target.command)) {
            throw new TerminalError("that session id does not belong to this machine and target — open a new terminal");
          }
          term = existing;
        } else if (target.shell !== undefined && target.command !== undefined) {
          term = await openShell(logicalName, target.command, target.shell, req.id);
        } else {
          term = await openTerminalForMachine(logicalName, deps, target.command === undefined ? {} : { command: target.command });
        }
        ws.send(JSON.stringify({ t: "ready", id: term.id }));
        attachSocket(ws, term);
      } catch (err) {
        logOpenFailed(logicalName, req.id, req.query.shell !== undefined, err);
        const known = err instanceof TerminalError || err instanceof TmuxError;
        ws.send(JSON.stringify({ t: "e", m: known ? err.message : "terminal open failed" }));
        ws.close();
      }
    }
  );
}
