/**
 * Keycard routes (M1 task 2, TP-3; docs/machine-auth-design.md; PROJECT_BIBLE §7 tier 4, §9 C.5; ADR-0008).
 *
 * The DOOR — `/keycard/v1/*`, keycard-authenticated by the app-level guard, GET only, one route per
 * scope plus a zero-scope `whoami`. There is no management or write route under the prefix at any
 * scope (TM-011); the closed scope enum has nothing to grant one with.
 *   GET /keycard/v1/whoami     — the card's principal + scopes (no scope required)
 *   GET /keycard/v1/usage      — `usage:read`  (labeled 503 until the M2 usage ledger exists)
 *   GET /keycard/v1/approvals  — `approvals:read`, REFERENCE-ONLY (D8): id/tool/server/status/time/
 *                                requester — never arguments, diff or payload; bounded (200 items,
 *                                256 chars per field, upstream timeout)
 *   GET /keycard/v1/sessions   — `sessions:read`, session METADATA only
 *
 * The ADMIN side — minting, listing and revoking live on the D6 admin surface (`/api/keycards`,
 * behind the operator guard). The raw token is returned exactly once: JSON callers get it in the
 * 201 body; the Configuration form is Post/Redirect/Get to a ONE-SHOT page (`/admin/keycards/minted?
 * slot=<nonce>`) that reads-and-burns a short-lived in-memory slot — a browser reload cannot re-mint
 * and the token is never in a URL. Form validation errors and revocations redirect back to the
 * Configuration page with allow-listed `?error=` / `?notice=` codes (never reflected text).
 */

import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Session } from "../../session/types.js";
import type { Keycard, KeycardScope } from "../../keycard/types.js";
import { KeycardService, KeycardValidationError } from "../../keycard/service.js";
import { readApprovalReferences, type ApprovalsReader } from "../../approvals/projection.js";
import { KEYCARD_PREFIX } from "../auth/keycard-guard.js";
import { escapeHtml as esc } from "../config-page.js";

export interface KeycardDoorDeps {
  readonly keycards: KeycardService;
  /** Peta approvals reader; absent → labeled 503. */
  readonly approvals?: ApprovalsReader;
  /** Upstream budget for the approvals read (default 10 s). */
  readonly approvalsTimeoutMs?: number;
  /** Session metadata source; absent → labeled 503. */
  readonly sessionLedger?: { list(): Session[] };
}

const DEFAULT_APPROVALS_TIMEOUT_MS = 10_000;

/** Per-route scope check. The guard already authenticated; this is authorization (exact scope). */
function requireScope(keycards: KeycardService, scope: KeycardScope) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const card = req.keycard;
    if (!card) {
      reply.code(401).send({ error: "keycard_required" });
      return;
    }
    if (!keycards.authorize(card, scope)) {
      reply.code(403).send({ error: "insufficient_scope", required: scope });
    }
  };
}

export function registerKeycardDoor(app: FastifyInstance, deps: KeycardDoorDeps): void {
  const { keycards } = deps;
  const p = (path: string): string => `${KEYCARD_PREFIX}${path}`;
  const approvalsTimeoutMs = deps.approvalsTimeoutMs ?? DEFAULT_APPROVALS_TIMEOUT_MS;

  app.get(p("whoami"), async (req, reply) => {
    const card = req.keycard;
    if (!card) {
      reply.code(401);
      return { error: "keycard_required" };
    }
    return { principal: card.principal, scopes: card.scopes, expiresAt: card.expiresAt };
  });

  app.get(p("usage"), { preHandler: requireScope(keycards, "usage:read") }, async (_req, reply) => {
    reply.code(503);
    return { state: "unavailable", message: "the usage ledger is not built yet (M2 step 6) — nothing to read" };
  });

  app.get(p("approvals"), { preHandler: requireScope(keycards, "approvals:read") }, async (_req, reply) => {
    if (!deps.approvals) {
      reply.code(503);
      return { state: "unavailable", message: "the approval gate (Peta) is not configured on this server" };
    }
    const res = await readApprovalReferences(deps.approvals, approvalsTimeoutMs);
    if (res.state === "failed") {
      reply.code(502);
      return { state: "failed", message: res.message };
    }
    return { approvals: res.approvals, truncated: res.truncated };
  });

  app.get(p("sessions"), { preHandler: requireScope(keycards, "sessions:read") }, async (_req, reply) => {
    if (!deps.sessionLedger) {
      reply.code(503);
      return { state: "unavailable", message: "the session ledger is not configured on this server" };
    }
    return { sessions: deps.sessionLedger.list() };
  });
}

