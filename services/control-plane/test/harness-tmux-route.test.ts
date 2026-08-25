/**
 * GET /harness/tmux/:logicalName — the live tmux session list the harness launch bar fetches
 * (M1 task 1). Admin-guarded like every harness route; resolves the machine with the SAME
 * fail-closed rules as opening a terminal (unknown / disabled / unprovisioned never dial); every
 * outcome is a labeled JSON `state` (CC1 text, CC2 fail closed).
 */

import { describe, it, expect, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/http/app.js";
import { SqliteRegistry, seedDefaults } from "../src/registry/sqlite-repository.js";
import { RegistryService } from "../src/registry/service.js";
import { McpRegistrationService } from "../src/registry/mcp-registration.js";
import type { TmuxListResult } from "../src/devmachine/tmux.js";
import type { SshTarget } from "../src/devmachine/provisioning.js";

const TOKEN = "super-strong-admin-token-0123456789abcdef";
const auth = { authorization: `Bearer ${TOKEN}` };

type Lister = (target: SshTarget, handle: string) => Promise<TmuxListResult>;

function makeApp(list?: Lister): { app: FastifyInstance; registry: RegistryService } {
  const repo = new SqliteRegistry(":memory:");
  seedDefaults(repo);
  const registry = new RegistryService(repo);
  const mcp = new McpRegistrationService({
    createServer: vi.fn(async () => ({ success: true })),
    getServers: vi.fn(async () => ({ success: true, servers: [] }))
  } as never);
  const app = buildApp({ adminToken: TOKEN, registry, mcp, ...(list ? { tmux: { list } } : {}) });
  return { app, registry };
}

function addMachine(registry: RegistryService, over: { provisioned?: boolean; enabled?: boolean } = {}): void {
  const m = registry.createDevMachine({ logicalName: "mac-mini", host: "192.168.1.192", user: "karl", enabled: over.enabled ?? true });
  if (over.provisioned ?? true) registry.markProvisioned(m.id, "harness");
}

describe("GET /harness/tmux/:logicalName", () => {
  it("is admin-guarded (401 without credentials)", async () => {
    const { app, registry } = makeApp(vi.fn(async () => ({ state: "ok", sessions: [] }) as TmuxListResult));
    addMachine(registry);
    const res = await app.inject({ method: "GET", url: "/harness/tmux/mac-mini" });
    expect(res.statusCode).toBe(401);
  });

  it("returns the live session list for a ready machine, calling the lister with the machine's SSH target + key handle", async () => {
    const list = vi.fn(async (): Promise<TmuxListResult> => ({
      state: "ok",
      sessions: [{ name: "pantheon", windows: 2, attached: true, createdAt: "2026-08-24T10:00:00.000Z", attachable: true }]
    }));
    const { app, registry } = makeApp(list);
    addMachine(registry);
    const res = await app.inject({ method: "GET", url: "/harness/tmux/mac-mini", headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      machine: "mac-mini",
      state: "ok",
      sessions: [{ name: "pantheon", windows: 2, attached: true, createdAt: "2026-08-24T10:00:00.000Z", attachable: true }]
    });
    expect(list).toHaveBeenCalledWith({ logicalName: "mac-mini", host: "192.168.1.192", port: 22, user: "karl" }, "harness");
  });

  it("unknown machine → 404 with a labeled state; the lister is never called", async () => {
    const list = vi.fn(async (): Promise<TmuxListResult> => ({ state: "ok", sessions: [] }));
    const { app } = makeApp(list);
    const res = await app.inject({ method: "GET", url: "/harness/tmux/nope", headers: auth });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ machine: "nope", state: "unknown_machine" });
    expect(list).not.toHaveBeenCalled();
  });

  it("unprovisioned machine → 409 'not_connectable' with a text reason; never dials", async () => {
    const list = vi.fn(async (): Promise<TmuxListResult> => ({ state: "ok", sessions: [] }));
    const { app, registry } = makeApp(list);
    addMachine(registry, { provisioned: false });
    const res = await app.inject({ method: "GET", url: "/harness/tmux/mac-mini", headers: auth });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ state: "not_connectable" });
    expect(String(res.json().message)).toMatch(/not provisioned/i);
    expect(list).not.toHaveBeenCalled();
  });

  it("disabled machine → 409 'not_connectable'; never dials", async () => {
    const list = vi.fn(async (): Promise<TmuxListResult> => ({ state: "ok", sessions: [] }));
    const { app, registry } = makeApp(list);
    addMachine(registry, { enabled: false });
    const res = await app.inject({ method: "GET", url: "/harness/tmux/mac-mini", headers: auth });
    expect(res.statusCode).toBe(409);
    expect(String(res.json().message)).toMatch(/disabled/i);
    expect(list).not.toHaveBeenCalled();
  });

  it("unreachable machine → 502 with the labeled 'unreachable' state (no crash, no stack)", async () => {
    const { app, registry } = makeApp(async () => ({ state: "unreachable", message: "mac-mini unreachable — SSH connection failed" }));
    addMachine(registry);
    const res = await app.inject({ method: "GET", url: "/harness/tmux/mac-mini", headers: auth });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ machine: "mac-mini", state: "unreachable", message: "mac-mini unreachable — SSH connection failed" });
  });

  it("tmux missing on the machine → 502 with the labeled 'tmux_missing' state", async () => {
    const { app, registry } = makeApp(async () => ({ state: "tmux_missing", message: "tmux is not installed on mac-mini" }));
    addMachine(registry);
    const res = await app.inject({ method: "GET", url: "/harness/tmux/mac-mini", headers: auth });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ state: "tmux_missing" });
  });

  it("lister throwing unexpectedly → 502 labeled 'failed', raw exception text never echoed", async () => {
    const { app, registry } = makeApp(async () => {
      throw new Error("SECRET-DO-NOT-LEAK");
    });
    addMachine(registry);
    const res = await app.inject({ method: "GET", url: "/harness/tmux/mac-mini", headers: auth });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ state: "failed" });
    expect(res.body).not.toContain("SECRET-DO-NOT-LEAK");
  });

  it("when no tmux lister is wired (server without SSH) → 503 labeled 'unavailable' (fail closed, in text)", async () => {
    const { app, registry } = makeApp(undefined);
    addMachine(registry);
    const res = await app.inject({ method: "GET", url: "/harness/tmux/mac-mini", headers: auth });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ machine: "mac-mini", state: "unavailable" });
  });
});

