/**
 * SQLite implementation of {@link SessionStore} (better-sqlite3, synchronous) — mirrors the
 * registry repository style (PROJECT_BIBLE §5: a small local store sized for one operator).
 *
 * Monotonic taint (#14c / D5): `markTaint` issues only `taint_flag = 1`; there is no SQL path
 * anywhere in this file that sets it back to 0, and {@link getOrCreate} never rewrites an
 * existing row (so re-opening an id can neither rebind nor clear taint).
 */

import Database from "better-sqlite3";
import type { Session, SessionBinding, SessionStore } from "./types.js";

interface SessionRow {
  id: string;
  identity_id: string | null;
  backend_id: string;
  taint_flag: number;
  created_at: string;
  closed_at: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS session (
  id          TEXT PRIMARY KEY,
  identity_id TEXT,
  backend_id  TEXT NOT NULL,
  taint_flag  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  closed_at   TEXT
);
`;

export class SqliteSessionStore implements SessionStore {
  private readonly db: Database.Database;

  constructor(filename = ":memory:") {
    this.db = new Database(filename);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
  }

  private static toSession(r: SessionRow): Session {
    return {
      id: r.id,
      identityId: r.identity_id,
      backendId: r.backend_id,
      taintFlag: r.taint_flag === 1,
      createdAt: r.created_at,
      closedAt: r.closed_at
    };
  }

  getOrCreate(id: string, binding: SessionBinding): Session {
    const existing = this.get(id);
    if (existing) return existing; // never rebind or clear an existing session.
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO session (id, identity_id, backend_id, taint_flag, created_at, closed_at)
         VALUES (@id, @identity_id, @backend_id, 0, @created_at, NULL)`
      )
      .run({ id, identity_id: binding.identityId, backend_id: binding.backendId, created_at: now });
    return this.get(id)!;
  }

  get(id: string): Session | undefined {
    const r = this.db.prepare("SELECT * FROM session WHERE id = ?").get(id) as SessionRow | undefined;
    return r ? SqliteSessionStore.toSession(r) : undefined;
  }

  /** Set taint true. Monotonic — only ever sets 1, never 0; no-op on an unknown session. */
  /** Newest first, at most 500; metadata only — the entity carries no content. */
  list(): Session[] {
    const rows = this.db
      .prepare(`SELECT id, identity_id, backend_id, taint_flag, created_at, closed_at FROM session ORDER BY created_at DESC, rowid DESC LIMIT 500`)
      .all() as SessionRow[];
    return rows.map((r) => SqliteSessionStore.toSession(r));
  }

  /** Set taint true. Monotonic — only ever sets 1, never 0; no-op on an unknown session. */
  markTaint(id: string): void {
    this.db.prepare("UPDATE session SET taint_flag = 1 WHERE id = ?").run(id);
  }

  close(): void {
    this.db.close();
  }
}
