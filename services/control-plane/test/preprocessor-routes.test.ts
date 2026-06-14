/**
 * Route tests for the pre-processor surface wired into the Fastify app:
 *   POST /v1/chat/completions   (LibreChat entry; identity via x-pantheon-identity; NOT admin-guarded)
 *   GET  /inspector/:sessionId/latest   (admin-guarded)
 *   GET  /approvals + POST /approvals/:id/decide  (admin-guarded; proxy PetaAdminClient)
 *
 * Admin-guarded routes must DENY without ADMIN_API_TOKEN (fail closed). The chat entry is
 * NOT admin-guarded (LibreChat is not an admin) but is identity-gated and fail-closed.
 */

import { describe, it, expect } from "vitest";
import { buildApp } from "../src/http/app.js";
import { SqliteRegistry } from "../src/registry/sqlite-repository.js";
import { RegistryService } from "../src/registry/service.js";
import { SqliteSessionStore } from "../src/session/sqlite-store.js";
import { Preprocessor } from "../src/preprocessor/index.js";
import { StubRetriever } from "../src/preprocessor/retriever.js";
import { BackendError, type ChatCompletionRequest, type ChatCompletionResponse } from "../src/backend/client.js";
import type { McpRegistrationService } from "../src/registry/mcp-registration.js";

const ADMIN = "admin-token-1234567890";

class SpyBackendClient {
  chatCompletions(_b: { endpoint: string }, _r: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    return Promise.resolve({
      id: "spy",
      object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }]
    });
  }
}

/** A stubbed Peta admin surface (only the two approval methods the routes proxy). */
const petaStub = {
  listApprovals: async () => ({ success: true, data: { requests: [{ id: "appr-1", toolName: "write_thing" }] } }),
  decideApproval: async (id: string, decision: string) => ({ success: true, data: { id, decision } })
};

function build(over: { peta?: typeof petaStub } = {}) {
  const repo = new SqliteRegistry();
  const registry = new RegistryService(repo);
  const bound = registry.createBackend({
    kind: "local_alden1",
    endpoint: "10.0.0.1:8080",
    displayName: "Bound",
    enabled: true
  });
  const sessions = new SqliteSessionStore();
  const pre = new Preprocessor({
    registry,
    sessions,
    backendClient: new SpyBackendClient(),
    retriever: new StubRetriever(),
    resolveIdentity: (id) => (id === "id-A" ? { identityId: id, backendId: bound.id } : undefined)
  });
  const mcp = { list: async () => [], register: async () => ({}) } as unknown as McpRegistrationService;
  return buildApp({
    adminToken: ADMIN,
    registry,
    mcp,
    preprocessor: pre,
    peta: (over.peta ?? petaStub) as never
  });
}

