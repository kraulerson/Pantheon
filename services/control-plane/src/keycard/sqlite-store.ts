/**
 * SQLite implementation of {@link KeycardRepository} (better-sqlite3, synchronous) — same shape as
 * the registry and session stores (PROJECT_BIBLE §5: a small local store sized for one operator).
 *
 * `token_hash` is UNIQUE (a hash maps to exactly one card) and is never selected into a Keycard
 * value: {@link SqliteKeycardStore.findByTokenHash} looks a hash UP; nothing lists hashes OUT.
 * Additive schema (`CREATE TABLE IF NOT EXISTS`), as every table in this service.
 *
 * Read-side validation (audit 2026-08-25): SQLite column affinity is not a type constraint, so a
 * row edited outside the app could hold a non-array `scopes` or a TEXT counter. Scopes are parsed
 * and filtered to the closed enum (anything else ⇒ `[]`, which the service treats as NOT live), and
 * counters are coerced to numbers — the page never receives a string where it prints a count.
 */

import Database from "better-sqlite3";
import { KEYCARD_SCOPE_SET, type Keycard, type KeycardRepository, type KeycardScope } from "./types.js";

interface KeycardRow {
  id: string;
  principal: string;
  scopes: unknown;
  created_at: string;
  updated_at: string;
  expires_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
  use_count: unknown;
  deny_count: unknown;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS keycard (
  id           TEXT PRIMARY KEY,
  principal    TEXT NOT NULL,
  scopes       TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  revoked_at   TEXT,
  last_used_at TEXT,
  use_count    INTEGER NOT NULL DEFAULT 0,
  deny_count   INTEGER NOT NULL DEFAULT 0
);
`;

const COLUMNS = "id, principal, scopes, created_at, updated_at, expires_at, revoked_at, last_used_at, use_count, deny_count";
const MAX_LIST = 500;

function parseScopes(raw: unknown): KeycardScope[] {
  if (typeof raw !== "string") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((s): s is KeycardScope => typeof s === "string" && KEYCARD_SCOPE_SET.has(s));
}

function count(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

export class SqliteKeycardStore implements KeycardRepository {
  private readonly db: Database.Database;

  /** `filename` is a path or `:memory:`. */
  constructor(filename = ":memory:") {
    this.db = new Database(filename);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
  }

  private static toCard(r: KeycardRow): Keycard {
    return {
      id: r.id,
      principal: r.principal,
      scopes: parseScopes(r.scopes),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      expiresAt: r.expires_at,
      revokedAt: r.revoked_at,
      lastUsedAt: r.last_used_at,
      useCount: count(r.use_count),
      denyCount: count(r.deny_count)
    };
  }

  insert(card: Keycard, tokenHash: string): void {
    this.db
      .prepare(
        `INSERT INTO keycard (id, principal, scopes, token_hash, created_at, updated_at, expires_at, revoked_at, last_used_at, use_count, deny_count)
         VALUES (@id, @principal, @scopes, @token_hash, @created_at, @updated_at, @expires_at, @revoked_at, @last_used_at, @use_count, @deny_count)`
      )
      .run({
        id: card.id,
        principal: card.principal,
        scopes: JSON.stringify(card.scopes),
        token_hash: tokenHash,
        created_at: card.createdAt,
        updated_at: card.updatedAt,
        expires_at: card.expiresAt,
        revoked_at: card.revokedAt,
        last_used_at: card.lastUsedAt,
        use_count: card.useCount,
        deny_count: card.denyCount
      });
  }

  findByTokenHash(tokenHash: string): Keycard | undefined {
    const row = this.db.prepare(`SELECT ${COLUMNS} FROM keycard WHERE token_hash = ?`).get(tokenHash) as KeycardRow | undefined;
    return row ? SqliteKeycardStore.toCard(row) : undefined;
  }

  get(id: string): Keycard | undefined {
    const row = this.db.prepare(`SELECT ${COLUMNS} FROM keycard WHERE id = ?`).get(id) as KeycardRow | undefined;
    return row ? SqliteKeycardStore.toCard(row) : undefined;
  }

  list(): Keycard[] {
    const rows = this.db.prepare(`SELECT ${COLUMNS} FROM keycard ORDER BY created_at DESC, rowid DESC LIMIT ${MAX_LIST}`).all() as KeycardRow[];
    return rows.map((r) => SqliteKeycardStore.toCard(r));
  }

  revoke(id: string, at: string): boolean {
    if (!this.get(id)) return false;
    this.db.prepare(`UPDATE keycard SET revoked_at = COALESCE(revoked_at, ?), updated_at = ? WHERE id = ?`).run(at, at, id);
    return true;
  }

  recordUse(id: string, at: string, denied: boolean): void {
    if (denied) {
      this.db.prepare(`UPDATE keycard SET deny_count = deny_count + 1, updated_at = ? WHERE id = ?`).run(at, id);
    } else {
      this.db.prepare(`UPDATE keycard SET use_count = use_count + 1, last_used_at = ?, updated_at = ? WHERE id = ?`).run(at, at, id);
    }
  }

  /** TEST HOOK: write a raw `scopes` text as an out-of-app edit would (read-side validation tests). */
  rawUpdateScopesForTest(id: string, rawScopes: string): void {
    this.db.prepare(`UPDATE keycard SET scopes = ? WHERE id = ?`).run(rawScopes, id);
  }

  /** TEST HOOK: write raw counter values (SQLite affinity lets TEXT in) for read-side coercion tests. */
  rawUpdateCountersForTest(id: string, useCount: unknown, denyCount: unknown): void {
    this.db.prepare(`UPDATE keycard SET use_count = ?, deny_count = ? WHERE id = ?`).run(useCount, denyCount, id);
  }
}
