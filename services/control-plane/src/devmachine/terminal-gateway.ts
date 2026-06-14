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
 */

import { randomUUID } from "node:crypto";
import { type DevMachine } from "../registry/types.js";
import { type TerminalSession } from "./connection.js";
import { type SshTarget } from "./provisioning.js";

/** A transport-agnostic duplex (a real WebSocket is adapted to this in the Fastify route). */
export interface DuplexSocket {
  send(data: string): void;
  onMessage(cb: (raw: string) => void): void;
  onClose(cb: () => void): void;
  close(): void;
}

/** Client→server frames: input keystrokes and PTY resize. */
type ClientFrame = { t: "i"; d: string } | { t: "r"; c: number; r: number };

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
  return null;
}

const DEFAULT_SCROLLBACK_BYTES = 64 * 1024;

export class ManagedTerminal {
  private scrollback = "";
  private sink: ((frame: string) => void) | undefined;
  private closed = false;

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

/** Wire a duplex socket to a managed terminal. Socket close => detach (reconnectable). */
export function attachSocket(socket: DuplexSocket, term: ManagedTerminal): void {
  term.attach((frame) => socket.send(frame));
  socket.onMessage((raw) => {
    const frame = parseClientFrame(raw);
    if (!frame) return;
    if (frame.t === "i") term.input(frame.d);
    else term.resize(frame.c, frame.r);
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

export interface OpenTerminalDeps {
  readonly registry: { getDevMachineByLogicalName(logicalName: string): DevMachine | undefined };
  readonly terminals: TerminalRegistry;
  /** Inject the SSH connect step (real: `connectTerminal` bound to custody). */
  readonly connect: (target: SshTarget, handle: string) => Promise<TerminalSession>;
}

/**
 * Resolve a DevMachine by logicalName, fail closed if it is unknown / unprovisioned / disabled,
 * then open a key-only SSH terminal and register it. Returns the ManagedTerminal (its `id` is the
 * reconnect handle). Never dials an unprovisioned machine.
 */
export async function openTerminalForMachine(logicalName: string, deps: OpenTerminalDeps): Promise<ManagedTerminal> {
  const machine = deps.registry.getDevMachineByLogicalName(logicalName);
  if (!machine) throw new TerminalError(`no dev machine with logicalName '${logicalName}'`);
  if (!machine.enabled) throw new TerminalError(`dev machine '${logicalName}' is disabled`);
  if (!machine.provisioned || machine.sshKeyHandle === "") {
    throw new TerminalError(`dev machine '${logicalName}' is not provisioned`);
  }
  const target: SshTarget = {
    logicalName: machine.logicalName,
    host: machine.host,
    port: machine.port,
    user: machine.user
  };
  const session = await deps.connect(target, machine.sshKeyHandle);
  return deps.terminals.register(randomUUID(), session);
}
