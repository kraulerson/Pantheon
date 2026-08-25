/**
 * Server entrypoint — Task #16f. `createServer` composes the whole control-plane into one runnable
 * Fastify app (registry + harness UI + terminal WebSocket + config), so `npm start` serves the
 * Config page, harness frame, and Claude-CLI terminals. Tested via inject (no real listen).
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { createServer } from "../src/server.js";

const TOKEN = "admin-token-0123456789abcdef0123456789abcdef";
const auth = { authorization: `Bearer ${TOKEN}` };

let app: FastifyInstance | undefined;
let keyDir: string;
afterEach(async () => {
  await app?.close();
  app = undefined;
  if (keyDir) rmSync(keyDir, { recursive: true, force: true });
});

async function makeServer(): Promise<FastifyInstance> {
  keyDir = mkdtempSync(join(tmpdir(), "pantheon-srv-keys-"));
  return createServer({ adminToken: TOKEN, dbPath: ":memory:", keyDir });
}

describe("createServer", () => {
  it("serves the harness frame behind auth and the public xterm assets", async () => {
    app = await makeServer();
    expect((await app.inject({ method: "GET", url: "/harness" })).statusCode).toBe(401);
    const frame = await app.inject({ method: "GET", url: "/harness", headers: auth });
    expect(frame.statusCode).toBe(200);
    expect(frame.body).toMatch(/New Session/i);
    expect((await app.inject({ method: "GET", url: "/assets/xterm.js" })).statusCode).toBe(200); // public
  });

  it("wires the DevMachine registry: create via API, then it appears + serves a terminal tab", async () => {
    app = await makeServer();
    const created = await app.inject({
      method: "POST",
      url: "/api/dev-machines",
      headers: auth,
      payload: { logicalName: "mac-studio", host: "192.168.1.192", user: "karl", enabled: true }
    });
    expect(created.statusCode).toBe(201);

    const list = await app.inject({ method: "GET", url: "/api/dev-machines", headers: auth });
    expect(list.json().some((m: { logicalName: string }) => m.logicalName === "mac-studio")).toBe(true);

    const tab = await app.inject({ method: "GET", url: "/harness/terminal/mac-studio", headers: auth });
    expect(tab.statusCode).toBe(200);
    expect(tab.body).toContain("mac-studio");
    expect(tab.body).toMatch(/new WebSocket\(/);
  });

  it("gates the terminal WebSocket route behind the admin guard (#9/TM-020)", async () => {
    app = await makeServer();
    // A plain GET (no auth) must be rejected by the guard before any upgrade.
    expect((await app.inject({ method: "GET", url: "/terminal/mac-studio" })).statusCode).toBe(401);
  });

  it("requires an admin token (throws if missing)", async () => {
    keyDir = mkdtempSync(join(tmpdir(), "pantheon-srv-keys-"));
    await expect(createServer({ adminToken: "", dbPath: ":memory:", keyDir })).rejects.toThrow();
  });
});

describe("createServer — session keycards (M1 task 2)", () => {
  it("wires the keycard door: mint on the admin API, then the card opens /keycard/v1/* and nothing else", async () => {
    app = await makeServer();
    const minted = await app.inject({ method: "POST", url: "/api/keycards", headers: auth, payload: { principal: "cli-mac-mini", scopes: ["sessions:read"] } });
    expect(minted.statusCode).toBe(201);
    const token = minted.json().token as string;
    const who = await app.inject({ method: "GET", url: "/keycard/v1/whoami", headers: { authorization: `Bearer ${token}` } });
    expect(who.statusCode).toBe(200);
    expect(who.json()).toMatchObject({ principal: "cli-mac-mini" });
    const sessions = await app.inject({ method: "GET", url: "/keycard/v1/sessions", headers: { authorization: `Bearer ${token}` } });
    expect(sessions.statusCode).toBe(200);
    expect(sessions.json()).toEqual({ sessions: [] });
    expect((await app.inject({ method: "GET", url: "/api/backends", headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(403);
  });

  it("the Configuration page shows the Session Keycards section", async () => {
    app = await makeServer();
    const res = await app.inject({ method: "GET", url: "/admin/config", headers: auth });
    expect(res.body).toContain("Session Keycards");
  });
});

describe("createServer — Peta approvals backend is wired when PETA_URL/PETA_ADMIN_TOKEN are set", () => {
  /** A fake Peta admin endpoint: answers LIST_APPROVALS (9201) with one pending approval carrying arguments. */
  function fakePetaFetch(): typeof fetch {
    return (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { action: number };
      const payload =
        body.action === 9201
          ? { success: true, approvals: [{ approvalId: "ap-9", tool: "gitea_file_write", status: "pending", arguments: { content: "SECRET-CONTENT" } }] }
          : { success: true, servers: [] };
      return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
  }

  it("mounts the admin /approvals proxy and makes approvals:read live on the keycard door (reference-only)", async () => {
    keyDir = mkdtempSync(join(tmpdir(), "pantheon-srv-keys-"));
    app = await createServer({ adminToken: TOKEN, dbPath: ":memory:", keyDir, keyHandle: "harness", peta: { url: "http://peta.test", token: "peta-admin-token" }, fetchFn: fakePetaFetch() });
    const adminList = await app.inject({ method: "GET", url: "/approvals", headers: auth });
    expect(adminList.statusCode).toBe(200);
    const minted = await app.inject({ method: "POST", url: "/api/keycards", headers: auth, payload: { principal: "cli", scopes: ["approvals:read"] } });
    const token = minted.json().token as string;
    const door = await app.inject({ method: "GET", url: "/keycard/v1/approvals", headers: { authorization: `Bearer ${token}` } });
    expect(door.statusCode).toBe(200);
    expect(door.json()).toEqual({ approvals: [{ id: "ap-9", tool: "gitea_file_write", status: "pending" }], truncated: false });
    expect(door.body).not.toContain("SECRET-CONTENT");
  });

  it("without Peta configured the admin /approvals proxy is not mounted and the door answers a labeled 503", async () => {
    app = await makeServer();
    expect((await app.inject({ method: "GET", url: "/approvals", headers: auth })).statusCode).toBe(404);
    const minted = await app.inject({ method: "POST", url: "/api/keycards", headers: auth, payload: { principal: "cli", scopes: ["approvals:read"] } });
    const door = await app.inject({ method: "GET", url: "/keycard/v1/approvals", headers: { authorization: `Bearer ${minted.json().token}` } });
    expect(door.statusCode).toBe(503);
    expect(door.json()).toMatchObject({ state: "unavailable" });
  });
});
