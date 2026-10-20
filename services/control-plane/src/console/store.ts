/**
 * Maestro Console store (plan Task 7; F2 Task 4): one row per observed Claude session (`console_session`),
 * one row per card face (`console_card`) and one append-only audit row per Submit step
 * (`console_submit_log`), better-sqlite3, same shape and conventions as `src/keycard/sqlite-store.ts`.
 * Additive schema (project ruling A): `CREATE ... IF NOT EXISTS`, and a column F2 added to an F1 table
 * arrives through `ensureColumn` (`ALTER TABLE ... ADD COLUMN` guarded by `PRAGMA table_info`), so an F1
 * database opens unchanged and the store can share the harness's SQLite file.
 *
 * R1: no column holds reply text, reasoning, tool output or a prompt. A card is its masked TL;DR, a
 * masked short title, counts and the lettered option ids of a reply question (never the option text);
 * the full text is re-read from the machine on demand, never stored. `console_submit_log.text_masked`
 * is Karl's own masked words (a ≤ 4 KiB submit, ≤ 8 KiB once masked), kept forever (R6): the table is
 * INSERT only — two `BEFORE UPDATE` / `BEFORE DELETE` triggers abort any change at the database itself (DI-6,
 * triage 46), whichever module shares the file — and the retention sweep never touches it.
 * Read-side validation: SQLite affinity is not a type constraint, so counts are coerced to numbers and
 * booleans/enums are re-checked on the way out.
 */

import { createHash, randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import type { CardFace, NeedsKind, SessionState } from "./cards.js";
import { IDEMPOTENCY_KEY_RE, SUBMIT_MAX_BYTES, type SubmitOutcome } from "./submit.js";

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
  /** The reply asked Karl a question (O1 `reply_question`); stays set once answered, so the card can say so. */
  readonly asksYou: boolean;
  /** The question's lettered option ids (≤ 12, each ≤ 8 chars) — ids only, never option text. */
  readonly options: readonly string[];
  readonly answeredAt: string | null;
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
  asks_you: unknown;
  options_json: unknown;
  answered_at: string | null;
}

export type SubmitLogRowKind = "attempted" | "result";

/**
 * A Submit's outcome (Task 6), a new session's or project's (Task 8) or a machine shell's (Task 7; ruling T11-12:
 * `opened_shell`, because tmux cannot tell a creation from a re-attach before `new-session -A` runs).
 */
export type SubmitLogOutcome = SubmitOutcome | "created_session" | "created_project" | "opened_shell" | "refused_name" | "refused_root";

