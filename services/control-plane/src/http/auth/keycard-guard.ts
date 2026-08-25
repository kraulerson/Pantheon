/**
 * Keycard door guard (M1 task 2, TP-3; docs/machine-auth-design.md §4 — a SEPARATE auth domain).
 *
 * Everything in the keycard domain (`/keycard/v1` and below) is authenticated by a keycard bearer
 * and by nothing else: the operator's session cookie is ignored here and the admin bearer is
 * rejected (it is not a keycard). Conversely a keycard is rejected everywhere else (the admin guard
 * compares it against the admin token and answers 403). No endpoint accepts both tiers.
 *
 * Order (audit 2026-08-25): no service → 503 · door-wide pre-auth budget exhausted → 429 (no store
 * lookup) · no bearer → 401 · unknown / revoked / expired → 403, counted door-wide AND on the card
 * when the token is a known card (a replayed stolen card is visible) · per-card cap → 429, counted ·
 * served → counted. The raw token is never echoed.
 */

import type { FastifyRequest } from "fastify";
import type { Keycard } from "../../keycard/types.js";
import type { KeycardService } from "../../keycard/service.js";

export const KEYCARD_PREFIX = "/keycard/v1/";
const KEYCARD_ROOT = "/keycard/v1";

/** True for every path that belongs to the keycard auth domain (the bare root included). */
export function isKeycardPath(path: string): boolean {
  return path === KEYCARD_ROOT || path.startsWith(KEYCARD_PREFIX);
}

export type KeycardGuardResult =
  | { readonly ok: true; readonly card: Keycard }
  | { readonly ok: false; readonly status: 401 | 403 | 429 | 503; readonly reason: string };

export function keycardGuard(service: KeycardService | undefined): (req: FastifyRequest) => KeycardGuardResult {
  return (req) => {
    if (!service) return { ok: false, status: 503, reason: "keycard_unavailable" };
    if (!service.preAuthAllowed()) return { ok: false, status: 429, reason: "rate_limited" };
    const header = req.headers.authorization;
    if (typeof header !== "string" || !header.startsWith("Bearer ")) {
      return { ok: false, status: 401, reason: "keycard_required" };
    }
    const presented = header.slice("Bearer ".length);
    const result = service.authenticate(presented);
    if (!result.ok) {
      service.refuse(presented, result.reason);
      return { ok: false, status: 403, reason: result.reason === "invalid" ? "invalid_keycard" : `keycard_${result.reason}` };
    }
    if (!service.checkRate(result.card.id)) {
      service.noteRateLimited(result.card.id);
      return { ok: false, status: 429, reason: "rate_limited" };
    }
    service.recordServed(result.card.id);
    return { ok: true, card: result.card };
  };
}

declare module "fastify" {
  interface FastifyRequest {
    /** Set by the keycard guard for requests in the keycard domain; null elsewhere. */
    keycard: Keycard | null;
  }
}
