/**
 * BUGS #55 — regression tests for the production-dependency advisories that this code reaches.
 *
 * fastify GHSA-p68q-wchp-6fh7 (fixed in 5.12.2): a malformed request target whose method has no matching route went
 * straight to the not-found handler, skipping the request lifecycle — including the root `onRequest` hook that holds
 * the operator and keycard guards. Today the only not-found handler serves a fixed 404, so nothing leaks; these tests
 * pin the fail-closed answer so a malformed URL always meets `frameworkErrors` (400 `bad_request`) instead.
 */

import { describe, it, expect, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/http/app.js";
import { SqliteRegistry, seedDefaults } from "../src/registry/sqlite-repository.js";
import { RegistryService } from "../src/registry/service.js";
import { McpRegistrationService } from "../src/registry/mcp-registration.js";
import { SessionStore } from "../src/http/auth/session.js";

const TOKEN = "super-strong-admin-token-0123456789abcdef";
const PASSWORD = "correct-horse-battery-staple";

function makeApp(): FastifyInstance {
  const repo = new SqliteRegistry(":memory:");
  seedDefaults(repo);
  const registry = new RegistryService(repo);
  const mcp = new McpRegistrationService({
    createServer: vi.fn(),
    getServers: vi.fn(async () => ({ success: true, servers: [] }))
  } as never);
  return buildApp({ adminToken: TOKEN, registry, mcp, operatorPassword: PASSWORD, sessions: new SessionStore() });
}

describe("fastify GHSA-p68q-wchp-6fh7: a malformed URL never skips the guards to reach the not-found handler", () => {
  // PATCH has no route anywhere in the app, which is the advisory's precondition ("the request method has no route
  // in the main router"). The targets cover the admin API, the console API, the keycard door and the root.
  it.each([
    ["PATCH", "/api/%zz"],
    ["PATCH", "/console/api/%zz"],
    ["PATCH", "/keycard/v1/%zz"],
    ["PATCH", "/%"],
    ["PATCH", "/admin/config%E0%A4%A"]
  ])("%s %s without credentials answers 400 bad_request", async (method, url) => {
    const app = makeApp();
    const res = await app.inject({ method: method as "PATCH", url, headers: { accept: "application/json" } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "bad_request" });
    await app.close();
  });
});
