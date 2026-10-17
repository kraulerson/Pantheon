/**
 * Maestro Console store (plan Task 7): one row per observed Claude session (`console_session`) and one
 * row per card face (`console_card`), better-sqlite3, same shape and conventions as
 * `src/keycard/sqlite-store.ts`. Additive schema (`CREATE ... IF NOT EXISTS`, project ruling A), so the
 * store can share the harness's SQLite file.
 *
 * R1: no column holds reply text, reasoning, tool output or a prompt. A card is its masked TL;DR, a
 * masked short title and counts; the full text is re-read from the machine on demand, never stored.
 * Read-side validation: SQLite affinity is not a type constraint, so counts are coerced to numbers and
 * booleans/enums are re-checked on the way out.
 */

import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import type { CardFace, NeedsKind, SessionState } from "./cards.js";

export interface ConsoleSessionRow {
  readonly machine: string;
  readonly tmuxSession: string;
  readonly paneId: string;
  readonly claudePid: number;
  readonly sessionId: string;
  readonly procStart: string;
  readonly cwd: string;
  readonly projectKey: string;
  /** The session sits in a probed tmux pane the console may target (cards.ts `projectKeyFor`; false for `sh-*`). */
  readonly reachable: boolean;
  readonly status: string;
  readonly waitingFor: string | null;
  readonly state: SessionState;
  readonly stateReason: string | null;
  readonly transcriptOffset: number;
  /** Transcript file size reported by the probe at the last poll (poller: "no new bytes since the previous poll"). */
  readonly transcriptSize: number;
  readonly lastSeenAt: string;
  readonly endedAt: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ConsoleCardRow extends CardFace {
  readonly id: string;
  readonly needsYou: boolean;
  readonly needsKind: NeedsKind | null;
  readonly dismissedAt: string | null;
  readonly purgeAfter: string;
  readonly version: number;
  readonly updatedAt: string;
}

interface SessionDbRow {
  machine: string;
  tmux_session: string;
  pane_id: string;
  claude_pid: unknown;
  session_id: string;
  proc_start: string;
  cwd: string;
  project_key: string;
  reachable: unknown;
  status: string;
  waiting_for: string | null;
  state: string;
  state_reason: string | null;
  transcript_offset: unknown;
  transcript_size: unknown;
  last_seen_at: string;
  ended_at: string | null;
  version: unknown;
  created_at: string;
  updated_at: string;
}

interface CardDbRow {
  id: string;
  session_id: string;
  turn_uuid: string;
  machine: string;
  project_key: string;
  kind: string;
  title: string;
  tldr_masked: string;
  byte_start: unknown;
  byte_end: unknown;
  tool_call_count: unknown;
  thinking_chars: unknown;
  needs_you: unknown;
  needs_kind: string | null;
  dismissed_at: string | null;
  purge_after: string;
  version: unknown;
  created_at: string;
  updated_at: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS console_session (
  machine           TEXT NOT NULL,
  session_id        TEXT NOT NULL,
  tmux_session      TEXT NOT NULL,
  pane_id           TEXT NOT NULL,
  claude_pid        INTEGER NOT NULL,
  proc_start        TEXT NOT NULL,
  cwd               TEXT NOT NULL,
  project_key       TEXT NOT NULL,
  reachable         INTEGER NOT NULL DEFAULT 1,
  status            TEXT NOT NULL,
  waiting_for       TEXT,
  state             TEXT NOT NULL,
  state_reason      TEXT,
  transcript_offset INTEGER NOT NULL DEFAULT 0,
  transcript_size   INTEGER NOT NULL DEFAULT 0,
  last_seen_at      TEXT NOT NULL,
  ended_at          TEXT,
  version           INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  PRIMARY KEY (machine, session_id)
);
CREATE INDEX IF NOT EXISTS idx_console_session_machine_project ON console_session (machine, project_key);

CREATE TABLE IF NOT EXISTS console_card (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL,
  turn_uuid       TEXT NOT NULL,
  machine         TEXT NOT NULL,
  project_key     TEXT NOT NULL,
  kind            TEXT NOT NULL,
  title           TEXT NOT NULL CHECK (length(title) <= 120),
  tldr_masked     TEXT NOT NULL CHECK (length(tldr_masked) <= 1024),
  byte_start      INTEGER NOT NULL,
  byte_end        INTEGER NOT NULL,
  tool_call_count INTEGER NOT NULL DEFAULT 0,
  thinking_chars  INTEGER NOT NULL DEFAULT 0,
  needs_you       INTEGER NOT NULL DEFAULT 0,
  needs_kind      TEXT,
  dismissed_at    TEXT,
  purge_after     TEXT NOT NULL,
  version         INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_console_card_turn ON console_card (session_id, turn_uuid);
CREATE INDEX IF NOT EXISTS idx_console_card_machine_project ON console_card (machine, project_key);
CREATE INDEX IF NOT EXISTS idx_console_card_purge ON console_card (purge_after);
CREATE INDEX IF NOT EXISTS idx_console_card_created ON console_card (created_at);
`;

const SESSION_COLUMNS =
  "machine, session_id, tmux_session, pane_id, claude_pid, proc_start, cwd, project_key, reachable, status, waiting_for, state, state_reason, transcript_offset, transcript_size, last_seen_at, ended_at, version, created_at, updated_at";
const CARD_COLUMNS =
  "id, session_id, turn_uuid, machine, project_key, kind, title, tldr_masked, byte_start, byte_end, tool_call_count, thinking_chars, needs_you, needs_kind, dismissed_at, purge_after, version, created_at, updated_at";
const MAX_SESSIONS = 500;
const DEFAULT_CARD_LIMIT = 200;
const DAY_MS = 24 * 60 * 60 * 1000;

const SESSION_STATES: ReadonlySet<string> = new Set<SessionState>(["needs_you", "working", "idle", "shell", "unknown"]);
const NEEDS_KINDS: ReadonlySet<string> = new Set<NeedsKind>(["waiting", "menu_on_screen", "sentinel"]);
const CARD_KINDS: ReadonlySet<string> = new Set<CardFace["kind"]>(["reply", "commit_approval", "menu"]);

function count(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

/**
 * Deviation from the brief (controller ruling, Task 7 fix 7): the brief hashes `session_id + turn_uuid`;
 * a "\n" separator is added so ("ab", "c") and ("a", "bc") cannot collide.
 */
const cardId = (sessionId: string, turnUuid: string): string =>
  createHash("sha256").update(`${sessionId}\n${turnUuid}`).digest("hex").slice(0, 32);

export class SqliteConsoleStore {
  private readonly db: Database.Database;

  /** `filename` is a path or `:memory:`. */
  constructor(filename = ":memory:") {
    this.db = new Database(filename);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
  }

  private static toSession(r: SessionDbRow): ConsoleSessionRow {
    return {
      machine: r.machine,
      tmuxSession: r.tmux_session,
      paneId: r.pane_id,
      claudePid: count(r.claude_pid),
      sessionId: r.session_id,
      procStart: r.proc_start,
      cwd: r.cwd,
      projectKey: r.project_key,
      // Only a literal 1 is reachable: an odd stored value never makes a session targetable.
      reachable: count(r.reachable) === 1,
      status: r.status,
      waitingFor: r.waiting_for,
      state: SESSION_STATES.has(r.state) ? (r.state as SessionState) : "unknown",
      stateReason: r.state_reason,
      transcriptOffset: count(r.transcript_offset),
      transcriptSize: count(r.transcript_size),
      lastSeenAt: r.last_seen_at,
      endedAt: r.ended_at,
      version: count(r.version),
      createdAt: r.created_at,
      updatedAt: r.updated_at
    };
  }

  private static toCard(r: CardDbRow): ConsoleCardRow {
    return {
      id: r.id,
      turnUuid: r.turn_uuid,
      sessionId: r.session_id,
      machine: r.machine,
      projectKey: r.project_key,
      createdAt: r.created_at,
      kind: CARD_KINDS.has(r.kind) ? (r.kind as CardFace["kind"]) : "reply",
      title: r.title,
      tldrMasked: r.tldr_masked,
      byteStart: count(r.byte_start),
      byteEnd: count(r.byte_end),
      toolCallCount: count(r.tool_call_count),
      thinkingChars: count(r.thinking_chars),
      needsYou: count(r.needs_you) === 1,
      needsKind: r.needs_kind !== null && NEEDS_KINDS.has(r.needs_kind) ? (r.needs_kind as NeedsKind) : null,
      dismissedAt: r.dismissed_at,
      purgeAfter: r.purge_after,
      version: count(r.version),
      updatedAt: r.updated_at
    };
  }

  close(): void {
    this.db.close();
  }

  /**
   * Insert or update by `(machine, session_id)`; `created_at` is kept, `version` bumps on update.
   * `ended_at` is overwritten with the supplied value, so an upsert after {@link markEnded} with
   * `endedAt: null` resurrects the session: the poller must upsert only sessions it currently sees alive.
   */
  upsertSession(row: Omit<ConsoleSessionRow, "version" | "createdAt" | "updatedAt">, now: string): void {
    this.db
      .prepare(
        `INSERT INTO console_session (machine, session_id, tmux_session, pane_id, claude_pid, proc_start, cwd, project_key, reachable, status, waiting_for, state, state_reason, transcript_offset, transcript_size, last_seen_at, ended_at, version, created_at, updated_at)
         VALUES (@machine, @session_id, @tmux_session, @pane_id, @claude_pid, @proc_start, @cwd, @project_key, @reachable, @status, @waiting_for, @state, @state_reason, @transcript_offset, @transcript_size, @last_seen_at, @ended_at, 1, @now, @now)
         ON CONFLICT (machine, session_id) DO UPDATE SET
           tmux_session = excluded.tmux_session, pane_id = excluded.pane_id, claude_pid = excluded.claude_pid,
           proc_start = excluded.proc_start, cwd = excluded.cwd, project_key = excluded.project_key,
           reachable = excluded.reachable, status = excluded.status, waiting_for = excluded.waiting_for, state = excluded.state,
           state_reason = excluded.state_reason, transcript_offset = excluded.transcript_offset,
           transcript_size = excluded.transcript_size, last_seen_at = excluded.last_seen_at,
           ended_at = excluded.ended_at, version = console_session.version + 1, updated_at = excluded.updated_at`
      )
      .run({
        machine: row.machine,
        session_id: row.sessionId,
        tmux_session: row.tmuxSession,
        pane_id: row.paneId,
        claude_pid: row.claudePid,
        proc_start: row.procStart,
        cwd: row.cwd,
        project_key: row.projectKey,
        reachable: row.reachable ? 1 : 0,
        status: row.status,
        waiting_for: row.waitingFor,
        state: row.state,
        state_reason: row.stateReason,
        transcript_offset: row.transcriptOffset,
        transcript_size: row.transcriptSize,
        last_seen_at: row.lastSeenAt,
        ended_at: row.endedAt,
        now
      });
  }

  listSessions(machine?: string): ConsoleSessionRow[] {
    const where = machine !== undefined ? "WHERE machine = ?" : "";
    const args = machine !== undefined ? [machine] : [];
    const rows = this.db
      .prepare(`SELECT ${SESSION_COLUMNS} FROM console_session ${where} ORDER BY last_seen_at DESC, rowid DESC LIMIT ?`)
      .all(...args, MAX_SESSIONS) as SessionDbRow[];
    return rows.map((r) => SqliteConsoleStore.toSession(r));
  }

  /** Sets `ended_at`; the session's cards stay until they expire. A no-op for an unknown session. */
  markEnded(machine: string, sessionId: string, now: string): void {
    this.db
      .prepare(`UPDATE console_session SET ended_at = ?, version = version + 1, updated_at = ? WHERE machine = ? AND session_id = ?`)
      .run(now, now, machine, sessionId);
  }

  /**
   * One row per `(session_id, turn_uuid)`; a repeat keeps the row, refreshes the face and needs, and
   * bumps `version`. `dismissed_at` is never touched here. `purge_after = now + retentionDays`.
   */
  upsertCard(
    face: CardFace,
    needs: { readonly needsYou: boolean; readonly needsKind: NeedsKind | null },
    retentionDays: number,
    now: string
  ): ConsoleCardRow {
    const id = cardId(face.sessionId, face.turnUuid);
    const purgeAfter = new Date(new Date(now).getTime() + retentionDays * DAY_MS).toISOString();
    this.db
      .prepare(
        `INSERT INTO console_card (id, session_id, turn_uuid, machine, project_key, kind, title, tldr_masked, byte_start, byte_end, tool_call_count, thinking_chars, needs_you, needs_kind, dismissed_at, purge_after, version, created_at, updated_at)
         VALUES (@id, @session_id, @turn_uuid, @machine, @project_key, @kind, @title, @tldr_masked, @byte_start, @byte_end, @tool_call_count, @thinking_chars, @needs_you, @needs_kind, NULL, @purge_after, 1, @created_at, @now)
         ON CONFLICT (session_id, turn_uuid) DO UPDATE SET
           machine = excluded.machine, project_key = excluded.project_key, kind = excluded.kind,
           title = excluded.title, tldr_masked = excluded.tldr_masked, byte_start = excluded.byte_start,
           byte_end = excluded.byte_end, tool_call_count = excluded.tool_call_count,
           thinking_chars = excluded.thinking_chars, needs_you = excluded.needs_you,
           needs_kind = excluded.needs_kind, purge_after = excluded.purge_after,
           version = console_card.version + 1, updated_at = excluded.updated_at`
      )
      .run({
        id,
        session_id: face.sessionId,
        turn_uuid: face.turnUuid,
        machine: face.machine,
        project_key: face.projectKey,
        kind: face.kind,
        title: face.title,
        tldr_masked: face.tldrMasked,
        byte_start: face.byteStart,
        byte_end: face.byteEnd,
        tool_call_count: face.toolCallCount,
        thinking_chars: face.thinkingChars,
        needs_you: needs.needsYou ? 1 : 0,
        needs_kind: needs.needsKind,
        purge_after: purgeAfter,
        created_at: face.createdAt,
        now
      });
    const row = this.getCard(id);
    if (!row) throw new Error("console card vanished after upsert");
    return row;
  }

  /** Newest first (by the turn's `created_at`). A non-positive or non-integer `limit` throws `RangeError`. */
  listCards(
    filter: { readonly machine?: string; readonly projectKey?: string; readonly needsYouOnly?: boolean },
    limit = DEFAULT_CARD_LIMIT
  ): ConsoleCardRow[] {
    const clauses: string[] = [];
    const args: (string | number)[] = [];
    if (filter.machine !== undefined) {
      clauses.push("machine = ?");
      args.push(filter.machine);
    }
    if (filter.projectKey !== undefined) {
      clauses.push("project_key = ?");
      args.push(filter.projectKey);
    }
    if (filter.needsYouOnly === true) clauses.push("needs_you = 1");
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    if (!Number.isInteger(limit) || limit <= 0) throw new RangeError(`listCards limit must be a positive integer, got ${String(limit)}`);
    const rows = this.db
      .prepare(`SELECT ${CARD_COLUMNS} FROM console_card ${where} ORDER BY created_at DESC, rowid DESC LIMIT ?`)
      .all(...args, limit) as CardDbRow[];
    return rows.map((r) => SqliteConsoleStore.toCard(r));
  }

  getCard(id: string): ConsoleCardRow | undefined {
    const row = this.db.prepare(`SELECT ${CARD_COLUMNS} FROM console_card WHERE id = ?`).get(id) as CardDbRow | undefined;
    return row ? SqliteConsoleStore.toCard(row) : undefined;
  }

  /**
   * Clears the needs-you flags on every card of one session that still carries them, and resets their
   * `kind` to "reply" (a menu / commit-approval kind only holds while the signal does); returns the number
   * of cards changed. Rows without the flag are not touched (no version churn).
   */
  clearNeedsYou(machine: string, sessionId: string, now: string): number {
    return this.db
      .prepare(
        `UPDATE console_card SET needs_you = 0, needs_kind = NULL, kind = 'reply', version = version + 1, updated_at = ?
         WHERE machine = ? AND session_id = ? AND needs_you = 1`
      )
      .run(now, machine, sessionId).changes;
  }

  /** The session's newest card (by the turn's `created_at`, as `listCards` orders), or undefined. */
  latestCard(machine: string, sessionId: string): ConsoleCardRow | undefined {
    const row = this.db
      .prepare(`SELECT ${CARD_COLUMNS} FROM console_card WHERE machine = ? AND session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`)
      .get(machine, sessionId) as CardDbRow | undefined;
    return row ? SqliteConsoleStore.toCard(row) : undefined;
  }

  /** Sets one card's needs-you flags and kind and bumps `version`; returns the updated row (undefined for an unknown id). */
  setCardNeeds(
    id: string,
    needs: { readonly needsYou: boolean; readonly needsKind: NeedsKind | null; readonly kind: CardFace["kind"] },
    now: string
  ): ConsoleCardRow | undefined {
    this.db
      .prepare(`UPDATE console_card SET needs_you = ?, needs_kind = ?, kind = ?, version = version + 1, updated_at = ? WHERE id = ?`)
      .run(needs.needsYou ? 1 : 0, needs.needsKind, needs.kind, now, id);
    return this.getCard(id);
  }

  /**
   * Deletes cards whose `purge_after` is before `now`; sessions are never purged here. `now` is
   * normalised to UTC ISO first (throws on a malformed value, as `upsertCard` does), because
   * `purge_after` is compared as text.
   */
  purgeExpired(now: string): number {
    const iso = new Date(now).toISOString();
    return this.db.prepare(`DELETE FROM console_card WHERE purge_after < ?`).run(iso).changes;
  }
}
