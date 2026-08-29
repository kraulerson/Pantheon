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
import formbody from "@fastify/formbody";
import { RegistryService, ValidationError } from "../registry/service.js";
import type { McpRegistrationService } from "../registry/mcp-registration.js";
import { renderConfigPage } from "./config-page.js";
import type { Preprocessor } from "../preprocessor/index.js";
import { registerChatCompletionsRoute } from "./routes/chat-completions.js";
import { registerInspectorRoute } from "./routes/inspector.js";
import { registerApprovalsRoutes, registerApprovalsInbox, type ApprovalsBackend } from "./routes/approvals.js";
import { registerHarnessRoutes, HARNESS_ASSET_PATHS, type TmuxLister } from "./routes/harness.js";
import { SessionStore } from "./auth/session.js";
import { operatorGuard, registerAuthRoutes, AUTH_PUBLIC_PATHS } from "./auth/operator-auth.js";
import { USER_GUIDE_HTML, USER_GUIDE_PATH } from "./user-guide.js";
import { isKeycardPath, keycardGuard } from "./auth/keycard-guard.js";
import { registerKeycardAdminRoutes, registerKeycardDoor } from "./routes/keycard.js";
import { requestBase, withBase } from "./base-path.js";
import type { ApprovalSource } from "../approvals/projection.js";
import { LOCAL_SOURCE_LABEL } from "../approvals/sources.js";
import type { KeycardService } from "../keycard/service.js";
import type { Session } from "../session/types.js";

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
  /**
   * Operator passphrase for #9 browser login (§7 tier-1). When set, /login + /logout are mounted and
   * the guard also accepts the resulting session cookie; logged-out browser navigations redirect to
   * /login. Omit to keep bearer-token-only auth (API/headless).
   */
  readonly operatorPassword?: string;
  /** Session store backing the login cookie (defaults to a fresh in-memory store when login is on). */
  readonly sessions?: SessionStore;
  /** Add `Secure` to the session cookie (set true behind HTTPS). */
  readonly secureCookies?: boolean;
  /**
   * Live tmux session lister for the harness launch bar (M1 task 1; real: `listTmuxSessions` over
   * `runRemoteCommand` + custody). Omit on a server with no SSH custody — the route answers 503.
   */
  readonly tmux?: TmuxLister;
  /**
   * Session keycards (M1 task 2, TP-3 — PROJECT_BIBLE §7 tier 4). When provided, the keycard door
   * `/keycard/v1/*` (its own auth domain) and the admin mint/list/revoke routes are mounted and the
   * Configuration page shows the Session Keycards section. Omit → the prefix answers 503 (fail closed).
   */
  readonly keycards?: KeycardService;
  /** Session metadata source for `sessions:read` (the Facade's session store). Absent → labeled 503. */
  readonly sessionLedger?: { list(): Session[] };
  /** Upstream budget for the keycard approvals read (default 10 s; tests shorten it). */
  readonly approvalsTimeoutMs?: number;
  /** Clock for rendered ages on the Pending-Approvals inbox (tests). */
  readonly now?: () => number;
  /** The chat page's address (`PANTHEON_CHAT_URL`): the admin-site Chat tab links there. Omit → text only. */
  readonly chatUrl?: string;
  /**
   * EXTRA approval stores (BUGS #42 — e.g. Alden's capability-gateway Peta), read by the inbox and
   * the keycard door alongside this host's Peta (`peta`, labelled "Pantheon"). Readers only.
   */
  readonly approvalSources?: readonly ApprovalSource[];
}

/**
 * Allow-listed Configuration-page banner codes (`?error=` / `?notice=`). A code that is not listed
 * renders nothing — query text is never reflected into the page (§8/TM-008).
 */
const CONFIG_PAGE_ERRORS: Readonly<Record<string, string>> = {
  keycard_principal: "Invalid principal — keycard not minted. Use 1–64 letters, digits, '.', '_' or '-' (not starting with '-').",
  keycard_scopes: "Invalid scopes — keycard not minted. Tick at least one of usage:read, approvals:read, sessions:read.",
  keycard_ttl: "Invalid validity — keycard not minted. Use a whole number of days from 1 to 365.",
  keycard_not_found: "That keycard no longer exists — nothing changed."
};
const CONFIG_PAGE_NOTICES: Readonly<Record<string, string>> = {
  keycard_minted: "Keycard minted. It was shown once on the previous page; the harness keeps only its fingerprint.",
  keycard_revoked: "Keycard revoked — the holder is refused from its very next request."
};

/**
 * Public, non-admin routes (identity-gated, fail-closed in their own handlers). The admin guard
 * is NOT applied to these: LibreChat is not an admin, it presents an operator identity header.
 */
