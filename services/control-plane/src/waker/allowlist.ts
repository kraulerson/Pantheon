/**
 * Who may wake whom (TP-1, XC-6; ADR-0009).
 *
 * DENY BY DEFAULT and directional: an empty allowlist permits nothing, and `a -> b` never implies
 * `b -> a`. `isConfigured` is what the dispatcher checks to satisfy XC-6 — it refuses to dispatch
 * at all until an allowlist exists, so a missing config can never read as "allow everything".
 */

export interface Pair {
  readonly sender: string;
  readonly recipient: string;
}

/** Identity slugs as the household uses them (registry/bus style): no spaces, no laundering. */
const SLUG = /^[a-z0-9][a-z0-9._-]{0,63}$/;

const key = (sender: string, recipient: string): string => `${sender} ${recipient}`;

export class PairAllowlist {
  private constructor(private readonly pairs: ReadonlySet<string>) {}

  /** Build from config. A malformed entry throws — silently dropping one would widen or narrow the gate. */
  static from(entries: readonly Pair[]): PairAllowlist {
    const set = new Set<string>();
    entries.forEach((e, i) => {
      const sender = (e as Pair | undefined)?.sender;
      const recipient = (e as Pair | undefined)?.recipient;
      if (typeof sender !== "string" || !SLUG.test(sender)) {
        throw new Error(`waker allowlist entry ${i + 1}: invalid sender (lower-case slug required)`);
      }
      if (typeof recipient !== "string" || !SLUG.test(recipient)) {
        throw new Error(`waker allowlist entry ${i + 1}: invalid recipient (lower-case slug required)`);
      }
      set.add(key(sender, recipient));
    });
    return new PairAllowlist(set);
  }

  /** False until at least one pair is configured — the XC-6 gate. */
  get isConfigured(): boolean {
    return this.pairs.size > 0;
  }

  allows(sender: string, recipient: string): boolean {
    return this.pairs.has(key(sender, recipient));
  }
}
