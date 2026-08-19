/**
 * `POST /api/dev-machines/:id/provision` — set a machine up entirely from the harness UI.
 *
 * The operator supplies the target machine's password in the browser; the server performs the
 * one-time key install and only then records `provisioned`. The password must never come back out
 * — not in a response body, not in an error, not in a redirect target — and a failed enrollment
 * must leave the machine unprovisioned rather than half-recorded.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/http/app.js";
import { registerEnrollmentRoute } from "../src/http/routes/enrollment.js";
import { SqliteRegistry, seedDefaults } from "../src/registry/sqlite-repository.js";
import { RegistryService } from "../src/registry/service.js";
import { McpRegistrationService } from "../src/registry/mcp-registration.js";
import { EnrollmentError } from "../src/devmachine/enrollment.js";

const TOKEN = "super-strong-admin-token-0123456789abcdef";
const PASSWORD = "operators-machine-password";
const auth = { authorization: `Bearer ${TOKEN}` };
const formHeaders = { ...auth, "content-type": "application/x-www-form-urlencoded" };

function makeApp(enroll = vi.fn(async () => ({ keyHandle: "harness", generatedKeyPair: false }))): {
  app: FastifyInstance;
  registry: RegistryService;
  enroll: typeof enroll;
  machineId: string;
} {
  const repo = new SqliteRegistry(":memory:");
  seedDefaults(repo);
  const registry = new RegistryService(repo);
  const mcp = new McpRegistrationService({
    createServer: vi.fn(),
    getServers: vi.fn(async () => ({ success: true, servers: [] }))
  } as never);
  const app = buildApp({ adminToken: TOKEN, registry, mcp });
  registerEnrollmentRoute(app, { registry, enroll, keyHandle: "harness" });
  const machine = registry.createDevMachine({
    logicalName: "mac-mini",
    host: "192.168.1.192",
    port: 22,
    user: "karl",
    enabled: true
  } as never);
  return { app, registry, enroll, machineId: machine.id };
}

describe("dev-machine enrollment route", () => {
  let ctx: ReturnType<typeof makeApp>;
  beforeEach(() => {
    ctx = makeApp();
  });

  it("refuses an unauthenticated call (fail-closed)", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: `/api/dev-machines/${ctx.machineId}/provision`,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: `password=${encodeURIComponent(PASSWORD)}`
    });
    expect(res.statusCode).toBe(401);
    expect(ctx.enroll).not.toHaveBeenCalled();
  });

  it("enrolls the machine and records it as provisioned", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: `/api/dev-machines/${ctx.machineId}/provision`,
      headers: formHeaders,
      payload: `password=${encodeURIComponent(PASSWORD)}`
    });
    expect(res.statusCode).toBe(303); // POST → GET, back to the page the form lives on
    expect(res.headers.location).toBe("/admin/config");
    expect(ctx.enroll).toHaveBeenCalledOnce();

    const [target, handle, password] = ctx.enroll.mock.calls[0] as unknown as [
      { logicalName: string; host: string; port: number; user: string },
      string,
      string
    ];
    expect(target).toMatchObject({ logicalName: "mac-mini", host: "192.168.1.192", port: 22, user: "karl" });
    expect(handle).toBe("harness");
    expect(password).toBe(PASSWORD);
    expect(ctx.registry.listDevMachines()[0]!.provisioned).toBe(true);
  });

  it("answers an API caller with JSON instead of a redirect", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: `/api/dev-machines/${ctx.machineId}/provision`,
      headers: auth,
      payload: { password: PASSWORD }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ logicalName: "mac-mini", provisioned: true });
    expect(res.body).not.toContain(PASSWORD);
  });

  it("rejects a missing password without dialing anything", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: `/api/dev-machines/${ctx.machineId}/provision`,
      headers: formHeaders,
      payload: "password="
    });
    expect(res.statusCode).toBe(400);
    expect(ctx.enroll).not.toHaveBeenCalled();
    expect(ctx.registry.listDevMachines()[0]!.provisioned).toBe(false);
  });

  it("404s an unknown machine id", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/dev-machines/not-a-real-id/provision",
      headers: formHeaders,
      payload: `password=${encodeURIComponent(PASSWORD)}`
    });
    expect(res.statusCode).toBe(404);
    expect(ctx.enroll).not.toHaveBeenCalled();
  });

  it("leaves the machine unprovisioned when enrollment fails, and never echoes the password", async () => {
    const failing = makeApp(
      vi.fn(async () => {
        throw new EnrollmentError(`could not authenticate to mac-mini with the supplied password`);
      }) as never
    );
    const res = await failing.app.inject({
      method: "POST",
      url: `/api/dev-machines/${failing.machineId}/provision`,
      headers: formHeaders,
      payload: `password=${encodeURIComponent(PASSWORD)}`
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain(PASSWORD);
    expect(failing.registry.listDevMachines()[0]!.provisioned).toBe(false);
  });

  it("does not leak the password when something unexpected explodes", async () => {
    const exploding = makeApp(
      vi.fn(async () => {
        throw new Error(`ssh2 barfed with password=${PASSWORD}`);
      }) as never
    );
    const res = await exploding.app.inject({
      method: "POST",
      url: `/api/dev-machines/${exploding.machineId}/provision`,
      headers: formHeaders,
      payload: `password=${encodeURIComponent(PASSWORD)}`
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.body).not.toContain(PASSWORD);
    expect(exploding.registry.listDevMachines()[0]!.provisioned).toBe(false);
  });
});
