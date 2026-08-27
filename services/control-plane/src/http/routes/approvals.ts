/**
 * Write-Approval Gate proxy (§9 C.3, #14c). Admin-guarded routes that proxy the durable
 * human-in-the-loop approval surface in Peta:
 *   GET  /approvals             → PetaAdminClient.listApprovals()
 *   POST /approvals/:id/decide  → PetaAdminClient.decideApproval(id, decision)
 *
 * The control-plane never decides on its own — it surfaces Peta's pending requests and relays
 * the operator's single-resolution decision. Decision is validated to the closed set
 * {approved, rejected}; anything else fails closed with NO proxy call (CC2).
 */

import type { FastifyInstance } from "fastify";
import { readPendingApprovals, type ApprovalsListFilter, type ApprovalsReader } from "../../approvals/projection.js";
import { renderApprovalsInbox } from "../approvals-inbox.js";

/** The narrow Peta surface these routes proxy (matches PetaAdminClient). */
export interface ApprovalsBackend {
  listApprovals(filter?: ApprovalsListFilter): Promise<unknown>;
  decideApproval(approvalId: string, decision: "approved" | "rejected"): Promise<unknown>;
}

const VALID_DECISIONS: ReadonlySet<string> = new Set(["approved", "rejected"]);

export function registerApprovalsRoutes(app: FastifyInstance, peta: ApprovalsBackend): void {
  app.get("/approvals", async (_req, reply) => {
    const result = await peta.listApprovals();
    reply.code(200).send(result);
  });

  app.post<{ Params: { id: string }; Body: { decision?: unknown } }>(
    "/approvals/:id/decide",
    async (req, reply) => {
      const decision = req.body?.decision;
      if (typeof decision !== "string" || !VALID_DECISIONS.has(decision)) {
        reply.code(400).send({ error: "invalid_decision" });
        return;
      }
      const result = await peta.decideApproval(req.params.id, decision as "approved" | "rejected");
      reply.code(200).send(result);
    }
  );
}

// ---------------------------------------------------------------------------------------------
// Pending-Approvals inbox (M1 task 3, TP-2 amendment): ONE read-only page over Peta's queue for
// every session/identity, reference-only (D8). Mounted always — without Peta it answers a
// labelled 503 rather than vanishing (CC2). Resolution buttons arrive with M2 C.3.
// ---------------------------------------------------------------------------------------------

const DEFAULT_INBOX_TIMEOUT_MS = 10_000;

export interface ApprovalsInboxDeps {
  /** Reader only — the decide verb is structurally out of the page's reach. Absent → labelled 503. */
  readonly approvals?: ApprovalsReader;
  readonly timeoutMs?: number;
  /** Clock for the rendered ages (tests). */
  readonly now?: () => number;
}

/**
 * Peta's resolved vocabulary (Bible §5 ApprovalRecord), matched case-insensitively. ONLY these are
 * hidden; anything else — `PENDING`, `Pending`, an unknown label, or no status at all — is SHOWN with
 * its own label (fail-visible). Audit 2026-08-26: a lowercase-only `pending` match would have hidden
 * every live item, since Peta answers `PENDING`.
 */
const RESOLVED_STATUSES: ReadonlySet<string> = new Set(["approved", "rejected", "expired"]);
const isResolved = (status: string | undefined): boolean => status !== undefined && RESOLVED_STATUSES.has(status.toLowerCase());

export function registerApprovalsInbox(app: FastifyInstance, deps: ApprovalsInboxDeps): void {
  app.get("/admin/approvals", async (_req, reply) => {
    const nowMs = (deps.now ?? Date.now)();
    reply.type("text/html; charset=utf-8").header("Cache-Control", "no-store");
    if (!deps.approvals) {
      reply.code(503);
      return renderApprovalsInbox({ state: "unavailable", approvals: [], hiddenCount: 0, unidentifiedCount: 0, more: false, nowMs });
    }
    const res = await readPendingApprovals(deps.approvals, deps.timeoutMs ?? DEFAULT_INBOX_TIMEOUT_MS);
    if (res.state === "failed") {
      reply.code(502);
      return renderApprovalsInbox({ state: "failed", approvals: [], hiddenCount: 0, unidentifiedCount: 0, more: false, message: res.message, nowMs });
    }
    // An item with no reference id cannot be pointed at or resolved — counted, never shown as a row.
    const identified = res.approvals.filter((a) => a.id !== undefined && a.id !== "");
    const pending = identified.filter((a) => !isResolved(a.status));
    return renderApprovalsInbox({
      state: pending.length > 0 ? "ok" : "empty",
      approvals: pending,
      hiddenCount: identified.length - pending.length,
      unidentifiedCount: res.approvals.length - identified.length,
      more: res.more,
      nowMs
    });
  });
}