describe("POST /v1/chat/completions", () => {
  it("runs the pre-processor and returns a completion (identity via header, no admin token)", async () => {
    const app = build();
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { "x-pantheon-identity": "id-A" },
      payload: { model: "x", messages: [{ role: "user", content: "hi" }] }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().choices[0].message.content).toBe("ok");
    await app.close();
  });

  it("fails closed (4xx) on a missing identity header", async () => {
    const app = build();
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: { model: "x", messages: [{ role: "user", content: "hi" }] }
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
    await app.close();
  });

  it("fails closed on an unknown identity (403)", async () => {
    const app = build();
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { "x-pantheon-identity": "id-UNKNOWN" },
      payload: { model: "x", messages: [{ role: "user", content: "hi" }] }
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("rejects a body with no messages array (400)", async () => {
    const app = build();
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { "x-pantheon-identity": "id-A" },
      payload: { model: "x" }
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("honors an explicit x-pantheon-session header for the session id", async () => {
    const app = build();
    await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { "x-pantheon-identity": "id-A", "x-pantheon-session": "custom-sess" },
      payload: { model: "x", messages: [{ role: "user", content: "hi" }] }
    });
    const res = await app.inject({
      method: "GET",
      url: "/inspector/custom-sess/latest",
      headers: { authorization: `Bearer ${ADMIN}` }
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("returns 502 when the backend fails (BackendError, never leaks detail)", async () => {
    const repo = new SqliteRegistry();
    const registry = new RegistryService(repo);
    const bound = registry.createBackend({ kind: "local_alden1", endpoint: "10.0.0.1:8080", displayName: "B", enabled: true });
    const sessions = new SqliteSessionStore();
    const failing = {
      chatCompletions: () => Promise.reject(new BackendError("down", 503, bound.id))
    };
    const pre = new Preprocessor({
      registry,
      sessions,
      backendClient: failing,
      retriever: new StubRetriever(),
      resolveIdentity: (id) => (id === "id-A" ? { identityId: id, backendId: bound.id } : undefined)
    });
    const mcp = { list: async () => [], register: async () => ({}) } as unknown as McpRegistrationService;
    const app = buildApp({ adminToken: ADMIN, registry, mcp, preprocessor: pre, peta: petaStub as never });
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { "x-pantheon-identity": "id-A" },
      payload: { model: "x", messages: [{ role: "user", content: "hi" }] }
    });
    expect(res.statusCode).toBe(502);
    expect(JSON.stringify(res.json())).not.toContain("down");
    await app.close();
  });
});

describe("GET /inspector/:sessionId/latest (admin-guarded)", () => {
  it("denies without ADMIN_API_TOKEN", async () => {
    const app = build();
    const res = await app.inject({ method: "GET", url: "/inspector/s1/latest" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("returns assembled items with trusted flags + labels after a chat turn", async () => {
    const app = build();
    await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { "x-pantheon-identity": "id-A" },
      payload: { model: "x", messages: [{ role: "user", content: "inspect me" }] }
    });
    const res = await app.inject({
      method: "GET",
      url: "/inspector/s1/latest",
      headers: { authorization: `Bearer ${ADMIN}` }
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.items)).toBe(true);
    const user = body.items.find((i: { source: string }) => i.source === "user");
    expect(user.trusted).toBe(true);
    expect(typeof user.label).toBe("string");
    expect(body.items.some((i: { trusted: boolean }) => i.trusted === false)).toBe(true);
    await app.close();
  });

  it("returns 404 for a session with no stashed prompt", async () => {
    const app = build();
    const res = await app.inject({
      method: "GET",
      url: "/inspector/never/latest",
      headers: { authorization: `Bearer ${ADMIN}` }
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe("approvals routes (admin-guarded, proxy PetaAdminClient)", () => {
  it("denies GET /approvals without ADMIN_API_TOKEN", async () => {
    const app = build();
    const res = await app.inject({ method: "GET", url: "/approvals" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("GET /approvals proxies listApprovals", async () => {
    const app = build();
    const res = await app.inject({
      method: "GET",
      url: "/approvals",
      headers: { authorization: `Bearer ${ADMIN}` }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.requests[0].id).toBe("appr-1");
    await app.close();
  });

  it("POST /approvals/:id/decide proxies decideApproval", async () => {
    const app = build();
    const res = await app.inject({
      method: "POST",
      url: "/approvals/appr-1/decide",
      headers: { authorization: `Bearer ${ADMIN}` },
      payload: { decision: "approved" }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ id: "appr-1", decision: "approved" });
    await app.close();
  });

  it("POST /approvals/:id/decide rejects an invalid decision (fail closed, no proxy call)", async () => {
    let called = false;
    const peta = {
      ...petaStub,
      decideApproval: async (id: string, decision: string) => {
        called = true;
        return { success: true, data: { id, decision } };
      }
    };
    const app = build({ peta });
    const res = await app.inject({
      method: "POST",
      url: "/approvals/appr-1/decide",
      headers: { authorization: `Bearer ${ADMIN}` },
      payload: { decision: "maybe" }
    });
    expect(res.statusCode).toBe(400);
    expect(called).toBe(false);
    await app.close();
  });
});
