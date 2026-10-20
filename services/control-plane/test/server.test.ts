/**
 * Server entrypoint — Task #16f. `createServer` composes the whole control-plane into one runnable
 * Fastify app (registry + harness UI + terminal WebSocket + config), so `npm start` serves the
 * Config page, harness frame, and Claude-CLI terminals. Tested via inject; one test listens on 127.0.0.1:0
 * to run the onListen hook (the console poller's start), and nothing is dialled.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import { configFromEnv, createServer } from "../src/server.js";

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

  it("ruling T11-3 (F-1): with login on, the production terminal socket refuses a bearer-only upgrade (403) and opens for the operator's cookie session", async () => {
    // The production loggers write to stderr: swallowed for the whole test (the output stays clean), then checked.
    const lines: string[] = [];
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
      lines.push(...String(chunk).split("\n"));
      return true;
    }) as never);
    const frames: string[] = [];
    try {
      keyDir = mkdtempSync(join(tmpdir(), "pantheon-srv-keys-"));
      app = await createServer({ adminToken: TOKEN, dbPath: ":memory:", keyDir, keyHandle: "harness", operatorPassword: "correct horse" });
      await app.ready();
      const ws = app as FastifyInstance & { injectWS: (path: string, ctx?: { headers?: Record<string, string> }, opts?: { onInit?: (s: { on: (e: string, cb: (d: unknown) => void) => void }) => void }) => Promise<{ close: () => void }> };
      await expect(ws.injectWS("/terminal/mac-studio", { headers: auth })).rejects.toThrow(/403/);
      await expect(ws.injectWS("/terminal/mac-studio")).rejects.toThrow(/401/);
      const login = await app.inject({ method: "POST", url: "/login", headers: { "content-type": "application/x-www-form-urlencoded" }, payload: "password=correct%20horse" });
      const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
      // The cookie session reaches the route: its first frame is the gateway's labelled refusal for an unknown machine,
      // and the production logger writes one warn line for the failed open (triage 14).
      let got: (() => void) | undefined;
      const first = new Promise<void>((resolve) => (got = resolve));
      const socket = await ws.injectWS("/terminal/mac-studio", { headers: { cookie } }, { onInit: (s) => s.on("message", (d) => { frames.push(String(d)); got?.(); }) });
      await first;
      socket.close();
    } finally {
      stderr.mockRestore();
    }
    expect(JSON.parse(frames[0]!)).toEqual({ t: "e", m: "no dev machine with logicalName 'mac-studio'" });
    // Ruling T11-23 (m3): only lines that parse as JSON objects are log lines — other stderr output is skipped, never fatal.
    const events = lines.flatMap((l): Record<string, unknown>[] => {
      if (!l.startsWith("{")) return [];
      try {
        return [JSON.parse(l) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
    const warn = events.find((l) => l["event"] === "terminal.open_failed");
    expect(warn).toMatchObject({ level: "warn", module: "terminal-route", machine: "mac-studio", shell: false, reason: "refused", errName: "TerminalError" });
    expect(JSON.stringify(warn)).not.toContain("no dev machine");
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
    expect(door.json()).toEqual({ approvals: [{ id: "ap-9", tool: "gitea_file_write", status: "pending", source: "Pantheon" }], truncated: false });
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

describe("configFromEnv — Maestro Console settings file (F1 Task 10)", () => {
  it("configFromEnv reads PANTHEON_CONSOLE_SETTINGS and defaults beside the DB", () => {
    const base = { ADMIN_API_TOKEN: TOKEN };
    expect(configFromEnv({ ...base, PANTHEON_CONSOLE_SETTINGS: "/etc/pantheon/console.json" }).consoleSettingsPath).toBe("/etc/pantheon/console.json");
    // Beside whatever DB is configured, and beside the default DB when none is.
    expect(configFromEnv({ ...base, PANTHEON_DB: "/var/lib/pantheon/control-plane.db" }).consoleSettingsPath).toBe("/var/lib/pantheon/console-settings.json");
    expect(configFromEnv(base).consoleSettingsPath).toBe(resolve("data/console-settings.json"));
    // `.env.local.example` ships `PANTHEON_CONSOLE_SETTINGS=` — an empty value is "unset", like every other optional path here.
    expect(configFromEnv({ ...base, PANTHEON_CONSOLE_SETTINGS: "" }).consoleSettingsPath).toBe(resolve("data/console-settings.json"));
  });
});

// Final review M2: ADR-0010 — a bad console settings file disables the console module only. A settings path that
// cannot be read (EISDIR, EACCES) used to throw out of createServer and stop the whole control-plane.
describe("createServer — a console settings file that cannot be read (final review M2)", () => {
  it("a settings path that is a directory disables the console only: the server starts, the poller is not started, the API says disabled", async () => {
    keyDir = mkdtempSync(join(tmpdir(), "pantheon-srv-keys-"));
    const settingsDir = mkdtempSync(join(tmpdir(), "pantheon-srv-settings-"));
    const lines: string[] = [];
    const write = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      lines.push(...String(chunk).split("\n"));
      return true;
    });
    try {
      app = await createServer({ adminToken: TOKEN, dbPath: ":memory:", keyDir, keyHandle: "harness", consoleSettingsPath: settingsDir });
      const state = await app.inject({ method: "GET", url: "/console/api/state", headers: auth });
      expect(state.statusCode).toBe(200);
      expect(state.json()).toMatchObject({ settings: { disabled: true, entry: "(file)" } });
      const page = await app.inject({ method: "GET", url: "/console", headers: auth });
      expect(page.body).toContain('data-console-disabled="(file)"');
      // The rest of the control-plane runs: the harness frame still answers.
      expect((await app.inject({ method: "GET", url: "/harness", headers: auth })).statusCode).toBe(200);
      await app.listen({ port: 0, host: "127.0.0.1" });
      const events = lines.filter((l) => l.startsWith("{")).map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(events.find((e) => e["event"] === "console.settings_unreadable")).toMatchObject({ level: "error", code: "EISDIR" });
      expect(events.find((e) => e["event"] === "console.poller_not_started")).toMatchObject({ entry: "(file)", detail: "(file) could not be read" });
      expect(events.some((e) => e["event"] === "console.poller_started")).toBe(false);
    } finally {
      write.mockRestore();
      rmSync(settingsDir, { recursive: true, force: true });
    }
  });
});