/** One audit row (spec §7): an `attempted` row goes in before any dial, a `result` row after; neither is ever changed. */
export interface SubmitLogRow {
  readonly id: string;
  readonly at: string;
  readonly idempotencyKey: string;
  readonly rowKind: SubmitLogRowKind;
  /** NULL on an `attempted` row. */
  readonly outcome: SubmitLogOutcome | null;
  readonly reason: string | null;
  readonly machine: string;
  readonly tmuxSession: string | null;
  readonly paneId: string | null;
  readonly claudePid: number | null;
  readonly sessionId: string | null;
  readonly procStart: string | null;
  readonly statusAtSend: string | null;
  /** NULL for session creation and machine shells. */
  readonly cardId: string | null;
  /** The masked submitted text (a ≤ 4096-byte submit; ≤ 8192 bytes once masked), Karl's own words. */
  readonly textMasked: string | null;
  readonly paneTailHash: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** The fields every audit row may carry; `SubmitLogInsert` adds the row kind (and a result's outcome). */
export interface SubmitLogFields {
  readonly at: string;
  /** Must match `IDEMPOTENCY_KEY_RE` (a fresh `randomUUID()` for a row no Submit owns). */
  readonly idempotencyKey: string;
  readonly machine: string;
  readonly reason?: string;
  readonly tmuxSession?: string;
  readonly paneId?: string;
  readonly claudePid?: number;
  readonly sessionId?: string;
  readonly procStart?: string;
  readonly statusAtSend?: string;
  readonly cardId?: string;
  readonly textMasked?: string;
  readonly paneTailHash?: string;
}

/** An absent field is stored NULL. A `result` row carries its outcome; an `attempted` row cannot carry one. */
export type SubmitLogInsert =
  | (SubmitLogFields & { readonly rowKind: "attempted" })
  | (SubmitLogFields & { readonly rowKind: "result"; readonly outcome: SubmitLogOutcome });

interface SubmitLogDbRow {
  id: string;
  at: string;
  idempotency_key: string;
  row_kind: string;
  outcome: string | null;
  reason: string | null;
  machine: string;
  tmux_session: string | null;
  pane_id: string | null;
  claude_pid: unknown;
  session_id: string | null;
  proc_start: string | null;
  status_at_send: string | null;
  card_id: string | null;
  text_masked: string | null;
  pane_tail_hash: string | null;
  version: unknown;
  created_at: string;
  updated_at: string;
}

// Ruling T4-1b, restated (triage 47, T11-14): maskSecrets grows text by at most 12/7 ≈ 1.714× — only url_credentials
// grows that much ("://a:b@" → "://[masked]@", 7 → 12 bytes), every other pattern's match is ≥ 8 bytes, and "[masked]"
// never compounds — so a 4,096-byte submit masks to ≤ 7,022 bytes; maskSubmitText (the audit copy) only shrinks that.
const SUBMIT_LOG_TEXT_MAX_BYTES = 2 * SUBMIT_MAX_BYTES;

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

CREATE TABLE IF NOT EXISTS console_submit_log (
  id              TEXT PRIMARY KEY,
  at              TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  row_kind        TEXT NOT NULL,
  outcome         TEXT,
  reason          TEXT,
  machine         TEXT NOT NULL,
  tmux_session    TEXT,
  pane_id         TEXT,
  claude_pid      INTEGER,
  session_id      TEXT,
  proc_start      TEXT,
  status_at_send  TEXT,
  card_id         TEXT,
  text_masked     TEXT CHECK (text_masked IS NULL OR length(CAST(text_masked AS BLOB)) <= ${SUBMIT_LOG_TEXT_MAX_BYTES}),
  pane_tail_hash  TEXT,
  version         INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  CHECK ((row_kind = 'attempted' AND outcome IS NULL) OR (row_kind = 'result' AND outcome IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_console_submit_log_key_kind ON console_submit_log (idempotency_key, row_kind);
CREATE INDEX IF NOT EXISTS idx_console_submit_log_card ON console_submit_log (card_id);
CREATE TRIGGER IF NOT EXISTS console_submit_log_no_update BEFORE UPDATE ON console_submit_log
BEGIN SELECT RAISE(ABORT, 'console_submit_log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS console_submit_log_no_delete BEFORE DELETE ON console_submit_log
BEGIN SELECT RAISE(ABORT, 'console_submit_log is append-only'); END;
`;

/**
 * The columns F2 added to F1's `console_card`, applied by `ensureColumn` on every open. Ruling A: the F1
 * CREATE TABLE above stays as written, so a fresh database and a migrated F1 database take one path.
 */
const CARD_F2_COLUMNS: readonly { readonly column: string; readonly ddl: string }[] = [
  { column: "asks_you", ddl: "INTEGER NOT NULL DEFAULT 0" },
  { column: "options_json", ddl: "TEXT NOT NULL DEFAULT '[]'" },
  { column: "answered_at", ddl: "TEXT" }
];

const SESSION_COLUMNS =
  "machine, session_id, tmux_session, pane_id, claude_pid, proc_start, cwd, project_key, reachable, status, waiting_for, state, state_reason, transcript_offset, transcript_size, last_seen_at, ended_at, version, created_at, updated_at";
const CARD_COLUMNS =
  "id, session_id, turn_uuid, machine, project_key, kind, title, tldr_masked, byte_start, byte_end, tool_call_count, thinking_chars, needs_you, needs_kind, dismissed_at, purge_after, version, created_at, updated_at, asks_you, options_json, answered_at";
const SUBMIT_LOG_COLUMNS =
  "id, at, idempotency_key, row_kind, outcome, reason, machine, tmux_session, pane_id, claude_pid, session_id, proc_start, status_at_send, card_id, text_masked, pane_tail_hash, version, created_at, updated_at";
const MAX_SESSIONS = 500;
const DEFAULT_CARD_LIMIT = 200;
const DEFAULT_SUBMIT_LOG_LIMIT = 20;
const MAX_CARD_OPTIONS = 12;
const DAY_MS = 24 * 60 * 60 * 1000;

const SESSION_STATES: ReadonlySet<string> = new Set<SessionState>(["needs_you", "working", "idle", "shell", "unknown"]);
const NEEDS_KINDS: ReadonlySet<string> = new Set<NeedsKind>(["waiting", "menu_on_screen", "sentinel", "reply_question"]);
const CARD_KINDS: ReadonlySet<string> = new Set<CardFace["kind"]>(["reply", "commit_approval", "menu"]);
const SUBMIT_LOG_OUTCOMES: ReadonlySet<string> = new Set<SubmitLogOutcome>([
  "sent", "refused_target_changed", "refused_menu_visible", "failed", "unconfirmed",
  "created_session", "created_project", "opened_shell", "refused_name", "refused_root"
]);
/** An option id: 1–8 chars, a letter or digit first, then letters, digits, `.`, `_` or `-` — an id, never option text. */
const OPTION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,7}$/;

function count(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

/** `options_json` for `options`: refuses (never truncates) more than 12 ids or an id outside `OPTION_ID_RE`. */
function optionsJson(options: readonly string[]): string {
  if (options.length > MAX_CARD_OPTIONS) throw new RangeError(`console card options: at most ${MAX_CARD_OPTIONS} ids, got ${options.length}`);
  for (const o of options) {
    if (typeof o !== "string" || !OPTION_ID_RE.test(o)) throw new RangeError("console card options: each id is 1–8 chars of letters, digits, '.', '_' or '-'");
  }
  return JSON.stringify(options);
}

/** The ids in `options_json`; anything but a JSON array of ≤ 12 conforming ids reads as none (the card then shows no buttons). */
function parseOptions(raw: unknown): readonly string[] {
  if (typeof raw !== "string") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  return Array.isArray(parsed) && parsed.length <= MAX_CARD_OPTIONS && parsed.every((o): o is string => typeof o === "string" && OPTION_ID_RE.test(o))
    ? parsed
    : [];
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
    for (const c of CARD_F2_COLUMNS) this.ensureColumn("console_card", c.column, c.ddl);
  }

  /**
   * Adds `column` to `table` unless `PRAGMA table_info` already lists it (ruling A: additive, never a
   * rebuild; idempotent, so a second open is a no-op). Names and DDL are module constants, never input.
   */
  private ensureColumn(table: string, column: string, ddl: string): void {
    const present = (this.db.pragma(`table_info(${table})`) as { name: string }[]).some((c) => c.name === column);
    if (!present) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
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
      asksYou: count(r.asks_you) === 1,
      options: parseOptions(r.options_json),
      answeredAt: r.answered_at,
      dismissedAt: r.dismissed_at,
      purgeAfter: r.purge_after,
      version: count(r.version),
      updatedAt: r.updated_at
    };
  }

  private static toSubmitLog(r: SubmitLogDbRow): SubmitLogRow {
    return {
      id: r.id,
      at: r.at,
      idempotencyKey: r.idempotency_key,
      // Both vocabularies are enforced on the way in (the table's CHECK for row_kind, SUBMIT_LOG_OUTCOMES for
      // outcome) and no row is ever rewritten, so an audit value comes back as stored rather than coerced.
      rowKind: r.row_kind as SubmitLogRowKind,
      outcome: r.outcome as SubmitLogOutcome | null,
      reason: r.reason,
      machine: r.machine,
      tmuxSession: r.tmux_session,
      paneId: r.pane_id,
      claudePid: r.claude_pid === null ? null : count(r.claude_pid),
      sessionId: r.session_id,
      procStart: r.proc_start,
      statusAtSend: r.status_at_send,
      cardId: r.card_id,
      textMasked: r.text_masked,
      paneTailHash: r.pane_tail_hash,
      version: count(r.version),
      createdAt: r.created_at,
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
   * One row per `(session_id, turn_uuid)`; a repeat keeps the row, refreshes the face and needs
   * (`asksYou` and `options` included: omitted means false and none), and bumps `version`.
   * `dismissed_at` and `answered_at` are never touched here. `purge_after = now + retentionDays`.
   * Throws `RangeError`, writing nothing, on more than 12 options or an id outside `OPTION_ID_RE`.
   */
  upsertCard(
    face: CardFace,
    needs: { readonly needsYou: boolean; readonly needsKind: NeedsKind | null; readonly asksYou?: boolean; readonly options?: readonly string[] },
    retentionDays: number,
    now: string
  ): ConsoleCardRow {
    const id = cardId(face.sessionId, face.turnUuid);
    const purgeAfter = new Date(new Date(now).getTime() + retentionDays * DAY_MS).toISOString();
    const options = optionsJson(needs.options ?? []);
    this.db
      .prepare(
        `INSERT INTO console_card (id, session_id, turn_uuid, machine, project_key, kind, title, tldr_masked, byte_start, byte_end, tool_call_count, thinking_chars, needs_you, needs_kind, dismissed_at, purge_after, version, created_at, updated_at, asks_you, options_json, answered_at)
         VALUES (@id, @session_id, @turn_uuid, @machine, @project_key, @kind, @title, @tldr_masked, @byte_start, @byte_end, @tool_call_count, @thinking_chars, @needs_you, @needs_kind, NULL, @purge_after, 1, @created_at, @now, @asks_you, @options_json, NULL)
         ON CONFLICT (session_id, turn_uuid) DO UPDATE SET
           machine = excluded.machine, project_key = excluded.project_key, kind = excluded.kind,
           title = excluded.title, tldr_masked = excluded.tldr_masked, byte_start = excluded.byte_start,
           byte_end = excluded.byte_end, tool_call_count = excluded.tool_call_count,
           thinking_chars = excluded.thinking_chars, needs_you = excluded.needs_you,
           needs_kind = excluded.needs_kind, asks_you = excluded.asks_you, options_json = excluded.options_json,
           purge_after = excluded.purge_after, version = console_card.version + 1, updated_at = excluded.updated_at`
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
        asks_you: needs.asksYou === true ? 1 : 0,
        options_json: options,
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

  /**
   * Sets one card's needs-you flags and kind, replaces its options when `options` is given (left as stored
   * when omitted, so a stronger signal does not lose a reply question's ids), bumps `version` and returns
   * the updated row (undefined for an unknown id). Throws `RangeError`, writing nothing, on bad options.
   */
  setCardNeeds(
    id: string,
    needs: { readonly needsYou: boolean; readonly needsKind: NeedsKind | null; readonly kind: CardFace["kind"]; readonly options?: readonly string[] },
    now: string
  ): ConsoleCardRow | undefined {
    const options = needs.options === undefined ? null : optionsJson(needs.options);
    this.db
      .prepare(
        `UPDATE console_card SET needs_you = ?, needs_kind = ?, kind = ?, options_json = COALESCE(?, options_json), version = version + 1, updated_at = ?
         WHERE id = ?`
      )
      .run(needs.needsYou ? 1 : 0, needs.needsKind, needs.kind, options, now, id);
    return this.getCard(id);
  }

  /**
   * Karl's Submit reached the session: sets `answered_at` and bumps `version`; `needs_you` is cleared only for a
   * `reply_question` (ruling T11-19): a sentinel or waiting flag is the session's own state and leaves when its
   * signal does, while the stored `answered_at` keeps the poller's sticky return away. `needs_kind` stays, so the
   * card can say which ask was answered. Undefined for an unknown id.
   */
  markAnswered(id: string, now: string): ConsoleCardRow | undefined {
    this.db
      .prepare(
        `UPDATE console_card SET answered_at = ?, needs_you = CASE WHEN needs_kind = 'reply_question' THEN 0 ELSE needs_you END,
           version = version + 1, updated_at = ?
         WHERE id = ?`
      )
      .run(now, now, id);
    return this.getCard(id);
  }

  /**
   * Sets `dismissed_at` and bumps `version`. `needs_you` is cleared only for a `reply_question` card: a
   * waiting / menu / sentinel signal is the session's own state, which dismissing a card does not change
   * (the poller would raise it again). Undefined for an unknown id.
   */
  markDismissed(id: string, now: string): ConsoleCardRow | undefined {
    this.db
      .prepare(
        `UPDATE console_card SET dismissed_at = ?, needs_you = CASE WHEN needs_kind = 'reply_question' THEN 0 ELSE needs_you END,
           version = version + 1, updated_at = ?
         WHERE id = ?`
      )
      .run(now, now, id);
    return this.getCard(id);
  }

  /**
   * Deletes cards whose `purge_after` is before `now`; sessions are never purged here, and the submit log
   * never (R6: its rows outlive their card). `now` is normalised to UTC ISO first (throws on a malformed
   * value, as `upsertCard` does), because `purge_after` is compared as text.
   */
  purgeExpired(now: string): number {
    const iso = new Date(now).toISOString();
    return this.db.prepare(`DELETE FROM console_card WHERE purge_after < ?`).run(iso).changes;
  }

  /**
   * Appends one audit row (R6: INSERT only — this module has no statement that changes or removes a row of
   * `console_submit_log`). `id` is a fresh uuid; `created_at = updated_at = at`. Throws `RangeError`,
   * writing nothing, on a key outside {@link IDEMPOTENCY_KEY_RE} or an outcome outside the vocabulary; the
   * table itself refuses `text_masked` over `SUBMIT_LOG_TEXT_MAX_BYTES`, a `row_kind` / `outcome` mismatch
   * and a second row of one kind for one key (unique `(idempotency_key, row_kind)`, ruling T4-3).
   */
  appendSubmitLog(row: SubmitLogInsert): SubmitLogRow {
    if (!IDEMPOTENCY_KEY_RE.test(row.idempotencyKey)) throw new RangeError("submit log: idempotency key must be a lowercase hyphenated uuid");
    if (row.rowKind === "result" && !SUBMIT_LOG_OUTCOMES.has(row.outcome)) throw new RangeError("submit log: unknown outcome");
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO console_submit_log (${SUBMIT_LOG_COLUMNS})
         VALUES (@id, @at, @idempotency_key, @row_kind, @outcome, @reason, @machine, @tmux_session, @pane_id, @claude_pid, @session_id, @proc_start, @status_at_send, @card_id, @text_masked, @pane_tail_hash, 1, @at, @at)`
      )
      .run({
        id,
        at: row.at,
        idempotency_key: row.idempotencyKey,
        row_kind: row.rowKind,
        outcome: row.rowKind === "result" ? row.outcome : null,
        reason: row.reason ?? null,
        machine: row.machine,
        tmux_session: row.tmuxSession ?? null,
        pane_id: row.paneId ?? null,
        claude_pid: row.claudePid ?? null,
        session_id: row.sessionId ?? null,
        proc_start: row.procStart ?? null,
        status_at_send: row.statusAtSend ?? null,
        card_id: row.cardId ?? null,
        text_masked: row.textMasked ?? null,
        pane_tail_hash: row.paneTailHash ?? null
      });
    const stored = this.getSubmitLogRow(id);
    if (!stored) throw new Error("console submit log row vanished after insert");
    return stored;
  }

  /** The one `result` row stored for `idempotencyKey` (the unique index allows one), or undefined while only an `attempted` row exists. */
  findSubmitResult(idempotencyKey: string): SubmitLogRow | undefined {
    const row = this.db
      .prepare(`SELECT ${SUBMIT_LOG_COLUMNS} FROM console_submit_log WHERE idempotency_key = ? AND row_kind = 'result'`)
      .get(idempotencyKey) as SubmitLogDbRow | undefined;
    return row ? SqliteConsoleStore.toSubmitLog(row) : undefined;
  }

  /** A card's audit rows, newest first (`at`, then insertion order). A non-positive or non-integer `limit` throws `RangeError`. */
  listSubmitLog(cardId: string, limit = DEFAULT_SUBMIT_LOG_LIMIT): SubmitLogRow[] {
    if (!Number.isInteger(limit) || limit <= 0) throw new RangeError(`listSubmitLog limit must be a positive integer, got ${String(limit)}`);
    const rows = this.db
      .prepare(`SELECT ${SUBMIT_LOG_COLUMNS} FROM console_submit_log WHERE card_id = ? ORDER BY at DESC, rowid DESC LIMIT ?`)
      .all(cardId, limit) as SubmitLogDbRow[];
    return rows.map((r) => SqliteConsoleStore.toSubmitLog(r));
  }

  private getSubmitLogRow(id: string): SubmitLogRow | undefined {
    const row = this.db.prepare(`SELECT ${SUBMIT_LOG_COLUMNS} FROM console_submit_log WHERE id = ?`).get(id) as SubmitLogDbRow | undefined;
    return row ? SqliteConsoleStore.toSubmitLog(row) : undefined;
  }
}
