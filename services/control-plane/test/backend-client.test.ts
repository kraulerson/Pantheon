/**
 * BackendClient tests. Forwards an OpenAI chat-completions request to a registry-resolved
 * backend's endpoint. Non-streaming path implemented fully; verified against an in-test
 * mock OpenAI-compatible backend (a tiny Fastify stub). Anthropic = documented translation
 * seam (throws); streaming = documented seam (not exercised here).
 */

import { describe, it, expect, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { BackendClient } from "../src/backend/client.js";
import type { Backend } from "../src/registry/types.js";

function backend(over: Partial<Backend> = {}): Backend {
  const now = new Date().toISOString();
  return {
    id: "be-1",
    kind: "local_alden1",
    endpoint: "127.0.0.1:0",
    displayName: "Mock",
    enabled: true,
    createdAt: now,
    updatedAt: now,
    ...over
  };
}

let server: FastifyInstance | undefined;
afterEach(async () => {
  if (server) await server.close();
  server = undefined;
});

async function standUpMockBackend(): Promise<{ host: string; lastBody: () => unknown }> {
  let captured: unknown;
  server = Fastify({ logger: false });
  server.post("/v1/chat/completions", async (req) => {
    captured = req.body;
    return {
      id: "chatcmpl-mock",
      object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" }]
    };
  });
  await server.listen({ port: 0, host: "127.0.0.1" });
  const addr = server.server.address();
  if (addr === null || typeof addr === "string") throw new Error("no address");
  return { host: `127.0.0.1:${addr.port}`, lastBody: () => captured };
}

describe("BackendClient", () => {
  it("forwards a non-streaming chat-completions request to {endpoint}/v1/chat/completions", async () => {
    const mock = await standUpMockBackend();
    const client = new BackendClient();
    const req = { model: "alden", messages: [{ role: "user", content: "ping" }] };
    const res = await client.chatCompletions(backend({ endpoint: mock.host }), req);
    expect(res.choices[0]?.message?.content).toBe("pong");
    expect(mock.lastBody()).toMatchObject({ messages: [{ role: "user", content: "ping" }] });
  });

  it("throws on a non-2xx backend response (fail closed, no silent empty completion)", async () => {
    server = Fastify({ logger: false });
    server.post("/v1/chat/completions", async (_req, reply) => {
      reply.code(503).send({ error: "down" });
    });
    await server.listen({ port: 0, host: "127.0.0.1" });
    const addr = server.server.address();
    if (addr === null || typeof addr === "string") throw new Error("no address");
    const client = new BackendClient();
    await expect(
      client.chatCompletions(backend({ endpoint: `127.0.0.1:${addr.port}` }), { model: "x", messages: [] })
    ).rejects.toThrow();
  });

  it("anthropic/claude backend is a translation SEAM — throws not-yet-wired", async () => {
    const client = new BackendClient();
    await expect(
      client.chatCompletions(backend({ kind: "claude_cli" }), { model: "x", messages: [] })
    ).rejects.toThrow(/anthropic translation not yet wired/i);
  });

  it("streaming is a documented SEAM — throws not-yet-implemented", async () => {
    const client = new BackendClient();
    await expect(
      client.chatCompletions(backend(), { model: "x", messages: [], stream: true })
    ).rejects.toThrow(/streaming not yet implemented/i);
  });

  it("throws on a transport error (unreachable endpoint, fail closed)", async () => {
    // fetch override that always rejects — simulates a connection refusal.
    const client = new BackendClient({ fetchFn: () => Promise.reject(new Error("ECONNREFUSED")) });
    await expect(client.chatCompletions(backend(), { model: "x", messages: [] })).rejects.toThrow(/transport error/i);
  });

  it("throws when the backend body is unparseable JSON", async () => {
    server = Fastify({ logger: false });
    server.post("/v1/chat/completions", async (_req, reply) => {
      reply.code(200).type("text/plain").send("not json");
    });
    await server.listen({ port: 0, host: "127.0.0.1" });
    const addr = server.server.address();
    if (addr === null || typeof addr === "string") throw new Error("no address");
    const client = new BackendClient();
    await expect(
      client.chatCompletions(backend({ endpoint: `127.0.0.1:${addr.port}` }), { model: "x", messages: [] })
    ).rejects.toThrow(/unparseable/i);
  });
});
