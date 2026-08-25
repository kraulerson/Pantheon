/**
 * Session entity (PROJECT_BIBLE §5 data model).
 *
 * A session is opened at New-Session time, bound to one identity (nullable for a bare
 * session) on one backend. Its `taintFlag` is MONOTONIC (#14c / D5 sticky): once true it
 * never reverts — a clean context means a brand-new session, not a cleared flag.
 */

export interface Session {
  readonly id: string;
  /** Resolved identity for this session; `null` for a bare (no-identity) session. */
  readonly identityId: string | null;
  /** The identity's immutable registry-bound backend (#14a). */
  readonly backendId: string;
  /** Monotonic taint-by-presence flag — once true, never false again (D5). */
  readonly taintFlag: boolean;
  readonly createdAt: string;
  /** Set when the session is closed; `null` while open. */
  readonly closedAt: string | null;
}

/** Binding supplied to {@link SessionStore.getOrCreate} when a session first opens. */
export interface SessionBinding {
  readonly identityId: string | null;
  readonly backendId: string;
}

/**
 * Session persistence boundary. There is deliberately NO clear/untaint/reset method:
 * the monotonic-taint invariant is enforced structurally (markTaint only sets true).
 */
export interface SessionStore {
  getOrCreate(id: string, binding: SessionBinding): Session;
  get(id: string): Session | undefined;
  markTaint(id: string): void;
  /** Newest first; metadata only (this entity never carries content). Bounded. */
  list(): Session[];
  close(): void;
}
