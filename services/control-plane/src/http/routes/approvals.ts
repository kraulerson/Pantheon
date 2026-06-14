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

/** The narrow Peta surface these routes proxy (matches PetaAdminClient). */
export interface ApprovalsBackend {
  listApprovals(): Promise<unknown>;
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
