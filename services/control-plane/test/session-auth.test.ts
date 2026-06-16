/**
 * Operator session store — Task #9 (browser auth, PROJECT_BIBLE §7 tier-1 UI auth).
 *
 * High-entropy server-side session ids with a TTL: the cookie value is the id, validated by lookup
 * (no client-trusted claims). Used to gate the harness pages + same-origin WebSocket for a browser
 * that can't present a bearer header.
 */

import { describe, it, expect } from "vitest";
import { SessionStore } from "../src/http/auth/session.js";

describe("SessionStore", () => {
  it("creates a high-entropy id that validates immediately", () => {
    const store = new SessionStore();
    const id = store.create();
    expect(id).toMatch(/^[a-f0-9]{64}$/); // 256-bit hex
    expect(store.validate(id)).toBe(true);
  });

  it("issues distinct ids", () => {
    const store = new SessionStore();
    expect(store.create()).not.toBe(store.create());
  });

  it("rejects an unknown id", () => {
    expect(new SessionStore().validate("nope")).toBe(false);
  });

  it("destroy() invalidates a session (logout)", () => {
    const store = new SessionStore();
    const id = store.create();
    store.destroy(id);
    expect(store.validate(id)).toBe(false);
  });

  it("expires a session after its TTL and purges it", () => {
    let now = 1_000_000;
    const store = new SessionStore(1000, () => now); // 1s TTL, injected clock
    const id = store.create();
    expect(store.validate(id)).toBe(true);
    now += 1001;
    expect(store.validate(id)).toBe(false);
    expect(store.size).toBe(0); // purged on the failed validate
  });
});
