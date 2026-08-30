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

describe("Harness UI routes (frame + terminal tab + public assets)", () => {
  it("serves the harness frame (guarded) with the New Session popup", async () => {
    const { app } = makeApp();
    expect((await app.inject({ method: "GET", url: "/harness" })).statusCode).toBe(401); // guarded
    const res = await app.inject({ method: "GET", url: "/harness", headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatch(/New Session/i);
  });

  it("serves a terminal tab page for a provisioned machine (with the WebSocket wiring)", async () => {
    const repo = new SqliteRegistry(":memory:");
    const registry = new RegistryService(repo);
    const m = registry.createDevMachine({ logicalName: "mac-studio", host: "192.168.1.192", user: "karl", enabled: true });
    registry.markProvisioned(m.id, "harness");
    const mcp = new McpRegistrationService({ createServer: vi.fn(), getServers: vi.fn(async () => ({ success: true, servers: [] })) } as never);
    const app = buildApp({ adminToken: TOKEN, registry, mcp });

    const res = await app.inject({ method: "GET", url: "/harness/terminal/mac-studio", headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("mac-studio");
    expect(res.body).toMatch(/new WebSocket\(/);
    expect(res.body).toContain("/terminal/mac-studio");
  });

  it("serves xterm.js assets WITHOUT auth (public) so the browser can load them", async () => {
    const { app } = makeApp();
    const js = await app.inject({ method: "GET", url: "/assets/xterm.js" });
    expect(js.statusCode).toBe(200);
    expect(js.headers["content-type"]).toMatch(/javascript/);
    const css = await app.inject({ method: "GET", url: "/assets/xterm.css" });
    expect(css.statusCode).toBe(200);
    // The fit addon ships from our origin too (no CDN), public like xterm.js, so a tab can size its grid.
    const fit = await app.inject({ method: "GET", url: "/assets/xterm-addon-fit.js" });
    expect(fit.statusCode).toBe(200);
    expect(fit.headers["content-type"]).toMatch(/javascript/);
    expect(fit.body).toContain("FitAddon");
    // OSC-52 clipboard (a copy made inside tmux) and the GPU renderer, both from our origin.
    for (const [path, marker] of [["/assets/xterm-addon-clipboard.js", "ClipboardAddon"], ["/assets/xterm-addon-webgl.js", "WebglAddon"]] as Array<[string, string]>) {
      const res = await app.inject({ method: "GET", url: path });
      expect(res.statusCode, path).toBe(200);
      expect(res.headers["content-type"], path).toMatch(/javascript/);
      expect(res.body, path).toContain(marker);
    }
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

describe("dev-machine form encoding (the Config page posts an HTML form, not JSON)", () => {
  let app: FastifyInstance;
  beforeEach(() => {
    ({ app } = makeApp());
  });

  const postForm = (payload: string) =>
    app.inject({
      method: "POST",
      url: "/api/dev-machines",
      headers: { ...auth, "content-type": "application/x-www-form-urlencoded" },
      payload
    });

  const getMachine = async (name: string) =>
    (await app.inject({ method: "GET", url: "/api/dev-machines", headers: auth }))
      .json().find((x: { logicalName: string }) => x.logicalName === name);

  it("accepts the page's own encoding and stores typed values (form → 303, record stored)", async () => {
    const res = await postForm("logicalName=mac-mini&host=192.168.1.192&port=22&user=karl&enabled=on");
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/admin/config");
    const m = await getMachine("mac-mini");
    expect(m.port).toBe(22);
    expect(m.enabled).toBe(true);
  });

  it("applies the default port when the form leaves the field blank", async () => {
    const res = await postForm("logicalName=blank-port&host=192.168.1.192&port=&user=karl&enabled=on");
    expect(res.statusCode).toBe(303);
    expect((await getMachine("blank-port")).port).toBe(22);
  });

  it("treats an absent checkbox as disabled, not as an error", async () => {
    const res = await postForm("logicalName=unchecked&host=192.168.1.192&port=22&user=karl");
    expect(res.statusCode).toBe(303);
    expect((await getMachine("unchecked")).enabled).toBe(false);
  });

  it("still rejects a genuinely bad port from a form (fail-closed, no write)", async () => {
    const bad = ["0", "65536", "-1", "22.5", "abc", "%2022", "0x16"];
    for (let i = 0; i < bad.length; i++) {
      const res = await postForm(`logicalName=bad-${i}&host=192.168.1.192&port=${bad[i]}&user=karl&enabled=on`);
      expect(res.statusCode, `port=${bad[i]}`).toBe(400);
    }
    const list = await app.inject({ method: "GET", url: "/api/dev-machines", headers: auth });
    expect(list.json()).toHaveLength(0);
  });

  it("leaves JSON bodies strict — a string port is still rejected", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/dev-machines",
      headers: auth,
      payload: { logicalName: "json-string-port", host: "192.168.1.192", port: "22", user: "karl" }
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("user guide at /help", () => {
  let app: FastifyInstance;
  beforeEach(() => {
    ({ app } = makeApp());
  });

  it("serves the guide WITHOUT login — the operator chose an open guide (ruling 2026-08-19)", async () => {
    const res = await app.inject({ method: "GET", url: "/help", headers: { accept: "text/html" } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
  });

  it("is the real guide, not a stub", async () => {
    const body = (await app.inject({ method: "GET", url: "/help" })).body;
    expect(body).toContain("Pantheon Harness — User Guide");
    expect(body).toContain("What is not built yet"); // the honesty section must survive edits
    expect(body).toContain("Setting up a dev machine");
  });

  it("does not open anything else up: /harness still needs auth", async () => {
    const res = await app.inject({ method: "GET", url: "/harness" });
    expect(res.statusCode).toBe(401);
  });
});

describe("config CRUD form posts redirect instead of dumping JSON (BUGS #21)", () => {
  let app: FastifyInstance;
  beforeEach(() => {
    ({ app } = makeApp());
  });
  const form = (payload: string) => ({
    headers: { ...auth, "content-type": "application/x-www-form-urlencoded" },
    payload
  });

  it("POST /api/backends form → 303 to /admin/config; JSON → 201", async () => {
    const r = await app.inject({ method: "POST", url: "/api/backends", ...form("displayName=b1&kind=local_alden1&endpoint=192.168.1.89:8080&enabled=on") });
    expect(r.statusCode).toBe(303);
    expect(r.headers.location).toBe("/admin/config");
    const j = await app.inject({ method: "POST", url: "/api/backends", headers: auth, payload: { displayName: "b2", kind: "local_alden1", endpoint: "192.168.1.89:8080", enabled: true } });
    expect(j.statusCode).toBe(201);
    expect(j.json().displayName).toBe("b2");
  });

  it("POST /api/service-endpoints form → 303; JSON → 201", async () => {
    const r = await app.inject({ method: "POST", url: "/api/service-endpoints", ...form("displayName=e1&key=gitea&endpoint=10.100.23.76:3000&enabled=on") });
    expect(r.statusCode).toBe(303);
    expect(r.headers.location).toBe("/admin/config");
  });

  it("POST /api/dev-machines form → 303; JSON → 201 (unchanged)", async () => {
    const r = await app.inject({ method: "POST", url: "/api/dev-machines", ...form("logicalName=m1&host=192.168.1.192&port=22&user=karl&enabled=on") });
    expect(r.statusCode).toBe(303);
    expect(r.headers.location).toBe("/admin/config");
  });

  it("POST /api/mcp-servers form → 303", async () => {
    const r = await app.inject({ method: "POST", url: "/api/mcp-servers", ...form("serverId=s1&serverName=S1&endpoint=10.100.23.90:9000") });
    expect(r.statusCode).toBe(303);
    expect(r.headers.location).toBe("/admin/config");
  });
});

describe("backend/service-endpoint Enabled checkbox is honoured (BUGS #18)", () => {
  let app: FastifyInstance;
  let registry: RegistryService;
  beforeEach(() => {
    const repo = new SqliteRegistry(":memory:");
    seedDefaults(repo);
    registry = new RegistryService(repo);
    const mcp = new McpRegistrationService({ createServer: vi.fn(), getServers: vi.fn(async () => ({ success: true, servers: [] })) } as never);
    app = buildApp({ adminToken: TOKEN, registry, mcp });
  });
  const form = (p: string) => ({ headers: { ...auth, "content-type": "application/x-www-form-urlencoded" }, payload: p });

  it("ticked checkbox on a backend form saves enabled:true", async () => {
    await app.inject({ method: "POST", url: "/api/backends", ...form("displayName=on1&kind=local_alden1&endpoint=192.168.1.89:8080&enabled=on") });
    expect(registry.listBackends().find((b) => b.displayName === "on1")!.enabled).toBe(true);
  });
  it("absent checkbox on a backend form saves enabled:false", async () => {
    await app.inject({ method: "POST", url: "/api/backends", ...form("displayName=off1&kind=local_alden1&endpoint=192.168.1.89:8080") });
    expect(registry.listBackends().find((b) => b.displayName === "off1")!.enabled).toBe(false);
  });
  it("ticked checkbox on a service-endpoint form saves enabled:true", async () => {
    await app.inject({ method: "POST", url: "/api/service-endpoints", ...form("displayName=se1&key=gitea&endpoint=10.100.23.76:3000&enabled=on") });
    expect(registry.listServiceEndpoints().find((e) => e.displayName === "se1")!.enabled).toBe(true);
  });
});
