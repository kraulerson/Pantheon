import { describe, it, expect, beforeEach, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp, bearerGuard, verifyStepUp } from "../src/http/app.js";
import { SqliteRegistry, seedDefaults } from "../src/registry/sqlite-repository.js";
import { RegistryService } from "../src/registry/service.js";
import { McpRegistrationService } from "../src/registry/mcp-registration.js";

const TOKEN = "super-strong-admin-token-0123456789abcdef";

function makeApp(): { app: FastifyInstance; mcpClient: { createServer: ReturnType<typeof vi.fn>; getServers: ReturnType<typeof vi.fn> } } {
  const repo = new SqliteRegistry(":memory:");
  seedDefaults(repo);
  const registry = new RegistryService(repo);
  const mcpClient = {
    createServer: vi.fn(async () => ({ success: true })),
    getServers: vi.fn(async () => ({ success: true, servers: [{ serverId: "obsidian" }] }))
  };
  const mcp = new McpRegistrationService(mcpClient as never);
  const app = buildApp({ adminToken: TOKEN, registry, mcp });
  return { app, mcpClient };
}

const auth = { authorization: `Bearer ${TOKEN}` };

describe("HTTP admin guard (fail-closed)", () => {
  let app: FastifyInstance;
  beforeEach(() => {
    ({ app } = makeApp());
  });

  it("denies a protected route with no Authorization header (401)", async () => {
    const res = await app.inject({ method: "GET", url: "/api/backends" });
    expect(res.statusCode).toBe(401);
  });

  it("denies with a wrong bearer token (403)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/backends",
      headers: { authorization: "Bearer wrong" }
    });
    expect(res.statusCode).toBe(403);
  });

  it("denies a malformed Authorization header (401)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/backends",
      headers: { authorization: TOKEN } // missing "Bearer "
    });
    expect(res.statusCode).toBe(401);
  });

  it("allows with the correct bearer token (200)", async () => {
    const res = await app.inject({ method: "GET", url: "/api/backends", headers: auth });
    expect(res.statusCode).toBe(200);
  });

  it("guards the config page too", async () => {
    expect((await app.inject({ method: "GET", url: "/admin/config" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/admin/config", headers: auth })).statusCode).toBe(200);
  });

  it("never echoes the admin token in an error body", async () => {
    const res = await app.inject({ method: "GET", url: "/api/backends", headers: { authorization: "Bearer wrong" } });
    expect(res.body).not.toContain(TOKEN);
  });
});

describe("Pluggable guard + step-up seam (D6)", () => {
  it("verifyStepUp fails closed until configured (403)", () => {
    const r = verifyStepUp({} as never);
    expect(r.ok).toBe(false);
    expect(r).toMatchObject({ status: 403, reason: "step_up_not_configured" });
  });

  it("bearerGuard accepts the exact token and rejects others", () => {
    const g = bearerGuard(TOKEN);
    expect(g({ headers: { authorization: `Bearer ${TOKEN}` } } as never)).toEqual({ ok: true });
    expect(g({ headers: {} } as never)).toMatchObject({ ok: false, status: 401 });
    expect(g({ headers: { authorization: "Bearer x" } } as never)).toMatchObject({ ok: false, status: 403 });
  });

  it("a custom guard can be plugged in (e.g. the future step-up)", async () => {
    const repo = new SqliteRegistry(":memory:");
    const registry = new RegistryService(repo);
    const mcp = new McpRegistrationService({ createServer: vi.fn(), getServers: vi.fn(async () => ({ success: true, servers: [] })) } as never);
    const app = buildApp({ adminToken: TOKEN, registry, mcp, guard: () => ({ ok: false, status: 403, reason: "step_up_required" }) });
    const res = await app.inject({ method: "GET", url: "/api/backends", headers: auth });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("step_up_required");
  });
});

describe("Internal error handling (sanitized, no leak)", () => {
  it("maps an unexpected handler throw to 500 with no raw text", async () => {
    const repo = new SqliteRegistry(":memory:");
    const registry = new RegistryService(repo);
    // mcp.list throws -> 500 sanitized on the API route (config page swallows separately)
    const mcp = new McpRegistrationService({
      createServer: vi.fn(),
      getServers: vi.fn(async () => {
        throw new Error("secret-bearing internal failure");
      })
    } as never);
    const app = buildApp({ adminToken: TOKEN, registry, mcp });
    const res = await app.inject({ method: "GET", url: "/api/mcp-servers", headers: auth });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain("secret-bearing");
    expect(res.json().error).toBe("internal_error");
  });

  it("config page renders an error banner when the MCP list is unavailable", async () => {
    const repo = new SqliteRegistry(":memory:");
    seedDefaults(repo);
    const registry = new RegistryService(repo);
    const mcp = new McpRegistrationService({
      createServer: vi.fn(),
      getServers: vi.fn(async () => {
        throw new Error("peta down");
      })
    } as never);
    const app = buildApp({ adminToken: TOKEN, registry, mcp });
    const res = await app.inject({ method: "GET", url: "/admin/config", headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatch(/role="alert"/);
    expect(res.body).toMatch(/unavailable/i);
  });
});

describe("Backends API (via inject)", () => {
  let app: FastifyInstance;
  beforeEach(() => {
    ({ app } = makeApp());
  });

  it("POST creates, GET lists, PUT updates, DELETE removes", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/backends",
      headers: auth,
      payload: { kind: "claude_cli", endpoint: "10.0.0.9:443", displayName: "Claude", enabled: true }
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;

    const list = await app.inject({ method: "GET", url: "/api/backends", headers: auth });
    expect(list.json().some((b: { id: string }) => b.id === id)).toBe(true);

    const upd = await app.inject({
      method: "PUT",
      url: `/api/backends/${id}`,
      headers: auth,
      payload: { endpoint: "10.0.0.10:443" }
    });
    expect(upd.statusCode).toBe(200);
    expect(upd.json().endpoint).toBe("10.0.0.10:443");

    const del = await app.inject({ method: "DELETE", url: `/api/backends/${id}`, headers: auth });
    expect(del.statusCode).toBe(204);
  });

  it("POST with a malformed endpoint returns 400 and persists nothing", async () => {
    const before = (await app.inject({ method: "GET", url: "/api/backends", headers: auth })).json().length;
    const res = await app.inject({
      method: "POST",
      url: "/api/backends",
      headers: auth,
      payload: { kind: "claude_cli", endpoint: "garbage", displayName: "X", enabled: true }
    });
    expect(res.statusCode).toBe(400);
    const after = (await app.inject({ method: "GET", url: "/api/backends", headers: auth })).json().length;
    expect(after).toBe(before);
  });

  it("POST with an empty displayName returns 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/backends",
      headers: auth,
      payload: { kind: "claude_cli", endpoint: "1.2.3.4:80", displayName: "", enabled: true }
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("Service-endpoints API (via inject)", () => {
  let app: FastifyInstance;
  beforeEach(() => {
    ({ app } = makeApp());
  });

  it("CRUD happy path", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/service-endpoints",
      headers: auth,
      payload: { key: "obsidian", endpoint: "10.100.23.90:9000", displayName: "Obsidian", enabled: true }
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;
    const upd = await app.inject({
      method: "PUT",
      url: `/api/service-endpoints/${id}`,
      headers: auth,
      payload: { enabled: false }
    });
    expect(upd.json().enabled).toBe(false);
    expect((await app.inject({ method: "DELETE", url: `/api/service-endpoints/${id}`, headers: auth })).statusCode).toBe(204);
  });

  it("rejects an unknown key with 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/service-endpoints",
      headers: auth,
      payload: { key: "bogus", endpoint: "1.2.3.4:80", displayName: "X", enabled: true }
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("Dev-machines API (via inject)", () => {
  let app: FastifyInstance;
  beforeEach(() => {
    ({ app } = makeApp());
  });

  it("POST creates, GET lists, PUT updates, DELETE removes", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/dev-machines",
      headers: auth,
      payload: { logicalName: "mac-studio", host: "192.168.1.192", user: "karl", enabled: true }
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().provisioned).toBe(false); // newly registered, not yet provisioned
    const id = created.json().id as string;

    const list = await app.inject({ method: "GET", url: "/api/dev-machines", headers: auth });
    expect(list.json().some((m: { id: string }) => m.id === id)).toBe(true);

    const upd = await app.inject({
      method: "PUT",
      url: `/api/dev-machines/${id}`,
      headers: auth,
      payload: { host: "192.168.1.250", provisioned: true, sshKeyHandle: "forged" }
    });
    expect(upd.statusCode).toBe(200);
    expect(upd.json().host).toBe("192.168.1.250");
    // provisioned/sshKeyHandle CANNOT be forged via the generic update route (only markProvisioned sets them)
    expect(upd.json().provisioned).toBe(false);
    expect(upd.json().sshKeyHandle).toBe("");

    const del = await app.inject({ method: "DELETE", url: `/api/dev-machines/${id}`, headers: auth });
    expect(del.statusCode).toBe(204);
  });

  it("is admin-guarded (401 without a token)", async () => {
    expect((await app.inject({ method: "GET", url: "/api/dev-machines" })).statusCode).toBe(401);
  });

  it("POST with a raw private key as the handle returns 400 and persists nothing (TM-020)", async () => {
    const before = (await app.inject({ method: "GET", url: "/api/dev-machines", headers: auth })).json().length;
    const res = await app.inject({
      method: "POST",
      url: "/api/dev-machines",
      headers: auth,
      payload: {
        logicalName: "evil",
        host: "10.0.0.1",
        user: "karl",
        enabled: true,
        sshKeyHandle: "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----"
      }
    });
    expect(res.statusCode).toBe(400);
    const after = (await app.inject({ method: "GET", url: "/api/dev-machines", headers: auth })).json().length;
    expect(after).toBe(before);
  });

  it("POST with a malformed host returns 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/dev-machines",
      headers: auth,
      payload: { logicalName: "m", host: "192.168.1.1:22", user: "karl", enabled: true }
    });
    expect(res.statusCode).toBe(400);
  });

  it("PUT cannot mutate logicalName — the immutable identity-binding handle (#14a)", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/dev-machines",
      headers: auth,
      payload: { logicalName: "bound-name", host: "10.0.0.1", user: "karl", enabled: true }
    });
    const id = created.json().id as string;
    const upd = await app.inject({
      method: "PUT",
      url: `/api/dev-machines/${id}`,
      headers: auth,
      payload: { logicalName: "attacker-rebind", host: "10.0.0.2" }
    });
    expect(upd.statusCode).toBe(200);
    expect(upd.json().host).toBe("10.0.0.2"); // host edit applied
    expect(upd.json().logicalName).toBe("bound-name"); // binding handle unchanged
  });
});