// ---------------------------------------------------------------------------------------------
// Admin surface (D6): mint / list / revoke
// ---------------------------------------------------------------------------------------------

export interface KeycardAdminDeps {
  readonly keycards: KeycardService;
  /** Clock for the one-shot slots (tests). */
  readonly now?: () => number;
}

interface MintBody {
  principal?: unknown;
  scopes?: unknown;
  ttlDays?: unknown;
}

function isUrlencodedForm(req: FastifyRequest): boolean {
  return (req.headers["content-type"] ?? "").includes("application/x-www-form-urlencoded");
}

/**
 * Wire → typed. A form posts `scopes` as one string or many and `ttlDays` as a string; those are
 * the ONLY translations. JSON passes through untouched so a wrong shape is rejected, never laundered
 * (`"scopes":"usage:read"` or `[["usage:read"]]` → 400). A repeated `ttlDays` form key → NaN → 400.
 */
function mintInputFrom(body: unknown, form: boolean): { principal: unknown; scopes: unknown; ttlDays?: unknown } {
  const b = (typeof body === "object" && body !== null ? body : {}) as MintBody;
  if (!form) return b.ttlDays === undefined ? { principal: b.principal, scopes: b.scopes } : { principal: b.principal, scopes: b.scopes, ttlDays: b.ttlDays };
  const scopes = Array.isArray(b.scopes) ? b.scopes : typeof b.scopes === "string" ? [b.scopes] : [];
  let ttlDays: number | undefined;
  if (b.ttlDays !== undefined) {
    if (typeof b.ttlDays === "string") {
      if (b.ttlDays !== "") ttlDays = /^[0-9]+$/.test(b.ttlDays) ? Number(b.ttlDays) : Number.NaN;
    } else {
      ttlDays = Number.NaN; // e.g. a repeated key arrives as an array — ambiguous input is refused, not defaulted
    }
  }
  return ttlDays === undefined ? { principal: b.principal, scopes } : { principal: b.principal, scopes, ttlDays };
}

/** One-shot, short-lived in-memory slots so the form mint can be Post/Redirect/Get without the token in a URL. */
export class MintedTokenSlots {
  private readonly slots = new Map<string, { card: Keycard; token: string; expiresAt: number }>();
  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs: number = 5 * 60_000
  ) {}
  put(card: Keycard, token: string): string {
    this.sweep();
    const nonce = randomBytes(16).toString("base64url");
    this.slots.set(nonce, { card, token, expiresAt: this.now() + this.ttlMs });
    return nonce;
  }
  /** Read-and-burn. */
  take(nonce: string): { card: Keycard; token: string } | undefined {
    this.sweep();
    const s = this.slots.get(nonce);
    if (!s) return undefined;
    this.slots.delete(nonce);
    return { card: s.card, token: s.token };
  }
  private sweep(): void {
    const t = this.now();
    for (const [k, v] of this.slots) if (v.expiresAt <= t) this.slots.delete(k);
  }
}

