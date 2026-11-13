/**
 * SshConnectionPool — BUGS #86. One persistent key-only ssh2 connection per dev machine; every command is its own
 * exec channel on it. Before this, each console poll (every 5 s) logged in to every machine from scratch.
 *
 * Security requirement (BUGS #86): a connection must not outlive the machine's right to be connected to. Disabling
 * or removing the machine, re-provisioning it, changing its address, and a changed or missing key in custody each
 * close the open connection. Those tests fail if the connection survives.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { CustodyError, type KeyCustody } from "../src/devmachine/custody.js";
import {
  remoteCommandFailure,
  SshConnectionError,
  type RemoteCommand,
  type SshClient,
  type SshExecStream,
  type SshStream
} from "../src/devmachine/connection.js";
import { closeOnDevMachineChange, createConnectionPool, MAX_CHANNELS_PER_CONNECTION } from "../src/devmachine/connection-pool.js";
import { SqliteRegistry } from "../src/registry/sqlite-repository.js";
import { RegistryService } from "../src/registry/service.js";

const KEY_A = "-----BEGIN OPENSSH PRIVATE KEY-----\nSECRET-A-DO-NOT-LEAK\n-----END OPENSSH PRIVATE KEY-----\n";
const KEY_B = "-----BEGIN OPENSSH PRIVATE KEY-----\nSECRET-B-DO-NOT-LEAK\n-----END OPENSSH PRIVATE KEY-----\n";
const TARGET = { logicalName: "mac-studio", host: "192.168.1.192", port: 22, user: "karl" } as const;
const OTHER = { logicalName: "linux-dev", host: "192.168.1.202", port: 22, user: "karl" } as const;
const HANDLE = "handle-1";
const cmd = (s: string): RemoteCommand => s as RemoteCommand;

class FakeChannel implements SshStream, SshExecStream {
  private cbs: Record<string, Array<(...a: unknown[]) => void>> = {};
  private errCbs: Array<(chunk: Buffer) => void> = [];
  readonly stderr = { on: (_ev: "data", cb: (chunk: Buffer) => void): void => void this.errCbs.push(cb) };
  closed = false;
  write(): void {}
  setWindow(): void {}
  end(): void {}
  close(): void {
    this.closed = true;
  }
  on(ev: "data" | "close", cb: (...a: unknown[]) => void): this {
    (this.cbs[ev] ??= []).push(cb);
    return this;
  }
  finish(code: number, stdout = "", stderr = ""): void {
    if (stdout) (this.cbs["data"] ?? []).forEach((h) => h(Buffer.from(stdout)));
    if (stderr) this.errCbs.forEach((h) => h(Buffer.from(stderr)));
    (this.cbs["close"] ?? []).forEach((h) => h(code));
  }
}

class FakeClient implements SshClient {
  connectCfg: Record<string, unknown> | undefined;
  ended = false;
  execs: Array<{ command: string; channel: FakeChannel }> = [];
  execError = false;
  private handlers: Record<string, Array<(...a: unknown[]) => void>> = {};
  on(ev: string, cb: (...a: never[]) => void): this {
    (this.handlers[ev] ??= []).push(cb as (...a: unknown[]) => void);
    return this;
  }
  connect(cfg: Record<string, unknown>): void {
    this.connectCfg = cfg;
  }
  shell(): void {
    throw new Error("the pool never opens a shell");
  }
  exec(command: string, _o: unknown, cb: (err: Error | undefined, stream: SshStream & SshExecStream) => void): void {
    if (this.execError) {
      cb(new Error("exec refused SECRET-A-DO-NOT-LEAK"), undefined as unknown as SshStream & SshExecStream);
      return;
    }
    const channel = new FakeChannel();
    this.execs.push({ command, channel });
    cb(undefined, channel);
  }
  end(): void {
    this.ended = true;
  }
  emit(ev: string, ...a: unknown[]): void {
    (this.handlers[ev] ?? []).forEach((h) => h(...a));
  }
}

class FakeCustody implements KeyCustody {
  keys = new Map<string, string>([[HANDLE, KEY_A]]);
  async hasKeyPair(handle: string): Promise<boolean> {
    return this.keys.has(handle);
  }
  async storeKeyPair(handle: string, privatePem: string): Promise<void> {
    this.keys.set(handle, privatePem);
  }
  async resolvePrivateKey(handle: string): Promise<string> {
    const key = this.keys.get(handle);
    if (key === undefined) throw new CustodyError(`no key in custody for handle ${handle}`);
    return key;
  }
  async resolvePublicKey(): Promise<string> {
    return "ssh-ed25519 AAAA harness@pantheon\n";
  }
}

/** Let the pool's awaits (custody, the ready promise) run. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
};

describe("SshConnectionPool (BUGS #86)", () => {
  let clients: FakeClient[];
  let custody: FakeCustody;
  let pool: ReturnType<typeof createConnectionPool>;

  beforeEach(() => {
    vi.useFakeTimers();
    clients = [];
    custody = new FakeCustody();
    pool = createConnectionPool({
      custody,
      clientFactory: () => {
        const c = new FakeClient();
        clients.push(c);
        return c;
      }
    });
  });
  afterEach(() => {
    pool.closeAll();
    vi.useRealTimers();
  });

  /** Start a command and bring it to the point where its exec channel is open on a ready connection. */
  async function started(target = TARGET, command = "probe", handle = HANDLE): Promise<{ p: Promise<unknown>; client: FakeClient }> {
    const p = pool.run(target, handle, cmd(command));
    p.catch(() => undefined);
    await settle();
    const client = clients[clients.length - 1]!;
    if (client.execs.length === 0) {
      client.emit("ready");
      await settle();
    }
    return { p, client };
  }

  async function runOk(target = TARGET, command = "probe"): Promise<FakeClient> {
    const { p, client } = await started(target, command);
    client.execs[client.execs.length - 1]!.channel.finish(0, "ok");
    await p;
    return client;
  }

  it("logs in once and runs every later command on the same connection", async () => {
    await runOk(TARGET, "one");
    await runOk(TARGET, "two");
    await runOk(TARGET, "three");
    expect(clients).toHaveLength(1);
    expect(clients[0]!.execs.map((e) => e.command)).toEqual(["one", "two", "three"]);
    expect(clients[0]!.ended).toBe(false);
  });

  it("returns each command's own exit code, stdout and stderr", async () => {
    const { p, client } = await started(TARGET, "one");
    client.execs[0]!.channel.finish(3, "out", "err");
    await expect(p).resolves.toEqual({ code: 3, stdout: "out", stderr: "err" });
  });

  it("connects key-only with SSH keepalives on", async () => {
    const client = await runOk();
    const cfg = client.connectCfg!;
    expect(cfg["privateKey"]).toBe(KEY_A);
    expect(cfg).not.toHaveProperty("password");
    expect(cfg["host"]).toBe(TARGET.host);
    expect(cfg["username"]).toBe(TARGET.user);
    expect(cfg["keepaliveInterval"]).toBeGreaterThan(0);
    expect(cfg["keepaliveCountMax"]).toBeGreaterThan(0);
  });

  it("shares one login between commands that start before the connection is ready", async () => {
    const a = pool.run(TARGET, HANDLE, cmd("a"));
    const b = pool.run(TARGET, HANDLE, cmd("b"));
    await settle();
    expect(clients).toHaveLength(1);
    clients[0]!.emit("ready");
    await settle();
    expect(clients[0]!.execs.map((e) => e.command).sort()).toEqual(["a", "b"]);
    clients[0]!.execs.forEach((e) => e.channel.finish(0));
    await Promise.all([a, b]);
  });

  it("keeps a separate connection per machine", async () => {
    await runOk(TARGET);
    await runOk(OTHER);
    expect(clients).toHaveLength(2);
    expect(clients[1]!.connectCfg!["host"]).toBe(OTHER.host);
  });

  it("a command that outlives its timeout fails as a timeout and closes only its own channel", async () => {
    const slow = await started(TARGET, "slow");
    vi.advanceTimersByTime(6_000);
    const other = await started(TARGET, "other");
    vi.advanceTimersByTime(4_001);
    const err = await slow.p.then(
      () => undefined,
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(SshConnectionError);
    expect(remoteCommandFailure(err)).toEqual({ mayHaveRun: true, reason: "timeout" });
    const client = slow.client;
    expect(client.execs[0]!.channel.closed).toBe(true);
    // The command that shares the connection is untouched (a delivery must not fail because a probe was slow).
    expect(client.ended).toBe(false);
    expect(client.execs[1]!.channel.closed).toBe(false);
    client.execs[1]!.channel.finish(0, "fine");
    await expect(other.p).resolves.toEqual({ code: 0, stdout: "fine", stderr: "" });
  });

  it("three timeouts in a row with no success between them close the connection, and the next command logs in again", async () => {
    for (let i = 0; i < 3; i += 1) {
      const { p } = await started();
      vi.advanceTimersByTime(10_001);
      await p.catch(() => undefined);
      expect(clients).toHaveLength(1);
      expect(clients[0]!.ended).toBe(i === 2);
    }
    await runOk();
    expect(clients).toHaveLength(2);
  });

  it("a success between timeouts resets the count", async () => {
    for (let i = 0; i < 4; i += 1) {
      const { p } = await started();
      vi.advanceTimersByTime(10_001);
      await p.catch(() => undefined);
      await runOk();
    }
    expect(clients).toHaveLength(1);
    expect(clients[0]!.ended).toBe(false);
  });

  it("a connection that drops fails the commands running on it as ssh_failed and the next command logs in again", async () => {
    const { p, client } = await started();
    client.emit("error", Object.assign(new Error("read ECONNRESET at 192.168.1.192"), { level: "client-socket", code: "ECONNRESET" }));
    const err = await p.then(
      () => undefined,
      (e: unknown) => e
    );
    expect(remoteCommandFailure(err)).toEqual({ mayHaveRun: true, reason: "ssh_failed" });
    expect((err as SshConnectionError).sshCause).toEqual({ errName: "Error", level: "client-socket", code: "ECONNRESET" });
    await runOk();
    expect(clients).toHaveLength(2);
  });

  it("a connection closed by the machine while idle is replaced on the next command", async () => {
    const first = await runOk();
    first.emit("close");
    await runOk();
    expect(clients).toHaveLength(2);
  });

  it("an exec request the machine refuses fails as exec_error without leaking the error text", async () => {
    const { client } = await started();
    client.execs[0]!.channel.finish(0);
    client.execError = true;
    const err = await pool.run(TARGET, HANDLE, cmd("again")).then(
      () => undefined,
      (e: unknown) => e
    );
    expect(remoteCommandFailure(err)).toEqual({ mayHaveRun: true, reason: "exec_error" });
    expect(String((err as Error).message)).not.toContain("SECRET");
  });

  it("a failed login fails the command before exec and is not retried until the backoff has passed", async () => {
    const p = pool.run(TARGET, HANDLE, cmd("probe"));
    await settle();
    clients[0]!.emit("error", Object.assign(new Error("connect ECONNREFUSED"), { level: "client-socket", code: "ECONNREFUSED" }));
    const err = await p.then(
      () => undefined,
      (e: unknown) => e
    );
    expect(remoteCommandFailure(err)).toEqual({ mayHaveRun: false, reason: "connect_failed" });
    expect(clients[0]!.ended).toBe(true);

    const during = await pool.run(TARGET, HANDLE, cmd("probe")).then(
      () => undefined,
      (e: unknown) => e
    );
    expect(remoteCommandFailure(during)).toEqual({ mayHaveRun: false, reason: "connect_failed" });
    expect(clients).toHaveLength(1);

    vi.advanceTimersByTime(60_000);
    await runOk();
    expect(clients).toHaveLength(2);
  });

  it("the backoff grows after repeated failed logins and resets after a good one", async () => {
    const failOnce = async (): Promise<void> => {
      const before = clients.length;
      const p = pool.run(TARGET, HANDLE, cmd("probe"));
      p.catch(() => undefined);
      await settle();
      expect(clients).toHaveLength(before + 1);
      clients[before]!.emit("error", new Error("refused"));
      await p.catch(() => undefined);
    };
    await failOnce();
    vi.advanceTimersByTime(1_000);
    await failOnce();
    // The second failure doubles the wait: 1 s is no longer enough.
    vi.advanceTimersByTime(1_000);
    await pool.run(TARGET, HANDLE, cmd("probe")).catch(() => undefined);
    expect(clients).toHaveLength(2);
    vi.advanceTimersByTime(1_000);
    await runOk();
    expect(clients).toHaveLength(3);
    // After a good login a drop is redialled at once.
    clients[2]!.emit("close");
    await runOk();
    expect(clients).toHaveLength(4);
  });

  it(`refuses a command over ${MAX_CHANNELS_PER_CONNECTION} at once on one machine, before exec`, async () => {
    const running: Array<Promise<unknown>> = [];
    for (let i = 0; i < MAX_CHANNELS_PER_CONNECTION; i += 1) running.push((await started(TARGET, `c${i}`)).p);
    const client = clients[0]!;
    expect(client.execs).toHaveLength(MAX_CHANNELS_PER_CONNECTION);
    const err = await pool.run(TARGET, HANDLE, cmd("one-too-many")).then(
      () => undefined,
      (e: unknown) => e
    );
    expect(remoteCommandFailure(err)).toEqual({ mayHaveRun: false, reason: "connect_failed" });
    expect(client.execs).toHaveLength(MAX_CHANNELS_PER_CONNECTION);
    expect(client.ended).toBe(false);
    client.execs.forEach((e) => e.channel.finish(0));
    await Promise.all(running);
    await runOk(TARGET, "after");
    expect(clients).toHaveLength(1);
  });

  describe("a connection never outlives the right to use it", () => {
    it("a rotated key closes the open connection and the next command logs in with the new key", async () => {
      const first = await runOk();
      custody.keys.set(HANDLE, KEY_B);
      const second = await runOk();
      expect(first.ended).toBe(true);
      expect(second).not.toBe(first);
      expect(second.connectCfg!["privateKey"]).toBe(KEY_B);
    });

    it("a key removed from custody closes the open connection and nothing is dialled", async () => {
      const first = await runOk();
      custody.keys.delete(HANDLE);
      await expect(pool.run(TARGET, HANDLE, cmd("probe"))).rejects.toBeInstanceOf(CustodyError);
      expect(first.ended).toBe(true);
      expect(clients).toHaveLength(1);
    });

    it("a changed address, user or key handle closes the open connection", async () => {
      const first = await runOk();
      custody.keys.set("handle-2", KEY_A);
      const { client: second } = await started({ ...TARGET, host: "192.168.1.250" });
      expect(first.ended).toBe(true);
      expect(second.connectCfg!["host"]).toBe("192.168.1.250");
      const { client: third } = await started({ ...TARGET, host: "192.168.1.250" }, "probe", "handle-2");
      expect(second.ended).toBe(true);
      expect(third).not.toBe(second);
    });

    it("close(name) ends the connection and fails what was running on it", async () => {
      const { p, client } = await started();
      pool.close(TARGET.logicalName);
      expect(client.ended).toBe(true);
      const err = await p.then(
        () => undefined,
        (e: unknown) => e
      );
      expect(remoteCommandFailure(err)).toEqual({ mayHaveRun: true, reason: "ssh_failed" });
    });

    it("closeAll ends every connection", async () => {
      const a = await runOk(TARGET);
      const b = await runOk(OTHER);
      pool.closeAll();
      expect(a.ended).toBe(true);
      expect(b.ended).toBe(true);
    });

    describe("bound to the registry", () => {
      let svc: RegistryService;
      let id: string;
      let open: FakeClient;

      beforeEach(async () => {
        svc = new RegistryService(new SqliteRegistry(":memory:"));
        closeOnDevMachineChange(svc, pool);
        const m = svc.createDevMachine({ logicalName: TARGET.logicalName, host: TARGET.host, port: 22, user: TARGET.user, enabled: true });
        id = m.id;
        svc.markProvisioned(id, HANDLE);
        open = await runOk();
        expect(open.ended).toBe(false);
      });

      it("disabling the machine closes its connection", () => {
        svc.updateDevMachine(id, { enabled: false });
        expect(open.ended).toBe(true);
      });

      it("removing the machine closes its connection", () => {
        svc.deleteDevMachine(id);
        expect(open.ended).toBe(true);
      });

      it("re-provisioning the machine (a new key) closes its connection", () => {
        svc.markProvisioned(id, "handle-2");
        expect(open.ended).toBe(true);
      });

      it("changing the machine's address closes its connection", () => {
        svc.updateDevMachine(id, { host: "192.168.1.250" });
        expect(open.ended).toBe(true);
      });

      it("a change to another machine leaves this connection open", () => {
        const other = svc.createDevMachine({ logicalName: OTHER.logicalName, host: OTHER.host, port: 22, user: OTHER.user, enabled: true });
        svc.updateDevMachine(other.id, { enabled: false });
        svc.deleteDevMachine(other.id);
        expect(open.ended).toBe(false);
      });
    });
  });

  describe("review findings (2026-11-12)", () => {
    it("a command already starting when the machine is closed does not log back in", async () => {
      const first = await runOk();
      const p = pool.run(TARGET, HANDLE, cmd("probe")); // now waiting on custody
      pool.close(TARGET.logicalName);
      const err = await p.then(
        () => undefined,
        (e: unknown) => e
      );
      expect(remoteCommandFailure(err)).toEqual({ mayHaveRun: false, reason: "connect_failed" });
      expect(first.ended).toBe(true);
      expect(clients).toHaveLength(1);
    });

    it("a command starting when the machine is closed with no connection open does not log in, and a later command can", async () => {
      const p = pool.run(TARGET, HANDLE, cmd("probe"));
      pool.close(TARGET.logicalName);
      await expect(p).rejects.toBeInstanceOf(SshConnectionError);
      expect(clients).toHaveLength(0);
      await runOk();
      expect(clients).toHaveLength(1);
    });

    it("a command starting when every connection is closed does not log in", async () => {
      const p = pool.run(TARGET, HANDLE, cmd("probe"));
      pool.closeAll();
      await expect(p).rejects.toBeInstanceOf(SshConnectionError);
      expect(clients).toHaveLength(0);
    });

    it("closing a machine clears its login backoff, so a re-provisioned machine is dialled at once", async () => {
      const p = pool.run(TARGET, HANDLE, cmd("probe"));
      p.catch(() => undefined);
      await settle();
      clients[0]!.emit("error", new Error("refused"));
      await p.catch(() => undefined);
      pool.close(TARGET.logicalName);
      await runOk();
      expect(clients).toHaveLength(2);
    });

    it("a changed port or user closes the open connection", async () => {
      const first = await runOk();
      const { client: second } = await started({ ...TARGET, port: 2222 });
      expect(first.ended).toBe(true);
      expect(second.connectCfg!["port"]).toBe(2222);
      const { client: third } = await started({ ...TARGET, port: 2222, user: "someone-else" });
      expect(second.ended).toBe(true);
      expect(third.connectCfg!["username"]).toBe("someone-else");
    });

    it("logs a connect and a close with the machine, a reason and the ssh2 error's class, level and code only", async () => {
      const lines: Array<Record<string, unknown>> = [];
      const logged = createConnectionPool({
        custody,
        clientFactory: () => {
          const c = new FakeClient();
          clients.push(c);
          return c;
        },
        log: { info: (obj) => void lines.push(obj), warn: (obj) => void lines.push(obj) }
      });
      const p = logged.run(TARGET, HANDLE, cmd("probe"));
      p.catch(() => undefined);
      await settle();
      const client = clients[clients.length - 1]!;
      client.emit("ready");
      await settle();
      client.emit("error", Object.assign(new Error(`reset at 192.168.1.192 ${KEY_A}`), { level: "client-socket", code: "ECONNRESET" }));
      await p.catch(() => undefined);
      expect(lines).toEqual([
        { event: "ssh.pool_connected", machine: "mac-studio" },
        { event: "ssh.pool_closed", machine: "mac-studio", reason: "error", errName: "Error", sshLevel: "client-socket", sshCode: "ECONNRESET" }
      ]);
      logged.closeAll();
    });
  });

  it("no error from the pool carries key material", async () => {
    const p = pool.run(TARGET, HANDLE, cmd("probe"));
    await settle();
    clients[0]!.emit("error", new Error(`bad key ${KEY_A}`));
    const err = (await p.then(
      () => undefined,
      (e: unknown) => e
    )) as Error;
    expect(err.message).not.toContain("SECRET");
    expect(JSON.stringify(err)).not.toContain("SECRET");
  });
});
