/**
 * server.ts ↔ SshConnectionPool wiring — BUGS #86 security requirement, end to end (review finding 2, 2026-11-12).
 *
 * The REAL `createServer`, the real ssh2 client and the real key custody, against an in-process ssh2 server on
 * 127.0.0.1 (no host is contacted). Pins what the pool's unit tests cannot: that the server actually routes commands
 * through one shared connection, and that a registry change made through the HTTP API closes it at the machine.
 * These fail if the lines in `server.ts` that create the pool, bind it to the registry or close it are removed.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import ssh2 from "ssh2";
import { createServer } from "../src/server.js";
import { FileKeyCustody } from "../src/devmachine/custody.js";

const { Server, utils } = ssh2;

const TOKEN = "admin-token-0123456789abcdef0123456789abcdef";
const auth = { authorization: `Bearer ${TOKEN}` };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface FakeSshd {
  readonly port: number;
  readonly stats: { authed: number; liveAuthed: number; authMethods: string[] };
  close(): Promise<void>;
}

/** A loopback sshd that accepts any public key (and the enrollment password), and answers every exec with "ok". */
function startSshd(): Promise<FakeSshd> {
  const stats = { authed: 0, liveAuthed: 0, authMethods: [] as string[] };
  const live = new Set<{ end(): void }>();
  const server = new Server({ hostKeys: [utils.generateKeyPairSync("ed25519").private] }, (client) => {
    let authed = false;
    live.add(client);
    client.on("authentication", (ctx) => {
      stats.authMethods.push(ctx.method);
      if (ctx.method === "publickey" || ctx.method === "password") ctx.accept();
      else ctx.reject(["publickey"]);
    });
    client.on("ready", () => {
      authed = true;
      stats.authed += 1;
      stats.liveAuthed += 1;
      client.on("session", (accept) => {
        accept().on("exec", (acceptExec) => {
          const stream = acceptExec();
          stream.write("ok\n");
          stream.exit(0);
          stream.end();
        });
      });
    });
    client.on("close", () => {
      live.delete(client);
      if (authed) stats.liveAuthed -= 1;
    });
    client.on("error", () => undefined);
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({
        port: (server.address() as AddressInfo).port,
        stats,
        close: () =>
          new Promise<void>((done) => {
            for (const c of live) c.end();
            server.close(() => done());
          })
      })
    )
  );
}

let app: FastifyInstance | undefined;
let sshd: FakeSshd | undefined;
let dir: string | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
  await sshd?.close();
  sshd = undefined;
  vi.restoreAllMocks();
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

async function setup(): Promise<{ app: FastifyInstance; sshd: FakeSshd; id: string }> {
  dir = mkdtempSync(join(tmpdir(), "pantheon-pool-wiring-"));
  vi.spyOn(process.stderr, "write").mockImplementation(() => true); // the server's structured log lines
  const keyDir = join(dir, "keys");
  const settingsPath = join(dir, "console-settings.json");
  writeFileSync(settingsPath, JSON.stringify({ machines: { box: { projectsRoot: "/tmp/pool-wiring-projects" } } }));
  // The harness keypair is already in custody, so enrollment reuses it and ssh-keygen is not run.
  const pair = utils.generateKeyPairSync("ed25519");
  await new FileKeyCustody(keyDir).storeKeyPair("harness", pair.private, pair.public);
  const s = (sshd = await startSshd());
  const a = (app = await createServer({ adminToken: TOKEN, dbPath: ":memory:", keyDir, keyHandle: "harness", consoleSettingsPath: settingsPath }));
  const created = await a.inject({
    method: "POST",
    url: "/api/dev-machines",
    headers: auth,
    payload: { logicalName: "box", host: "127.0.0.1", port: s.port, user: "u", enabled: true }
  });
  expect(created.statusCode).toBe(201);
  const id = (created.json() as { id: string }).id;
  await provision(a, id);
  await sleep(50);
  expect(s.stats.liveAuthed).toBe(0); // enrollment's own connections are gone
  return { app: a, sshd: s, id };
}

async function provision(a: FastifyInstance, id: string): Promise<void> {
  const res = await a.inject({ method: "POST", url: `/api/dev-machines/${id}/provision`, headers: auth, payload: { password: "test-only" } });
  expect(res.statusCode).toBe(200);
}

/** One pooled command through a real console route (no result cache, unlike the tmux lister). */
const pooledCommand = (a: FastifyInstance): ReturnType<FastifyInstance["inject"]> =>
  a.inject({ method: "GET", url: "/console/api/machines/box/projects", headers: auth });

describe("server.ts wires the SSH connection pool (BUGS #86)", () => {
  it("commands share one login, and disabling the machine through the API closes it at the machine", async () => {
    const { app: a, sshd: s, id } = await setup();
    const before = s.stats.authed;
    for (let i = 0; i < 3; i += 1) expect((await pooledCommand(a)).statusCode).toBe(200);
    expect(s.stats.authed - before).toBe(1);
    expect(s.stats.liveAuthed).toBe(1);

    expect((await a.inject({ method: "PUT", url: `/api/dev-machines/${id}`, headers: auth, payload: { enabled: false } })).statusCode).toBe(200);
    await sleep(100);
    expect(s.stats.liveAuthed).toBe(0);
    expect((await pooledCommand(a)).statusCode).toBe(409); // not connectable: nothing is dialled
    expect(s.stats.authed - before).toBe(1);
  });

  it("re-provisioning the machine, changing its address and removing it each close the connection", async () => {
    const { app: a, sshd: s, id } = await setup();
    await pooledCommand(a);
    expect(s.stats.liveAuthed).toBe(1);

    await provision(a, id);
    await sleep(100);
    expect(s.stats.liveAuthed).toBe(0); // re-provisioned

    await pooledCommand(a);
    expect(s.stats.liveAuthed).toBe(1);
    expect((await a.inject({ method: "PUT", url: `/api/dev-machines/${id}`, headers: auth, payload: { user: "someone-else" } })).statusCode).toBe(200);
    await sleep(100);
    expect(s.stats.liveAuthed).toBe(0); // address changed

    await provision(a, id);
    await sleep(50);
    await pooledCommand(a);
    expect(s.stats.liveAuthed).toBe(1);
    expect((await a.inject({ method: "DELETE", url: `/api/dev-machines/${id}`, headers: auth })).statusCode).toBe(204);
    await sleep(100);
    expect(s.stats.liveAuthed).toBe(0); // removed
  });

  it("closing the server ends every pooled connection", async () => {
    const { app: a, sshd: s } = await setup();
    await pooledCommand(a);
    expect(s.stats.liveAuthed).toBe(1);
    await a.close();
    app = undefined;
    await sleep(100);
    expect(s.stats.liveAuthed).toBe(0);
  });

  it("the pooled login offers the key only", async () => {
    const { app: a, sshd: s } = await setup();
    const from = s.stats.authMethods.length;
    await pooledCommand(a);
    expect([...new Set(s.stats.authMethods.slice(from))].sort()).toEqual(["none", "publickey"]);
  });
});
