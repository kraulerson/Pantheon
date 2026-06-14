/**
 * Real grounding retrievers — composition barrel (#13).
 *
 * The production pre-processor is wired with a {@link CompositeRetriever} built from the live
 * BridgeClient via {@link buildCompositeRetriever}, REPLACING the StubRetriever (which is kept
 * for unit tests / offline dev). Memory recall is scoped to the identity's OWN collection
 * (never "all") to preserve identity isolation.
 */

import type { GroundingRetriever } from "../retriever.js";
import type { MemorySearchPort, MailboxListPort } from "../../bridge/client.js";
import { MemoryRetriever, type IsolatedCollection } from "./memory.js";
import { MailboxRetriever } from "./mailbox.js";
import { CompositeRetriever, type GroundingSourceState } from "./composite.js";

export { MemoryRetriever, type MemoryRetrieverOptions, type IsolatedCollection } from "./memory.js";
export { MailboxRetriever, type MailboxRetrieverOptions } from "./mailbox.js";
export {
  CompositeRetriever,
  type CompositeRetrieverOptions,
  type GroundingSourceState
} from "./composite.js";

export interface BuildCompositeOptions {
  /** The active identity's OWN Qdrant collection (cloud→"alden-cloud", alden-1→"alden-1"). */
  readonly collection: IsolatedCollection;
  /** Source toggles (the session's GroundingSourceState). Default: all enabled. */
  readonly toggles?: GroundingSourceState;
  /** Also pull "alden-shared" memory alongside the identity's collection. */
  readonly includeShared?: boolean;
  /** Optional persona retriever (Gitea-backed, a separate seam). */
  readonly persona?: GroundingRetriever;
  readonly memoryLimit?: number;
  readonly mailboxLimit?: number;
}

/**
 * Build the production CompositeRetriever from a live bridge port (a {@link BridgeClient}).
 * The memory collection is passed EXPLICITLY per identity — isolation is enforced here.
 */
export function buildCompositeRetriever(
  bridge: MemorySearchPort & MailboxListPort,
  opts: BuildCompositeOptions
): CompositeRetriever {
  const memory = new MemoryRetriever(bridge, {
    collection: opts.collection,
    ...(opts.includeShared !== undefined ? { includeShared: opts.includeShared } : {}),
    ...(opts.memoryLimit !== undefined ? { limit: opts.memoryLimit } : {})
  });
  const mailbox = new MailboxRetriever(bridge, {
    ...(opts.mailboxLimit !== undefined ? { limit: opts.mailboxLimit } : {})
  });
  return new CompositeRetriever({
    toggles: opts.toggles ?? { persona: true, memory: true, mailbox: true },
    ...(opts.persona !== undefined ? { persona: opts.persona } : {}),
    memory,
    mailbox
  });
}
