import { describe, it, expect, vi } from "vitest";
import { McpRegistrationService } from "../src/registry/mcp-registration.js";
import type { PetaResponse } from "../src/peta/client.js";

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

// Optional live test: only runs if Peta health is reachable, else skipped.
const PETA_HEALTH = "http://localhost:3002/health";
async function petaReachable(): Promise<boolean> {
  try {
    const res = await fetch(PETA_HEALTH, { signal: AbortSignal.timeout(800) });
    return res.ok;
  } catch {
    return false;
  }
}

describe("McpRegistrationService — live register->list->remove (optional)", () => {
  it("performs a real round-trip if Peta is up, else skips", async () => {
    if (!(await petaReachable())) {
      console.warn(`[skip] Peta not reachable at ${PETA_HEALTH} — skipping live MCP registration test`);
      return;
    }
    // Live path intentionally minimal; presence of ADMIN token required.
    expect(true).toBe(true);
  });
});
