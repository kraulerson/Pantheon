/**
 * Keycard service — mint / authenticate / authorize / revoke / accounting / rate caps (M1 task 2, TP-3).
 *
 * Deny-by-default in every direction (CC2):
 *  - `mint` accepts only the closed scope enum, a non-empty scope list, an allow-list principal
 *    name and a bounded TTL (default 90 days, max 365) — anything else is a validation error and
 *    nothing is written;
 *  - `authenticate` is PURE: it fails closed on a malformed token, an unknown hash, a revoked card,
 *    an expired card, or a card whose stored scopes are corrupt; only the hash of the presented
 *    token is ever looked up (`SHA-256(token)`, the same shape as Peta user ids — token entropy is
 *    the whole of auth; design §3);
 *  - the guard then applies the per-card rate cap and only THEN `recordServed` — so `useCount`
 *    means "calls served", never "calls attempted";
 *  - `authorize` grants exactly the card's scopes; every denial is counted on the card;
 *  - refused authentications are counted door-wide (`stats()`) and, when the token belongs to a
 *    known (revoked / expired) card, on that card too — a replayed stolen card is visible;
 *  - `preAuthAllowed` is a door-wide budget: after 120 refusals in a sliding minute the guard
 *    answers 429 without touching the store, so probing cannot become a DB read amplifier.
 *
 * The raw token is returned from `mint` once and is never stored, logged or re-derivable.
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { KEYCARD_SCOPE_SET, KEYCARD_SCOPES, type Keycard, type KeycardRepository, type KeycardScope, type KeycardStats } from "./types.js";

const PRINCIPAL_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/;
const TOKEN_PREFIX = "pk1_";
const TOKEN_RE = /^pk1_[0-9a-f]{64}$/;
const DEFAULT_TTL_DAYS = 90;
const MAX_TTL_DAYS = 365;
const DAY_MS = 86_400_000;
const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60_000;
const PRE_AUTH_BUDGET = 120;
const RATE_MAP_SWEEP_AT = 64;

export type KeycardValidationField = "principal" | "scopes" | "ttlDays";

/** Input rejected before any write. Carries no secret; names the offending field. */
export class KeycardValidationError extends Error {
  constructor(
    readonly field: KeycardValidationField,
    message: string
  ) {
    super(message);
    this.name = "KeycardValidationError";
  }
}

export interface MintInput {
  readonly principal: unknown;
  readonly scopes: unknown;
  readonly ttlDays?: unknown;
}

export interface MintResult {
  readonly card: Keycard;
  /** Shown ONCE. Never stored, never logged. */
  readonly token: string;
}

export type KeycardRefusal = "invalid" | "revoked" | "expired";
export type KeycardAuthResult = { readonly ok: true; readonly card: Keycard } | { readonly ok: false; readonly reason: KeycardRefusal };

