/**
 * CompositeRetriever — runs the enabled grounding sources for a session and concatenates
 * their recalled items (#13). Every item is `trusted:false` (each sub-retriever guarantees it),
 * so any returned item flips session taint by presence in the engine.
 *
 * Toggles mirror the session's GroundingSourceState (PROJECT_BIBLE §9 grounding controls):
 * persona / memory / mailbox. Cross-session search (LibreChat / Meilisearch) is a documented
 * LATER seam and is intentionally not a toggle here yet.
 */

import type { GroundingRetriever, RetrievedItem } from "../retriever.js";

/** Per-session grounding-source enablement (subset wired today; cross-session is a later seam). */
export interface GroundingSourceState {
  readonly persona: boolean;
  readonly memory: boolean;
  readonly mailbox: boolean;
}

export interface CompositeRetrieverOptions {
  readonly toggles: GroundingSourceState;
  /** Persona-loading retriever (e.g. Gitea persona; StubRetriever during dev). */
  readonly persona?: GroundingRetriever;
  /** Qdrant memory retriever (per-identity collection). */
  readonly memory?: GroundingRetriever;
  /** Bridge mailbox retriever. */
  readonly mailbox?: GroundingRetriever;
}

export class CompositeRetriever implements GroundingRetriever {
  private readonly opts: CompositeRetrieverOptions;

  constructor(opts: CompositeRetrieverOptions) {
    this.opts = opts;
  }

  async retrieve(identityId: string | null, userInput: string): Promise<RetrievedItem[]> {
    const { toggles, persona, memory, mailbox } = this.opts;
    // Order is stable: persona, then memory, then mailbox (matches inspector readability).
    const enabled: GroundingRetriever[] = [];
    if (toggles.persona && persona) enabled.push(persona);
    if (toggles.memory && memory) enabled.push(memory);
    if (toggles.mailbox && mailbox) enabled.push(mailbox);

    const out: RetrievedItem[] = [];
    for (const r of enabled) {
      out.push(...(await r.retrieve(identityId, userInput)));
    }
    return out;
  }
}
