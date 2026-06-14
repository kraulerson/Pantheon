/**
 * Inspector stash (PROJECT_BIBLE §9 C.2 Grounding Inspector; D8 assembled-prompt retention).
 *
 * Holds the latest assembled grounded prompt per session so the admin-guarded inspector route
 * can render exactly what was sent, with each item's provenance distinguishable by TEXT/label
 * (never color, CC1). In-memory, last-write-wins per session — a small TTL/size cap is a later
 * hardening increment; this is the minimal retention the inspector needs.
 */

import type { ProvenanceItem } from "../grounding/index.js";

/** One stashed assembled prompt, inspectable item-by-item. */
export interface AssembledPromptRecord {
  readonly sessionId: string;
  readonly messageId: string;
  readonly createdAt: string;
  /** Ordered provenance items (trusted user item first, then recalled trusted:false items). */
  readonly items: ReadonlyArray<Pick<ProvenanceItem, "source" | "trusted" | "label" | "content">>;
  /** Colorblind-safe text rendering with provenance labels. */
  readonly rendered: string;
}

export class InspectorStash {
  private readonly latestBySession = new Map<string, AssembledPromptRecord>();

  stash(record: AssembledPromptRecord): void {
    this.latestBySession.set(record.sessionId, record);
  }

  latest(sessionId: string): AssembledPromptRecord | undefined {
    return this.latestBySession.get(sessionId);
  }
}
