import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import type { CardFace } from "../src/console/cards.js";
import { SqliteConsoleStore, type ConsoleSessionRow } from "../src/console/store.js";

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
      "dismissed_at", "purge_after", "created_at", "updated_at",
      "tmux_session", "pane_id", "proc_start", "cwd", "status", "waiting_for", "state", "state_reason", "last_seen_at", "ended_at"
    ]);
    for (const table of ["console_card", "console_session"]) {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string; type: string }[];
      expect(cols.length).toBeGreaterThan(0);
      for (const c of cols) {
        expect(c.name).not.toMatch(forbidden);
        if (c.type !== "INTEGER") expect(textAllowed.has(c.name), `${table}.${c.name}`).toBe(true);
      }
    }
    const cardCols = (db.prepare("PRAGMA table_info(console_card)").all() as { name: string }[]).map((c) => c.name);
    expect(cardCols).toEqual(expect.arrayContaining(["title", "tldr_masked", "needs_kind"]));
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
    expect(idx).toEqual(expect.arrayContaining(["idx_console_session_machine_project", "idx_console_card_turn", "idx_console_card_purge", "idx_console_card_created"]));
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