const PUBLIC_PATHS: ReadonlySet<string> = new Set([
  "/v1/chat/completions",
  ...HARNESS_ASSET_PATHS,
  ...AUTH_PUBLIC_PATHS,
  // The user guide is deliberately readable without signing in (ruling 2026-08-19), so the chat
  // page's Help link always opens it. It carries no credentials or key material.
  USER_GUIDE_PATH
]);

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

/**
 * Translate the Config page's "Add Dev Machine" HTML form into the typed shape the registry
 * expects. A plain HTML form has no types: every field arrives as a STRING, and an unchecked
 * checkbox does not arrive at all. The registry's guards are strict on purpose — `assertPort`
 * rejects the string "22" exactly as hard as the number 70000, because silent coercion deep in
 * the domain is how bad values get laundered — so the wire encoding is translated HERE, at the
 * only layer that knows which encoding was used, and nowhere deeper.
 *
 * JSON bodies pass through untouched: a JSON client sending `"port": "22"` is still rejected.
 * A non-numeric string is passed through untouched too, so the strict guard rejects it rather
 * than this function inventing a value.
 *
 * Deliberately NOT reused for PUT: in a patch body an ABSENT `enabled` means "leave it alone",
 * while an absent form checkbox means "false" — the same wire shape with opposite meanings.
 * There is no dev-machine edit form today; if one is added it needs its own normalizer.
 */
function devMachineFormBody(body: unknown, contentType: string | undefined): unknown {
  if (typeof contentType !== "string" || !contentType.includes("application/x-www-form-urlencoded")) {
    return body;
  }
  if (typeof body !== "object" || body === null) return body;
  const src = body as Record<string, unknown>;
  const out: Record<string, unknown> = { ...src };
  if (typeof src.port === "string") {
    // No trimming: " 22" is not something a number input can produce, so accepting it would be
    // laundering hand-crafted input. Only an exactly-empty field means "unset", and only pure
    // digits convert; everything else travels on untouched to be rejected by the strict guard.
    const raw = src.port;
    if (raw === "") {
      delete out.port; // blank field → let the registry apply its documented default (22)
    } else if (/^[0-9]+$/.test(raw)) {
      out.port = Number(raw);
    }
  }
  out.enabled = src.enabled === "on" || src.enabled === "true" || src.enabled === true;
  return out;
}

/**
 * Config-page form normalizer for entities WITHOUT a port (backends, service endpoints).
 * Same HTML-checkbox truth as devMachineFormBody: an unchecked box does not arrive, a checked box
 * arrives as the string "on". JSON bodies pass through untouched. Fixes BUGS #18 (the Enabled tick
 * was silently ignored for these two, because only /api/dev-machines ran a normalizer).
 */
function configFormBody(body: unknown, contentType: string | undefined): unknown {
  if (typeof contentType !== "string" || !contentType.includes("application/x-www-form-urlencoded")) {
    return body;
  }
  if (typeof body !== "object" || body === null) return body;
  const src = body as Record<string, unknown>;
  return { ...src, enabled: src.enabled === "on" || src.enabled === "true" || src.enabled === true };
}

/**
 * True when the request is an HTML form submit (urlencoded). Config-page forms do a full-page POST,
 * so on success the browser must be redirected back to /admin/config (303, POST->GET) rather than
 * shown the raw JSON record — the BUGS #15 / #21 dead end. JSON/API callers get the record.
 */
function isUrlencodedForm(req: FastifyRequest): boolean {
  return (req.headers["content-type"] ?? "").includes("application/x-www-form-urlencoded");
}

