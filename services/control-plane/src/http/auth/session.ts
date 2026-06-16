/**
 * Operator session store (Task #9, PROJECT_BIBLE §7 tier-1 UI auth).
 *
 * Server-side sessions for the single operator: `create()` mints a 256-bit random id (the cookie
 * value); `validate()` looks it up and enforces the TTL — the id is the only secret and is never a
 * client-trusted claim. In-memory is appropriate at one-operator scale (a restart just requires a
 * re-login). The clock is injectable for deterministic TTL tests.
 */

import { randomBytes } from "node:crypto";

const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000; // 12h

export class SessionStore {
  private readonly sessions = new Map<string, number>(); // id -> expiresAt (ms epoch)

  constructor(
    private readonly ttlMs: number = DEFAULT_TTL_MS,
    private readonly now: () => number = Date.now
  ) {}

  /** Mint a new session; returns the opaque id to set as the cookie value. */
  create(): string {
    const id = randomBytes(32).toString("hex");
    this.sessions.set(id, this.now() + this.ttlMs);
    return id;
  }

  /** True iff the id is known and unexpired. Expired ids are purged on access. */
  validate(id: string): boolean {
    const expiresAt = this.sessions.get(id);
    if (expiresAt === undefined) return false;
    if (this.now() >= expiresAt) {
      this.sessions.delete(id);
      return false;
    }
    return true;
  }

  /** Invalidate a session (logout). */
  destroy(id: string): void {
    this.sessions.delete(id);
  }

  get size(): number {
    return this.sessions.size;
  }
}
