/**
 * Terminal WebSocket route — Task #16(c) integration via `@fastify/websocket`'s `injectWS` (a real
 * in-process WebSocket, fake SSH session — no network). Verifies the ws⇄gateway wiring: ready frame,
 * input → PTY, PTY output → client, and the fail-closed error frame for an unprovisioned machine.
 *
 * NB: the message listener is attached via injectWS's `onInit` so the route's proactive ready/error
 * frame (sent on connect) is not lost to the in-process open race.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { registerTerminalRoute, type TerminalRouteDeps } from "../src/http/routes/terminal.js";
import { TerminalRegistry } from "../src/devmachine/terminal-gateway.js";
import { SqliteRegistry } from "../src/registry/sqlite-repository.js";
import { RegistryService } from "../src/registry/service.js";
import { SshConnectionError, type TerminalSession } from "../src/devmachine/connection.js";
import { SqliteConsoleStore, type SubmitLogInsert, type SubmitLogRow } from "../src/console/store.js";
import type { PollerLogger } from "../src/console/poller.js";

/** A logger that keeps the test output clean: the failed-open warn lines (triage 14) are asserted where they matter. */
const QUIET: PollerLogger = { info: () => {}, warn: () => {}, error: () => {} };

function fakeSession(): TerminalSession & { emitData: (s: string) => void; writes: string[] } {
  let dataCb: (c: Buffer) => void = () => {};
  const writes: string[] = [];
  return {
    writes,
    write: (s) => writes.push(s),
    onData: (cb) => (dataCb = cb),
    onClose: () => {},
    resize: () => {},
    close: () => {},
    emitData: (s) => dataCb(Buffer.from(s))
  };
}

function provisionedRegistry(provisioned = true): RegistryService {
  const svc = new RegistryService(new SqliteRegistry(":memory:"));
  const m = svc.createDevMachine({ logicalName: "mac-studio", host: "192.168.1.192", user: "karl", enabled: true });
  if (provisioned) svc.markProvisioned(m.id, "harness");
  return svc;
}

/** A frame queue attached via onInit so proactive server frames are never missed. */
function frameQueue() {
  const q: Array<Record<string, unknown>> = [];
  const waiters: Array<(m: Record<string, unknown>) => void> = [];
  const push = (raw: unknown) => {
    const msg = JSON.parse(String(raw)) as Record<string, unknown>;
    const w = waiters.shift();
    if (w) w(msg);
    else q.push(msg);
  };
  const next = () =>
    new Promise<Record<string, unknown>>((res) => {
      const m = q.shift();
      if (m) res(m);
      else waiters.push(res);
    });
  return { push, next };
}