function pageShell(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)} — Pantheon Harness</title>
<style>body{font-family:system-ui,sans-serif;max-width:44rem;margin:3rem auto;padding:0 1rem}code{font-family:monospace;word-break:break-all}
.token{display:block;padding:.6rem;border:1px solid #888;border-radius:6px;margin:.6rem 0}.warn{border:1px solid #888;padding:.6rem;border-radius:6px}</style></head>
<body>
${body}
</body>
</html>`;
}

/** The one-time token page. `no-store` so no cache ever holds the token. */
export function renderKeycardMinted(card: Keycard, token: string): string {
  return pageShell(
    "Keycard minted",
    `<h1>Keycard minted</h1>
<p><strong>${esc(card.principal)}</strong> — scopes: <code>${card.scopes.map(esc).join(", ")}</code> — expires ${esc(card.expiresAt)}.</p>
<p class="warn" role="alert"><strong>[!] Copy the keycard now. It will not be shown again.</strong> The harness keeps only a fingerprint of it; reloading this page will not show it a second time.</p>
<code class="token" data-keycard-token>${esc(token)}</code>
<p>Give it to the CLI session as an environment variable (for example <code>PANTHEON_KEYCARD</code>) and send it as
<code>Authorization: Bearer &lt;keycard&gt;</code> to <code>/keycard/v1/whoami</code>, <code>/keycard/v1/sessions</code>,
<code>/keycard/v1/approvals</code> or <code>/keycard/v1/usage</code>. It opens nothing else. Revoke it from the Configuration page at any time.</p>
<p><a href="/admin/config?notice=keycard_minted">Back to Configuration</a></p>`
  );
}

export function renderKeycardCollected(): string {
  return pageShell(
    "Keycard already collected",
    `<h1>Keycard already collected</h1>
<p role="status"><strong>[i] This keycard has already been collected, or the link expired.</strong> A keycard is shown exactly once and is never stored in the clear.</p>
<p>If you did not copy it, revoke that card on the Configuration page and mint a new one.</p>
<p><a href="/admin/config">Back to Configuration</a></p>`
  );
}

export function registerKeycardAdminRoutes(app: FastifyInstance, deps: KeycardAdminDeps): void {
  const { keycards } = deps;
  const slots = new MintedTokenSlots(deps.now ?? Date.now);

  app.get("/api/keycards", async () => keycards.list());

  app.post("/api/keycards", async (req, reply) => {
    const form = isUrlencodedForm(req);
    let minted;
    try {
      minted = keycards.mint(mintInputFrom(req.body, form));
    } catch (err) {
      if (err instanceof KeycardValidationError) {
        if (form) {
          const code = err.field === "principal" ? "keycard_principal" : err.field === "scopes" ? "keycard_scopes" : "keycard_ttl";
          reply.redirect(`/admin/config?error=${code}`, 303);
          return;
        }
        reply.code(400);
        return { error: "validation_error", field: err.field, detail: err.message };
      }
      throw err;
    }
    if (form) {
      const nonce = slots.put(minted.card, minted.token);
      reply.header("cache-control", "no-store").redirect(`/admin/keycards/minted?slot=${nonce}`, 303);
      return;
    }
    reply.code(201).header("cache-control", "no-store");
    return { card: minted.card, token: minted.token };
  });

  app.get<{ Querystring: { slot?: unknown } }>("/admin/keycards/minted", async (req, reply) => {
    const nonce = typeof req.query.slot === "string" ? req.query.slot : "";
    const hit = nonce ? slots.take(nonce) : undefined;
    reply.header("cache-control", "no-store").type("text/html; charset=utf-8");
    if (!hit) {
      reply.code(410);
      return renderKeycardCollected();
    }
    return renderKeycardMinted(hit.card, hit.token);
  });

  app.post<{ Params: { id: string } }>("/api/keycards/:id/revoke", async (req, reply) => {
    const form = isUrlencodedForm(req);
    if (!keycards.revoke(req.params.id)) {
      if (form) {
        reply.redirect("/admin/config?error=keycard_not_found", 303);
        return;
      }
      reply.code(404);
      return { error: "not_found" };
    }
    if (form) {
      reply.redirect("/admin/config?notice=keycard_revoked", 303);
      return;
    }
    reply.code(204);
  });
}
