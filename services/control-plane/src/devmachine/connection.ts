/**
 * Server-side SSH→PTY broker for a Claude-CLI terminal (Task #16c foundation, ADR-0005, TM-020).
 *
 * `connectTerminal` resolves the harness private key from custody (server-side, by handle), opens a
 * KEY-ONLY ssh2 connection to the DevMachine, and requests a remote PTY via `shell()`. The returned
 * {@link TerminalSession} is a thin duplex the WebSocket bridge (next increment) pumps to/from
 * xterm.js. The private key is captured in a closure here and never placed on the session object,
 * never logged, never sent to the browser (#14b).
 *
 * The ssh2 client is injected via {@link SshClientFactory} so the lifecycle is unit-testable; the
 * default factory wraps the real `ssh2.Client`.
 */

import { Client as Ssh2Client } from "ssh2";
import { type KeyCustody } from "./custody.js";
import { type SshTarget } from "./provisioning.js";

/** Minimal slice of an ssh2 PTY channel (a duplex stream) that the broker uses. */
export interface SshStream {
  write(data: string): void;
  on(event: "data" | "close", cb: (chunk?: Buffer) => void): this;
  setWindow(rows: number, cols: number, height: number, width: number): void;
  end(): void;
}

/** Minimal slice of the ssh2 `Client` the broker depends on. */
export interface SshClient {
  on(event: string, cb: (...args: never[]) => void): this;
  connect(cfg: Record<string, unknown>): void;
  shell(opts: unknown, cb: (err: Error | undefined, stream: SshStream) => void): void;
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

/**
 * Open a key-only SSH terminal session to `target` using the keypair stored under `handle`. Rejects
 * (fail closed, no session) if the machine is unprovisioned, the connection errors, or the remote
 * PTY cannot be opened.
 */
export async function connectTerminal(target: SshTarget, handle: string, deps: TerminalDeps): Promise<TerminalSession> {
  // Resolve BEFORE creating/connecting a client: an unprovisioned machine fails here, never dialing.
  const privateKey = await deps.custody.resolvePrivateKey(handle);

  const client = (deps.clientFactory ?? (() => new Ssh2Client() as unknown as SshClient))();

  return new Promise<TerminalSession>((resolve, reject) => {
    let settled = false;
    const fail = (message: string): void => {
      if (settled) return;
      settled = true;
      try {
        client.end();
      } catch {
        /* best-effort teardown */
      }
      reject(new SshConnectionError(message));
    };

    client.on("ready", () => {
      client.shell({ term: "xterm-256color" }, (err, stream) => {
        if (err || !stream) {
          fail(`failed to open a PTY on ${target.logicalName}`);
          return;
        }
        if (settled) return;
        settled = true;
        resolve(makeSession(client, stream));
      });
    });

    client.on("error", () => fail(`SSH connection to ${target.logicalName} (${target.user}@${target.host}) failed`));

    // KEY-ONLY auth — no password, ever (#14b/TM-020).
    client.connect({ host: target.host, port: target.port, username: target.user, privateKey });
  });
}