async function waitFor(pred: () => boolean, ms = 1000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("terminal WebSocket route", () => {
  it("opens a terminal, sends a ready frame, pipes input and output", async () => {
    const registry = provisionedRegistry(true);
    const terminals = new TerminalRegistry();
    let session: ReturnType<typeof fakeSession> | undefined;
    const connect = vi.fn(async () => (session = fakeSession()));

    app = Fastify();
    await registerTerminalRoute(app, { registry, terminals, connect, log: QUIET });
    await app.ready();

    const q = frameQueue();
    const client = await app.injectWS("/terminal/mac-studio", {}, { onInit: (ws) => ws.on("message", q.push) });

    const ready = await q.next();
    expect(ready["t"]).toBe("ready");
    expect(typeof ready["id"]).toBe("string");

    client.send(JSON.stringify({ t: "i", d: "ls -la\n" }));
    await waitFor(() => !!session && session.writes.includes("ls -la\n"));

    session!.emitData("total 0\n");
    const out = await q.next();
    expect(out).toEqual({ t: "o", d: "total 0\n" });

    client.close();
  });

  it("sends a fail-closed error frame for an unprovisioned machine (no connect)", async () => {
    const registry = provisionedRegistry(false); // not provisioned
    const connect = vi.fn(async () => fakeSession());

    app = Fastify();
    await registerTerminalRoute(app, { registry, terminals: new TerminalRegistry(), connect, log: QUIET });
    await app.ready();

    const q = frameQueue();
    const client = await app.injectWS("/terminal/mac-studio", {}, { onInit: (ws) => ws.on("message", q.push) });
    const msg = await q.next();
    expect(msg["t"]).toBe("e");
    expect(String(msg["m"])).toMatch(/not provisioned/i);
    expect(connect).not.toHaveBeenCalled();
    client.close();
  });
});

describe("terminal WebSocket route — tmux attach (M1 task 1)", () => {
  /** Open a socket against a provisioned registry; return the first proactive frame. */
  async function firstFrame(url: string, connect: ReturnType<typeof vi.fn>): Promise<Record<string, unknown>> {
    app = Fastify();
    await registerTerminalRoute(app, { registry: provisionedRegistry(true), terminals: new TerminalRegistry(), connect: connect as never, log: QUIET });
    await app.ready();
    const q = frameQueue();
    const client = await app.injectWS(url, {}, { onInit: (ws) => ws.on("message", q.push) });
    const first = await q.next();
    client.close();
    return first;
  }

  it("?tmux=<name> opens the terminal ATTACHED to that exact session (attach command handed to connect)", async () => {
    const connect = vi.fn(async () => fakeSession());
    const first = await firstFrame("/terminal/mac-studio?tmux=pantheon", connect);
    expect(first["t"]).toBe("ready");
    expect(connect).toHaveBeenCalledTimes(1);
    expect(String(connect.mock.calls[0]?.[2])).toMatch(/tmux attach-session -t '=pantheon'$/);
  });

  it("?tmux=<name>&create=1 uses attach-or-create (new session)", async () => {
    const connect = vi.fn(async () => fakeSession());
    const first = await firstFrame("/terminal/mac-studio?tmux=solo&create=1", connect);
    expect(first["t"]).toBe("ready");
    expect(String(connect.mock.calls[0]?.[2])).toMatch(/tmux new-session -A -s 'solo'$/);
  });

  it("without ?tmux the plain login shell is opened (no remote command)", async () => {
    const connect = vi.fn(async () => fakeSession());
    await firstFrame("/terminal/mac-studio", connect);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(connect.mock.calls[0]?.[2]).toBeUndefined();
  });

  it("a tmux name with shell metacharacters is refused BEFORE any SSH connect (labeled error frame)", async () => {
    const connect = vi.fn(async () => fakeSession());
    const first = await firstFrame("/terminal/mac-studio?tmux=" + encodeURIComponent("x;id"), connect);
    expect(first["t"]).toBe("e");
    expect(String(first["m"])).toMatch(/session name/i);
    expect(connect).not.toHaveBeenCalled();
  });
});

describe("terminal WebSocket route — audit remediation (2026-08-25)", () => {
  it("a repeated ?tmux key (array) is refused before any dial", async () => {
    const connect = vi.fn(async () => fakeSession());
    app = Fastify();
    await registerTerminalRoute(app, { registry: provisionedRegistry(true), terminals: new TerminalRegistry(), connect: connect as never, log: QUIET });
    await app.ready();
    const q = frameQueue();
    const client = await app.injectWS("/terminal/mac-studio?tmux=a&tmux=b", {}, { onInit: (ws) => ws.on("message", q.push) });
    const first = await q.next();
    client.close();
    expect(first["t"]).toBe("e");
    expect(connect).not.toHaveBeenCalled();
  });

  it("?session=<id> reattach is refused with a labeled error when the id belongs to another machine or target (no silent swap)", async () => {
    const registry = provisionedRegistry(true);
    const other = registry.createDevMachine({ logicalName: "linux-box", host: "192.168.1.202", user: "karl", enabled: true });
    registry.markProvisioned(other.id, "harness");
    const terminals = new TerminalRegistry();
    const connect = vi.fn(async () => fakeSession());
    app = Fastify();
    await registerTerminalRoute(app, { registry, terminals, connect, log: QUIET });
    await app.ready();

    const q1 = frameQueue();
    const c1 = await app.injectWS("/terminal/mac-studio", {}, { onInit: (ws) => ws.on("message", q1.push) });
    const ready = await q1.next();
    const id = String(ready["id"]);
    c1.close();

    // Same id presented for a DIFFERENT machine → error frame, no new dial.
    const q2 = frameQueue();
    const c2 = await app.injectWS(`/terminal/linux-box?session=${id}`, {}, { onInit: (ws) => ws.on("message", q2.push) });
    const m2 = await q2.next();
    c2.close();
    expect(m2["t"]).toBe("e");
    expect(String(m2["m"])).toMatch(/does not belong/i);

    // Same id, same machine, but a tmux target it was not opened with → error frame too.
    const q3 = frameQueue();
    const c3 = await app.injectWS(`/terminal/mac-studio?session=${id}&tmux=pantheon`, {}, { onInit: (ws) => ws.on("message", q3.push) });
    const m3 = await q3.next();
    c3.close();
    expect(m3["t"]).toBe("e");

    // Same id, same machine, same (plain-shell) target → reattaches, still one dial in total.
    const q4 = frameQueue();
    const c4 = await app.injectWS(`/terminal/mac-studio?session=${id}`, {}, { onInit: (ws) => ws.on("message", q4.push) });
    const m4 = await q4.next();
    c4.close();
    expect(m4["t"]).toBe("ready");
    expect(m4["id"]).toBe(id);
    expect(connect).toHaveBeenCalledTimes(1);
  });
});

describe("explicit tab close (BUGS #33)", () => {
  it('a {t:"c"} frame ENDS the SSH session and evicts the terminal — closing a tab must not leave a ghost tmux client', async () => {
    let closeCb: (() => void) | undefined;
    let closed = false;
    const session: TerminalSession = {
      write: () => {},
      onData: () => {},
      onClose: (cb) => {
        closeCb = cb;
      },
      resize: () => {},
      close: () => {
        closed = true;
        closeCb?.();
      }
    };
    const terminals = new TerminalRegistry();
    app = Fastify();
    await registerTerminalRoute(app, { registry: provisionedRegistry(true), terminals, connect: vi.fn(async () => session), log: QUIET });
    await app.ready();
    const q = frameQueue();
    const client = await app.injectWS("/terminal/mac-studio?tmux=pantheon", {}, { onInit: (ws) => ws.on("message", q.push) });
    const ready = await q.next();
    expect(terminals.get(String(ready["id"]))).toBeDefined();
    client.send(JSON.stringify({ t: "c" }));
    await waitFor(() => closed);
    expect(terminals.get(String(ready["id"]))).toBeUndefined();
    client.close();
  });

  it("a plain socket drop (no close frame) still only DETACHES — the session stays reconnectable", async () => {
    let closed = false;
    const session: TerminalSession = { write: () => {}, onData: () => {}, onClose: () => {}, resize: () => {}, close: () => (closed = true) };
    const terminals = new TerminalRegistry();
    app = Fastify();
    await registerTerminalRoute(app, { registry: provisionedRegistry(true), terminals, connect: vi.fn(async () => session), log: QUIET });
    await app.ready();
    const q = frameQueue();
    const client = await app.injectWS("/terminal/mac-studio", {}, { onInit: (ws) => ws.on("message", q.push) });
    const ready = await q.next();
    client.close();
    await new Promise((r) => setTimeout(r, 20));
    expect(closed).toBe(false);
    expect(terminals.get(String(ready["id"]))).toBeDefined();
  });
});

describe("terminal WebSocket route — machine shell (?shell=1, F2 Task 7)", () => {
  const ROOT = "/Users/karl/Documents/Claude Projects";
  const SHELL_LINE = "tmux new-session -A -s 'sh-mac-studio' -c '/Users/karl/Documents/Claude Projects'";
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const NAME_RULE = "cannot name a tmux shell session (letters, digits, '_' and '-' only, at most 61 characters)";

  function registryWith(...names: string[]): RegistryService {
    const svc = new RegistryService(new SqliteRegistry(":memory:"));
    for (const logicalName of names) {
      const m = svc.createDevMachine({ logicalName, host: "192.168.1.192", user: "karl", enabled: true });
      svc.markProvisioned(m.id, "harness");
    }
    return svc;
  }

  type ShellDeps = Pick<TerminalRouteDeps, "projectsRootFor" | "consoleStore" | "log">;

  /** Mount the route with the shell deps on a fresh app; `open` returns a socket's first proactive frame. */
  async function mount(deps: ShellDeps, registry = registryWith("mac-studio"), connect: ReturnType<typeof vi.fn> = vi.fn(async () => fakeSession())) {
    const server = Fastify();
    app = server;
    await registerTerminalRoute(server, { registry, terminals: new TerminalRegistry(), connect: connect as never, log: QUIET, ...deps });
    await server.ready();
    const open = async (url: string): Promise<Record<string, unknown>> => {
      const q = frameQueue();
      const client = await server.injectWS(url, {}, { onInit: (ws) => ws.on("message", q.push) });
      const first = await q.next();
      client.close();
      return first;
    };
    return { connect, open, server };
  }

  it("?shell=1 opens the machine shell: attach-or-create of sh-<machine> in that machine's projects root, written ahead (T11-12) — an attempted row before the dial, a result opened_shell row once the PTY is up", async () => {
    const projectsRootFor = vi.fn((name: string) => (name === "mac-studio" ? ROOT : undefined));
    const store = new SqliteConsoleStore();
    const append = vi.spyOn(store, "appendSubmitLog");
    const { connect, open } = await mount({ projectsRootFor, consoleStore: store });
    const first = await open("/terminal/mac-studio?shell=1");
    expect(first["t"]).toBe("ready");
    expect(connect).toHaveBeenCalledTimes(1);
    expect(String(connect.mock.calls[0]?.[2]).endsWith(SHELL_LINE)).toBe(true);
    expect(projectsRootFor).toHaveBeenCalledWith("mac-studio");
    expect(append.mock.calls.map((c) => c[0].rowKind)).toEqual(["attempted", "result"]);
    expect(append.mock.invocationCallOrder[0]!).toBeLessThan(connect.mock.invocationCallOrder[0]!);
    expect(append.mock.invocationCallOrder[1]!).toBeGreaterThan(connect.mock.invocationCallOrder[0]!);
    const [attempted, result] = append.mock.results.map((r) => r.value as SubmitLogRow) as [SubmitLogRow, SubmitLogRow];
    expect(attempted).toMatchObject({ rowKind: "attempted", outcome: null, machine: "mac-studio", tmuxSession: "sh-mac-studio", cardId: null, textMasked: null, reason: null });
    expect(attempted.idempotencyKey).toMatch(UUID_RE);
    expect(attempted.at).toBe(new Date(attempted.at).toISOString());
    expect(result).toMatchObject({ rowKind: "result", outcome: "opened_shell", idempotencyKey: attempted.idempotencyKey, machine: "mac-studio", tmuxSession: "sh-mac-studio", cardId: null, textMasked: null, reason: null });
    expect(store.findSubmitResult(attempted.idempotencyKey)).toEqual(result);
  });

  it("ruling T11-17: ?shell=1 fails closed on a mount without the console store — a labelled frame, no dial", async () => {
    const { connect, open } = await mount({ projectsRootFor: () => ROOT });
    expect(await open("/terminal/mac-studio?shell=1")).toEqual({ t: "e", m: "machine shell refused — this terminal mount keeps no audit log" });
    expect(connect).not.toHaveBeenCalled();
  });

  it("ruling T11-17: the machine is resolved before any row — an unknown, disabled or unprovisioned machine writes nothing and dials nothing", async () => {
    const registry = registryWith("mac-studio");
    registry.createDevMachine({ logicalName: "parked", host: "192.168.1.193", user: "karl", enabled: false });
    registry.createDevMachine({ logicalName: "fresh", host: "192.168.1.194", user: "karl", enabled: true });
    const store = new SqliteConsoleStore();
    const append = vi.spyOn(store, "appendSubmitLog");
    const { connect, open } = await mount({ projectsRootFor: () => ROOT, consoleStore: store }, registry);
    expect(await open("/terminal/ghost?shell=1")).toEqual({ t: "e", m: "no dev machine with logicalName 'ghost'" });
    expect(await open("/terminal/parked?shell=1")).toEqual({ t: "e", m: "dev machine 'parked' is disabled" });
    expect(await open("/terminal/fresh?shell=1")).toEqual({ t: "e", m: "dev machine 'fresh' is not provisioned" });
    expect(append).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });

  it("ruling T11-12: a dial that fails after the attempted row writes a result failed row; the frame stays the generic label", async () => {
    const store = new SqliteConsoleStore();
    const append = vi.spyOn(store, "appendSubmitLog");
    const refused = vi.fn(async () => {
      throw new SshConnectionError("SSH connection to mac-studio (karl@192.168.1.192) failed");
    });
    const { open } = await mount({ projectsRootFor: () => ROOT, consoleStore: store }, registryWith("mac-studio"), refused);
    expect(await open("/terminal/mac-studio?shell=1")).toEqual({ t: "e", m: "terminal open failed" });
    expect(refused).toHaveBeenCalledTimes(1);
    const rows = append.mock.results.map((r) => r.value as SubmitLogRow);
    expect(rows.map((r) => [r.rowKind, r.outcome, r.reason])).toEqual([["attempted", null, null], ["result", "failed", "open_failed"]]);
    expect(rows[1]!.idempotencyKey).toBe(rows[0]!.idempotencyKey);
  });

  it("a tmux tab or a plain login shell never consults the projects root or the audit log", async () => {
    const projectsRootFor = vi.fn(() => ROOT);
    const store = new SqliteConsoleStore();
    const append = vi.spyOn(store, "appendSubmitLog");
    const { connect, open } = await mount({ projectsRootFor, consoleStore: store });
    expect((await open("/terminal/mac-studio?tmux=pantheon"))["t"]).toBe("ready");
    expect((await open("/terminal/mac-studio"))["t"]).toBe("ready");
    expect(connect).toHaveBeenCalledTimes(2);
    expect(projectsRootFor).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
  });

  it("?shell=1 is refused with 400 alongside ?tmux= or ?create=, or with any value but 1 — before any dial", async () => {
    const { connect, server } = await mount({ projectsRootFor: () => ROOT });
    for (const url of [
      "/terminal/mac-studio?shell=1&tmux=pantheon",
      "/terminal/mac-studio?shell=1&create=1",
      "/terminal/mac-studio?shell=yes",
      "/terminal/mac-studio?shell=1&shell=1"
    ]) {
      await expect(server.injectWS(url)).rejects.toThrow(/400/);
    }
    expect(connect).not.toHaveBeenCalled();
  });

  it("a machine without a projects root → the labelled first frame and no dial (whether the lookup answers undefined or is not wired)", async () => {
    const expected = { t: "e", m: "no projects root configured for mac-studio — add machines.mac-studio.projectsRoot to the console settings file" };
    const unset = await mount({ projectsRootFor: () => undefined });
    expect(await unset.open("/terminal/mac-studio?shell=1")).toEqual(expected);
    expect(unset.connect).not.toHaveBeenCalled();
    await unset.server.close();
    const unwired = await mount({});
    expect(await unwired.open("/terminal/mac-studio?shell=1")).toEqual(expected);
    expect(unwired.connect).not.toHaveBeenCalled();
  });

  it("a logical name that cannot name a tmux session (a '.', or over 61 characters) → the labelled first frame; no dial, no audit row, never a 500", async () => {
    const long = "m".repeat(62);
    const fits = "m".repeat(61);
    const store = new SqliteConsoleStore();
    const append = vi.spyOn(store, "appendSubmitLog");
    const { connect, open } = await mount({ projectsRootFor: () => ROOT, consoleStore: store }, registryWith("mac.studio", long, fits));
    expect(await open("/terminal/mac.studio?shell=1")).toEqual({ t: "e", m: `machine name mac.studio ${NAME_RULE}` });
    expect(await open(`/terminal/${long}?shell=1`)).toEqual({ t: "e", m: `machine name ${long} ${NAME_RULE}` });
    expect(connect).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
    // The boundary: 61 characters plus the "sh-" prefix is exactly the 64-character tmux session name cap.
    expect((await open(`/terminal/${fits}?shell=1`))["t"]).toBe("ready");
    expect(String(connect.mock.calls[0]?.[2])).toContain(`-s 'sh-${fits}'`);
  });

  it("ruling T11-12: every new-dial ?shell=1 open is audited — no per-process Set: two opens are two row pairs, another machine gets its own", async () => {
    const store = new SqliteConsoleStore();
    const append = vi.spyOn(store, "appendSubmitLog");
    const { connect, open } = await mount({ projectsRootFor: () => ROOT, consoleStore: store }, registryWith("mac-studio", "linux-box"));
    expect((await open("/terminal/mac-studio?shell=1"))["t"]).toBe("ready");
    expect((await open("/terminal/mac-studio?shell=1"))["t"]).toBe("ready");
    expect(connect).toHaveBeenCalledTimes(2);
    expect(append).toHaveBeenCalledTimes(4);
    const rows = append.mock.results.map((r) => r.value as SubmitLogRow);
    expect(rows.map((r) => [r.rowKind, r.outcome, r.machine])).toEqual([
      ["attempted", null, "mac-studio"],
      ["result", "opened_shell", "mac-studio"],
      ["attempted", null, "mac-studio"],
      ["result", "opened_shell", "mac-studio"]
    ]);
    expect(rows[2]!.idempotencyKey).not.toBe(rows[0]!.idempotencyKey); // a fresh key per open
    expect((await open("/terminal/linux-box?shell=1"))["t"]).toBe("ready");
    expect(append).toHaveBeenCalledTimes(6);
    expect((append.mock.results[5]?.value as SubmitLogRow)).toMatchObject({ outcome: "opened_shell", machine: "linux-box", tmuxSession: "sh-linux-box" });
  });

  it("?session=<id>&shell=1 reattaches the shell terminal (no second dial, no row: T11-12); the same id without shell=1 is another target and is refused", async () => {
    const store = new SqliteConsoleStore();
    const append = vi.spyOn(store, "appendSubmitLog");
    const { connect, open } = await mount({ projectsRootFor: () => ROOT, consoleStore: store });
    const ready = await open("/terminal/mac-studio?shell=1");
    const id = String(ready["id"]);
    expect(append).toHaveBeenCalledTimes(2);
    expect(await open(`/terminal/mac-studio?shell=1&session=${id}`)).toEqual({ t: "ready", id });
    const other = await open(`/terminal/mac-studio?session=${id}`);
    expect(other["t"]).toBe("e");
    expect(String(other["m"])).toMatch(/does not belong/i);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(append).toHaveBeenCalledTimes(2);
  });

  it("ruling T11-12: an attempted row that cannot be written refuses the shell before any dial — one error line (T7-2), a labelled frame without raw error text, and the next open retries", async () => {
    const real = new SqliteConsoleStore();
    let fail = true;
    const consoleStore = {
      appendSubmitLog: vi.fn((row: SubmitLogInsert) => {
        if (fail) throw new Error("SQLITE_BUSY: database is locked (RAW-ERROR-TEXT)");
        return real.appendSubmitLog(row);
      })
    };
    // A root the logged line must never carry.
    const root = "/srv/projects-root-canary";
    const error = vi.fn();
    const log: PollerLogger = { info: vi.fn(), warn: vi.fn(), error };
    const { connect, open } = await mount({ projectsRootFor: () => root, consoleStore, log });
    const refused = await open("/terminal/mac-studio?shell=1");
    expect(refused).toEqual({ t: "e", m: "machine shell refused — its audit row could not be written" });
    expect(connect).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
    const [fields, msg] = error.mock.calls[0] as [Record<string, unknown>, string];
    expect(msg).toBe("console shell: audit row not written; nothing dialled");
    expect(fields).toMatchObject({ event: "console.shell_audit_failed", machine: "mac-studio", row: "attempted" });
    expect(typeof fields["correlationId"]).toBe("string");
    expect(String((fields["err"] as { message?: string })?.message)).toContain("SQLITE_BUSY");
    expect(JSON.stringify(error.mock.calls)).not.toContain(root);
    expect(log.info).not.toHaveBeenCalled();
    fail = false;
    expect((await open("/terminal/mac-studio?shell=1"))["t"]).toBe("ready");
    expect(connect).toHaveBeenCalledTimes(1);
    expect(consoleStore.appendSubmitLog).toHaveBeenCalledTimes(3);
  });

  it("ruling T11-17 + triage 61: a result row that cannot be written once the PTY is up — the error line BEFORE the PTY closes, the PTY closed, a labelled frame; the attempted row records the open", async () => {
    const order: string[] = [];
    const session: TerminalSession = { write: () => {}, onData: () => {}, onClose: () => {}, resize: () => {}, close: () => void order.push("close") };
    const real = new SqliteConsoleStore();
    const consoleStore = {
      appendSubmitLog: vi.fn((row: SubmitLogInsert) => {
        if (row.rowKind === "result") throw new Error("SQLITE_FULL: database or disk is full");
        return real.appendSubmitLog(row);
      })
    };
    const log: PollerLogger = { info: vi.fn(), warn: vi.fn((): void => void order.push("warn")), error: vi.fn((): void => void order.push("error")) };
    const { connect, open } = await mount({ projectsRootFor: () => ROOT, consoleStore, log }, registryWith("mac-studio"), vi.fn(async () => session));
    expect(await open("/terminal/mac-studio?shell=1")).toEqual({ t: "e", m: "machine shell closed — its audit row could not be written" });
    expect(connect).toHaveBeenCalledTimes(1);
    expect(order.slice(0, 2)).toEqual(["error", "close"]);
    const [fields, msg] = (log.error as ReturnType<typeof vi.fn>).mock.calls[0] as [Record<string, unknown>, string];
    expect(msg).toBe("console shell: audit row not written; session closed");
    expect(fields).toMatchObject({ event: "console.shell_audit_failed", machine: "mac-studio", row: "result" });
    // The attempted row stands alone: it records that a shell was opened.
    const attempted = consoleStore.appendSubmitLog.mock.results[0]?.value as SubmitLogRow;
    expect(attempted).toMatchObject({ rowKind: "attempted", tmuxSession: "sh-mac-studio" });
    expect(real.findSubmitResult(attempted.idempotencyKey)).toBeUndefined();
  });

  it("a throwing logger never breaks the answer: the refusal still reaches the socket and the line falls back to stderr with loggerFailed (the poller's rule)", async () => {
    const consoleStore = {
      appendSubmitLog: vi.fn(() => {
        throw new Error("SQLITE_BUSY: database is locked");
      })
    };
    const log: PollerLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(() => {
        throw new Error("logger down");
      })
    };
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const { open } = await mount({ projectsRootFor: () => ROOT, consoleStore, log });
      const refused = await open("/terminal/mac-studio?shell=1");
      expect(String(refused["m"])).toMatch(/audit row could not be written/);
      const line = stderr.mock.calls.map((c) => String(c[0])).find((l) => l.includes("console.shell_audit_failed"));
      expect(line).toBeDefined();
      expect(JSON.parse(String(line)) as Record<string, unknown>).toMatchObject({
        level: "error",
        event: "console.shell_audit_failed",
        machine: "mac-studio",
        loggerFailed: true,
        msg: "console shell: audit row not written; nothing dialled"
      });
    } finally {
      stderr.mockRestore();
    }
  });

  it("ruling T11-17: ?tmux=sh-<…>&create=1 is refused with a labelled frame — a machine shell is created only through ?shell=1; a plain ?tmux=sh-<…> attach stays (recorded D18 residual)", async () => {
    const store = new SqliteConsoleStore();
    const append = vi.spyOn(store, "appendSubmitLog");
    const { connect, open } = await mount({ projectsRootFor: () => ROOT, consoleStore: store });
    expect(await open("/terminal/mac-studio?tmux=sh-mac-studio&create=1")).toEqual({ t: "e", m: "a machine shell (sh-…) is opened only through ?shell=1" });
    expect(await open("/terminal/mac-studio?tmux=sh-other&create=1")).toEqual({ t: "e", m: "a machine shell (sh-…) is opened only through ?shell=1" });
    expect(connect).not.toHaveBeenCalled();
    expect((await open("/terminal/mac-studio?tmux=sh-mac-studio"))["t"]).toBe("ready");
    expect(String(connect.mock.calls[0]?.[2])).toMatch(/tmux attach-session -t '=sh-mac-studio'$/);
    // A project session named like the shells' neighbours is not in the namespace.
    expect((await open("/terminal/mac-studio?tmux=shell-x&create=1"))["t"]).toBe("ready");
    expect(append).not.toHaveBeenCalled();
  });
});

