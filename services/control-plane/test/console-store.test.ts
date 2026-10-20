import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import type { CardFace } from "../src/console/cards.js";
import { SqliteConsoleStore, type ConsoleSessionRow, type SubmitLogFields, type SubmitLogInsert, type SubmitLogOutcome } from "../src/console/store.js";
import { SUBMIT_MAX_BYTES } from "../src/console/submit.js";

const T0 = "2026-10-16T10:00:00.000Z";
const T1 = "2026-10-16T11:00:00.000Z";
const T2 = "2026-10-16T12:00:00.000Z";

const face = (over: Partial<CardFace> = {}): CardFace => ({
  turnUuid: "turn-1",
  sessionId: "sess-1",
  machine: "Mac-Mini",
  projectKey: "pantheon-harness",
  createdAt: T0,
  kind: "reply",
  title: "Done",
  tldrMasked: "TL;DR: all good",
  byteStart: 0,
  byteEnd: 100,
  toolCallCount: 2,
  thinkingChars: 40,
  ...over
});

const session = (over: Partial<Omit<ConsoleSessionRow, "version" | "createdAt" | "updatedAt">> = {}): Omit<ConsoleSessionRow, "version" | "createdAt" | "updatedAt"> => ({
  machine: "Mac-Mini",
  tmuxSession: "work",
  paneId: "%1",
  claudePid: 4242,
  sessionId: "sess-1",
  procStart: "Fri Oct 16 09:00:00 2026",
  cwd: "/Users/karl/proj",
  projectKey: "proj",
  reachable: true,
  status: "busy",
  waitingFor: null,
  state: "working",
  stateReason: null,
  transcriptOffset: 0,
  transcriptSize: 0,
  lastSeenAt: T0,
  endedAt: null,
  ...over
});

const NO_NEEDS = { needsYou: false, needsKind: null } as const;
const ASKS = { needsYou: true, needsKind: "reply_question", asksYou: true, options: ["A1", "A2"] } as const;

/** Every column F1 gave `console_card`, in order (HEAD `src/console/store.ts`). */
const F1_CARD_COLUMNS = [
  "id", "session_id", "turn_uuid", "machine", "project_key", "kind", "title", "tldr_masked", "byte_start", "byte_end",
  "tool_call_count", "thinking_chars", "needs_you", "needs_kind", "dismissed_at", "purge_after", "version", "created_at", "updated_at"
];

