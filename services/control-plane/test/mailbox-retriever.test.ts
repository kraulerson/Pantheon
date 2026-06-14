/**
 * MailboxRetriever unit tests (mock BridgeClient — no network).
 *
 * Invariants: messages map to trusted:false items; since_id high-water polling advances on
 * each call so the same message is not re-surfaced; label encodes id/sender/timestamp.
 */

import { describe, it, expect } from "vitest";
import { MailboxRetriever } from "../src/preprocessor/retrievers/mailbox.js";
import type { MailboxListPort, MailboxMessage } from "../src/bridge/client.js";

function msg(over: Partial<MailboxMessage> = {}): MailboxMessage {
  return {
    id: 1,
    timestamp: "2026-06-13T00:00:00Z",
    sender: "cloud-alden",
    recipient: "alden-1",
    message: "heartbeat",
    read: false,
    ...over
  };
}

function mockPort(batches: MailboxMessage[][]): MailboxListPort & { calls: Array<{ sinceId?: number; limit?: number; newestFirst?: boolean }> } {
  const calls: Array<{ sinceId?: number; limit?: number; newestFirst?: boolean }> = [];
  let i = 0;
  return {
    calls,
    async mailboxList(args = {}) {
      calls.push({
        ...(args.sinceId !== undefined ? { sinceId: args.sinceId } : {}),
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
        ...(args.newestFirst !== undefined ? { newestFirst: args.newestFirst } : {})
      });
      const out = batches[i] ?? [];
      i += 1;
      return out;
    }
  };
}

describe("MailboxRetriever", () => {
  it("maps mailbox messages to trusted:false items with id/sender/timestamp in the label", async () => {
    const port = mockPort([[msg({ id: 5, sender: "cloud-alden", timestamp: "2026-06-13T09:00:00Z", message: "ping" })]]);
    const r = new MailboxRetriever(port);

    const items = await r.retrieve("alden-1", "anything");

    expect(items).toHaveLength(1);
    expect(items[0]?.trusted).toBe(false);
    expect(items[0]?.source).toBe("mailbox");
    expect(items[0]?.content).toBe("ping");
    expect(items[0]?.label).toContain("5");
    expect(items[0]?.label).toContain("cloud-alden");
    expect(items[0]?.label).toContain("2026-06-13T09:00:00Z");
  });

  it("advances the since_id high-water mark so a message is surfaced only once", async () => {
    const port = mockPort([
      [msg({ id: 10 }), msg({ id: 11 })],
      [msg({ id: 12 })]
    ]);
    const r = new MailboxRetriever(port);

    const first = await r.retrieve("alden-1", "q");
    expect(first).toHaveLength(2);
    // First poll has no high-water mark yet.
    expect(port.calls[0]?.sinceId).toBeUndefined();

    const second = await r.retrieve("alden-1", "q");
    expect(second).toHaveLength(1);
    // Second poll resumes after the highest id seen (11).
    expect(port.calls[1]?.sinceId).toBe(11);
  });

  it("forwards the configured limit and returns empty on an empty mailbox", async () => {
    const port = mockPort([[]]);
    const r = new MailboxRetriever(port, { limit: 3 });
    await expect(r.retrieve("alden-1", "q")).resolves.toEqual([]);
    expect(port.calls[0]?.limit).toBe(3);
  });
});
