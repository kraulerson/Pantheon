/**
 * BridgeClient unit tests (no network).
 *
 * Covers: env factory (fail-closed when unset), constructor guards, result extraction
 * (structured vs text), array unwrapping, and the memory/mailbox/check mapping to typed
 * results. The protected `call` seam is overridden so mapping is exercised without a transport.
 * Also asserts the Bearer token never leaks into a thrown error.
 */

import { describe, it, expect } from "vitest";
import {
  BridgeClient,
  BridgeError,
  bridgeClientFromEnv,
  asArray,
  extractToolResult
} from "../src/bridge/client.js";

/** Test subclass that returns canned tool payloads instead of hitting a transport. */
class FakeBridge extends BridgeClient {
  public lastCall: { name: string; args: Record<string, unknown> } | undefined;
  private readonly payloads: Record<string, unknown>;
  constructor(payloads: Record<string, unknown>) {
    super({ url: "http://x/mcp", token: "SECRET-TOKEN" });
    this.payloads = payloads;
  }
  protected override async call(name: string, args: Record<string, unknown>): Promise<unknown> {
    this.lastCall = { name, args };
    return Promise.resolve(this.payloads[name]);
  }
}

describe("bridgeClientFromEnv", () => {
  it("returns undefined (fail closed) when url or token is unset", () => {
    expect(bridgeClientFromEnv({})).toBeUndefined();
    expect(bridgeClientFromEnv({ BRIDGE_MCP_URL: "http://x/mcp" })).toBeUndefined();
    expect(bridgeClientFromEnv({ BRIDGE_MCP_TOKEN: "t" })).toBeUndefined();
  });
  it("constructs a client when both are present", () => {
    expect(bridgeClientFromEnv({ BRIDGE_MCP_URL: "http://x/mcp", BRIDGE_MCP_TOKEN: "t" })).toBeInstanceOf(BridgeClient);
  });
});

describe("BridgeClient constructor guards", () => {
  it("throws BridgeError without leaking the token", () => {
    expect(() => new BridgeClient({ url: "", token: "SECRET" })).toThrow(BridgeError);
    try {
      new BridgeClient({ url: "http://x", token: "" });
    } catch (e) {
      expect(String(e)).not.toContain("SECRET");
    }
  });
});

describe("extractToolResult / asArray", () => {
  it("prefers structuredContent", () => {
    expect(extractToolResult({ structuredContent: { hits: [1] } })).toEqual({ hits: [1] });
  });
  it("parses the first text content block as JSON", () => {
    expect(extractToolResult({ content: [{ type: "text", text: '{"a":1}' }] })).toEqual({ a: 1 });
  });
  it("falls back to the raw string when text is not JSON", () => {
    expect(extractToolResult({ content: [{ type: "text", text: "plain" }] })).toBe("plain");
  });
  it("returns undefined when there is no usable content", () => {
    expect(extractToolResult({})).toBeUndefined();
  });
  it("unwraps wrapped arrays and tolerates non-arrays", () => {
    expect(asArray([1, 2])).toEqual([1, 2]);
    expect(asArray({ messages: [3] })).toEqual([3]);
    expect(asArray({ nope: 1 })).toEqual([]);
    expect(asArray(null)).toEqual([]);
  });
});

describe("BridgeClient mapping", () => {
  it("memorySearch maps hits and forwards collection+limit", async () => {
    const c = new FakeBridge({
      alden_memory_search: { hits: [{ collection: "alden-1", score: 0.8, id: 7, information: "doc", metadata: { k: 1 } }] }
    });
    const hits = await c.memorySearch({ query: "q", collection: "alden-1", limit: 4 });
    expect(c.lastCall).toEqual({ name: "alden_memory_search", args: { query: "q", collection: "alden-1", limit: 4 } });
    expect(hits).toEqual([{ collection: "alden-1", score: 0.8, id: 7, information: "doc", metadata: { k: 1 } }]);
  });

  it("mailboxList maps messages and translates camelCase args to snake_case", async () => {
    const c = new FakeBridge({
      alden_mailbox_list: [{ id: 3, timestamp: "t", sender: "s", recipient: "r", message: "m", read: true }]
    });
    const msgs = await c.mailboxList({ sinceId: 2, limit: 5, newestFirst: true });
    expect(c.lastCall?.args).toEqual({ since_id: 2, limit: 5, newest_first: true });
    expect(msgs).toEqual([{ id: 3, timestamp: "t", sender: "s", recipient: "r", message: "m", read: true }]);
  });

  it("mailboxCheck maps unread_count + latest_timestamp", async () => {
    const c = new FakeBridge({ alden_mailbox_check: { unread_count: 2, latest_timestamp: "2026-01-01T00:00:00Z" } });
    expect(await c.mailboxCheck()).toEqual({ unreadCount: 2, latestTimestamp: "2026-01-01T00:00:00Z" });
  });

  it("mailboxCheck tolerates a missing latest_timestamp", async () => {
    const c = new FakeBridge({ alden_mailbox_check: { unread_count: 0 } });
    expect(await c.mailboxCheck()).toEqual({ unreadCount: 0, latestTimestamp: null });
  });
});