describe("GET /harness/tmux/:logicalName — audit remediation (2026-08-25)", () => {
  it("does not echo an unvalidated path parameter back in the 404 body", async () => {
    const { app } = makeApp(async () => ({ state: "ok", sessions: [], ignoredLines: 0, truncated: false }));
    const res = await app.inject({ method: "GET", url: "/harness/tmux/" + encodeURIComponent("<script>alert(1)</script>"), headers: auth });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ state: "unknown_machine" });
    expect(res.body).not.toContain("<script>");
  });

  it("passes the parser's ignored-line count and truncation flag through to the page", async () => {
    const { app, registry } = makeApp(async () => ({ state: "ok", sessions: [], ignoredLines: 2, truncated: true }));
    addMachine(registry);
    const res = await app.inject({ method: "GET", url: "/harness/tmux/mac-mini", headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ machine: "mac-mini", state: "ok", sessions: [], ignoredLines: 2, truncated: true });
  });

  it("passes a failure's separate remoteDetail through (the page labels it as machine-supplied)", async () => {
    const { app, registry } = makeApp(async () => ({ state: "failed", message: "tmux list-sessions failed (exit 2)", remoteDetail: "boom" }));
    addMachine(registry);
    const res = await app.inject({ method: "GET", url: "/harness/tmux/mac-mini", headers: auth });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ machine: "mac-mini", state: "failed", message: "tmux list-sessions failed (exit 2)", remoteDetail: "boom" });
  });

  it("every response carries X-Content-Type-Options: nosniff (JSON, HTML and 401 alike)", async () => {
    const { app, registry } = makeApp(async () => ({ state: "ok", sessions: [], ignoredLines: 0, truncated: false }));
    addMachine(registry);
    const json = await app.inject({ method: "GET", url: "/harness/tmux/mac-mini", headers: auth });
    expect(json.headers["x-content-type-options"]).toBe("nosniff");
    const html = await app.inject({ method: "GET", url: "/harness", headers: auth });
    expect(html.headers["x-content-type-options"]).toBe("nosniff");
    const denied = await app.inject({ method: "GET", url: "/harness/tmux/mac-mini" });
    expect(denied.statusCode).toBe(401);
    expect(denied.headers["x-content-type-options"]).toBe("nosniff");
  });
});
