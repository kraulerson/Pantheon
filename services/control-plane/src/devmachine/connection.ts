/**
 * Server-side SSH→PTY broker for a Claude-CLI terminal (Task #16c foundation, ADR-0005, TM-020).
 *
 * `connectTerminal` resolves the harness private key from custody (server-side, by handle), opens a
 * KEY-ONLY ssh2 connection to the DevMachine, and requests a remote PTY via `shell()` — or, when a
 * remote command is given (M1 task 1: tmux attach), `exec()`s that command on a PTY. The returned
 * {@link TerminalSession} is a thin duplex the WebSocket bridge pumps to/from xterm.js. The private
 * key is captured in a closure here and never placed on the session object, never logged, never
 * sent to the browser (#14b).
 *
 * `runRemoteCommand` is the non-interactive capture variant (no PTY) used for `tmux list-sessions`:
 * it collects stdout/stderr/exit code with a BYTE-accurate cap (decoded once, at the end, so a
 * multi-byte sequence split across packets is never corrupted), times out fail-closed, and always
 * closes the connection.
 *
 * Both paths are bounded by an overall timeout (handshake AND channel open), and a synchronous
 * throw from the ssh2 client (unparseable key, bad username) is converted into a sanitized
 * {@link SshConnectionError} — never a raw error, never key material.
 *
 * The remote command is the branded {@link RemoteCommand} type: it can only be minted by the
 * allow-listing builders in `tmux.ts`, so a plain attacker-influenced string cannot reach `exec`
 * without a deliberate cast (TM-020).
 *
 * The ssh2 client is injected via {@link SshClientFactory} so the lifecycle is unit-testable; the
 * default factory wraps the real `ssh2.Client`.
 */

import { StringDecoder } from "node:string_decoder";
import { Client as Ssh2Client } from "ssh2";
import { type KeyCustody } from "./custody.js";
import { type SshTarget } from "./provisioning.js";

/**
 * A remote command that has passed allow-list validation. Minted ONLY by `tmux.ts`'s builders —
 * the brand makes an unvalidated string a compile error at the exec seam.
 */
export type RemoteCommand = string & { readonly __brand: "RemoteCommand" };

/** Minimal slice of an ssh2 PTY channel (a duplex stream) that the broker uses. */
export interface SshStream {
  write(data: string): void;
  on(event: "data" | "close", cb: (chunk?: Buffer) => void): this;
  setWindow(rows: number, cols: number, height: number, width: number): void;
  end(): void;
}

/** Minimal slice of an ssh2 exec channel: stdout as `data`, the exit code on `close`, separate stderr. */
export interface SshExecStream {
  on(event: "data", cb: (chunk: Buffer) => void): this;
  on(event: "close", cb: (code: number | null) => void): this;
  readonly stderr: { on(event: "data", cb: (chunk: Buffer) => void): unknown };
}

/** Minimal slice of the ssh2 `Client` the broker depends on. */
export interface SshClient {
  on(event: string, cb: (...args: never[]) => void): this;
  connect(cfg: Record<string, unknown>): void;
  shell(opts: unknown, cb: (err: Error | undefined, stream: SshStream) => void): void;
  exec(
    command: string,
    options: { readonly pty?: { readonly term: string } },
    cb: (err: Error | undefined, stream: SshStream & SshExecStream) => void
  ): void;
  end(): void;
}

export type SshClientFactory = () => SshClient;

/** A live interactive terminal session over SSH. Operator-driven I/O — not fed recalled content. */
export interface TerminalSession {
  /** Send operator keystrokes/input to the remote PTY. */
  write(input: string): void;
  /** Subscribe to remote PTY output. */
  onData(cb: (chunk: Buffer) => void): void;
  /** Subscribe to session close (remote shell exited or connection dropped). */
  onClose(cb: () => void): void;
  /** Resize the remote PTY (cols, rows) — e.g. when the xterm.js viewport changes. */
  resize(cols: number, rows: number): void;
  /** Tear the session down (ends the PTY stream and the SSH connection). */
  close(): void;
}

export interface TerminalDeps {
  readonly custody: KeyCustody;
  readonly clientFactory?: SshClientFactory;
}

export interface ConnectOptions {
  /** Remote command to run on the PTY instead of the login shell (e.g. a tmux attach line). */
  readonly command?: RemoteCommand;
  /** Overall budget for handshake + channel open (default 20 s). On expiry the connection is torn down. */
  readonly timeoutMs?: number;
}

export interface RemoteCommandOptions {
  /** Overall budget for connect + run (default 10 s). On expiry the connection is torn down. */
  readonly timeoutMs?: number;
  /** Cap on captured stdout and stderr, each, in BYTES (default 64 KiB). */
  readonly maxOutputBytes?: number;
}

export interface RemoteCommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 20_000;
const DEFAULT_REMOTE_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;

/** SSH connect / PTY failures. Carries no key material and no raw ssh2 internals toward a client. */
export class SshConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SshConnectionError";
  }
}

function makeSession(client: SshClient, stream: SshStream): TerminalSession {
  return {
    write: (input) => stream.write(input),
    onData: (cb) => stream.on("data", (chunk) => cb(chunk ?? Buffer.alloc(0))),
    onClose: (cb) => stream.on("close", () => cb()),
    resize: (cols, rows) => stream.setWindow(rows, cols, 0, 0),
    close: () => {
      stream.end();
      client.end();
    }
  };
}

