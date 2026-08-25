/**
 * connectTerminal — Task #16(c, foundation), the server-side SSH→PTY broker (ADR-0005, TM-020).
 *
 * Opens a key-only ssh2 connection to a DevMachine using the private key resolved from custody at
 * connect time, then requests a remote PTY (`shell()`) — or, when a remote command is given (M1
 * task 1: tmux attach), `exec()`s that command on a PTY. The ssh2 client is injected so the
 * lifecycle (ready → shell/exec → session; error → reject) is unit-tested without a real machine.
 *
 * `runRemoteCommand` is the capture variant (no PTY) used for `tmux list-sessions`: it collects
 * stdout/stderr/exit code (byte-accurate cap, decoded once at the end), times out fail-closed, and
 * always closes the connection.
 *
 * Security invariants: connection auth is KEY-ONLY (never a password); an unprovisioned machine
 * (no key in custody) is rejected BEFORE any connection attempt; the private key is captured in a
 * closure and never exposed on the returned session object or in any error message; a synchronous
 * throw from the ssh2 client never escapes as a raw error; both paths are bounded by a timeout.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileKeyCustody } from "../src/devmachine/custody.js";
import {
  connectTerminal,
  runRemoteCommand,
  SshConnectionError,
  type RemoteCommand,
  type SshClient,
  type SshExecStream,
  type SshStream
} from "../src/devmachine/connection.js";

const PRIV = "-----BEGIN OPENSSH PRIVATE KEY-----\nSECRET-DO-NOT-LEAK\n-----END OPENSSH PRIVATE KEY-----\n";
const PUB = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFAKEPUBLIC harness@pantheon\n";
const TARGET = { logicalName: "mac-studio", host: "192.168.1.192", port: 22, user: "karl" } as const;
const cmd = (s: string): RemoteCommand => s as RemoteCommand;

class FakeStream implements SshStream, SshExecStream {
  written: string[] = [];
  windowCalls: Array<[number, number, number, number]> = [];
  ended = false;
  private cbs: Record<string, Array<(...a: unknown[]) => void>> = {};
  private errCbs: Array<(chunk: Buffer) => void> = [];
  readonly stderr = {
    on: (_ev: "data", cb: (chunk: Buffer) => void): void => {
      this.errCbs.push(cb);
    }
  };
  write(d: string): void {
    this.written.push(d);
  }
  on(ev: "data" | "close", cb: (...a: unknown[]) => void): this {
    (this.cbs[ev] ??= []).push(cb);
    return this;
  }
  setWindow(rows: number, cols: number, height: number, width: number): void {
    this.windowCalls.push([rows, cols, height, width]);
  }
  end(): void {
    this.ended = true;
  }
  emit(ev: "data" | "close", ...a: unknown[]): void {
    (this.cbs[ev] ?? []).forEach((h) => h(...a));
  }
  emitStderr(chunk: Buffer): void {
    this.errCbs.forEach((cb) => cb(chunk));
  }
}

interface FakeExecScript {
  stdout?: string;
  /** Raw stdout chunks (lets a test split a multi-byte sequence across packets). */
  stdoutChunks?: Buffer[];
  stderr?: string;
  code?: number;
  /** Never emit close — simulates a command that hangs. */
  hang?: boolean;
}

interface FakeClientOpts {
  outcome?: "ready" | "error";
  shellError?: boolean;
  /** shell()/exec() never call back — simulates a peer that completes the handshake then stalls. */
  channelHang?: boolean;
  execError?: boolean;
  /** connect() throws synchronously (ssh2 does this for e.g. an unparseable private key). */
  connectThrows?: boolean;
  exec?: FakeExecScript;
}

class FakeClient implements SshClient {
  connectCfg: Record<string, unknown> | undefined;
  ended = false;
  stream = new FakeStream();
  shellCalls = 0;
  execCalls: Array<{ command: string; pty: boolean }> = [];
  private handlers: Record<string, Array<(...a: unknown[]) => void>> = {};
  constructor(private readonly opts: FakeClientOpts = {}) {}
  on(ev: string, cb: (...a: unknown[]) => void): this {
    (this.handlers[ev] ??= []).push(cb);
    return this;
  }
  connect(cfg: Record<string, unknown>): void {
    if (this.opts.connectThrows) throw new Error("Cannot parse privateKey: SECRET-DO-NOT-LEAK");
    this.connectCfg = cfg;
    queueMicrotask(() => {
      if (this.opts.outcome === "error") this.emit("error", new Error("connection refused"));
      else this.emit("ready");
    });
  }
  shell(_opts: unknown, cb: (err: Error | undefined, stream: SshStream) => void): void {
    this.shellCalls++;
    if (this.opts.channelHang) return;
    if (this.opts.shellError) cb(new Error("no pty"), undefined as never);
    else cb(undefined, this.stream);
  }
  exec(command: string, options: { pty?: unknown }, cb: (err: Error | undefined, stream: SshStream & SshExecStream) => void): void {
    this.execCalls.push({ command, pty: Boolean(options.pty) });
    if (this.opts.channelHang) return;
    if (this.opts.execError) {
      cb(new Error("exec failed"), undefined as never);
      return;
    }
    cb(undefined, this.stream);
    const script = this.opts.exec;
    if (script && !script.hang) {
      queueMicrotask(() => {
        if (script.stdoutChunks) script.stdoutChunks.forEach((c) => this.stream.emit("data", c));
        if (script.stdout) this.stream.emit("data", Buffer.from(script.stdout));
        if (script.stderr) this.stream.emitStderr(Buffer.from(script.stderr));
        this.stream.emit("close", script.code ?? 0);
      });
    }
  }
  end(): void {
    this.ended = true;
  }
  private emit(ev: string, ...a: unknown[]): void {
    (this.handlers[ev] ?? []).forEach((h) => h(...a));
  }
}

