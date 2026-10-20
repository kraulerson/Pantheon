/**
 * Passphrase step-up window (F2 Task 3; spec R4; the first D6 consumer; ADR-0010). Every action that types into a
 * live Claude Code session — Submit, New Session — must find the operator's SESSION elevated: a cookie session that
 * re-entered the operator passphrase within the last {@link STEP_UP_TTL_MS}. The window is keyed by the session
 * id, so two tabs on one login share it (Review Focus 4) and a second login does not; it lives in memory, like the
 * session store, and an entry past its `until` reads as closed and is dropped on that read.
 *
 * `requireElevated` is the one check the typing routes call: a bearer-only caller (no accepted cookie session) is
 * `step_up_cookie_only` — the admin token alone never types — and an accepted session without an open window is
 * `step_up_required`. The routes that open and close the window live in `routes/console.ts`.
 */

import { createHash } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { parseSessionCookie } from "./operator-auth.js";
import type { SessionStore } from "./session.js";

/** How long one passphrase entry keeps a session elevated (R4: 15 minutes). */
export const STEP_UP_TTL_MS = 900_000;

export class StepUpWindow {
  /** session id → elevated until (ms epoch). */
  private readonly until = new Map<string, number>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs: number = STEP_UP_TTL_MS
  ) {}

  /** Open (or re-arm) the window for a session; returns the ISO instant it closes. */
  elevate(sessionId: string): string {
    const until = this.now() + this.ttlMs;
    this.until.set(sessionId, until);
    return new Date(until).toISOString();
  }

  /** The ISO instant the session's window closes, or undefined when closed. An entry past its instant is dropped here. */
  elevatedUntil(sessionId: string): string | undefined {
    const until = this.until.get(sessionId);
    if (until === undefined) return undefined;
    if (this.now() >= until) {
      this.until.delete(sessionId);
      return undefined;
    }
    return new Date(until).toISOString();
  }

  isElevated(sessionId: string): boolean {
    return this.elevatedUntil(sessionId) !== undefined;
  }

  /** Close the window (ruling P-1: the page's lock control); an unknown id is a no-op. */
  revoke(sessionId: string): void {
    this.until.delete(sessionId);
  }
}

/**
 * The ONE derivation of "the request's accepted operator session": the session cookie's non-empty value, known to
 * the store and unexpired. A bearer-only request and an unknown, empty, expired or logged-out cookie all read as none.
 */
export function cookieSessionId(req: FastifyRequest, sessions: SessionStore): string | undefined {
  const sid = parseSessionCookie(req.headers.cookie);
  return sid !== undefined && sid !== "" && sessions.validate(sid) ? sid : undefined;
}

export type ElevationResult =
  | { readonly ok: true; readonly sessionId: string }
  | { readonly ok: false; readonly status: 403; readonly reason: "step_up_required" | "step_up_cookie_only" };

/** The typing routes' check: an accepted cookie session with an open window passes with its id; anything else is a 403 reason. */
export function requireElevated(req: FastifyRequest, sessions: SessionStore, window: StepUpWindow): ElevationResult {
  const sessionId = cookieSessionId(req, sessions);
  if (sessionId === undefined) return { ok: false, status: 403, reason: "step_up_cookie_only" };
  if (!window.isElevated(sessionId)) return { ok: false, status: 403, reason: "step_up_required" };
  return { ok: true, sessionId };
}

/** What a log line carries for a session: the first 12 hex of its SHA-256 — never the id, which is the cookie secret. */
export function sessionIdHash(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex").slice(0, 12);
}
