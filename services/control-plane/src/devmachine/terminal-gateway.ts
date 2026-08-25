/**
 * Terminal gateway (Task #16c, ADR-0005 / §9 C.6) — the transport-agnostic core of the
 * SSH→PTY→WebSocket bridge.
 *
 * `ManagedTerminal` wraps a {@link TerminalSession} with a bounded scrollback ring and an
 * attach/detach lifecycle: a dropped WebSocket DETACHES (the SSH session keeps running) so the
 * operator can reconnect and reattach to a live shell. `attachSocket` wires a {@link DuplexSocket}
 * to a ManagedTerminal with a tiny JSON frame protocol. `TerminalRegistry` tracks live terminals by
 * id and auto-evicts on close.
 *
 * Security (ADR-0005/TM-020): the bridge forwards ONLY operator-typed input frames to the PTY; it
 * never injects recalled `trusted:false` content. Malformed/unknown frames are ignored (fail safe).
 * `resolveConnectableMachine` is the ONE place the fail-closed machine rules live (unknown /
 * disabled / unprovisioned never dial) — the terminal route and the tmux list route both use it.
 */

import { randomUUID } from "node:crypto";
import { type DevMachine } from "../registry/types.js";
import { type RemoteCommand, type TerminalSession } from "./connection.js";
import { type SshTarget } from "./provisioning.js";

/** A transport-agnostic duplex (a real WebSocket is adapted to this in the Fastify route). */
export interface DuplexSocket {
  send(data: string): void;
  onMessage(cb: (raw: string) => void): void;
  onClose(cb: () => void): void;
  close(): void;
}

/**
 * Client→server frames: input keystrokes, PTY resize, and an EXPLICIT close (`{t:"c"}`, BUGS #33).
 * A dropped socket only detaches (reconnectable); an explicit close ends the SSH session, so a
 * closed tmux tab does not leave a ghost tmux client attached on the dev machine.
 */
type ClientFrame = { t: "i"; d: string } | { t: "r"; c: number; r: number } | { t: "c" };

/** Server→client frames: PTY output, session exit. (Errors use `{t:"e",m}`.) */
function outputFrame(data: string): string {
  return JSON.stringify({ t: "o", d: data });
}
function exitFrame(): string {
  return JSON.stringify({ t: "x" });
}

/** Parse + validate a client frame. Returns null for malformed/unknown input (fail safe). */
function parseClientFrame(raw: string): ClientFrame | null {
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof msg !== "object" || msg === null) return null;
  const m = msg as Record<string, unknown>;
  if (m["t"] === "i" && typeof m["d"] === "string") return { t: "i", d: m["d"] };
  if (m["t"] === "r" && Number.isInteger(m["c"]) && Number.isInteger(m["r"])) {
    return { t: "r", c: m["c"] as number, r: m["r"] as number };
  }
  if (m["t"] === "c") return { t: "c" };
  return null;
}

const DEFAULT_SCROLLBACK_BYTES = 64 * 1024;

/** Where a terminal was opened: the machine and the (allow-listed) remote command, if any. */
export interface TerminalOrigin {
  readonly logicalName: string;
  readonly command: RemoteCommand | undefined;
}

export class ManagedTerminal {
  private scrollback = "";
  private sink: ((frame: string) => void) | undefined;
  private closed = false;
  /**
   * Set by {@link openTerminalForMachine}; a reattach (`?session=<id>`) must present the SAME
   * machine + target or be refused — a session id never silently swaps to another machine's shell.
   */
  origin: TerminalOrigin | undefined;

  constructor(
    readonly id: string,
    private readonly session: TerminalSession,
    private readonly maxScrollbackBytes: number = DEFAULT_SCROLLBACK_BYTES
  ) {
    this.session.onData((chunk) => this.onOutput(chunk.toString("utf8")));
    this.session.onClose(() => this.onClosed());
  }

  get isClosed(): boolean {
    return this.closed;
  }

  private onOutput(text: string): void {
    this.scrollback = (this.scrollback + text).slice(-this.maxScrollbackBytes);
    this.sink?.(outputFrame(text));
  }

  private onClosed(): void {
    this.closed = true;
    this.sink?.(exitFrame());
  }

  /** Attach a client sink (reconnect): replay the scrollback, then stream live output. */
  attach(sink: (frame: string) => void): void {
    this.sink = sink;
    if (this.scrollback.length > 0) sink(outputFrame(this.scrollback));
    if (this.closed) sink(exitFrame());
  }

  /** Detach the current client WITHOUT killing the SSH session (it survives a dropped socket). */
  detach(): void {
    this.sink = undefined;
  }

