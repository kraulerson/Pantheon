/**
 * GET /inspector/:sessionId/latest (admin-guarded) — Grounding Inspector (§9 C.2).
 *
 * Returns the latest assembled grounded prompt for a session: each item's {source, trusted,
 * label, content}, so trusted:false content is distinguishable by TEXT/label (CC1 — never
 * color). 404 if nothing has been assembled for that session yet.
 */

import type { FastifyInstance } from "fastify";
import type { Preprocessor } from "../../preprocessor/index.js";

export function registerInspectorRoute(app: FastifyInstance, preprocessor: Preprocessor): void {
  app.get<{ Params: { sessionId: string } }>("/inspector/:sessionId/latest", async (req, reply) => {
    const record = preprocessor.inspector.latest(req.params.sessionId);
    if (!record) {
      reply.code(404).send({ error: "no_assembled_prompt" });
      return;
    }
    reply.code(200).send({
      sessionId: record.sessionId,
      messageId: record.messageId,
      createdAt: record.createdAt,
      rendered: record.rendered,
      items: record.items
    });
  });
}