export function buildApp(opts: AppOptions): FastifyInstance {
  const app = Fastify({
    logger: false,
    // A malformed URL never reaches a route or a hook; answer it ourselves so the body is sanitized
    // (no reflected path) and the security header still lands (audit 2026-08-25).
    frameworkErrors: (_error, _req, reply) => {
      void (reply as FastifyReply).code(400).header("X-Content-Type-Options", "nosniff").send({ error: "bad_request" });
    }
  });
  const { registry, mcp } = opts;

  // #9 browser login (§7 tier-1): when an operator passphrase is configured, the guard also accepts
  // a session cookie and logged-out browser navigations redirect to /login.
  const loginEnabled = typeof opts.operatorPassword === "string" && opts.operatorPassword.length > 0;
  const sessions = opts.sessions ?? (loginEnabled ? new SessionStore() : undefined);
  const guard: AdminGuard = opts.guard ?? operatorGuard(opts.adminToken, sessions);

  // Parse application/x-www-form-urlencoded so the login form (and config-page forms) submit.
  app.register(formbody);

  // On EVERY response (guard denials included): the app now has a browser-navigable JSON GET that
  // echoes a (validated) name, so browsers must never content-sniff (audit 2026-08-25).
  app.addHook("onSend", async (_req, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    // Console pages are never meant to be framed (terminals are built in-page; the harness frames the
    // CHAT page, not the other way round). frame-ancestors wins over Caddy's site-level X-Frame-Options:
    // 'self' refuses every cross-origin ancestor (LibreChat artifacts run cross-origin); the one
    // same-origin case — the embedded chat page navigating itself to the console — is busted to the
    // top window by the page's own FRAME_BUST_JS (audit 2026-08-27 A/F5 + B/F-A; BUGS #29 step 1).
    const contentType = String(reply.getHeader("content-type") ?? "");
    if (contentType.startsWith("text/html")) {
      reply.header("Content-Security-Policy", "frame-ancestors 'self'");
      // A console page is generated per request and changes with every deploy; a browser that
      // heuristically cached one hides the whole release (operator report 2026-08-28 — the sidebar
      // looked missing on a cached page). Assets are versioned by deploy and stay cacheable.
      reply.header("Cache-Control", "no-store");
    }
  });

  // Admin-tier guard on every ADMIN route (fail-closed). Public, identity-gated routes
  // (the pre-processor chat entry, login page, static assets) are exempted.
  const kcGuard = keycardGuard(opts.keycards);
  app.decorateRequest("keycard", null);
  app.addHook("onRequest", async (req, reply) => {
    const routePath = req.routeOptions.url ?? req.url.split("?")[0] ?? "";
    const rawPath = req.url.split("?")[0] ?? "";
    // CSRF (audit 2026-08-25): the session cookie is SameSite=Lax, which still travels on a
    // same-SITE cross-origin POST (any other service under the same registrable domain — the chat UI,
    // for one). Browsers label every request with Sec-Fetch-Site; a state-changing request the
    // browser itself marks cross-site or same-site is refused before any guard runs. Same-origin
    // form posts and non-browser API clients (no header) pass. Topology-safe, unlike Origin==Host
    // (the household edge proxy rewrites Host).
    // The terminal WebSocket handshake is a GET that carries the Lax cookie from any sibling host
    // (audit 2026-08-27 F3 / BUGS #26): treat an `Upgrade: websocket` request as state-changing.
    const isUpgrade = String(req.headers.upgrade ?? "").toLowerCase() === "websocket";
    if (isUpgrade || (req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS")) {
      const site = req.headers["sec-fetch-site"];
      if (site === "cross-site" || site === "same-site") {
        reply.code(403).send({ error: "cross_origin_rejected" });
        return;
      }
    }
    // Keycard door (§7 tier 4, docs/machine-auth-design.md §4): its OWN auth domain, dispatched
    // FIRST and by raw path as well as route pattern (bare `/keycard/v1` included), so even an
    // unmatched URL in the domain meets the keycard guard — never the admin guard, never a login
    // redirect. The operator cookie is not consulted here and the admin bearer is not a keycard.
    if (isKeycardPath(rawPath) || isKeycardPath(routePath)) {
      const kc = kcGuard(req);
      if (!kc.ok) {
        reply.code(kc.status).send({ error: kc.reason });
        return;
      }
      req.keycard = kc.card;
      return;
    }
    if (PUBLIC_PATHS.has(routePath)) return;
    const result = await guard(req);
    if (!result.ok) {
      // A logged-out BROWSER navigation → redirect to the login page (no metadata leaked, §7);
      // an API caller → sanitized status code only (never the token or raw exception text, §8/TM-008).
      const wantsHtml = req.method === "GET" && (req.headers.accept ?? "").includes("text/html");
      if (wantsHtml && loginEnabled) {
        reply.redirect(withBase(requestBase(req), "/login"));
        return;
      }
      reply.code(result.status).send({ error: result.reason });
    }
  });

  // ---- #9 login/logout (public) ----
  if (loginEnabled && sessions) {
    registerAuthRoutes(app, {
      operatorPassword: opts.operatorPassword as string,
      sessions,
      ...(opts.secureCookies !== undefined ? { secureCookies: opts.secureCookies } : {})
    });
  }

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
    const created = registry.createBackend(configFormBody(req.body, req.headers["content-type"]) as never);
    if (isUrlencodedForm(req)) { reply.redirect(withBase(requestBase(req), "/admin/config"), 303); return; }
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
    const created = registry.createServiceEndpoint(configFormBody(req.body, req.headers["content-type"]) as never);
    if (isUrlencodedForm(req)) { reply.redirect(withBase(requestBase(req), "/admin/config"), 303); return; }
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
    const created = registry.createDevMachine(
      devMachineFormBody(req.body, req.headers["content-type"]) as never
    );
    if (isUrlencodedForm(req)) { reply.redirect(withBase(requestBase(req), "/admin/config"), 303); return; }
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
    if (isUrlencodedForm(req)) { reply.redirect(withBase(requestBase(req), "/admin/config"), 303); return; }
    reply.code(201);
    return res;
  });

  // Removal of an MCP-server registration. (Wiring to Peta's delete is left to the registration
  // service as it matures; returns 204 to confirm the request was accepted by the admin surface.)
  app.delete<{ Params: { id: string } }>("/api/mcp-servers/:id", async (_req, reply) => {
    reply.code(204);
  });

  // The bare origin is what a bookmark, or the chat UI's admin shortcut, actually requests.
  // Without a route here an AUTHENTICATED request fell through to Fastify's 404 and the operator
  // got raw JSON ("Route GET:/ not found") after clicking a link (BUGS #15). The gap was
  // invisible while logged out, because the auth hook redirects to /login before routing ever
  // happens. Not in PUBLIC_PATHS: logged-out callers keep getting /login (browser) or 401 (API).
  app.get("/", async (req, reply) => {
    reply.redirect(withBase(requestBase(req), "/harness"));
  });

  app.get(USER_GUIDE_PATH, async (_req, reply) => {
    reply.type("text/html; charset=utf-8").send(USER_GUIDE_HTML);
  });

  // ---- Harness UI (frame + xterm.js terminal tabs + public xterm assets) — ADR-0005 §9 C.1/C.6 ----
  registerHarnessRoutes(app, { registry, loginEnabled, ...(opts.tmux ? { tmux: opts.tmux } : {}), ...(opts.chatUrl !== undefined ? { chatUrl: opts.chatUrl } : {}) });

  // ---- Approval stores (BUGS #42): this host's Peta first (READER only — the decide verb is
  // structurally out of reach of the inbox and the door), then every configured extra source. ----
  const localPeta = opts.peta;
  const approvalSources: readonly ApprovalSource[] = [
    ...(localPeta ? [{ label: LOCAL_SOURCE_LABEL, reader: { listApprovals: (filter?: Parameters<ApprovalsBackend["listApprovals"]>[0]) => localPeta.listApprovals(filter) } }] : []),
    ...(opts.approvalSources ?? [])
  ];

  // ---- Session keycards (M1 task 2): admin mint/list/revoke (guarded above) + the keycard door ----
  if (opts.keycards) {
    registerKeycardAdminRoutes(app, { keycards: opts.keycards });
    registerKeycardDoor(app, {
      keycards: opts.keycards,
      // The door gets a READER only — the decide verb is structurally out of its reach.
      approvalSources: approvalSources,
      ...(opts.approvalsTimeoutMs !== undefined ? { approvalsTimeoutMs: opts.approvalsTimeoutMs } : {}),
      ...(opts.sessionLedger ? { sessionLedger: opts.sessionLedger } : {})
    });
  }

  // ---- Config page (server-rendered, behind the guard) ----
  app.get<{ Querystring: { error?: unknown; notice?: unknown } }>("/admin/config", async (req, reply) => {
    let mcpServers: unknown[] = [];
    let error: string | undefined;
    try {
      mcpServers = await mcp.list();
    } catch {
      error = "MCP server list unavailable — Peta unreachable.";
    }
    // Allow-listed banner codes from a redirect (never reflected text).
    const errCode = typeof req.query.error === "string" ? req.query.error : "";
    const noticeCode = typeof req.query.notice === "string" ? req.query.notice : "";
    if (error === undefined && Object.hasOwn(CONFIG_PAGE_ERRORS, errCode)) error = CONFIG_PAGE_ERRORS[errCode];
    const notice = Object.hasOwn(CONFIG_PAGE_NOTICES, noticeCode) ? CONFIG_PAGE_NOTICES[noticeCode] : undefined;
    const html = renderConfigPage({
      backends: registry.listBackends(),
      serviceEndpoints: registry.listServiceEndpoints(),
      devMachines: registry.listDevMachines(),
      mcpServers,
      ...(opts.keycards ? { keycards: opts.keycards.list(), keycardStats: opts.keycards.stats() } : {}),
      ...(error !== undefined ? { error } : {}),
      ...(notice !== undefined ? { notice } : {}),
      base: requestBase(req)
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

  // ---- Pending-Approvals inbox (M1 task 3, TP-2). Admin-guarded page; always mounted (503 without Peta). ----
  registerApprovalsInbox(app, {
    sources: approvalSources,
    ...(opts.approvalsTimeoutMs !== undefined ? { timeoutMs: opts.approvalsTimeoutMs } : {}),
    ...(opts.now ? { now: opts.now } : {})
  });

  return app;
}

/** Barrel-free re-export for the reply type used in tests/consumers. */
export type { FastifyReply };