describe("terminal WebSocket route — a failed open is logged (triage 14, L12)", () => {
  it("one warn line per failed terminal or shell open: machine, correlation id, a fixed reason and the error's class — never its message, a path or user@host", async () => {
    const warn = vi.fn();
    const log: PollerLogger = { info: vi.fn(), warn, error: vi.fn() };
    const refusedDial = vi.fn(async () => {
      throw new SshConnectionError("SSH connection to mac-studio (karl@192.168.1.192) failed");
    });
    app = Fastify();
    const store = new SqliteConsoleStore();
    await registerTerminalRoute(app, { registry: provisionedRegistry(true), terminals: new TerminalRegistry(), connect: refusedDial, projectsRootFor: () => "/srv/secret-root", consoleStore: store, log });
    await app.ready();
    const open = async (url: string): Promise<Record<string, unknown>> => {
      const q = frameQueue();
      const client = await app!.injectWS(url, {}, { onInit: (ws) => ws.on("message", q.push) });
      const first = await q.next();
      client.close();
      return first;
    };
    expect(await open("/terminal/mac-studio")).toEqual({ t: "e", m: "terminal open failed" });
    expect(await open("/terminal/mac-studio?shell=1")).toEqual({ t: "e", m: "terminal open failed" });
    expect(await open("/terminal/mac-studio?tmux=" + encodeURIComponent("x;id"))).toMatchObject({ t: "e" });
    expect(await open("/terminal/ghost")).toMatchObject({ t: "e" });
    expect(warn).toHaveBeenCalledTimes(4);
    const lines = warn.mock.calls.map((c) => c[0] as Record<string, unknown>);
    expect(lines[0]).toEqual({ event: "terminal.open_failed", machine: "mac-studio", shell: false, reason: "connect_failed", errName: "SshConnectionError", correlationId: expect.any(String) as string });
    expect(lines[1]).toMatchObject({ event: "terminal.open_failed", machine: "mac-studio", shell: true, reason: "connect_failed" });
    expect(lines[2]).toMatchObject({ event: "terminal.open_failed", machine: "mac-studio", shell: false, reason: "refused", errName: "TmuxError" });
    expect(lines[3]).toMatchObject({ event: "terminal.open_failed", machine: "ghost", reason: "refused", errName: "TerminalError" });
    expect(warn.mock.calls.every((c) => c[1] === "terminal open failed")).toBe(true);
    const logged = JSON.stringify(warn.mock.calls);
    for (const leak of ["@", "192.168", "secret-root", "x;id", "no dev machine"]) expect(logged).not.toContain(leak);
  });
});