/** F1's DDL verbatim (HEAD `src/console/store.ts`, `SCHEMA`): the shape of a database the F1 build wrote. */
const F1_SCHEMA = `
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

/** `face()`'s card id, as the store derives it. */
const CARD_ID = createHash("sha256").update("sess-1\nturn-1").digest("hex").slice(0, 32);
/** The idempotency key of the rows below (named so a secret scanner does not read it as a key assignment: triage 5). */
const IDEM = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

type AttemptedInsert = Extract<SubmitLogInsert, { rowKind: "attempted" }>;

/** The write-ahead row the submit route appends before any dial (Task 6's shape). */
const attempted = (over: Partial<SubmitLogFields> = {}): AttemptedInsert => ({
  at: T0,
  idempotencyKey: IDEM,
  rowKind: "attempted",
  machine: "Mac-Mini",
  tmuxSession: "work",
  paneId: "%1",
  claudePid: 4242,
  sessionId: "sess-1",
  procStart: "1760605200",
  statusAtSend: "idle",
  cardId: CARD_ID,
  textMasked: "A1 — go ahead",
  ...over
});

const columnNames = (store: SqliteConsoleStore, table: string): string[] =>
  ((store as unknown as { db: Database.Database }).db.pragma(`table_info(${table})`) as { name: string }[]).map((c) => c.name);

describe("SqliteConsoleStore", () => {
  it("upserting a card twice for one turn keeps one row and bumps version", () => {
    const s = new SqliteConsoleStore();
    const a = s.upsertCard(face(), NO_NEEDS, 30, T0);
    const b = s.upsertCard(face({ tldrMasked: "TL;DR: revised" }), { needsYou: true, needsKind: "waiting" }, 30, T1);
    expect(b.id).toBe(a.id);
    expect(a.id).toMatch(/^[0-9a-f]{32}$/);
    expect(a.version).toBe(1);
    expect(b.version).toBe(2);
    expect(b.tldrMasked).toBe("TL;DR: revised");
    expect(b.needsYou).toBe(true);
    expect(b.needsKind).toBe("waiting");
    expect(b.updatedAt).toBe(T1);
    expect(s.listCards({})).toHaveLength(1);
  });

  it("listCards returns newest first and honours needsYouOnly", () => {
    const s = new SqliteConsoleStore();
    s.upsertCard(face({ turnUuid: "a", createdAt: T0 }), NO_NEEDS, 30, T0);
    s.upsertCard(face({ turnUuid: "b", createdAt: T2 }), { needsYou: true, needsKind: "menu_on_screen" }, 30, T2);
    s.upsertCard(face({ turnUuid: "c", createdAt: T1, machine: "Other", projectKey: "x" }), NO_NEEDS, 30, T1);
    expect(s.listCards({}).map((c) => c.turnUuid)).toEqual(["b", "c", "a"]);
    expect(s.listCards({ needsYouOnly: true }).map((c) => c.turnUuid)).toEqual(["b"]);
    expect(s.listCards({ machine: "Other" }).map((c) => c.turnUuid)).toEqual(["c"]);
    expect(s.listCards({ projectKey: "pantheon-harness" }).map((c) => c.turnUuid)).toEqual(["b", "a"]);
    expect(s.listCards({}, 2)).toHaveLength(2);
  });

  it("getCard returns the row by id and undefined for an unknown id", () => {
    const s = new SqliteConsoleStore();
    const c = s.upsertCard(face(), NO_NEEDS, 30, T0);
    expect(s.getCard(c.id)).toEqual(c);
    expect(s.getCard("nope")).toBeUndefined();
  });

  it("purgeExpired removes rows past purge_after and returns the count", () => {
    const s = new SqliteConsoleStore();
    s.upsertCard(face({ turnUuid: "old" }), NO_NEEDS, 1, T0);
    s.upsertCard(face({ turnUuid: "new" }), NO_NEEDS, 30, T0);
    s.upsertSession(session(), T0);
    expect(s.purgeExpired("2026-10-16T23:00:00.000Z")).toBe(0);
    expect(s.purgeExpired("2026-10-18T00:00:00.000Z")).toBe(1);
    expect(s.listCards({}).map((c) => c.turnUuid)).toEqual(["new"]);
    expect(s.purgeExpired("2027-01-01T00:00:00.000Z")).toBe(1);
    expect(s.listSessions()).toHaveLength(1);
  });

  it("a face never stores more than the masked TL;DR (no column holds reply text)", () => {
    const s = new SqliteConsoleStore();
    const db = (s as unknown as { db: Database.Database }).db;
    const forbidden = /full_text|reply|reasoning|tool_output|prompt/;
    const textAllowed = new Set([
      "id", "session_id", "turn_uuid", "machine", "project_key", "kind", "title", "tldr_masked", "needs_kind",
      "dismissed_at", "purge_after", "created_at", "updated_at", "options_json", "answered_at",
      "tmux_session", "pane_id", "proc_start", "cwd", "status", "waiting_for", "state", "state_reason", "last_seen_at", "ended_at",
      // console_submit_log: labels plus Karl's own masked words (text_masked, ≤ 4 KiB) — nothing a session wrote.
      "at", "idempotency_key", "row_kind", "outcome", "reason", "status_at_send", "card_id", "text_masked", "pane_tail_hash"
    ]);
    for (const table of ["console_card", "console_session", "console_submit_log"]) {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string; type: string }[];
      expect(cols.length).toBeGreaterThan(0);
      for (const c of cols) {
        expect(c.name).not.toMatch(forbidden);
        if (c.type !== "INTEGER") expect(textAllowed.has(c.name), `${table}.${c.name}`).toBe(true);
      }
    }
    const cardCols = (db.prepare("PRAGMA table_info(console_card)").all() as { name: string }[]).map((c) => c.name);
    expect(cardCols).toEqual(expect.arrayContaining(["title", "tldr_masked", "needs_kind", "options_json"]));
  });

  it("version, created_at, updated_at exist on both tables", () => {
    const s = new SqliteConsoleStore();
    const db = (s as unknown as { db: Database.Database }).db;
    for (const table of ["console_card", "console_session"]) {
      const names = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
      expect(names).toEqual(expect.arrayContaining(["version", "created_at", "updated_at"]));
    }
  });

  it("creates the brief's indexes", () => {
    const s = new SqliteConsoleStore();
    const db = (s as unknown as { db: Database.Database }).db;
    const idx = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_console_%'").all() as { name: string }[]).map((r) => r.name);
    expect(idx).toEqual(expect.arrayContaining([
      "idx_console_session_machine_project", "idx_console_card_turn", "idx_console_card_purge", "idx_console_card_created",
      "idx_console_submit_log_key_kind", "idx_console_submit_log_card"
    ]));
    const list = db.pragma("index_list(console_submit_log)") as { name: string; unique: number }[];
    expect(list.find((i) => i.name === "idx_console_submit_log_key_kind")).toMatchObject({ unique: 1 });
    expect(list.find((i) => i.name === "idx_console_submit_log_card")).toMatchObject({ unique: 0 });
  });

  it("markEnded sets ended_at and leaves cards in place", () => {
    const s = new SqliteConsoleStore();
    s.upsertSession(session(), T0);
    s.upsertCard(face(), NO_NEEDS, 30, T0);
    s.markEnded("Mac-Mini", "sess-1", T1);
    const [row] = s.listSessions("Mac-Mini");
    expect(row?.endedAt).toBe(T1);
    expect(row?.updatedAt).toBe(T1);
    expect(row?.version).toBe(2);
    expect(s.listCards({})).toHaveLength(1);
  });

  it("upsertSession round-trips every field including transcriptSize and keeps createdAt", () => {
    const s = new SqliteConsoleStore();
    s.upsertSession(session({ transcriptOffset: 10, transcriptSize: 99, waitingFor: "approve", status: "waiting", state: "needs_you", stateReason: "approve" }), T0);
    s.upsertSession(session({ transcriptOffset: 50, transcriptSize: 120, lastSeenAt: T1 }), T1);
    const rows = s.listSessions();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      ...session({ transcriptOffset: 50, transcriptSize: 120, lastSeenAt: T1 }),
      version: 2,
      createdAt: T0,
      updatedAt: T1
    });
    expect(s.listSessions("Nowhere")).toEqual([]);
  });

  it("two stores on one file share the tables (schema is idempotent)", () => {
    const dir = mkdtempSync(join(tmpdir(), "console-store-"));
    try {
      const file = join(dir, "c.db");
      const a = new SqliteConsoleStore(file);
      const c = a.upsertCard(face(), NO_NEEDS, 30, T0);
      a.upsertSession(session(), T0);
      const b = new SqliteConsoleStore(file);
      expect(b.getCard(c.id)).toEqual(c);
      expect(b.listSessions()).toHaveLength(1);
      const mode = (b as unknown as { db: Database.Database }).db.pragma("journal_mode", { simple: true });
      expect(mode).toBe("wal");
      a.close();
      b.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("purgeExpired throws on a malformed now instead of deleting everything", () => {
    const s = new SqliteConsoleStore();
    s.upsertCard(face(), NO_NEEDS, 30, T0);
    for (const bad of ["garbage", "Invalid Date", "NaN"]) expect(() => s.purgeExpired(bad)).toThrow(RangeError);
    expect(s.listCards({})).toHaveLength(1);
  });

  it("purgeExpired normalises an offset-bearing now to UTC", () => {
    const s = new SqliteConsoleStore();
    s.upsertCard(face({ turnUuid: "a" }), NO_NEEDS, 1, "2026-10-16T09:00:00.000Z"); // expires 2026-10-17T09:00Z
    s.upsertCard(face({ turnUuid: "b" }), NO_NEEDS, 1, "2026-10-16T11:00:00.000Z"); // expires 2026-10-17T11:00Z
    // 12:00+02:00 is 10:00Z: only "a" is expired.
    expect(s.purgeExpired("2026-10-17T12:00:00+02:00")).toBe(1);
    expect(s.listCards({}).map((c) => c.turnUuid)).toEqual(["b"]);
  });

  it("listCards throws RangeError on a non-positive or non-integer limit", () => {
    const s = new SqliteConsoleStore();
    for (const bad of [0, -1, 1.5, Number.NaN]) expect(() => s.listCards({}, bad)).toThrow(RangeError);
    expect(s.listCards({}, undefined)).toEqual([]);
  });

  it("a re-upsert keeps the row's created_at and dismissed_at", () => {
    const s = new SqliteConsoleStore();
    const a = s.upsertCard(face({ createdAt: T0 }), NO_NEEDS, 30, T0);
    const db = (s as unknown as { db: Database.Database }).db;
    db.prepare("UPDATE console_card SET dismissed_at = ? WHERE id = ?").run(T1, a.id);
    const b = s.upsertCard(face({ createdAt: T2 }), NO_NEEDS, 30, T2);
    expect(b.createdAt).toBe(T0);
    expect(b.dismissedAt).toBe(T1);
    expect(b.version).toBe(2);
  });

  it("upsertSession after markEnded with endedAt null resurrects the session", () => {
    const s = new SqliteConsoleStore();
    s.upsertSession(session(), T0);
    s.markEnded("Mac-Mini", "sess-1", T1);
    s.upsertSession(session({ lastSeenAt: T2 }), T2);
    const [row] = s.listSessions();
    expect(row?.endedAt).toBeNull();
    expect(row?.version).toBe(3);
  });

  it("an oversize title or TL;DR is rejected by the table", () => {
    const s = new SqliteConsoleStore();
    expect(() => s.upsertCard(face({ title: "t".repeat(121) }), NO_NEEDS, 30, T0)).toThrow(/CHECK/);
    expect(() => s.upsertCard(face({ tldrMasked: "x".repeat(1025) }), NO_NEEDS, 30, T0)).toThrow(/CHECK/);
    expect(() => s.upsertCard(face({ title: "t".repeat(120), tldrMasked: "x".repeat(1024) }), NO_NEEDS, 30, T0)).not.toThrow();
  });

  it("the card id is sha256(session_id, newline, turn_uuid) and cannot be spoofed by shifting the boundary", () => {
    const s = new SqliteConsoleStore();
    const a = s.upsertCard(face({ sessionId: "ab", turnUuid: "c" }), NO_NEEDS, 30, T0);
    const b = s.upsertCard(face({ sessionId: "a", turnUuid: "bc" }), NO_NEEDS, 30, T0);
    expect(a.id).not.toBe(b.id);
    expect(a.id).toBe(createHash("sha256").update("ab\nc").digest("hex").slice(0, 32));
  });

  it("reachable round-trips through upsertSession and only a stored 1 reads back as true", () => {
    const s = new SqliteConsoleStore();
    s.upsertSession(session({ reachable: false }), T0);
    expect(s.listSessions()[0]?.reachable).toBe(false);
    s.upsertSession(session({ reachable: true }), T1);
    expect(s.listSessions()[0]?.reachable).toBe(true);
    const db = (s as unknown as { db: Database.Database }).db;
    db.prepare("UPDATE console_session SET reachable = 7").run();
    expect(s.listSessions()[0]?.reachable).toBe(false);
    const col = (db.prepare("PRAGMA table_info(console_session)").all() as { name: string; type: string; notnull: number; dflt_value: string }[]).find((c) => c.name === "reachable");
    expect(col).toMatchObject({ type: "INTEGER", notnull: 1, dflt_value: "1" });
  });

  it("clearNeedsYou clears only that session's flagged cards and bumps their version", () => {
    const s = new SqliteConsoleStore();
    const flagged = s.upsertCard(face({ turnUuid: "t1", kind: "menu" }), { needsYou: true, needsKind: "menu_on_screen" }, 30, T0);
    const plain = s.upsertCard(face({ turnUuid: "t2" }), NO_NEEDS, 30, T0);
    const other = s.upsertCard(face({ sessionId: "sess-2", turnUuid: "t1" }), { needsYou: true, needsKind: "waiting" }, 30, T0);
    expect(s.clearNeedsYou("Mac-Mini", "sess-1", T1)).toBe(1);
    expect(s.getCard(flagged.id)).toMatchObject({ needsYou: false, needsKind: null, kind: "reply", version: 2, updatedAt: T1 });
    expect(s.getCard(plain.id)).toMatchObject({ version: 1, updatedAt: T0 });
    expect(s.getCard(other.id)).toMatchObject({ needsYou: true, needsKind: "waiting", version: 1 });
    expect(s.clearNeedsYou("Mac-Mini", "sess-1", T2)).toBe(0);
  });

  it("latestCard returns the session's newest card and setCardNeeds sets its flags", () => {
    const s = new SqliteConsoleStore();
    expect(s.latestCard("Mac-Mini", "sess-1")).toBeUndefined();
    s.upsertCard(face({ turnUuid: "old", createdAt: T0 }), NO_NEEDS, 30, T0);
    const newest = s.upsertCard(face({ turnUuid: "new", createdAt: T1 }), NO_NEEDS, 30, T1);
    s.upsertCard(face({ sessionId: "sess-2", turnUuid: "x", createdAt: T2 }), NO_NEEDS, 30, T2);
    expect(s.latestCard("Mac-Mini", "sess-1")?.id).toBe(newest.id);
    expect(s.latestCard("Studio", "sess-1")).toBeUndefined();
    const updated = s.setCardNeeds(newest.id, { needsYou: true, needsKind: "sentinel", kind: "commit_approval" }, T2);
    expect(updated).toMatchObject({ needsYou: true, needsKind: "sentinel", kind: "commit_approval", version: 2, updatedAt: T2 });
    expect(s.setCardNeeds("no-such-id", { needsYou: true, needsKind: "waiting", kind: "reply" }, T2)).toBeUndefined();
  });
});

describe("SqliteConsoleStore F2 card columns", () => {
  it("upsertCard persists asksYou and options, defaulting to false and [] when omitted", () => {
    const s = new SqliteConsoleStore();
    const db = (s as unknown as { db: Database.Database }).db;
    const a = s.upsertCard(face(), NO_NEEDS, 30, T0);
    expect(a).toMatchObject({ asksYou: false, options: [], answeredAt: null });
    const b = s.upsertCard(face(), { needsYou: true, needsKind: "reply_question", asksYou: true, options: ["A1", "B2"] }, 30, T1);
    expect(b).toMatchObject({ id: a.id, asksYou: true, options: ["A1", "B2"], needsYou: true, needsKind: "reply_question", version: 2 });
    expect(s.getCard(a.id)).toEqual(b);
    expect(db.prepare("SELECT options_json, asks_you FROM console_card WHERE id = ?").get(a.id)).toEqual({ options_json: '["A1","B2"]', asks_you: 1 });
    // The needs are refreshed on every upsert: omitted again means false and [] again.
    expect(s.upsertCard(face(), NO_NEEDS, 30, T2)).toMatchObject({ asksYou: false, options: [], version: 3 });
  });

  it("setCardNeeds replaces options only when they are given", () => {
    const s = new SqliteConsoleStore();
    const c = s.upsertCard(face(), ASKS, 30, T0);
    // A stronger signal takes the flags; the reply's options survive for when it clears (Task 10: sticky reply_question).
    expect(s.setCardNeeds(c.id, { needsYou: true, needsKind: "sentinel", kind: "commit_approval" }, T1)).toMatchObject({
      needsKind: "sentinel", kind: "commit_approval", asksYou: true, options: ["A1", "A2"], version: 2
    });
    expect(s.setCardNeeds(c.id, { needsYou: true, needsKind: "reply_question", kind: "reply", options: ["B1"] }, T2)?.options).toEqual(["B1"]);
    expect(s.setCardNeeds(c.id, { needsYou: false, needsKind: null, kind: "reply", options: [] }, T2)?.options).toEqual([]);
  });

  it("options_json refuses more than 12 ids, an id over 8 chars or outside the id charset, and writes nothing", () => {
    const s = new SqliteConsoleStore();
    const c = s.upsertCard(face(), NO_NEEDS, 30, T0);
    const thirteen = Array.from({ length: 13 }, (_, i) => `A${i}`);
    expect(() => s.upsertCard(face(), { ...NO_NEEDS, options: thirteen }, 30, T1)).toThrow(RangeError);
    const flag = (options: readonly string[]) => s.setCardNeeds(c.id, { needsYou: true, needsKind: "reply_question", kind: "reply", options }, T1);
    expect(() => flag(thirteen)).toThrow(RangeError);
    expect(() => flag(["ABCDEFGHI"])).toThrow(RangeError);
    for (const bad of ["", "A 1", "A\n", "<b>", "A'1", "-A", ".A", "é1", "A1\u0000"]) expect(() => flag([bad]), JSON.stringify(bad)).toThrow(RangeError);
    expect(s.getCard(c.id)).toEqual(c);
    const twelve = ["A", "B1", "C12", "ABCDEFGH", "a-b", "v1.2", "x_y", "Z9", "Q", "R", "S", "T"];
    expect(flag(twelve)?.options).toEqual(twelve);
  });

  it("markAnswered clears needs_you and sets answered_at; markDismissed clears needs_you only for reply_question", () => {
    const s = new SqliteConsoleStore();
    const q = s.upsertCard(face({ turnUuid: "q" }), ASKS, 30, T0);
    const q2 = s.upsertCard(face({ turnUuid: "q2" }), ASKS, 30, T0);
    const w = s.upsertCard(face({ turnUuid: "w" }), { needsYou: true, needsKind: "waiting" }, 30, T0);
    const m = s.upsertCard(face({ turnUuid: "m", kind: "menu" }), { needsYou: true, needsKind: "menu_on_screen" }, 30, T0);
    expect(s.markAnswered(q.id, T1)).toMatchObject({
      needsYou: false, needsKind: "reply_question", asksYou: true, options: ["A1", "A2"], answeredAt: T1, dismissedAt: null, version: 2, updatedAt: T1
    });
    expect(s.markAnswered("no-such-id", T1)).toBeUndefined();
    expect(s.markDismissed(q2.id, T2)).toMatchObject({ needsYou: false, needsKind: "reply_question", dismissedAt: T2, answeredAt: null, version: 2, updatedAt: T2 });
    // A waiting / menu signal is the session's state: a dismissal does not clear it.
    expect(s.markDismissed(w.id, T2)).toMatchObject({ needsYou: true, needsKind: "waiting", dismissedAt: T2, version: 2, updatedAt: T2 });
    expect(s.markDismissed(m.id, T2)).toMatchObject({ needsYou: true, needsKind: "menu_on_screen", kind: "menu", dismissedAt: T2 });
    expect(s.markDismissed("no-such-id", T2)).toBeUndefined();
    expect(s.listCards({ needsYouOnly: true }).map((c) => c.turnUuid).sort()).toEqual(["m", "w"]);
  });

  it("ruling T11-19 (I-2): markAnswered sets answered_at on any card but clears needs_you only for a reply_question — a sentinel or waiting flag that is still up keeps the card raised", () => {
    const s = new SqliteConsoleStore();
    const sentinel = s.upsertCard(face({ turnUuid: "s" }), { needsYou: true, needsKind: "sentinel", asksYou: true, options: ["A1", "A2"] }, 30, T0);
    const waiting = s.upsertCard(face({ turnUuid: "w" }), { needsYou: true, needsKind: "waiting", asksYou: true }, 30, T0);
    const plain = s.upsertCard(face({ turnUuid: "p" }), { needsYou: false, needsKind: null, asksYou: true }, 30, T0);
    expect(s.markAnswered(sentinel.id, T1)).toMatchObject({ needsYou: true, needsKind: "sentinel", answeredAt: T1, version: 2, updatedAt: T1 });
    expect(s.markAnswered(waiting.id, T1)).toMatchObject({ needsYou: true, needsKind: "waiting", answeredAt: T1, version: 2 });
    expect(s.markAnswered(plain.id, T1)).toMatchObject({ needsYou: false, needsKind: null, answeredAt: T1, version: 2 });
  });

  it("a re-upsert keeps answered_at and takes the needs it is given", () => {
    const s = new SqliteConsoleStore();
    const a = s.upsertCard(face(), ASKS, 30, T0);
    s.markAnswered(a.id, T1);
    expect(s.upsertCard(face(), ASKS, 30, T2)).toMatchObject({ answeredAt: T1, needsYou: true, version: 3 });
    expect(s.upsertCard(face(), NO_NEEDS, 30, T2)).toMatchObject({ answeredAt: T1, needsYou: false, version: 4 });
  });

  it("a stored options_json that is not an array of ids reads as [], and asks_you reads true only for a stored 1", () => {
    const s = new SqliteConsoleStore();
    const db = (s as unknown as { db: Database.Database }).db;
    const c = s.upsertCard(face(), ASKS, 30, T0);
    for (const bad of ["nope", "{}", '"A1"', '["A1", 2]', '["A1", "toolongid"]', "[]"]) {
      db.prepare("UPDATE console_card SET options_json = ?, asks_you = 7 WHERE id = ?").run(bad, c.id);
      expect(s.getCard(c.id), bad).toMatchObject({ options: [], asksYou: false });
    }
    // The read side re-checks the count as the write side does: 13 conforming ids read as none, 12 read back.
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `A${i}`);
    db.prepare("UPDATE console_card SET options_json = ? WHERE id = ?").run(JSON.stringify(ids(13)), c.id);
    expect(s.getCard(c.id)?.options).toEqual([]);
    db.prepare("UPDATE console_card SET options_json = ? WHERE id = ?").run(JSON.stringify(ids(12)), c.id);
    expect(s.getCard(c.id)?.options).toEqual(ids(12));
  });

  it("an F1 database gains the new card columns without data loss", () => {
    const dir = mkdtempSync(join(tmpdir(), "console-store-f1-"));
    try {
      const file = join(dir, "f1.db");
      const raw = new Database(file);
      raw.exec(F1_SCHEMA);
      raw
        .prepare(
          `INSERT INTO console_card (${F1_CARD_COLUMNS.join(", ")})
           VALUES (?, 'sess-1', 'turn-1', 'Mac-Mini', 'pantheon-harness', 'reply', 'Done', 'TL;DR: all good', 0, 100, 2, 40, 1, 'waiting', NULL, '2027-01-14T10:00:00.000Z', 3, ?, ?)`
        )
        .run(CARD_ID, T0, T1);
      raw
        .prepare(
          `INSERT INTO console_session (machine, session_id, tmux_session, pane_id, claude_pid, proc_start, cwd, project_key, reachable, status, waiting_for, state, state_reason, transcript_offset, transcript_size, last_seen_at, ended_at, version, created_at, updated_at)
           VALUES ('Mac-Mini', 'sess-1', 'work', '%1', 4242, 'Fri Oct 16 09:00:00 2026', '/Users/karl/proj', 'proj', 1, 'busy', NULL, 'working', NULL, 0, 0, ?, NULL, 1, ?, ?)`
        )
        .run(T0, T0, T0);
      expect((raw.pragma("table_info(console_card)") as { name: string }[]).map((c) => c.name)).toEqual(F1_CARD_COLUMNS);
      expect(raw.prepare("SELECT name FROM sqlite_master WHERE name = 'console_submit_log'").get()).toBeUndefined();
      raw.close();

      const s = new SqliteConsoleStore(file);
      const db = (s as unknown as { db: Database.Database }).db;
      const cols = db.pragma("table_info(console_card)") as { name: string; type: string; notnull: number; dflt_value: string | null }[];
      expect(cols.map((c) => c.name)).toEqual([...F1_CARD_COLUMNS, "asks_you", "options_json", "answered_at"]);
      expect(cols.find((c) => c.name === "asks_you")).toMatchObject({ type: "INTEGER", notnull: 1, dflt_value: "0" });
      expect(cols.find((c) => c.name === "options_json")).toMatchObject({ type: "TEXT", notnull: 1, dflt_value: "'[]'" });
      expect(cols.find((c) => c.name === "answered_at")).toMatchObject({ type: "TEXT", notnull: 0, dflt_value: null });
      expect(s.getCard(CARD_ID)).toEqual({
        id: CARD_ID,
        turnUuid: "turn-1",
        sessionId: "sess-1",
        machine: "Mac-Mini",
        projectKey: "pantheon-harness",
        createdAt: T0,
        kind: "reply",
        title: "Done",
        tldrMasked: "TL;DR: all good",
        byteStart: 0,
        byteEnd: 100,
        toolCallCount: 2,
        thinkingChars: 40,
        needsYou: true,
        needsKind: "waiting",
        dismissedAt: null,
        purgeAfter: "2027-01-14T10:00:00.000Z",
        version: 3,
        updatedAt: T1,
        asksYou: false,
        options: [],
        answeredAt: null
      });
      expect(s.listSessions()).toHaveLength(1);
      expect(s.listSubmitLog(CARD_ID)).toEqual([]);
      // The F1 row takes the new fields through the ordinary paths (ruling T11-19: its `waiting` flag stays raised).
      expect(s.markAnswered(CARD_ID, T2)).toMatchObject({ needsYou: true, needsKind: "waiting", answeredAt: T2, version: 4 });
      s.close();

      // A second open finds the columns present and adds nothing (no duplicate-column error).
      const again = new SqliteConsoleStore(file);
      expect(columnNames(again, "console_card")).toEqual([...F1_CARD_COLUMNS, "asks_you", "options_json", "answered_at"]);
      expect(again.getCard(CARD_ID)).toMatchObject({ answeredAt: T2, version: 4 });
      const againIdx = (again as unknown as { db: Database.Database }).db.pragma("index_list(console_submit_log)") as { name: string; unique: number }[];
      expect(againIdx.find((i) => i.name === "idx_console_submit_log_key_kind")).toMatchObject({ unique: 1 });
      again.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("SqliteConsoleStore F2 submit log", () => {
  it("submit log is INSERT-only in source", () => {
    const src = readFileSync(join(__dirname, "..", "src", "console", "store.ts"), "utf8");
    // Every INSERT statement for the table (to the end of its template literal) is a plain insert: no upsert clause.
    const inserts = src.match(/INSERT\s+INTO\s+console_submit_log[^`]*/gi) ?? [];
    expect(inserts.length).toBeGreaterThan(0);
    for (const stmt of inserts) expect(stmt).not.toMatch(/ON\s+CONFLICT/i);
    expect(src).not.toMatch(/UPDATE\s+console_submit_log/i);
    expect(src).not.toMatch(/DELETE\s+FROM\s+console_submit_log/i);
    expect(src).not.toMatch(/REPLACE\s+INTO\s+console_submit_log/i);
    expect(src).not.toMatch(/DROP\s+TABLE\s+(IF\s+EXISTS\s+)?console_submit_log/i);
  });

  it("triage 46 (DI-6): the table itself is append-only — a raw UPDATE or DELETE aborts with the trigger's message, the INSERT path still works, and a reopen keeps the triggers", () => {
    const dir = mkdtempSync(join(tmpdir(), "console-store-triggers-"));
    try {
      const file = join(dir, "c.db");
      const s = new SqliteConsoleStore(file);
      const row = s.appendSubmitLog(attempted());
      const db = (s as unknown as { db: Database.Database }).db;
      expect(() => db.prepare("UPDATE console_submit_log SET text_masked = 'changed' WHERE id = ?").run(row.id)).toThrow(/console_submit_log is append-only/);
      expect(() => db.prepare("DELETE FROM console_submit_log WHERE id = ?").run(row.id)).toThrow(/console_submit_log is append-only/);
      expect(() => db.prepare("DELETE FROM console_submit_log").run()).toThrow(/console_submit_log is append-only/);
      expect(s.findSubmitResult(IDEM)).toBeUndefined();
      expect(s.listSubmitLog(CARD_ID)).toEqual([row]);
      const result = s.appendSubmitLog({ ...attempted(), at: T1, rowKind: "result", outcome: "sent" });
      expect(s.findSubmitResult(IDEM)).toEqual(result);
      s.close();
      const again = new SqliteConsoleStore(file);
      const triggers = (again as unknown as { db: Database.Database }).db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'console_submit_log' ORDER BY name")
        .all() as { name: string }[];
      expect(triggers.map((t) => t.name)).toEqual(["console_submit_log_no_delete", "console_submit_log_no_update"]);
      expect(() => (again as unknown as { db: Database.Database }).db.prepare("DELETE FROM console_submit_log").run()).toThrow(/append-only/);
      again.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a second attempted row for one key is refused by the unique (key, row_kind) index and leaves one row", () => {
    const s = new SqliteConsoleStore();
    s.appendSubmitLog(attempted());
    expect(() => s.appendSubmitLog(attempted({ at: T1 }))).toThrow(/UNIQUE constraint failed/);
    // Triage 52: the route recognises the clash by better-sqlite3's error code, not by the message text.
    let clash: unknown;
    try {
      s.appendSubmitLog(attempted({ at: T1 }));
    } catch (e) {
      clash = e;
    }
    expect(clash).toMatchObject({ code: "SQLITE_CONSTRAINT_UNIQUE" });
    expect(s.listSubmitLog(CARD_ID)).toHaveLength(1);
    // The key's result row is the other kind and goes in; a second result for the key is refused as well.
    const r = s.appendSubmitLog({ ...attempted(), at: T1, rowKind: "result", outcome: "sent" });
    expect(() => s.appendSubmitLog({ ...attempted(), at: T2, rowKind: "result", outcome: "failed" })).toThrow(/UNIQUE constraint failed/);
    expect(s.listSubmitLog(CARD_ID).map((x) => x.rowKind)).toEqual(["result", "attempted"]);
    expect(s.findSubmitResult(IDEM)).toEqual(r);
  });

  it("attempted then result rows are both kept and replay finds the result", () => {
    const s = new SqliteConsoleStore();
    const card = s.upsertCard(face(), ASKS, 30, T0);
    expect(card.id).toBe(CARD_ID);
    const a = s.appendSubmitLog(attempted());
    expect(a).toEqual({
      id: a.id,
      at: T0,
      idempotencyKey: IDEM,
      rowKind: "attempted",
      outcome: null,
      reason: null,
      machine: "Mac-Mini",
      tmuxSession: "work",
      paneId: "%1",
      claudePid: 4242,
      sessionId: "sess-1",
      procStart: "1760605200",
      statusAtSend: "idle",
      cardId: CARD_ID,
      textMasked: "A1 — go ahead",
      paneTailHash: null,
      version: 1,
      createdAt: T0,
      updatedAt: T0
    });
    expect(a.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    // In flight: only the attempted row exists, so a replay has nothing to return yet.
    expect(s.findSubmitResult(IDEM)).toBeUndefined();
    const r = s.appendSubmitLog({ ...attempted(), at: T1, rowKind: "result", outcome: "sent", paneTailHash: "ab".repeat(32) });
    expect(r).toMatchObject({ rowKind: "result", outcome: "sent", reason: null, paneTailHash: "ab".repeat(32), textMasked: "A1 — go ahead", createdAt: T1, updatedAt: T1 });
    expect(r.id).not.toBe(a.id);
    expect(s.listSubmitLog(CARD_ID)).toEqual([r, a]);
    expect(s.findSubmitResult(IDEM)).toEqual(r);
    expect(s.findSubmitResult(randomUUID())).toBeUndefined();
  });

  it("findSubmitResult returns the result row of its own key, a refusal included, with its reason", () => {
    const s = new SqliteConsoleStore();
    const other = randomUUID();
    s.appendSubmitLog(attempted());
    s.appendSubmitLog({ ...attempted(), at: T1, rowKind: "result", outcome: "refused_target_changed", reason: "session file missing" });
    s.appendSubmitLog(attempted({ idempotencyKey: other, at: T2 }));
    s.appendSubmitLog({ ...attempted({ idempotencyKey: other, at: T2 }), rowKind: "result", outcome: "failed", reason: "timed out" });
    expect(s.findSubmitResult(IDEM)).toMatchObject({ idempotencyKey: IDEM, outcome: "refused_target_changed", reason: "session file missing" });
    expect(s.findSubmitResult(other)).toMatchObject({ idempotencyKey: other, outcome: "failed", reason: "timed out" });
    expect(s.listSubmitLog(CARD_ID)).toHaveLength(4);
  });

  it("listSubmitLog is newest first, honours limit and throws RangeError on a bad limit", () => {
    const s = new SqliteConsoleStore();
    s.appendSubmitLog(attempted({ at: T0 }));
    s.appendSubmitLog({ ...attempted({ at: T1 }), rowKind: "result", outcome: "failed", reason: "timed out" });
    s.appendSubmitLog(attempted({ at: T2, idempotencyKey: randomUUID() }));
    s.appendSubmitLog(attempted({ at: T2, idempotencyKey: randomUUID(), cardId: "other-card" }));
    expect(s.listSubmitLog(CARD_ID).map((r) => [r.at, r.rowKind])).toEqual([[T2, "attempted"], [T1, "result"], [T0, "attempted"]]);
    expect(s.listSubmitLog(CARD_ID, 2).map((r) => r.at)).toEqual([T2, T1]);
    expect(s.listSubmitLog("other-card")).toHaveLength(1);
    expect(s.listSubmitLog("no-such-card")).toEqual([]);
    for (const bad of [0, -1, 1.5, Number.NaN]) expect(() => s.listSubmitLog(CARD_ID, bad)).toThrow(RangeError);
  });

  it("the retention sweep deletes expired cards and never a submit log row", () => {
    const s = new SqliteConsoleStore();
    s.upsertCard(face(), ASKS, 1, T0);
    s.appendSubmitLog(attempted());
    s.appendSubmitLog({ ...attempted(), at: T1, rowKind: "result", outcome: "sent" });
    expect(s.purgeExpired("2099-01-01T00:00:00.000Z")).toBe(1);
    expect(s.getCard(CARD_ID)).toBeUndefined();
    expect(s.listSubmitLog(CARD_ID)).toHaveLength(2);
    expect(s.findSubmitResult(IDEM)?.outcome).toBe("sent");
  });

  it("appendSubmitLog refuses a malformed idempotency key and an unknown outcome, writing nothing", () => {
    const s = new SqliteConsoleStore();
    for (const bad of ["", "not-a-uuid", IDEM.toUpperCase(), `${IDEM}\n`]) {
      expect(() => s.appendSubmitLog(attempted({ idempotencyKey: bad })), JSON.stringify(bad)).toThrow(RangeError);
    }
    expect(() => s.appendSubmitLog({ ...attempted(), rowKind: "result", outcome: "bogus" as SubmitLogOutcome })).toThrow(RangeError);
    expect(() => s.appendSubmitLog({ ...attempted(), rowKind: "result", outcome: "" as SubmitLogOutcome })).toThrow(RangeError);
    expect(s.listSubmitLog(CARD_ID)).toEqual([]);
  });

  it("the table refuses text_masked over 2 x SUBMIT_MAX_BYTES (bytes, not characters) and a row_kind / outcome mismatch", () => {
    const s = new SqliteConsoleStore();
    const db = (s as unknown as { db: Database.Database }).db;
    // Ruling T4-1b, restated (triage 47): a 4,096-byte submit grows at most 12/7 ≈ 1.714× under maskSecrets (≤ 7,022
    // bytes) and maskSubmitText only shrinks that, so the stored bound is twice the submit limit.
    const max = 2 * SUBMIT_MAX_BYTES;
    expect(max).toBe(8192);
    expect(() => s.appendSubmitLog(attempted({ textMasked: "x".repeat(max + 1) }))).toThrow(/CHECK/);
    // max / 2 + 1 = 4,097 characters, well under 8,192 characters, but 8,194 bytes: the bound counts bytes.
    expect(() => s.appendSubmitLog(attempted({ textMasked: "é".repeat(max / 2 + 1) }))).toThrow(/CHECK/);
    expect(s.appendSubmitLog(attempted({ textMasked: "é".repeat(max / 2) })).textMasked).toBe("é".repeat(max / 2));
    expect(s.appendSubmitLog(attempted({ idempotencyKey: randomUUID(), textMasked: "x".repeat(max) })).textMasked).toHaveLength(max);
    const rawInsert = (id: string, rowKind: string, outcome: string | null) =>
      db
        .prepare(
          "INSERT INTO console_submit_log (id, at, idempotency_key, row_kind, outcome, machine, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'Mac-Mini', 1, ?, ?)"
        )
        .run(id, T0, randomUUID(), rowKind, outcome, T0, T0);
    expect(() => rawInsert("r1", "result", null)).toThrow(/CHECK/);
    expect(() => rawInsert("a1", "attempted", "sent")).toThrow(/CHECK/);
    expect(() => rawInsert("x1", "bogus", null)).toThrow(/CHECK/);
    expect(() => rawInsert("x2", "bogus", "sent")).toThrow(/CHECK/);
    expect(s.listSubmitLog(CARD_ID)).toHaveLength(2);
  });

  it("a session-creation row carries a machine and tmux session but no card, text or pane", () => {
    const s = new SqliteConsoleStore();
    const key = randomUUID();
    const r = s.appendSubmitLog({ at: T0, idempotencyKey: key, rowKind: "result", outcome: "opened_shell", machine: "Mac-Mini", tmuxSession: "sh-Mac-Mini" });
    expect(r).toMatchObject({
      outcome: "opened_shell", machine: "Mac-Mini", tmuxSession: "sh-Mac-Mini", reason: null, paneId: null, claudePid: null,
      sessionId: null, procStart: null, statusAtSend: null, cardId: null, textMasked: null, paneTailHash: null
    });
    expect(s.findSubmitResult(key)).toEqual(r);
    // Ruling T11-12: the shell outcome is `opened_shell` (tmux cannot tell create from re-attach); the old word is gone.
    expect(() => s.appendSubmitLog({ at: T1, idempotencyKey: randomUUID(), rowKind: "result", outcome: "created_shell" as never, machine: "Mac-Mini" })).toThrow(/unknown outcome/);
    for (const outcome of ["created_session", "created_project", "refused_name", "refused_root"] as const) {
      expect(s.appendSubmitLog({ at: T1, idempotencyKey: randomUUID(), rowKind: "result", outcome, machine: "Mac-Mini", reason: "x" }).outcome).toBe(outcome);
    }
  });
});
