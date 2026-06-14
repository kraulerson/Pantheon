/**
 * POST /v1/chat/completions — the OpenAI-compatible pre-processor entry point.
 * LibreChat is pointed here via a custom-endpoint baseURL (§3 ADR), carrying the operator
 * identity in a request header (default `x-pantheon-identity`, e.g. {{LIBRECHAT_USER_EMAIL}}).
 *
 * This route is NOT behind the admin guard (LibreChat is not an admin) but it is identity-gated
 * and FAIL-CLOSED: a missing/unknown identity → 4xx, no model call. The session id is taken
 * from a header if present, else derived from the identity (one open session per identity here;
 * richer session selection is a later increment).
 */

import type { FastifyInstance } from "fastify";
import { IdentityResolutionError, type Preprocessor } from "../../preprocessor/index.js";
import { BackendError, type ChatCompletionRequest } from "../../backend/index.js";

export interface ChatCompletionsRouteDeps {
  readonly preprocessor: Preprocessor;
  /** Header carrying the operator identity. Default `x-pantheon-identity`. */
  readonly identityHeader?: string;
}

export function registerChatCompletionsRoute(app: FastifyInstance, deps: ChatCompletionsRouteDeps): void {
  const identityHeader = (deps.identityHeader ?? "x-pantheon-identity").toLowerCase();

  app.post("/v1/chat/completions", async (req, reply) => {
    const identity = req.headers[identityHeader];
    const identityId = Array.isArray(identity) ? identity[0] : identity;
    if (typeof identityId !== "string" || identityId.trim() === "") {
      // Fail closed: no identity → no grounding, no model call.
      reply.code(401).send({ error: "missing_identity" });
      return;
    }

    const body = req.body as ChatCompletionRequest | undefined;
    if (!body || !Array.isArray(body.messages)) {
      reply.code(400).send({ error: "invalid_request" });
      return;
    }

    // Session id from a header if supplied, else one stable session per identity.
    const sidHeader = req.headers["x-pantheon-session"];
    const sessionId =
      (Array.isArray(sidHeader) ? sidHeader[0] : sidHeader) ?? `s1`;

    try {
      const result = await deps.preprocessor.handle({ sessionId, identityId: identityId.trim(), request: body });
      reply.code(200).send(result.completion);
    } catch (err) {
      if (err instanceof IdentityResolutionError) {
        // Unknown identity / unbound or disabled backend — fail closed (§3 / TM-002).
        reply.code(403).send({ error: "identity_resolution_failed" });
        return;
      }
      if (err instanceof BackendError) {
        // Backend down/seam — never leak raw text; 502 (upstream failure).
        reply.code(502).send({ error: "backend_unavailable" });
        return;
      }
      throw err;
    }
  });
}
