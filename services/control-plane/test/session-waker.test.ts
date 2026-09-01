/**
 * Session waker — deterministic guardrails (M1 task 4; TP-1 HIGH + TP-5 partial; ADR-0009).
 *
 * Promotes `prototypes/cli-channel-loop` to product. The guardrails are DETERMINISTIC on purpose:
 * a wake must never depend on a model call to decide whether it is allowed (CC3 — enforce at the
 * gateway, never trust the model).
 *
 *   - **XC-6:** the dispatcher refuses to dispatch AT ALL until an allowlist is configured.
 *   - **Deny by default:** an empty allowlist denies every pair.
 *   - **Rate cap:** a per-pair sliding window, counted without a model call.
 *   - **WAKE-NOT-BODY:** a wake carries sender names and ids, never message bodies.
 *   - **Idle-only delivery:** a wake is held while the session is mid-turn (prompt-cache/turn
 *     integrity) and delivered when it goes idle.
 */

import { describe, it, expect, vi } from "vitest";
import { PairAllowlist } from "../src/waker/allowlist.js";
import { SlidingWindowCap } from "../src/waker/rate-cap.js";
import { buildWake, MAX_WAKE_CHARS } from "../src/waker/wake.js";
import { WakeDispatcher, WakerNotConfiguredError } from "../src/waker/dispatcher.js";

const msg = (id: number, sender: string, body: string) => ({ id, sender, body, recipient: "claude-code" });

describe("PairAllowlist — deny by default (XC-6)", () => {
  it("an EMPTY allowlist denies every pair", () => {
    const list = PairAllowlist.from([]);
    expect(list.isConfigured).toBe(false);
    expect(list.allows("alden-1", "claude-code")).toBe(false);
    expect(list.allows("anyone", "anyone")).toBe(false);
  });

  it("allows only the exact pairs it was given, in the direction it was given", () => {
    const list = PairAllowlist.from([{ sender: "alden-1", recipient: "claude-code" }]);
    expect(list.isConfigured).toBe(true);
    expect(list.allows("alden-1", "claude-code")).toBe(true);
    expect(list.allows("claude-code", "alden-1")).toBe(false); // direction matters
    expect(list.allows("alden-cloud", "claude-code")).toBe(false);
    expect(list.allows("ALDEN-1", "claude-code")).toBe(false); // no case laundering
  });

  it("refuses a malformed entry loudly rather than silently widening or narrowing", () => {
    for (const bad of [[{ sender: "", recipient: "x" }], [{ sender: "a", recipient: "" }], [{ sender: "a b", recipient: "x" }]]) {
      expect(() => PairAllowlist.from(bad as Array<{ sender: string; recipient: string }>)).toThrow(/allowlist/i);
    }
  });
});

describe("SlidingWindowCap — per pair, no model call", () => {
  it("allows up to the budget inside the window, then trips at the boundary", () => {
    const now = 1_000_000;
    const cap = new SlidingWindowCap({ limit: 3, windowMs: 60_000, now: () => now });
    for (let i = 0; i < 3; i++) expect(cap.take("alden-1->claude-code").allowed, `take ${i}`).toBe(true);
    const denied = cap.take("alden-1->claude-code");
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBeGreaterThan(0);
    expect(denied.retryAfterMs).toBeLessThanOrEqual(60_000);
  });

  it("cools down as the window slides — the oldest take expiring frees exactly one slot", () => {
    let now = 1_000_000;
    const cap = new SlidingWindowCap({ limit: 2, windowMs: 1_000, now: () => now });
    expect(cap.take("p").allowed).toBe(true);
    now += 400;
    expect(cap.take("p").allowed).toBe(true);
    expect(cap.take("p").allowed).toBe(false);
    now += 601; // the first take is now outside the window
    expect(cap.take("p").allowed).toBe(true);
    expect(cap.take("p").allowed).toBe(false); // the second take still counts
  });

  it("counts each pair separately (one noisy pair never starves another)", () => {
    const now = 0;
    const cap = new SlidingWindowCap({ limit: 1, windowMs: 10_000, now: () => now });
    expect(cap.take("a->b").allowed).toBe(true);
    expect(cap.take("a->b").allowed).toBe(false);
    expect(cap.take("c->b").allowed).toBe(true);
  });
});

describe("buildWake — WAKE-NOT-BODY + light context (TP-5)", () => {
  const batch = [msg(41, "alden-1", "the launch codes are hunter2"), msg(42, "alden-1", "second secret line"), msg(43, "alden-cloud", "third")];

  it("carries senders, count and the id range — and NEVER a message body", () => {
    const wake = buildWake(batch, { recipient: "claude-code", sinceId: 40 });
    const whole = wake.content + JSON.stringify(wake.meta);
    for (const secret of ["hunter2", "launch codes", "second secret line", "third"]) expect(whole, secret).not.toContain(secret);
    expect(wake.content).toContain("alden-1");
    expect(wake.content).toContain("alden-cloud");
    expect(wake.meta).toMatchObject({ kind: "bridge_mail", count: "3", first_id: "41", last_id: "43" });
  });

  it("is a LIGHT briefing: short, and it tells the session to fetch the messages itself", () => {
    const wake = buildWake(batch, { recipient: "claude-code", sinceId: 40 });
    expect(wake.content.length).toBeLessThanOrEqual(MAX_WAKE_CHARS);
    expect(wake.content).toMatch(/since_id=40/);
    expect(wake.content).toMatch(/untrusted/i);
  });

  it("stays inside the budget and keeps the id range even with a flood of senders", () => {
    const many = Array.from({ length: 200 }, (_, i) => msg(100 + i, `sender-${i}`, "x".repeat(500)));
    const wake = buildWake(many, { recipient: "claude-code", sinceId: 99 });
    expect(wake.content.length).toBeLessThanOrEqual(MAX_WAKE_CHARS);
    expect(wake.content).not.toContain("xxxx");
    expect(wake.meta.first_id).toBe("100");
    expect(wake.meta.last_id).toBe("299");
  });
});

