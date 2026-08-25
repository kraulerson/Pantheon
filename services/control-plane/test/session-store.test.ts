/**
 * SessionStore tests (PROJECT_BIBLE §5 Session entity; #14c monotonic taint; D5 sticky).
 *
 * The session's `taintFlag` is MONOTONIC: once `markTaint` sets it true it can never
 * revert. There is no clear/reset path. getOrCreate is keyed so a session is stable.
 */

import { describe, it, expect } from "vitest";
import { SqliteSessionStore } from "../src/session/sqlite-store.js";

describe("SqliteSessionStore", () => {
  it("getOrCreate creates a session bound to identity + backend, taint starts false", () => {
    const store = new SqliteSessionStore();
    const s = store.getOrCreate("sess-1", { identityId: "id-A", backendId: "be-1" });
    expect(s.id).toBe("sess-1");
    expect(s.identityId).toBe("id-A");
    expect(s.backendId).toBe("be-1");
    expect(s.taintFlag).toBe(false);
    expect(s.closedAt).toBeNull();
    store.close();
  });

  it("getOrCreate is idempotent — returns the same row, does not rebind", () => {
    const store = new SqliteSessionStore();
    const a = store.getOrCreate("sess-1", { identityId: "id-A", backendId: "be-1" });
    // A second call with different binding must NOT rebind an existing session.
    const b = store.getOrCreate("sess-1", { identityId: "id-EVIL", backendId: "be-EVIL" });
    expect(b.identityId).toBe(a.identityId);
    expect(b.backendId).toBe(a.backendId);
    expect(b.createdAt).toBe(a.createdAt);
    store.close();
  });

  it("supports a null identity (bare session)", () => {
    const store = new SqliteSessionStore();
    const s = store.getOrCreate("bare", { identityId: null, backendId: "be-1" });
    expect(s.identityId).toBeNull();
    store.close();
  });

  it("markTaint flips taintFlag to true", () => {
    const store = new SqliteSessionStore();
    store.getOrCreate("sess-1", { identityId: "id-A", backendId: "be-1" });
    store.markTaint("sess-1");
    expect(store.get("sess-1")?.taintFlag).toBe(true);
    store.close();
  });

  it("taint is MONOTONIC — markTaint only ever sets true; there is no revert path", () => {
    const store = new SqliteSessionStore();
    store.getOrCreate("sess-1", { identityId: "id-A", backendId: "be-1" });
    store.markTaint("sess-1");
    // Re-creating / re-fetching never clears taint (D5: a clean context = a NEW session).
    const again = store.getOrCreate("sess-1", { identityId: "id-A", backendId: "be-1" });
    expect(again.taintFlag).toBe(true);
    // Idempotent re-mark keeps it true.
    store.markTaint("sess-1");
    expect(store.get("sess-1")?.taintFlag).toBe(true);
    // The store deliberately exposes no clear/untaint method.
    expect((store as unknown as Record<string, unknown>).clearTaint).toBeUndefined();
    expect((store as unknown as Record<string, unknown>).untaint).toBeUndefined();
    store.close();
  });

  it("markTaint on an unknown session is a no-op (does not create a phantom row)", () => {
    const store = new SqliteSessionStore();
    store.markTaint("ghost");
    expect(store.get("ghost")).toBeUndefined();
    store.close();
  });

  it("get returns undefined for an unknown session", () => {
    const store = new SqliteSessionStore();
    expect(store.get("nope")).toBeUndefined();
    store.close();
  });
});

describe("SqliteSessionStore.list (keycard sessions:read — M1 task 2)", () => {
  it("lists sessions newest first with metadata only", async () => {
    const { SqliteSessionStore } = await import("../src/session/sqlite-store.js");
    const store = new SqliteSessionStore(":memory:");
    store.getOrCreate("s-old", { identityId: "alden-1", backendId: "b1" });
    await new Promise((r) => setTimeout(r, 5));
    store.getOrCreate("s-new", { identityId: null, backendId: "b1" });
    store.markTaint("s-old");
    const list = store.list();
    expect(list.map((s) => s.id)).toEqual(["s-new", "s-old"]);
    expect(list[1]).toMatchObject({ id: "s-old", identityId: "alden-1", taintFlag: true, closedAt: null });
    expect(Object.keys(list[0] as object).sort()).toEqual(["backendId", "closedAt", "createdAt", "id", "identityId", "taintFlag"]);
    store.close();
  });
});
