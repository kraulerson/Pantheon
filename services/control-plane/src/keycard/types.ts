/**
 * Session keycard — domain types (M1 task 2, TP-3; docs/machine-auth-design.md; PROJECT_BIBLE §7 tier 4, ADR-0008).
 *
 * A keycard is the narrow, deny-by-default machine credential a Claude-CLI session presents at the
 * harness's read/propose door (`/keycard/v1/*`). It is NOT an Identity, NOT the operator, and NOT
 * an admin credential: its scopes are a CLOSED enum of read scopes — there is no management or
 * write scope to grant, so TM-011 (management never reachable from a session) holds by construction.
 *
 * Custody (Bible §5 Principle 1, design §3): the server stores ONLY `SHA-256(token)`; the raw
 * token exists once, in the mint response, and then only in the principal's own environment.
 */

/** Closed enum. Adding a scope is a Bible change, not a config change. */
export const KEYCARD_SCOPES = ["usage:read", "approvals:read", "sessions:read"] as const;
export type KeycardScope = (typeof KEYCARD_SCOPES)[number];
export const KEYCARD_SCOPE_SET: ReadonlySet<string> = new Set(KEYCARD_SCOPES);

export interface Keycard {
  readonly id: string;
  /** Free-form label for the holder (e.g. `cli-mac-mini`); allow-list charset, no secrets. */
  readonly principal: string;
  /** Validated on read: a corrupt stored value yields `[]`, and a card with no scopes is never live. */
  readonly scopes: readonly KeycardScope[];
  readonly createdAt: string;
  /** Bumped by every mutation (revoke, use/deny counters) — Bible §5 Principle 3. */
  readonly updatedAt: string;
  /** ISO time after which the card fails closed. Always set at mint (default 90 d, max 365 d). */
  readonly expiresAt: string;
  /** Set once by revoke; a revoked card fails closed on the next call. */
  readonly revokedAt: string | null;
  readonly lastUsedAt: string | null;
  /** Requests actually SERVED (counted after the rate check) — visibility, not a quota. */
  readonly useCount: number;
  /** Denials charged to this card: wrong scope, replay after revoke/expiry, rate-limited. */
  readonly denyCount: number;
}

export type KeycardStatus = "active" | "revoked" | "expired" | "invalid";

export function keycardStatus(card: Keycard, nowIso: string): KeycardStatus {
  if (card.revokedAt !== null) return "revoked";
  if (card.expiresAt <= nowIso) return "expired";
  if (card.scopes.length === 0) return "invalid";
  return "active";
}

/** Door-wide refusal accounting (design §7: deny-by-default is only trustworthy if denies are visible). */
export interface KeycardStats {
  /** Authentications refused: unknown, malformed, revoked or expired tokens. */
  readonly refusedAuth: number;
  readonly lastRefusedAt: string | null;
  /** Requests answered 429 (per-card cap or the door-wide pre-auth budget). */
  readonly rateLimited: number;
}

/**
 * Persistence boundary. Storage-only (validation lives in the service). The token hash is written
 * once at insert and is never read back out as a field — lookup is by hash, never listing of hashes.
 */
export interface KeycardRepository {
  insert(card: Keycard, tokenHash: string): void;
  findByTokenHash(tokenHash: string): Keycard | undefined;
  get(id: string): Keycard | undefined;
  /** Newest first, bounded (at most 500). */
  list(): Keycard[];
  /** Returns true when the card exists (idempotent — the first revocation time is kept). */
  revoke(id: string, at: string): boolean;
  recordUse(id: string, at: string, denied: boolean): void;
}