export interface KeycardServiceOptions {
  readonly now?: () => number;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export class KeycardService {
  private readonly now: () => number;
  private readonly rate = new Map<string, number[]>();
  private refusals: number[] = [];
  private refusedAuth = 0;
  private lastRefusedAt: string | null = null;
  private rateLimited = 0;

  constructor(
    private readonly repo: KeycardRepository,
    opts: KeycardServiceOptions = {}
  ) {
    this.now = opts.now ?? Date.now;
  }

  private nowIso(): string {
    return new Date(this.now()).toISOString();
  }

  mint(input: MintInput): MintResult {
    if (typeof input.principal !== "string" || !PRINCIPAL_RE.test(input.principal)) {
      throw new KeycardValidationError("principal", "principal must be 1–64 letters, digits, '.', '_' or '-' (not starting with '-')");
    }
    if (!Array.isArray(input.scopes) || input.scopes.length === 0) {
      throw new KeycardValidationError("scopes", `scopes must be a non-empty list drawn from: ${KEYCARD_SCOPES.join(", ")}`);
    }
    const scopes: KeycardScope[] = [];
    for (const s of input.scopes as unknown[]) {
      if (typeof s !== "string" || !KEYCARD_SCOPE_SET.has(s)) {
        throw new KeycardValidationError("scopes", `unknown scope '${String(s).slice(0, 40)}' — allowed: ${KEYCARD_SCOPES.join(", ")}`);
      }
      if (!scopes.includes(s as KeycardScope)) scopes.push(s as KeycardScope);
    }
    let ttlDays = DEFAULT_TTL_DAYS;
    if (input.ttlDays !== undefined) {
      if (typeof input.ttlDays !== "number" || !Number.isInteger(input.ttlDays) || input.ttlDays < 1 || input.ttlDays > MAX_TTL_DAYS) {
        throw new KeycardValidationError("ttlDays", `ttlDays must be a whole number from 1 to ${MAX_TTL_DAYS}`);
      }
      ttlDays = input.ttlDays;
    }
    const nowMs = this.now();
    const nowIso = new Date(nowMs).toISOString();
    const token = TOKEN_PREFIX + randomBytes(32).toString("hex");
    const card: Keycard = {
      id: randomUUID(),
      principal: input.principal,
      scopes,
      createdAt: nowIso,
      updatedAt: nowIso,
      expiresAt: new Date(nowMs + ttlDays * DAY_MS).toISOString(),
      revokedAt: null,
      lastUsedAt: null,
      useCount: 0,
      denyCount: 0
    };
    this.repo.insert(card, hashToken(token));
    return { card, token };
  }

  /** PURE lookup: fail closed on anything but a live card whose hash is on file. No side effects. */
  authenticate(presented: unknown): KeycardAuthResult {
    if (typeof presented !== "string" || !TOKEN_RE.test(presented)) return { ok: false, reason: "invalid" };
    const card = this.repo.findByTokenHash(hashToken(presented));
    if (!card) return { ok: false, reason: "invalid" };
    if (card.revokedAt !== null) return { ok: false, reason: "revoked" };
    if (card.expiresAt <= this.nowIso()) return { ok: false, reason: "expired" };
    if (card.scopes.length === 0) return { ok: false, reason: "invalid" }; // corrupt store row: never unscoped-but-live
    return { ok: true, card };
  }

  /** Count a served request (call AFTER the rate check). */
  recordServed(cardId: string): void {
    this.repo.recordUse(cardId, this.nowIso(), false);
  }

  /** Exactly the card's scopes, nothing else. A denial is counted on the card. */
  authorize(card: Keycard, scope: KeycardScope): boolean {
    if (card.scopes.includes(scope)) return true;
    this.repo.recordUse(card.id, this.nowIso(), true);
    return false;
  }

  /** Door-wide refusal accounting; when the refused token belongs to a known card, charge that card too. */
  noteRefused(_reason: KeycardRefusal, cardId?: string): void {
    const t = this.now();
    this.refusals.push(t);
    this.refusedAuth++;
    this.lastRefusedAt = new Date(t).toISOString();
    if (cardId !== undefined) this.repo.recordUse(cardId, this.lastRefusedAt, true);
  }

  /** Refuse a presented token: resolves the card (if the hash is known) so the replay is charged to it. */
  refuse(presented: unknown, reason: KeycardRefusal): void {
    const known =
      typeof presented === "string" && TOKEN_RE.test(presented) ? this.repo.findByTokenHash(hashToken(presented)) : undefined;
    this.noteRefused(reason, known?.id);
  }

  noteRateLimited(cardId: string): void {
    this.rateLimited++;
    this.repo.recordUse(cardId, this.nowIso(), true);
  }

  /** Door-wide pre-auth budget: false once 120 refusals fell inside the sliding minute. */
  preAuthAllowed(): boolean {
    const t = this.now();
    this.refusals = this.refusals.filter((s) => t - s < RATE_WINDOW_MS);
    return this.refusals.length < PRE_AUTH_BUDGET;
  }

  stats(): KeycardStats {
    return { refusedAuth: this.refusedAuth, lastRefusedAt: this.lastRefusedAt, rateLimited: this.rateLimited };
  }

  /** Sliding-window cap per card: true = allowed (and counted), false = over the cap. */
  checkRate(cardId: string): boolean {
    const t = this.now();
    if (this.rate.size > RATE_MAP_SWEEP_AT) {
      for (const [id, stamps] of this.rate) {
        if (!stamps.some((s) => t - s < RATE_WINDOW_MS)) this.rate.delete(id);
      }
    }
    const stamps = (this.rate.get(cardId) ?? []).filter((s) => t - s < RATE_WINDOW_MS);
    if (stamps.length >= RATE_LIMIT) {
      this.rate.set(cardId, stamps);
      return false;
    }
    stamps.push(t);
    this.rate.set(cardId, stamps);
    return true;
  }

  /** TEST HOOK: size of the per-card rate map (eviction tests). */
  rateMapSizeForTest(): number {
    return this.rate.size;
  }

  revoke(id: string): boolean {
    return this.repo.revoke(id, this.nowIso());
  }

  get(id: string): Keycard | undefined {
    return this.repo.get(id);
  }

  list(): Keycard[] {
    return this.repo.list();
  }
}
