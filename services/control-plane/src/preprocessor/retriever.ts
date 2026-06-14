/**
 * GroundingRetriever — the seam that pulls recalled context for an identity (#13).
 *
 * Every retrieved item is `trusted:false` by construction (built via makeRecalledItem, which
 * has no trust parameter). A retriever can therefore never forge a trusted recall.
 *
 * INCREMENT NOTE: the only implementation here is {@link StubRetriever}, so the whole
 * pre-processor pipeline is testable WITHOUT a live Qdrant / mailbox / cross-session backend.
 * REAL retrievers (Qdrant per-identity collection, Bridge mailbox, cross-session search) are a
 * LATER increment — they will implement this same interface and tag items `trusted:false` at
 * the point of retrieval.
 */

import { makeRecalledItem, type RecalledProvenanceItem, type RecalledSource } from "../grounding/index.js";

/** A retrieved fragment of context for an identity. Always tagged `trusted:false`. */
export type RetrievedItem = RecalledProvenanceItem;

export interface GroundingRetriever {
  /**
   * Recall context for `identityId` relevant to `userInput`. All results are `trusted:false`.
   *
   * May be synchronous (StubRetriever) or asynchronous (real network-backed retrievers such as
   * the Qdrant memory + bridge mailbox retrievers). The pre-processor awaits the result either way.
   */
  retrieve(identityId: string | null, userInput: string): RetrievedItem[] | Promise<RetrievedItem[]>;
}

export interface StubRetrieverOptions {
  /** Emit a default persona item (untrusted recall). Default true. */
  readonly persona?: boolean;
  /** Extra untrusted items to inject (e.g. to simulate a Qdrant/mailbox hit in tests). */
  readonly inject?: ReadonlyArray<{ source: RecalledSource; content: string }>;
}

/**
 * Default, dependency-free retriever for development and tests. Returns a persona item plus
 * any injected items — all `trusted:false`. Stands in for live recall backends.
 */
export class StubRetriever implements GroundingRetriever {
  private readonly persona: boolean;
  private readonly inject: ReadonlyArray<{ source: RecalledSource; content: string }>;

  constructor(opts: StubRetrieverOptions = {}) {
    this.persona = opts.persona ?? true;
    this.inject = opts.inject ?? [];
  }

  retrieve(identityId: string | null, _userInput: string): RetrievedItem[] {
    const items: RetrievedItem[] = [];
    if (this.persona) {
      items.push(
        makeRecalledItem("persona", `Persona for identity ${identityId ?? "(none)"} (stub — real persona load is a later increment).`)
      );
    }
    for (const i of this.inject) {
      items.push(makeRecalledItem(i.source, i.content));
    }
    return items;
  }
}