let dir: string;
let custody: FileKeyCustody;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "pantheon-conn-"));
  custody = new FileKeyCustody(dir);
  await custody.storeKeyPair("harness", PRIV, PUB);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("connectTerminal", () => {
  it("connects KEY-ONLY using the custodied private key and resolves an interactive session", async () => {
    const client = new FakeClient({ outcome: "ready" });
    const session = await connectTerminal(TARGET, "harness", { custody, clientFactory: () => client });

    expect(client.connectCfg).toMatchObject({ host: "192.168.1.192", port: 22, username: "karl", privateKey: PRIV });
    expect(client.connectCfg && "password" in client.connectCfg).toBe(false); // key-only

    session.write("ls -la\n");
    expect(client.stream.written).toContain("ls -la\n");

    const received: string[] = [];
    session.onData((c) => received.push(c.toString()));
    client.stream.emit("data", Buffer.from("total 0\n"));
    expect(received).toEqual(["total 0\n"]);
  });

  it("requests a window resize on the remote PTY", async () => {
    const client = new FakeClient({ outcome: "ready" });
    const session = await connectTerminal(TARGET, "harness", { custody, clientFactory: () => client });
    session.resize(120, 40); // (cols, rows)
    expect(client.stream.windowCalls[0]?.slice(0, 2)).toEqual([40, 120]); // setWindow(rows, cols, ...)
  });

  it("close() ends the PTY stream and the client", async () => {
    const client = new FakeClient({ outcome: "ready" });
    const session = await connectTerminal(TARGET, "harness", { custody, clientFactory: () => client });
    session.close();
    expect(client.stream.ended).toBe(true);
    expect(client.ended).toBe(true);
  });

  it("rejects (fail closed) when the connection errors — no session", async () => {
    const client = new FakeClient({ outcome: "error" });
    await expect(connectTerminal(TARGET, "harness", { custody, clientFactory: () => client })).rejects.toBeInstanceOf(
      SshConnectionError
    );
  });

  it("rejects when the remote PTY/shell cannot be opened", async () => {
    const client = new FakeClient({ outcome: "ready", shellError: true });
    await expect(connectTerminal(TARGET, "harness", { custody, clientFactory: () => client })).rejects.toBeInstanceOf(
      SshConnectionError
    );
  });

  it("rejects an UNPROVISIONED machine before any connection attempt (no key in custody)", async () => {
    const factory = vi.fn(() => new FakeClient());
    await expect(connectTerminal(TARGET, "no-such-handle", { custody, clientFactory: factory })).rejects.toThrow();
    expect(factory).not.toHaveBeenCalled(); // never tried to connect
  });

  it("does not expose the private key on the returned session object (TM-020)", async () => {
    const client = new FakeClient({ outcome: "ready" });
    const session = await connectTerminal(TARGET, "harness", { custody, clientFactory: () => client });
    expect(JSON.stringify(session) ?? "").not.toContain("SECRET-DO-NOT-LEAK");
    expect((session as unknown as Record<string, unknown>)["privateKey"]).toBeUndefined();
  });

  it("times out (fail closed) when the peer completes the handshake but never answers the channel request", async () => {
    const client = new FakeClient({ channelHang: true });
    await expect(
      connectTerminal(TARGET, "harness", { custody, clientFactory: () => client }, { timeoutMs: 20 })
    ).rejects.toThrow(/timed out/i);
    expect(client.ended).toBe(true);
  });

  it("converts a synchronous throw from the ssh2 client into a sanitized SshConnectionError (no key material)", async () => {
    const client = new FakeClient({ connectThrows: true });
    const p = connectTerminal(TARGET, "harness", { custody, clientFactory: () => client });
    await expect(p).rejects.toBeInstanceOf(SshConnectionError);
    await expect(p).rejects.not.toThrow(/SECRET-DO-NOT-LEAK/);
    expect(client.ended).toBe(true);
  });
});