  /** Operator keystrokes → remote PTY (ignored once closed). */
  input(data: string): void {
    if (!this.closed) this.session.write(data);
  }

  /** Resize the remote PTY (cols, rows). */
  resize(cols: number, rows: number): void {
    if (!this.closed) this.session.resize(cols, rows);
  }

  /** Explicit teardown of the SSH session. */
  close(): void {
    this.session.close();
  }
}

/** Wire a duplex socket to a managed terminal. Socket close => detach (reconnectable); `{t:"c"}` => end. */
export function attachSocket(socket: DuplexSocket, term: ManagedTerminal): void {
  term.attach((frame) => socket.send(frame));
  socket.onMessage((raw) => {
    const frame = parseClientFrame(raw);
    if (!frame) return;
    if (frame.t === "i") term.input(frame.d);
    else if (frame.t === "r") term.resize(frame.c, frame.r);
    else term.close(); // explicit tab close: end the SSH session (the registry evicts on close)
  });
  socket.onClose(() => term.detach());
}

/** Tracks live terminals by id; auto-evicts when the underlying session closes. */
export class TerminalRegistry {
  private readonly terminals = new Map<string, ManagedTerminal>();

  register(id: string, session: TerminalSession, maxScrollbackBytes?: number): ManagedTerminal {
    const term =
      maxScrollbackBytes === undefined
        ? new ManagedTerminal(id, session)
        : new ManagedTerminal(id, session, maxScrollbackBytes);
    this.terminals.set(id, term);
    // Auto-evict on close so the map never accumulates dead sessions.
    session.onClose(() => this.terminals.delete(id));
    return term;
  }

  get(id: string): ManagedTerminal | undefined {
    return this.terminals.get(id);
  }

  remove(id: string): void {
    const term = this.terminals.get(id);
    if (!term) return;
    this.terminals.delete(id);
    term.close();
  }

  get size(): number {
    return this.terminals.size;
  }
}

/** Terminal-open failures (unknown / unprovisioned / disabled machine). Carries no key material. */
export class TerminalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TerminalError";
  }
}

export interface MachineLookup {
  getDevMachineByLogicalName(logicalName: string): DevMachine | undefined;
}

export interface ConnectableMachine {
  readonly target: SshTarget;
  /** Custody handle of the key to dial with — an opaque reference, never key material. */
  readonly handle: string;
}

/**
 * Resolve a DevMachine by logicalName and fail closed if it is unknown / disabled / unprovisioned.
 * The single source of the "may we dial this machine at all" rule (TM-020).
 */
export function resolveConnectableMachine(logicalName: string, registry: MachineLookup): ConnectableMachine {
  const machine = registry.getDevMachineByLogicalName(logicalName);
  if (!machine) throw new TerminalError(`no dev machine with logicalName '${logicalName}'`);
  if (!machine.enabled) throw new TerminalError(`dev machine '${logicalName}' is disabled`);
  if (!machine.provisioned || machine.sshKeyHandle === "") {
    throw new TerminalError(`dev machine '${logicalName}' is not provisioned`);
  }
  return {
    target: { logicalName: machine.logicalName, host: machine.host, port: machine.port, user: machine.user },
    handle: machine.sshKeyHandle
  };
}

export interface OpenTerminalDeps {
  readonly registry: MachineLookup;
  readonly terminals: TerminalRegistry;
  /**
   * Inject the SSH connect step (real: `connectTerminal` bound to custody). `command`, when given,
   * runs on the PTY instead of the login shell (tmux attach) — already allow-list validated upstream.
   */
  readonly connect: (target: SshTarget, handle: string, command?: RemoteCommand) => Promise<TerminalSession>;
}

export interface OpenTerminalOptions {
  readonly command?: RemoteCommand;
}

/**
 * Resolve a DevMachine by logicalName, fail closed if it is unknown / unprovisioned / disabled,
 * then open a key-only SSH terminal and register it. Returns the ManagedTerminal (its `id` is the
 * reconnect handle). Never dials an unprovisioned machine.
 */
export async function openTerminalForMachine(
  logicalName: string,
  deps: OpenTerminalDeps,
  opts: OpenTerminalOptions = {}
): Promise<ManagedTerminal> {
  const { target, handle } = resolveConnectableMachine(logicalName, deps.registry);
  const session = opts.command === undefined ? await deps.connect(target, handle) : await deps.connect(target, handle, opts.command);
  const term = deps.terminals.register(randomUUID(), session);
  term.origin = { logicalName, command: opts.command };
  return term;
}