function defaultFactory(): SshClient {
  return new Ssh2Client() as unknown as SshClient;
}

function makeClient(factory: SshClientFactory | undefined, target: SshTarget): SshClient {
  try {
    return (factory ?? defaultFactory)();
  } catch {
    throw new SshConnectionError(`SSH client for ${target.logicalName} could not be created`);
  }
}

/** Bytes-accurate accumulator: keeps at most `cap` bytes, decoded once (incomplete tail dropped). */
class BoundedCapture {
  private readonly chunks: Buffer[] = [];
  private used = 0;
  constructor(private readonly cap: number) {}
  push(chunk: Buffer): void {
    const room = this.cap - this.used;
    if (room <= 0) return;
    const part = chunk.length > room ? chunk.subarray(0, room) : chunk;
    this.chunks.push(part);
    this.used += part.length;
  }
  text(): string {
    // `write` (not `end`) so a truncated trailing multi-byte sequence is dropped, not replaced.
    return new StringDecoder("utf8").write(Buffer.concat(this.chunks));
  }
}

/**
 * Open a key-only SSH terminal session to `target` using the keypair stored under `handle`. Rejects
 * (fail closed, no session) if the machine is unprovisioned, the connection errors, the remote PTY
 * cannot be opened, or the overall timeout expires. With `opts.command`, the command runs on the
 * PTY instead of a login shell.
 */
export async function connectTerminal(
  target: SshTarget,
  handle: string,
  deps: TerminalDeps,
  opts: ConnectOptions = {}
): Promise<TerminalSession> {
  // Resolve BEFORE creating/connecting a client: an unprovisioned machine fails here, never dialing.
  const privateKey = await deps.custody.resolvePrivateKey(handle);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const client = makeClient(deps.clientFactory, target);

  return new Promise<TerminalSession>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const fail = (message: string): void =>
      finish(() => {
        try {
          client.end();
        } catch {
          /* best-effort teardown */
        }
        reject(new SshConnectionError(message));
      });
    const timer = setTimeout(() => fail(`connection to ${target.logicalName} timed out after ${timeoutMs} ms`), timeoutMs);
    const onStream = (err: Error | undefined, stream: SshStream | undefined): void => {
      if (err || !stream) {
        fail(`failed to open a PTY on ${target.logicalName}`);
        return;
      }
      finish(() => resolve(makeSession(client, stream)));
    };

    client.on("ready", () => {
      try {
        if (opts.command !== undefined) client.exec(opts.command, { pty: { term: "xterm-256color" } }, onStream);
        else client.shell({ term: "xterm-256color" }, onStream);
      } catch {
        fail(`failed to open a PTY on ${target.logicalName}`);
      }
    });

    client.on("error", () => fail(`SSH connection to ${target.logicalName} (${target.user}@${target.host}) failed`));

    // KEY-ONLY auth — no password, ever (#14b/TM-020). ssh2 can throw synchronously here.
    try {
      client.connect({ host: target.host, port: target.port, username: target.user, privateKey, readyTimeout: timeoutMs });
    } catch {
      fail(`SSH connection to ${target.logicalName} could not be started`);
    }
  });
}

/**
 * Run one non-interactive command on `target` over a key-only connection and capture its output.
 * Resolves with the exit code as data (a non-zero exit is not an exception); rejects with a
 * sanitized {@link SshConnectionError} on connect failure, exec failure, or timeout. The connection
 * is always closed afterwards. Same fail-closed rule as the terminal: no key in custody → no dial.
 */
export async function runRemoteCommand(
  target: SshTarget,
  handle: string,
  command: RemoteCommand,
  deps: TerminalDeps,
  opts: RemoteCommandOptions = {}
): Promise<RemoteCommandResult> {
  const privateKey = await deps.custody.resolvePrivateKey(handle);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_REMOTE_TIMEOUT_MS;
  const cap = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const client = makeClient(deps.clientFactory, target);

  return new Promise<RemoteCommandResult>((resolve, reject) => {
    let settled = false;
    const stdout = new BoundedCapture(cap);
    const stderr = new BoundedCapture(cap);
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        client.end();
      } catch {
        /* best-effort teardown */
      }
      fn();
    };
    const fail = (message: string): void => finish(() => reject(new SshConnectionError(message)));
    const timer = setTimeout(() => fail(`remote command on ${target.logicalName} timed out after ${timeoutMs} ms`), timeoutMs);

    client.on("ready", () => {
      try {
        client.exec(command, {}, (err, stream) => {
          if (err || !stream) {
            fail(`failed to run a command on ${target.logicalName}`);
            return;
          }
          stream.on("data", (chunk: Buffer) => stdout.push(chunk));
          stream.stderr.on("data", (chunk) => stderr.push(chunk));
          stream.on("close", (code: number | null) => finish(() => resolve({ code: code ?? -1, stdout: stdout.text(), stderr: stderr.text() })));
        });
      } catch {
        fail(`failed to run a command on ${target.logicalName}`);
      }
    });

    client.on("error", () => fail(`SSH connection to ${target.logicalName} (${target.user}@${target.host}) failed`));

    // KEY-ONLY auth — no password, ever (#14b/TM-020). readyTimeout bounds the handshake too.
    try {
      client.connect({ host: target.host, port: target.port, username: target.user, privateKey, readyTimeout: timeoutMs });
    } catch {
      fail(`SSH connection to ${target.logicalName} could not be started`);
    }
  });
}