describe("connectTerminal with a remote command (tmux attach — M1 task 1)", () => {
  it("execs the command on a PTY instead of opening a bare shell; the session is still fully interactive", async () => {
    const client = new FakeClient();
    const session = await connectTerminal(
      TARGET,
      "harness",
      { custody, clientFactory: () => client },
      { command: cmd("tmux attach-session -t =pantheon") }
    );
    expect(client.execCalls).toEqual([{ command: "tmux attach-session -t =pantheon", pty: true }]);
    expect(client.shellCalls).toBe(0);
    session.write("ls\n");
    expect(client.stream.written).toContain("ls\n");
    session.resize(100, 30);
    expect(client.stream.windowCalls[0]?.slice(0, 2)).toEqual([30, 100]);
  });

  it("still opens a bare login shell when no command is given", async () => {
    const client = new FakeClient();
    await connectTerminal(TARGET, "harness", { custody, clientFactory: () => client }, {});
    expect(client.shellCalls).toBe(1);
    expect(client.execCalls).toEqual([]);
  });

  it("rejects (fail closed) and tears down when the remote command cannot be started", async () => {
    const client = new FakeClient({ execError: true });
    await expect(
      connectTerminal(TARGET, "harness", { custody, clientFactory: () => client }, { command: cmd("tmux attach-session -t =x") })
    ).rejects.toBeInstanceOf(SshConnectionError);
    expect(client.ended).toBe(true);
  });
});

describe("runRemoteCommand (capture — used for `tmux list-sessions`)", () => {
  it("captures stdout, stderr and the exit code over a KEY-ONLY connection, then closes the connection", async () => {
    const client = new FakeClient({ exec: { stdout: "2:1:1:pantheon\n", stderr: "warn\n", code: 0 } });
    const r = await runRemoteCommand(TARGET, "harness", cmd("tmux ls"), { custody, clientFactory: () => client });
    expect(r).toEqual({ code: 0, stdout: "2:1:1:pantheon\n", stderr: "warn\n" });
    expect(client.execCalls).toEqual([{ command: "tmux ls", pty: false }]);
    expect(client.connectCfg).toMatchObject({ host: "192.168.1.192", port: 22, username: "karl", privateKey: PRIV });
    expect(client.connectCfg && "password" in client.connectCfg).toBe(false);
    expect(client.ended).toBe(true);
  });

  it("reports a non-zero exit code as data rather than throwing", async () => {
    const client = new FakeClient({ exec: { stderr: "command not found: tmux\n", code: 127 } });
    const r = await runRemoteCommand(TARGET, "harness", cmd("tmux ls"), { custody, clientFactory: () => client });
    expect(r.code).toBe(127);
    expect(r.stderr).toContain("command not found");
  });

  it("rejects with SshConnectionError (no key material in the message) when the connection fails", async () => {
    const client = new FakeClient({ outcome: "error" });
    const p = runRemoteCommand(TARGET, "harness", cmd("tmux ls"), { custody, clientFactory: () => client });
    await expect(p).rejects.toBeInstanceOf(SshConnectionError);
    await expect(p).rejects.not.toThrow(/SECRET-DO-NOT-LEAK/);
  });

  it("rejects when the command cannot be started", async () => {
    const client = new FakeClient({ execError: true });
    await expect(runRemoteCommand(TARGET, "harness", cmd("tmux ls"), { custody, clientFactory: () => client })).rejects.toBeInstanceOf(
      SshConnectionError
    );
    expect(client.ended).toBe(true);
  });

  it("times out (fail closed) when the command never finishes, and tears the connection down", async () => {
    const client = new FakeClient({ exec: { hang: true } });
    await expect(
      runRemoteCommand(TARGET, "harness", cmd("sleep 999"), { custody, clientFactory: () => client }, { timeoutMs: 20 })
    ).rejects.toThrow(/timed out/i);
    expect(client.ended).toBe(true);
  });

  it("converts a synchronous throw from connect() into a sanitized SshConnectionError and still tears down", async () => {
    const client = new FakeClient({ connectThrows: true });
    const p = runRemoteCommand(TARGET, "harness", cmd("tmux ls"), { custody, clientFactory: () => client });
    await expect(p).rejects.toBeInstanceOf(SshConnectionError);
    await expect(p).rejects.not.toThrow(/SECRET-DO-NOT-LEAK/);
    expect(client.ended).toBe(true);
  });

  it("refuses an unprovisioned machine before dialing", async () => {
    const factory = vi.fn(() => new FakeClient());
    await expect(runRemoteCommand(TARGET, "no-such-handle", cmd("tmux ls"), { custody, clientFactory: factory })).rejects.toThrow();
    expect(factory).not.toHaveBeenCalled();
  });

  it("caps captured output in BYTES (not UTF-16 code units)", async () => {
    const client = new FakeClient({ exec: { stdout: "é".repeat(2000), code: 0 } }); // 2 bytes each = 4000 bytes
    const r = await runRemoteCommand(TARGET, "harness", cmd("yes"), { custody, clientFactory: () => client }, { maxOutputBytes: 1000 });
    expect(Buffer.byteLength(r.stdout, "utf8")).toBeLessThanOrEqual(1000);
    expect(r.stdout.length).toBeLessThan(1000);
  });

  it("decodes a multi-byte sequence split across SSH packets correctly (no U+FFFD)", async () => {
    const client = new FakeClient({ exec: { stdoutChunks: [Buffer.from([0xc3]), Buffer.from([0xa9])], code: 0 } });
    const r = await runRemoteCommand(TARGET, "harness", cmd("printf"), { custody, clientFactory: () => client });
    expect(r.stdout).toBe("é");
  });
});
