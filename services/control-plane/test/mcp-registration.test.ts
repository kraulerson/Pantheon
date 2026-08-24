import { describe, it, expect, vi } from "vitest";
import { McpRegistrationService } from "../src/registry/mcp-registration.js";
import { PetaAdminClient, type PetaResponse } from "../src/peta/client.js";

/** A stubbed PetaAdminClient surface — only the methods the registration service uses. */
function stubClient(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    createServer: vi.fn(async (): Promise<PetaResponse> => ({ success: true })),
    getServers: vi.fn(async (): Promise<PetaResponse> => ({ success: true, servers: [] })),
    deleteUser: vi.fn(),
    ...overrides
  };
}

describe("McpRegistrationService (stubbed PetaAdminClient)", () => {
  it("registers a server by proxying createServer with sane defaults", async () => {
    const client = stubClient();
    const svc = new McpRegistrationService(client as never);
    const res = await svc.register({ serverId: "obsidian", serverName: "Obsidian MCP", endpoint: "10.100.23.90:9000" });
    expect(res.success).toBe(true);
    expect(client.createServer).toHaveBeenCalledTimes(1);
    const arg = client.createServer.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg.serverId).toBe("obsidian");
    expect(arg.serverName).toBe("Obsidian MCP");
  });

  it("lists registered servers via getServers", async () => {
    const client = stubClient({
      getServers: vi.fn(async (): Promise<PetaResponse> => ({ success: true, servers: [{ serverId: "a" }] }))
    });
    const svc = new McpRegistrationService(client as never);
    const list = await svc.list();
    expect(list).toEqual([{ serverId: "a" }]);
  });

  it("rejects a malformed endpoint with no Peta call (fail-closed)", async () => {
    const client = stubClient();
    const svc = new McpRegistrationService(client as never);
    await expect(
      svc.register({ serverId: "x", serverName: "X", endpoint: "garbage" })
    ).rejects.toThrow();
    expect(client.createServer).not.toHaveBeenCalled();
  });

  it("rejects empty serverId/serverName with no Peta call", async () => {
    const client = stubClient();
    const svc = new McpRegistrationService(client as never);
    await expect(svc.register({ serverId: "", serverName: "X", endpoint: "1.2.3.4:80" })).rejects.toThrow();
    await expect(svc.register({ serverId: "x", serverName: " ", endpoint: "1.2.3.4:80" })).rejects.toThrow();
    expect(client.createServer).not.toHaveBeenCalled();
  });

  it("list() fails closed to [] when Peta returns no servers array", async () => {
    const client = stubClient({ getServers: vi.fn(async (): Promise<PetaResponse> => ({ success: true })) });
    const svc = new McpRegistrationService(client as never);
    expect(await svc.list()).toEqual([]);
  });

  it("propagates a Peta failure (does not swallow)", async () => {
    const client = stubClient({
      createServer: vi.fn(async () => {
        throw new Error("peta down");
      })
    });
    const svc = new McpRegistrationService(client as never);
    await expect(
      svc.register({ serverId: "x", serverName: "X", endpoint: "1.2.3.4:80" })
    ).rejects.toThrow(/peta down/);
  });
});

// Optional live test: a REAL register->list round-trip, but ONLY against an explicitly configured
// TEST Peta (PETA_TEST_URL + PETA_TEST_ADMIN_TOKEN). It must never touch the production Peta — the
// service has no remove(), so a registration cannot be cleaned up (see the /api/mcp-servers DELETE
// no-op). When the test Peta is not configured/reachable it SKIPS honestly (ctx.skip). Previously
// this did a bare `return` (tallied as a PASS) and asserted `expect(true).toBe(true)` — testing
// nothing while inflating the green count (BUGS #23).
const PETA_TEST_URL = process.env["PETA_TEST_URL"];
const PETA_TEST_TOKEN = process.env["PETA_TEST_ADMIN_TOKEN"];
async function testPetaReachable(): Promise<boolean> {
  if (!PETA_TEST_URL || !PETA_TEST_TOKEN) return false;
  try {
    const res = await fetch(`${PETA_TEST_URL}/health`, { signal: AbortSignal.timeout(800) });
    return res.ok;
  } catch {
    return false;
  }
}

describe("McpRegistrationService — live register->list round-trip (opt-in, test Peta only)", () => {
  it("registers then lists a throwaway server against a configured test Peta, else skips", async (ctx) => {
    if (!(await testPetaReachable())) {
      ctx.skip();
      return;
    }
    const svc = new McpRegistrationService(new PetaAdminClient(PETA_TEST_URL as string, PETA_TEST_TOKEN as string));
    const serverId = `pantheon-test-${Math.random().toString(36).slice(2, 8)}`;
    const res = await svc.register({ serverId, serverName: "Pantheon Test", endpoint: "127.0.0.1:9999" });
    expect(res.success).toBe(true);
    const list = (await svc.list()) as Array<{ serverId?: string }>;
    expect(list.some((entry) => entry.serverId === serverId)).toBe(true);
  }, 15_000);
});
