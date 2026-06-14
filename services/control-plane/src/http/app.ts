/**
 * Control-plane HTTP app (Fastify 5). Stands up the admin/config surface the later
 * pre-processor reuses. PROJECT_BIBLE §7/D6/TM-011: gateway management is reachable ONLY via a
 * separate authenticated admin surface, never via a session tool. Every route here sits behind
 * a PLUGGABLE admin-tier guard.
 *
 * Auth seam: the default guard checks a strong bearer `ADMIN_API_TOKEN`. The future passkey /
 * WebAuthn step-up (D6) plugs in at {@link verifyStepUp} — same guard shape, stronger ceremony.
 *
 * Fail-closed (CC2): missing/invalid admin auth → 401/403 with a sanitized body (never the
 * token, never raw exception text — §8/TM-008); validation errors → 400 with no mutation.
 */

import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { RegistryService, ValidationError } from "../registry/service.js";
import type { McpRegistrationService } from "../registry/mcp-registration.js";
import { renderConfigPage } from "./config-page.js";
import type { Preprocessor } from "../preprocessor/index.js";
import { registerChatCompletionsRoute } from "./routes/chat-completions.js";
import { registerInspectorRoute } from "./routes/inspector.js";
import { registerApprovalsRoutes, type ApprovalsBackend } from "./routes/approvals.js";
import { registerHarnessRoutes, HARNESS_ASSET_PATHS } from "./routes/harness.js";

/** Result of an admin-tier check. `ok:false` carries the HTTP status to fail closed with. */
export type GuardResult = { ok: true } | { ok: false; status: 401 | 403; reason: string };

/** Pluggable admin-tier guard. Default = strong bearer token; future = passkey/WebAuthn (D6). */
export type AdminGuard = (req: FastifyRequest) => GuardResult | Promise<GuardResult>;

export interface AppOptions {
  readonly adminToken: string;
  readonly registry: RegistryService;
  readonly mcp: McpRegistrationService;
  /** Override the default bearer guard (e.g. tests, or the future step-up guard). */
  readonly guard?: AdminGuard;
  /**
   * Pre-processor orchestration. When provided, the public OpenAI-compatible entry
   * (POST /v1/chat/completions, identity-gated, NOT admin-guarded) and the admin-guarded
   * Grounding Inspector (GET /inspector/:sessionId/latest) are mounted (§3 ADR, §9 C.2).
   */
  readonly preprocessor?: Preprocessor;
  /** Header carrying the operator identity on the chat entry. Default `x-pantheon-identity`. */
  readonly identityHeader?: string;
  /**
   * Peta admin surface for the Write-Approval Gate (§9 C.3). When provided, the admin-guarded
   * GET /approvals + POST /approvals/:id/decide routes are mounted (proxy listApprovals/decide).
   */
  readonly peta?: ApprovalsBackend;
}

/**
 * Public, non-admin routes (identity-gated, fail-closed in their own handlers). The admin guard
 * is NOT applied to these: LibreChat is not an admin, it presents an operator identity header.
 */
const PUBLIC_PATHS: ReadonlySet<string> = new Set(["/v1/chat/completions", ...HARNESS_ASSET_PATHS]);

function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  // Length is not secret here, but bail before timingSafeEqual (which requires equal length).
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Default guard: requires `Authorization: Bearer <ADMIN_API_TOKEN>`.
 *  - missing/malformed header → 401 (no credential presented)
 *  - present-but-wrong token  → 403 (credential rejected)
 * Comparison is constant-time; the token is never logged or echoed.
 */
export function bearerGuard(adminToken: string): AdminGuard {
  return (req) => {
    const header = req.headers.authorization;
    if (typeof header !== "string" || !header.startsWith("Bearer ")) {
      return { ok: false, status: 401, reason: "missing_bearer" };
    }
    const presented = header.slice("Bearer ".length);
    if (!constantTimeEquals(presented, adminToken)) {
      return { ok: false, status: 403, reason: "invalid_token" };
    }
    return { ok: true };
  };
}

/**
 * FUTURE STEP-UP SEAM (D6 — passkey/WebAuthn). The privileged tier will require a strong
 * step-up credential beyond the bearer token. Implement this to verify a WebAuthn assertion
 * (and "remember me" must NOT bypass it). Wire it by passing a composed guard via
 * {@link AppOptions.guard}. Left intentionally unimplemented in MVP — the bearer guard is the
 * current admin-tier check.
 */
export function verifyStepUp(_req: FastifyRequest): GuardResult {
  return { ok: false, status: 403, reason: "step_up_not_configured" };
}