describe("MCP-server registration API (via inject, stubbed Peta)", () => {
  it("GET lists, POST registers, DELETE removes — proxying PetaAdminClient", async () => {
    const { app, mcpClient } = makeApp();
    const list = await app.inject({ method: "GET", url: "/api/mcp-servers", headers: auth });
    expect(list.statusCode).toBe(200);
    expect(mcpClient.getServers).toHaveBeenCalled();

    const reg = await app.inject({
      method: "POST",
      url: "/api/mcp-servers",
      headers: auth,
      payload: { serverId: "obsidian", serverName: "Obsidian MCP", endpoint: "10.100.23.90:9000" }
    });
    expect(reg.statusCode).toBe(201);
    expect(mcpClient.createServer).toHaveBeenCalledTimes(1);

    const del = await app.inject({ method: "DELETE", url: "/api/mcp-servers/obsidian", headers: auth });
    expect(del.statusCode).toBe(204);
  });

  it("POST with malformed endpoint -> 400, no Peta call", async () => {
    const { app, mcpClient } = makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/mcp-servers",
      headers: auth,
      payload: { serverId: "x", serverName: "X", endpoint: "nope" }
    });
    expect(res.statusCode).toBe(400);
    expect(mcpClient.createServer).not.toHaveBeenCalled();
  });
});