describe("WakeDispatcher — the gate every wake passes through", () => {
  const make = (o: { allowlist?: PairAllowlist; idle?: boolean; limit?: number } = {}) => {
    const sent: Array<{ content: string; meta: Record<string, string> }> = [];
    let now = 0;
    let idle = o.idle ?? true;
    const d = new WakeDispatcher({
      allowlist: o.allowlist ?? PairAllowlist.from([{ sender: "alden-1", recipient: "claude-code" }]),
      cap: new SlidingWindowCap({ limit: o.limit ?? 10, windowMs: 60_000, now: () => now }),
      isIdle: () => idle,
      send: async (w) => void sent.push(w)
    });
    return { d, sent, setIdle: (v: boolean) => (idle = v), advance: (ms: number) => (now += ms) };
  };

  it("REFUSES to dispatch at all until an allowlist is configured (XC-6)", async () => {
    const { d, sent } = make({ allowlist: PairAllowlist.from([]) });
    await expect(d.dispatch([msg(1, "alden-1", "hi")], { recipient: "claude-code", sinceId: 0 })).rejects.toBeInstanceOf(WakerNotConfiguredError);
    expect(sent).toEqual([]);
  });

  it("drops a batch whose sender is not on the allowlist, and says which pair it refused", async () => {
    const { d, sent } = make();
    const res = await d.dispatch([msg(1, "stranger", "hi")], { recipient: "claude-code", sinceId: 0 });
    expect(res).toEqual({ state: "denied", reason: "not_allowlisted", pair: "stranger->claude-code" });
    expect(sent).toEqual([]);
  });

  it("delivers an allowed batch once, with the wake payload", async () => {
    const { d, sent } = make();
    const res = await d.dispatch([msg(7, "alden-1", "body stays home")], { recipient: "claude-code", sinceId: 6 });
    expect(res.state).toBe("sent");
    expect(sent).toHaveLength(1);
    expect(sent[0].content).not.toContain("body stays home");
  });

  it("HOLDS a wake while the session is mid-turn and delivers it when the session goes idle", async () => {
    const { d, sent, setIdle } = make({ idle: false });
    const held = await d.dispatch([msg(9, "alden-1", "x")], { recipient: "claude-code", sinceId: 8 });
    expect(held).toEqual({ state: "held", reason: "session_busy" });
    expect(sent).toEqual([]);
    setIdle(true);
    const flushed = await d.flush();
    expect(flushed).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0].meta.first_id).toBe("9");
  });

  it("coalesces everything held during one busy turn into a SINGLE wake (a burst is one interruption)", async () => {
    const { d, sent, setIdle } = make({ idle: false });
    await d.dispatch([msg(1, "alden-1", "a")], { recipient: "claude-code", sinceId: 0 });
    await d.dispatch([msg(2, "alden-1", "b"), msg(3, "alden-1", "c")], { recipient: "claude-code", sinceId: 1 });
    setIdle(true);
    expect(await d.flush()).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0].meta).toMatchObject({ count: "3", first_id: "1", last_id: "3" });
  });

  it("refuses a wake that would exceed the pair's rate cap, and allows it again once the window slides", async () => {
    const { d, sent, advance } = make({ limit: 1 });
    expect((await d.dispatch([msg(1, "alden-1", "a")], { recipient: "claude-code", sinceId: 0 })).state).toBe("sent");
    const capped = await d.dispatch([msg(2, "alden-1", "b")], { recipient: "claude-code", sinceId: 1 });
    expect(capped.state).toBe("rate_limited");
    expect(sent).toHaveLength(1);
    advance(60_001);
    expect((await d.dispatch([msg(3, "alden-1", "c")], { recipient: "claude-code", sinceId: 2 })).state).toBe("sent");
    expect(sent).toHaveLength(2);
  });

  it("never lets a send failure lose the wake — it stays held for the next flush", async () => {
    const sendFail = vi.fn(async () => { throw new Error("channel down"); });
    const d = new WakeDispatcher({
      allowlist: PairAllowlist.from([{ sender: "alden-1", recipient: "claude-code" }]),
      cap: new SlidingWindowCap({ limit: 10, windowMs: 60_000, now: () => 0 }),
      isIdle: () => true,
      send: sendFail
    });
    const res = await d.dispatch([msg(5, "alden-1", "x")], { recipient: "claude-code", sinceId: 4 });
    expect(res).toEqual({ state: "held", reason: "send_failed" });
    expect(d.pending).toBe(1);
  });
});
