/**
 * Pre-processor orchestration (PROJECT_BIBLE §3 ADR + §9). The control-plane sits as an
 * OpenAI-compatible pre-processor in front of the model: LibreChat → here → backend.
 *
 * Pipeline per inbound chat-completions request:
 *  1. RESOLVE identity → its registry-bound backend. FAIL CLOSED: unknown identity, unknown
 *     backend, or disabled backend → reject (no forward).
 *  2. BINDING (#14a / TM-002): the backend is taken ONLY from the identity's binding via the
 *     registry. The request body is NEVER consulted for a backend/endpoint — a session can
 *     never name an arbitrary backend.
 *  3. GROUND: assemble context — the operator's latest typed input is the single trusted:true
 *     item; every retrieved item is trusted:false.
 *  4. TAINT: monotonic markTaint if any trusted:false item is present (taint-by-presence, #14c).
 *  5. STASH the assembled prompt for the inspector (§9 C.2 / D8).
 *  6. FORWARD the grounded request to the bound backend; return the completion.
 */

import { assembleGroundedContext } from "../grounding/index.js";
import type { RegistryService } from "../registry/service.js";
import type { SessionStore } from "../session/index.js";
import type { ChatBackend, ChatCompletionRequest, ChatCompletionResponse } from "../backend/index.js";
import type { GroundingRetriever } from "./retriever.js";
import { InspectorStash } from "./inspector.js";

/** Resolves an identity to its IMMUTABLE registry-bound backend (#14a). */
export interface IdentityBinding {
  readonly identityId: string;
  readonly backendId: string;
}
export type ResolveIdentity = (identityId: string) => IdentityBinding | undefined;

/** Thrown when identity/backend resolution fails. Fail-closed; carries no secret material. */
export class IdentityResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdentityResolutionError";
  }
}

export interface PreprocessorOptions {
  readonly registry: RegistryService;
  readonly sessions: SessionStore;
  readonly backendClient: ChatBackend;
  readonly retriever: GroundingRetriever;
  /**
   * Identity directory: identity → bound backend. INCREMENT NOTE — a full Identity entity
   * (persona repo, Qdrant collection, Peta token, HMAC handle; §5/D1) is a later increment;
   * this minimal resolver carries the one binding the pre-processor must enforce (#14a).
   */
  readonly resolveIdentity: ResolveIdentity;
}

export interface PreprocessRequest {
  readonly sessionId: string;
  readonly identityId: string;
  readonly request: ChatCompletionRequest;
}

export interface PreprocessResult {
  readonly completion: ChatCompletionResponse;
  readonly tainted: boolean;
}

/** Extract the latest user-typed message — the ONLY trusted provenance for this turn. */
function latestUserInput(req: ChatCompletionRequest): string {
  for (let i = req.messages.length - 1; i >= 0; i -= 1) {
    const m = req.messages[i];
    if (m && m.role === "user") return m.content;
  }
  return "";
}

export class Preprocessor {
  readonly inspector = new InspectorStash();
  private readonly opts: PreprocessorOptions;

  constructor(opts: PreprocessorOptions) {
    this.opts = opts;
  }

  async handle(input: PreprocessRequest): Promise<PreprocessResult> {
    const { registry, sessions, backendClient, retriever, resolveIdentity } = this.opts;

    // 1+2. Resolve identity → bound backend (fail closed; binding is server-side, NOT from body).
    const binding = resolveIdentity(input.identityId);
    if (!binding) {
      throw new IdentityResolutionError(`unknown identity: ${input.identityId}`);
    }
    const backend = registry.getBackend(binding.backendId);
    if (!backend) {
      throw new IdentityResolutionError(`bound backend not found for identity ${input.identityId}`);
    }
    if (!backend.enabled) {
      throw new IdentityResolutionError(`bound backend is disabled for identity ${input.identityId}`);
    }

    // Open/lookup the session, bound to this identity + backend (idempotent; never rebinds).
    sessions.getOrCreate(input.sessionId, { identityId: binding.identityId, backendId: backend.id });

    // 3. Ground: user input trusted:true; retrieved items trusted:false.
    const userInput = latestUserInput(input.request);
    const retrieved = await retriever.retrieve(binding.identityId, userInput);
    const context = assembleGroundedContext(userInput, retrieved);

    // 4. Taint by presence (monotonic).
    const tainted = context.items.some((i) => i.trusted === false);
    if (tainted) sessions.markTaint(input.sessionId);

    // 5. Stash for the inspector.
    const messageId = `${input.sessionId}:${Date.now()}`;
    this.inspector.stash({
      sessionId: input.sessionId,
      messageId,
      createdAt: new Date().toISOString(),
      items: context.items.map((i) => ({ source: i.source, trusted: i.trusted, label: i.label, content: i.content })),
      rendered: context.render()
    });

    // 6. Forward the GROUNDED request to the bound backend. The forwarded messages carry the
    //    assembled context as a system message ahead of the original turn; the body's own
    //    model/backend hints are never used to pick a backend.
    const groundedRequest: ChatCompletionRequest = {
      ...input.request,
      messages: [{ role: "system", content: context.render() }, ...input.request.messages]
    };
    const completion = await backendClient.chatCompletions(backend, groundedRequest);
    const session = sessions.get(input.sessionId);
    return { completion, tainted: session?.taintFlag ?? tainted };
  }
}

export { StubRetriever } from "./retriever.js";
export type { GroundingRetriever, RetrievedItem } from "./retriever.js";
export { InspectorStash, type AssembledPromptRecord } from "./inspector.js";
export { MemoryRetriever, type MemoryRetrieverOptions, type IsolatedCollection } from "./retrievers/memory.js";
export { MailboxRetriever, type MailboxRetrieverOptions } from "./retrievers/mailbox.js";
export {
  CompositeRetriever,
  type CompositeRetrieverOptions,
  type GroundingSourceState
} from "./retrievers/composite.js";
