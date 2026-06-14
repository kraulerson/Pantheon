/**
 * Taint tracking — taint-by-presence + monotonic session taint (#14c, D5, DM-3).
 *
 * Taint is by PRESENCE, never by judgment (TM-004): if ANY `trusted:false` content is
 * present in the context, the session is tainted. Once tainted a session can NEVER revert
 * (D5: sticky; a clean context = a brand-new session). This is modeled so that reverting
 * is impossible — {@link SessionTaint.markTaint} only ever sets the flag true, the backing
 * field is private, and there is no detaint/clear/reset method.
 */

import type { GroundedContext } from "./assemble.js";

/**
 * Pure taint-by-presence check over an assembled context.
 * @returns true iff any item is `trusted:false`.
 */
export function computeTaint(context: GroundedContext): boolean {
  return context.items.some((item) => item.trusted === false);
}

/**
 * Monotonic per-session taint flag (D5 sticky).
 *
 * The flag starts `false` and the only mutator, {@link markTaint}, sets it `true`.
 * There is deliberately no method to clear it and the backing field is private (`#tainted`),
 * so it cannot be reverted by a method call or by writing a public property.
 */
export class SessionTaint {
  #tainted = false;

  /** Whether this session is tainted. Read-only to the outside world. */
  get tainted(): boolean {
    return this.#tainted;
  }

  /** Set tainted true. Idempotent. There is NO inverse — taint never reverts (D5). */
  markTaint(): void {
    this.#tainted = true;
  }

  /**
   * Absorb a grounded context: taint the session if (and only if) the context carries any
   * `trusted:false` content. A clean context never clears an already-tainted session.
   */
  absorb(context: GroundedContext): void {
    if (computeTaint(context)) {
      this.markTaint();
    }
  }
}
