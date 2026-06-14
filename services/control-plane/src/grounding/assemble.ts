/**
 * Grounded-context assembly (#13, Data Contract Transformation Step 1).
 *
 * Takes the operator's typed input plus any retrieved (already-tagged) items and
 * produces an ordered, inspectable context. The trusted operator item is always first;
 * every retrieved item keeps its `trusted:false` tag. The render is plain text with
 * provenance distinguished by LABEL + POSITION (colorblind-safe, CC1 — never color).
 */

import { makeUserItem, type ProvenanceItem, type RecalledProvenanceItem } from "./provenance.js";

export interface GroundedContext {
  /** Ordered items: the trusted user item first, then retrieved items in order. */
  readonly items: readonly ProvenanceItem[];
  /** An inspectable, colorblind-safe text rendering with provenance labels. */
  render(): string;
}

/**
 * Assemble the grounded context.
 *
 * @param userInput   the operator's typed input for this session (the only trusted item).
 * @param retrievedItems  recalled fragments, each already tagged `trusted:false` at retrieval.
 */
export function assembleGroundedContext(
  userInput: string,
  retrievedItems: readonly RecalledProvenanceItem[]
): GroundedContext {
  const items: readonly ProvenanceItem[] = [makeUserItem(userInput), ...retrievedItems];

  return {
    items,
    render(): string {
      return items
        .map((item) => `=== ${item.label} ===\n${item.content}`)
        .join("\n\n");
    }
  };
}