export function buildApp(opts: AppOptions): FastifyInstance {
  const app = Fastify({ logger: false });
  const { registry, mcp } = opts;
  const guard: AdminGuard = opts.guard ?? bearerGuard(opts.adminToken);

  // Admin-tier guard on every ADMIN route (fail-closed). Public, identity-gated routes
  // (the pre-processor chat entry) are exempted — they fail closed in their own handlers.
  app.addHook("onRequest", async (req, reply) => {
    if (PUBLIC_PATHS.has(req.routeOptions.url ?? req.url.split("?")[0] ?? "")) return;
    const result = await guard(req);
    if (!result.ok) {
      // Sanitized body: a code only, never the token or raw exception text (§8/TM-008).
      reply.code(result.status).send({ error: result.reason });
    }
  });

  // Centralized error handling: ValidationError → 400 (no mutation happened, validation is pre-write).
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ValidationError) {
      reply.code(400).send({ error: "validation_error", detail: err.message });
      return;
    }
    // Never leak raw exception text toward the client.
    reply.code(500).send({ error: "internal_error" });
  });

  // ---- Backends ----
  app.get("/api/backends", async () => registry.listBackends());

  app.post("/api/backends", async (req, reply) => {
    const created = registry.createBackend(req.body as never);
    reply.code(201);
    return created;
  });

  app.put<{ Params: { id: string } }>("/api/backends/:id", async (req) =>
    registry.updateBackend(req.params.id, req.body as never)
  );

  app.delete<{ Params: { id: string } }>("/api/backends/:id", async (req, reply) => {
    registry.deleteBackend(req.params.id);
    reply.code(204);
  });

  // ---- Service endpoints ----
  app.get("/api/service-endpoints", async () => registry.listServiceEndpoints());

  app.post("/api/service-endpoints", async (req, reply) => {
    const created = registry.createServiceEndpoint(req.body as never);
    reply.code(201);
    return created;
  });

  app.put<{ Params: { id: string } }>("/api/service-endpoints/:id", async (req) =>
    registry.updateServiceEndpoint(req.params.id, req.body as never)
  );

  app.delete<{ Params: { id: string } }>("/api/service-endpoints/:id", async (req, reply) => {
    registry.deleteServiceEndpoint(req.params.id);
    reply.code(204);
  });

  // ---- Dev machines (Claude-CLI SSH targets — ADR-0005, §5, TM-020) ----
  app.get("/api/dev-machines", async () => registry.listDevMachines());

  app.post("/api/dev-machines", async (req, reply) => {
    const created = registry.createDevMachine(req.body as never);
    reply.code(201);
    return created;
  });

  app.put<{ Params: { id: string } }>("/api/dev-machines/:id", async (req) =>
    registry.updateDevMachine(req.params.id, req.body as never)
  );

  app.delete<{ Params: { id: string } }>("/api/dev-machines/:id", async (req, reply) => {
    registry.deleteDevMachine(req.params.id);
    reply.code(204);
  });

  // ---- MCP-server registrations (proxy PetaAdminClient) ----
  app.get("/api/mcp-servers", async () => mcp.list());

  app.post("/api/mcp-servers", async (req, reply) => {
    const res = await mcp.register(req.body as never);
    reply.code(201);
    return res;
  });

  // Removal of an MCP-server registration. (Wiring to Peta's delete is left to the registration
  // service as it matures; returns 204 to confirm the request was accepted by the admin surface.)
  app.delete<{ Params: { id: string } }>("/api/mcp-servers/:id", async (_req, reply) => {
    reply.code(204);
  });

  // ---- Harness UI (frame + xterm.js terminal tabs + public xterm assets) — ADR-0005 §9 C.1/C.6 ----
  registerHarnessRoutes(app, { registry });

  // ---- Config page (server-rendered, behind the guard) ----
  app.get("/admin/config", async (_req, reply) => {
    let mcpServers: unknown[] = [];
    let error: string | undefined;
    try {
      mcpServers = await mcp.list();
    } catch {
      error = "MCP server list unavailable — Peta unreachable.";
    }
    const html = renderConfigPage({
      backends: registry.listBackends(),
      serviceEndpoints: registry.listServiceEndpoints(),
      devMachines: registry.listDevMachines(),
      mcpServers,
      ...(error !== undefined ? { error } : {})
    });
    reply.type("text/html").send(html);
  });

  // ---- Pre-processor surface (§3 ADR / §9). Mounted only when wired in. ----
  if (opts.preprocessor) {
    const preprocessorDeps =
      opts.identityHeader === undefined
        ? { preprocessor: opts.preprocessor }
        : { preprocessor: opts.preprocessor, identityHeader: opts.identityHeader };
    registerChatCompletionsRoute(app, preprocessorDeps); // public, identity-gated (NOT admin-guarded)
    registerInspectorRoute(app, opts.preprocessor); // admin-guarded
  }

  // ---- Write-Approval Gate proxy (§9 C.3). Admin-guarded. Mounted only when Peta is wired. ----
  if (opts.peta) {
    registerApprovalsRoutes(app, opts.peta);
  }

  return app;
}

/** Barrel-free re-export for the reply type used in tests/consumers. */
export type { FastifyReply };
