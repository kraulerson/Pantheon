/**
 * MemoryRetriever — real Qdrant-backed semantic recall via the Alden Bridge (#13).
 *
 * Pulls the identity's recalled memory using alden_memory_search and maps every hit to a
 * `trusted:false` RetrievedItem (recalled content can never be forged trusted — CC2/D7).
 *
 * IDENTITY ISOLATION (critical): the collection is the identity's OWN collection, passed
 * EXPLICITLY (cloud→"alden-cloud", alden-1→"alden-1"). The bridge has NO per-caller identity
 * scoping, so the control-plane MUST enforce isolation here. Using "all" merges every
 * identity's memory and breaks isolation — it is rejected at construction.
 */

import type { GroundingRetriever, RetrievedItem } from "../retriever.js";
import type { MemorySearchPort, MemoryHit } from "../../bridge/client.js";

/** Collections an isolated identity may own. Excludes "all" by design. */
export type IsolatedCollection = "alden-1" | "alden-shared" | "alden-cloud";

export interface MemoryRetrieverOptions {
  /** The identity's OWN collection. NEVER "all" (would merge identities). */
  readonly collection: IsolatedCollection;
  /** Also pull the shared "alden-shared" collection (still per-source scoped, never "all"). */
  readonly includeShared?: boolean;
  /** Hits per collection (bridge default 5; clamp 1..50). */
  readonly limit?: number;
}

function recalledMemoryItem(hit: MemoryHit): RetrievedItem {
  return {
    source: "qdrant",
    trusted: false,
    content: hit.information,
    label: `UNTRUSTED — memory:${hit.collection}#${hit.id} (score ${hit.score})`
  };
}

export class MemoryRetriever implements GroundingRetriever {
  private readonly port: MemorySearchPort;
  private readonly collection: IsolatedCollection;
  private readonly includeShared: boolean;
  private readonly limit: number | undefined;

  constructor(port: MemorySearchPort, opts: MemoryRetrieverOptions) {
    // Fail closed: refuse the merge-collection for an isolated identity.
    if ((opts.collection as string) === "all") {
      throw new Error('MemoryRetriever: collection "all" is forbidden — it merges identities and breaks isolation');
    }
    this.port = port;
    this.collection = opts.collection;
    this.includeShared = opts.includeShared ?? false;
    this.limit = opts.limit;
  }

  async retrieve(_identityId: string | null, userInput: string): Promise<RetrievedItem[]> {
    const collections: IsolatedCollection[] = [this.collection];
    if (this.includeShared && this.collection !== "alden-shared") collections.push("alden-shared");

    const perCollection = await Promise.all(
      collections.map(async (collection) => {
        try {
          const hits = await this.port.memorySearch({
            query: userInput,
            collection,
            ...(this.limit !== undefined ? { limit: this.limit } : {})
          });
          return hits.map(recalledMemoryItem);
        } catch {
          // A single source failure must not blank the whole turn; surface what we can.
          console.warn(`[memory-retriever] memory search failed for collection ${collection}`);
          return [];
        }
      })
    );
    return perCollection.flat();
  }
}
