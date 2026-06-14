/**
 * Provenance types — the trust boundary primitive (#13, #14c).
 *
 * Trust model (Manifesto §1, REQUIREMENTS #13): the operator's typed input in the
 * CURRENT session is the ONLY trusted provenance (`trusted:true`). EVERY other source
 * — persona, qdrant, mailbox, cross-session search, tool-result — is `trusted:false`.
 *
 * It must be impossible to construct a recalled item as trusted. This is enforced two ways:
 *  1. Type level — the discriminated union pins `trusted` to a literal per source.
 *  2. Factory level — {@link makeRecalledItem} hard-codes `trusted:false` and accepts no
 *     trust argument, so a caller cannot upgrade a non-user source (fail closed, CC2).
 */

/** Every non-user source. All are `trusted:false` by construction. */
export type RecalledSource =
  | "persona"
  | "qdrant"
  | "mailbox"
  | "cross-session"
  | "tool-result";

/** The only trusted source: the operator's typed input in this session. */
export type UserSource = "user";

export type ProvenanceSource = UserSource | RecalledSource;

/** The one trusted item — operator input in the current session. */
export interface UserProvenanceItem {
  readonly source: UserSource;
  readonly trusted: true;
  readonly content: string;
  /** Human-readable, colorblind-safe provenance label (text, never color). */
  readonly label: string;
}

/** Any recalled / non-user item. `trusted` is pinned to the literal `false`. */
export interface RecalledProvenanceItem {
  readonly source: RecalledSource;
  readonly trusted: false;
  readonly content: string;
  readonly label: string;
}

/**
 * Discriminated union over provenance. There is no variant in which a
 * {@link RecalledSource} carries `trusted:true`; the type system rejects it.
 */
export type ProvenanceItem = UserProvenanceItem | RecalledProvenanceItem;


/**
 * Build the single trusted item from the operator's typed input.
 * This is the ONLY way to produce `trusted:true`.
 */
export function makeUserItem(content: string): UserProvenanceItem {
  return {
    source: "user",
    trusted: true,
    content,
    label: "TRUSTED — operator input (this session)"
  };
}

/**
 * Build a recalled item. `trusted` is hard-coded `false` and there is no parameter
 * by which a caller can request `trusted:true` — a recalled item can never be forged
 * trusted (fail closed, CC2; never auto-promote recalled content, D7).
 */
export function makeRecalledItem(
  source: RecalledSource,
  content: string
): RecalledProvenanceItem {
  return {
    source,
    trusted: false,
    content,
    label: `UNTRUSTED — recalled (source: ${source})`
  };
}
