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
