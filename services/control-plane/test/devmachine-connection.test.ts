/**
 * connectTerminal — Task #16(c, foundation), the server-side SSH→PTY broker (ADR-0005, TM-020).
 *
 * Opens a key-only ssh2 connection to a DevMachine using the private key resolved from custody at
 * connect time, then requests a remote PTY (`shell()`). The ssh2 client is injected so the
 * lifecycle (ready → shell → session; error → reject) is unit-tested without a real machine.
 *
 * Security invariants: connection auth is KEY-ONLY (never a password); an unprovisioned machine
 * (no key in custody) is rejected BEFORE any connection attempt; the private key is captured in a
 * closure and never exposed on the returned session object.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileKeyCustody } from "../src/devmachine/custody.js";
import {
  connectTerminal,
  SshConnectionError,
  type SshClient,
  type SshStream
} from "../src/devmachine/connection.js";

const PRIV = "-----BEGIN OPENSSH PRIVATE KEY-----\nSECRET-DO-NOT-LEAK\n-----END OPENSSH PRIVATE KEY-----\n";
const PUB = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFAKEPUBLIC harness@pantheon\n";
const TARGET = { logicalName: "mac-studio", host: "192.168.1.192", port: 22, user: "karl" } as const;

class FakeStream implements SshStream {
  written: string[] = [];
  windowCalls: Array<[number, number, number, number]> = [];
  ended = false;
  private cbs: Record<string, (c?: Buffer) => void> = {};
  write(d: string): void {
    this.written.push(d);
  }
  on(ev: "data" | "close", cb: (c?: Buffer) => void): this {
    this.cbs[ev] = cb;
    return this;
  }
  setWindow(rows: number, cols: number, height: number, width: number): void {
    this.windowCalls.push([rows, cols, height, width]);
  }
  end(): void {
    this.ended = true;
  }
  emit(ev: "data" | "close", chunk?: Buffer): void {
    this.cbs[ev]?.(chunk);
  }
}

class FakeClient implements SshClient {
  connectCfg: Record<string, unknown> | undefined;
  ended = false;
  stream = new FakeStream();
  private handlers: Record<string, Array<(...a: unknown[]) => void>> = {};
  constructor(private readonly opts: { outcome: "ready" | "error"; shellError?: boolean } = { outcome: "ready" }) {}
  on(ev: string, cb: (...a: unknown[]) => void): this {
    (this.handlers[ev] ??= []).push(cb);
    return this;
  }
  connect(cfg: Record<string, unknown>): void {
    this.connectCfg = cfg;
    queueMicrotask(() => {
      if (this.opts.outcome === "error") this.emit("error", new Error("connection refused"));
      else this.emit("ready");
    });
  }
  shell(_opts: unknown, cb: (err: Error | undefined, stream: SshStream) => void): void {
    if (this.opts.shellError) cb(new Error("no pty"), undefined as never);
    else cb(undefined, this.stream);
  }
  end(): void {
    this.ended = true;
  }
  private emit(ev: string, ...a: unknown[]): void {
    (this.handlers[ev] ?? []).forEach((h) => h(...a));
  }
}

describe("connectTerminal", () => {
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
});
