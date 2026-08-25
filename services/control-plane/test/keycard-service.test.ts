/**
 * Scoped session keycard — M1 task 2 (TP-3; docs/machine-auth-design.md; PROJECT_BIBLE §7 tier 4).
 *
 * A keycard is a narrow, deny-by-default machine credential a Claude-CLI session presents to the
 * harness's read/propose door. Invariants pinned here (service + real SQLite store):
 *  - scopes are a CLOSED enum of read scopes; no management/write scope exists to grant (TM-011);
 *  - the server stores ONLY SHA-256(token); the raw token exists once, at mint, and is never derivable;
 *  - unknown / revoked / expired cards fail closed; every deny is counted (deny-visibility);
 *  - a per-card rate cap bounds how hard one card can lean on the door.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import { KEYCARD_SCOPES, type Keycard } from "../src/keycard/types.js";
import { SqliteKeycardStore } from "../src/keycard/sqlite-store.js";
import { KeycardService, KeycardValidationError } from "../src/keycard/service.js";

const T0 = Date.parse("2026-08-25T12:00:00.000Z");

function make(now: () => number = () => T0): { svc: KeycardService; store: SqliteKeycardStore } {
  const store = new SqliteKeycardStore(":memory:");
  const svc = new KeycardService(store, { now });
  return { svc, store };
}

describe("keycard scopes (closed enum)", () => {
  it("is exactly the three read scopes — no management or write scope exists to grant", () => {
    expect([...KEYCARD_SCOPES].sort()).toEqual(["approvals:read", "sessions:read", "usage:read"]);
    for (const s of KEYCARD_SCOPES) expect(s.endsWith(":read")).toBe(true);
  });
});

describe("KeycardService.mint", () => {
  it("mints a card with a one-time raw token; the store holds only the SHA-256 hash", () => {
    const { svc, store } = make();
    const { card, token } = svc.mint({ principal: "cli-pantheon", scopes: ["sessions:read"] });
    expect(token).toMatch(/^pk1_[0-9a-f]{64}$/);
    expect(card).toMatchObject({ principal: "cli-pantheon", scopes: ["sessions:read"], revokedAt: null, lastUsedAt: null, useCount: 0, denyCount: 0 });
    expect(card.createdAt).toBe(new Date(T0).toISOString());
    expect(card.updatedAt).toBe(card.createdAt);
    expect(typeof card.expiresAt).toBe("string"); // never "no expiry"
    const stored = store.findByTokenHash(createHash("sha256").update(token).digest("hex"));
    expect(stored?.id).toBe(card.id);
    // no field anywhere in the record carries the token or its hash
    expect(JSON.stringify(card)).not.toContain(token);
    expect(JSON.stringify(store.list())).not.toContain(token);
    expect(JSON.stringify(store.list())).not.toContain(createHash("sha256").update(token).digest("hex"));
  });

  it("defaults to a 90-day expiry and honours an explicit ttlDays within 1..365", () => {
    const { svc } = make();
    const d = svc.mint({ principal: "a", scopes: ["usage:read"] }).card;
    expect(d.expiresAt).toBe(new Date(T0 + 90 * 86_400_000).toISOString());
    const e = svc.mint({ principal: "b", scopes: ["usage:read"], ttlDays: 7 }).card;
    expect(e.expiresAt).toBe(new Date(T0 + 7 * 86_400_000).toISOString());
    for (const bad of [0, -1, 366, 1.5, Number.NaN]) {
      expect(() => svc.mint({ principal: "c", scopes: ["usage:read"], ttlDays: bad })).toThrow(KeycardValidationError);
    }
  });

  it("rejects an unknown scope, an empty scope list, and non-array scopes (deny-by-default)", () => {
    const { svc } = make();
    expect(() => svc.mint({ principal: "a", scopes: ["admin:write" as never] })).toThrow(KeycardValidationError);
    expect(() => svc.mint({ principal: "a", scopes: ["approvals:decide" as never] })).toThrow(KeycardValidationError);
    expect(() => svc.mint({ principal: "a", scopes: [] })).toThrow(KeycardValidationError);
    expect(() => svc.mint({ principal: "a", scopes: "usage:read" as never })).toThrow(KeycardValidationError);
  });

  it("dedupes scopes and validates the principal name (allow-list charset, no leading dash)", () => {
    const { svc } = make();
    const { card } = svc.mint({ principal: "cli.mac-mini_1", scopes: ["usage:read", "usage:read", "sessions:read"] });
    expect(card.scopes).toEqual(["usage:read", "sessions:read"]);
    for (const bad of ["", " ", "-x", "a b", "a;b", "x".repeat(65), "<x>"]) {
      expect(() => svc.mint({ principal: bad, scopes: ["usage:read"] })).toThrow(KeycardValidationError);
    }
  });

  it("every mint yields a distinct token and id", () => {
    const { svc } = make();
    const a = svc.mint({ principal: "a", scopes: ["usage:read"] });
    const b = svc.mint({ principal: "a", scopes: ["usage:read"] });
    expect(a.token).not.toBe(b.token);
    expect(a.card.id).not.toBe(b.card.id);
  });
});

describe("KeycardService.authenticate", () => {
  it("accepts a live card WITHOUT side effects; recordServed (after the rate check) counts the use", () => {
    let t = T0;
    const { svc, store } = make(() => t);
    const { card, token } = svc.mint({ principal: "a", scopes: ["sessions:read"] });
    t = T0 + 1000;
    const r = svc.authenticate(token);
    expect(r).toEqual({ ok: true, card: expect.objectContaining({ id: card.id }) });
    expect((store.get(card.id) as Keycard).useCount).toBe(0);
    svc.recordServed(card.id);
    const after = store.get(card.id) as Keycard;
    expect(after.useCount).toBe(1);
    expect(after.lastUsedAt).toBe(new Date(T0 + 1000).toISOString());
    expect(after.updatedAt).toBe(new Date(T0 + 1000).toISOString());
  });

  it("a card whose stored scopes are corrupt (not a JSON array of known scopes) is INVALID, never unscoped-but-live", () => {
    const { svc, store } = make();
    const { card, token } = svc.mint({ principal: "a", scopes: ["sessions:read"] });
    store.rawUpdateScopesForTest(card.id, '"usage:read approvals:read sessions:read"'); // a JSON string, not an array
    expect(svc.authenticate(token)).toEqual({ ok: false, reason: "invalid" });
    expect(store.get(card.id)?.scopes).toEqual([]);
    store.rawUpdateScopesForTest(card.id, "not json");
    expect(svc.authenticate(token)).toEqual({ ok: false, reason: "invalid" });
    expect(() => store.list()).not.toThrow();
  });

  it("stored counters are coerced to numbers on read (a tampered TEXT value can never reach the page as a string)", () => {
    const { svc, store } = make();
    const { card } = svc.mint({ principal: "a", scopes: ["sessions:read"] });
    store.rawUpdateCountersForTest(card.id, "<img src=x onerror=alert(1)>", "7");
    const c = store.get(card.id) as Keycard;
    expect(c.useCount).toBe(0);
    expect(c.denyCount).toBe(7);
  });

  it("fails closed on an unknown token, a malformed token, and a non-string", () => {
    const { svc } = make();
    svc.mint({ principal: "a", scopes: ["sessions:read"] });
    expect(svc.authenticate("pk1_" + "0".repeat(64))).toEqual({ ok: false, reason: "invalid" });
    expect(svc.authenticate("not-a-keycard")).toEqual({ ok: false, reason: "invalid" });
    expect(svc.authenticate("")).toEqual({ ok: false, reason: "invalid" });
    expect(svc.authenticate(undefined as never)).toEqual({ ok: false, reason: "invalid" });
  });

  it("fails closed on a revoked card (revocation is immediate and idempotent)", () => {
    const { svc } = make();
    const { card, token } = svc.mint({ principal: "a", scopes: ["sessions:read"] });
    expect(svc.revoke(card.id)).toBe(true);
    expect(svc.revoke(card.id)).toBe(true);
    expect(svc.authenticate(token)).toEqual({ ok: false, reason: "revoked" });
    expect(svc.revoke("nope")).toBe(false);
  });

  it("fails closed on an expired card", () => {
    let t = T0;
    const { svc } = make(() => t);
    const { token } = svc.mint({ principal: "a", scopes: ["sessions:read"], ttlDays: 1 });
    t = T0 + 86_400_000 - 1;
    expect(svc.authenticate(token).ok).toBe(true);
    t = T0 + 86_400_000;
    expect(svc.authenticate(token)).toEqual({ ok: false, reason: "expired" });
  });
});

describe("KeycardService.authorize (per-route scope check)", () => {
  it("grants exactly the card's scopes and nothing else; each deny is counted", () => {
    const { svc, store } = make();
    const { card } = svc.mint({ principal: "a", scopes: ["approvals:read"] });
    expect(svc.authorize(card, "approvals:read")).toBe(true);
    expect(svc.authorize(card, "sessions:read")).toBe(false);
    expect(svc.authorize(card, "usage:read")).toBe(false);
    expect(svc.authorize(card, "admin:write" as never)).toBe(false);
    expect((store.get(card.id) as Keycard).denyCount).toBe(3);
  });
});

describe("KeycardService refusal accounting (deny visibility) and the pre-auth budget", () => {
  it("counts refused authentications (unknown / revoked / expired) and the last time one happened", () => {
    let t = T0;
    const { svc, store } = make(() => t);
    const { card, token } = svc.mint({ principal: "a", scopes: ["sessions:read"] });
    expect(svc.stats()).toEqual({ refusedAuth: 0, lastRefusedAt: null, rateLimited: 0 });
    svc.noteRefused("invalid");
    t = T0 + 5000;
    svc.revoke(card.id);
    expect(svc.authenticate(token)).toEqual({ ok: false, reason: "revoked" });
    svc.noteRefused("revoked", card.id);
    expect(svc.stats()).toEqual({ refusedAuth: 2, lastRefusedAt: new Date(T0 + 5000).toISOString(), rateLimited: 0 });
    // a refused KNOWN card is also counted on the card itself, so a replayed revoked card is visible in the table
    expect((store.get(card.id) as Keycard).denyCount).toBe(1);
    svc.noteRateLimited(card.id);
    expect(svc.stats().rateLimited).toBe(1);
    expect((store.get(card.id) as Keycard).denyCount).toBe(2);
  });

  it("pre-auth budget: after 120 refusals in a minute the door stops looking tokens up until the window slides", () => {
    let t = T0;
    const { svc } = make(() => t);
    for (let i = 0; i < 120; i++) {
      expect(svc.preAuthAllowed()).toBe(true);
      svc.noteRefused("invalid");
    }
    expect(svc.preAuthAllowed()).toBe(false);
    t = T0 + 60_001;
    expect(svc.preAuthAllowed()).toBe(true);
  });
});

describe("KeycardService rate cap (per card, sliding window)", () => {
  it("allows 60 calls per minute per card, then answers limited until the window slides", () => {
    let t = T0;
    const { svc } = make(() => t);
    const { card } = svc.mint({ principal: "a", scopes: ["sessions:read"] });
    for (let i = 0; i < 60; i++) expect(svc.checkRate(card.id)).toBe(true);
    expect(svc.checkRate(card.id)).toBe(false);
    t = T0 + 60_001;
    expect(svc.checkRate(card.id)).toBe(true);
  });

  it("evicts idle entries so the rate map does not grow with dead cards", () => {
    let t = T0;
    const { svc } = make(() => t);
    for (let i = 0; i < 100; i++) svc.checkRate(svc.mint({ principal: "p" + i, scopes: ["usage:read"] }).card.id);
    t = T0 + 120_000;
    svc.checkRate(svc.mint({ principal: "fresh", scopes: ["usage:read"] }).card.id);
    expect(svc.rateMapSizeForTest()).toBeLessThanOrEqual(1);
  });

  it("caps are per card — another card is unaffected", () => {
    const { svc } = make();
    const a = svc.mint({ principal: "a", scopes: ["sessions:read"] }).card;
    const b = svc.mint({ principal: "b", scopes: ["sessions:read"] }).card;
    for (let i = 0; i < 61; i++) svc.checkRate(a.id);
    expect(svc.checkRate(a.id)).toBe(false);
    expect(svc.checkRate(b.id)).toBe(true);
  });
});

describe("SqliteKeycardStore persistence", () => {
  let store: SqliteKeycardStore;
  beforeEach(() => {
    store = new SqliteKeycardStore(":memory:");
  });

  it("round-trips a card, lists newest first, and never stores the token", () => {
    const svc = new KeycardService(store, { now: () => T0 });
    const a = svc.mint({ principal: "a", scopes: ["usage:read"] });
    const svc2 = new KeycardService(store, { now: () => T0 + 5000 });
    const b = svc2.mint({ principal: "b", scopes: ["sessions:read", "approvals:read"] });
    const list = store.list();
    expect(list.map((c) => c.id)).toEqual([b.card.id, a.card.id]);
    expect(list[0]?.scopes).toEqual(["sessions:read", "approvals:read"]);
    expect(JSON.stringify(list)).not.toContain(a.token);
    expect(JSON.stringify(list)).not.toContain(b.token);
  });

  it("lists at most 500 cards (newest first) — the table cannot grow without bound", () => {
    const svc = new KeycardService(store, { now: () => T0 });
    for (let i = 0; i < 505; i++) svc.mint({ principal: "p", scopes: ["usage:read"] });
    expect(store.list()).toHaveLength(500);
  });

  it("rejects a duplicate token hash (a hash maps to exactly one card)", () => {
    const now = new Date(T0).toISOString();
    const card: Keycard = { id: "k1", principal: "a", scopes: ["usage:read"], createdAt: now, updatedAt: now, expiresAt: now, revokedAt: null, lastUsedAt: null, useCount: 0, denyCount: 0 };
    store.insert(card, "h".repeat(64));
    expect(() => store.insert({ ...card, id: "k2" }, "h".repeat(64))).toThrow();
  });
});
