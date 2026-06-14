/**
 * MemoryRetriever unit tests (mock BridgeClient — no network).
 *
 * Invariants under test (#13 / identity isolation):
 *  - every mapped hit is trusted:false (recalled);
 *  - the identity's EXPLICIT collection is passed to the bridge — NEVER "all";
 *  - optional includeShared also pulls "alden-shared" (and only then);
 *  - content === the hit's `information`; label encodes collection#id and score.
 */

import { describe, it, expect, vi } from "vitest";
import { MemoryRetriever } from "../src/preprocessor/retrievers/memory.js";
import type { MemorySearchPort, MemoryHit } from "../src/bridge/client.js";

function hit(over: Partial<MemoryHit> = {}): MemoryHit {
  return {
    collection: "alden-cloud",
    score: 0.42,
    id: "h1",
    information: "recalled fact",
    metadata: {},
    ...over
  };
}

function mockPort(hits: MemoryHit[]): MemorySearchPort & { calls: Array<{ query: string; collection: string; limit?: number }> } {
  const calls: Array<{ query: string; collection: string; limit?: number }> = [];
  return {
    calls,
    async memorySearch(args) {
      calls.push({ query: args.query, collection: args.collection, ...(args.limit !== undefined ? { limit: args.limit } : {}) });
      // Return only hits whose collection matches the requested one (simulates scoping).
      return hits.filter((h) => h.collection === args.collection);
    }
  };
}

describe("MemoryRetriever", () => {
  it("passes the identity's EXPLICIT collection (never \"all\") and maps hits to trusted:false", async () => {
    const port = mockPort([hit({ collection: "alden-cloud", id: "m1", score: 0.91, information: "cloud memory" })]);
    const r = new MemoryRetriever(port, { collection: "alden-cloud" });

    const items = await r.retrieve("cloud", "what do you recall");

    expect(port.calls).toHaveLength(1);
    expect(port.calls[0]?.collection).toBe("alden-cloud");
    expect(port.calls.every((c) => c.collection !== "all")).toBe(true);
    expect(items).toHaveLength(1);
    expect(items[0]?.trusted).toBe(false);
    expect(items[0]?.source).toBe("qdrant");
    expect(items[0]?.content).toBe("cloud memory");
    expect(items[0]?.label).toContain("alden-cloud");
    expect(items[0]?.label).toContain("m1");
    expect(items[0]?.label).toContain("0.91");
  });

  it("forwards the configured limit", async () => {
    const port = mockPort([]);
    const r = new MemoryRetriever(port, { collection: "alden-1", limit: 7 });
    await r.retrieve("alden-1", "q");
    expect(port.calls[0]?.limit).toBe(7);
  });

  it("with includeShared, also queries alden-shared (two scoped calls, never \"all\")", async () => {
    const port = mockPort([
      hit({ collection: "alden-1", id: "a", information: "own" }),
      hit({ collection: "alden-shared", id: "s", information: "shared" })
    ]);
    const r = new MemoryRetriever(port, { collection: "alden-1", includeShared: true });

    const items = await r.retrieve("alden-1", "q");

    const collections = port.calls.map((c) => c.collection).sort();
    expect(collections).toEqual(["alden-1", "alden-shared"]);
    expect(port.calls.every((c) => c.collection !== "all")).toBe(true);
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.trusted === false)).toBe(true);
    expect(items.map((i) => i.content).sort()).toEqual(["own", "shared"]);
  });

  it("without includeShared, does NOT query alden-shared", async () => {
    const port = mockPort([hit({ collection: "alden-1", id: "a", information: "own" })]);
    const r = new MemoryRetriever(port, { collection: "alden-1" });
    await r.retrieve("alden-1", "q");
    expect(port.calls.map((c) => c.collection)).toEqual(["alden-1"]);
  });

  it("returns empty (no throw) when the bridge yields no hits", async () => {
    const port = mockPort([]);
    const r = new MemoryRetriever(port, { collection: "alden-1" });
    await expect(r.retrieve("alden-1", "q")).resolves.toEqual([]);
  });

  it("rejects an identity configured with the \"all\" merge-collection (isolation guard)", () => {
    const port = mockPort([]);
    // @ts-expect-error "all" is not assignable to an isolated identity collection
    expect(() => new MemoryRetriever(port, { collection: "all" })).toThrow();
  });

  it("ignores a single source failure and still returns the other source's hits", async () => {
    const port: MemorySearchPort = {
      async memorySearch(args) {
        if (args.collection === "alden-shared") throw new Error("shared down");
        return [hit({ collection: "alden-1", id: "a", information: "own" })];
      }
    };
    const r = new MemoryRetriever(port, { collection: "alden-1", includeShared: true });
    const spy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const items = await r.retrieve("alden-1", "q");
    spy.mockRestore();
    expect(items.map((i) => i.content)).toEqual(["own"]);
  });
});
