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
import { registerTerminalRoute } from "../src/http/routes/terminal.js";
import { TerminalRegistry } from "../src/devmachine/terminal-gateway.js";
import { SqliteRegistry } from "../src/registry/sqlite-repository.js";
import { RegistryService } from "../src/registry/service.js";
import { type TerminalSession } from "../src/devmachine/connection.js";

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
    await registerTerminalRoute(app, { registry, terminals, connect });
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
    await registerTerminalRoute(app, { registry, terminals: new TerminalRegistry(), connect });
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
    await registerTerminalRoute(app, { registry: provisionedRegistry(true), terminals: new TerminalRegistry(), connect: connect as never });
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
    await registerTerminalRoute(app, { registry: provisionedRegistry(true), terminals: new TerminalRegistry(), connect: connect as never });
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
    await registerTerminalRoute(app, { registry, terminals, connect });
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
