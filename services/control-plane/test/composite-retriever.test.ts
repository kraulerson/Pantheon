/**
 * CompositeRetriever unit tests + end-to-end taint flip through the real engine.
 *
 * The composite runs only the retrievers enabled by the session's GroundingSourceState
 * toggles (persona/memory/mailbox) and concatenates their trusted:false items. Anything
 * returned must flip session taint via the real Preprocessor + grounding engine.
 */

import { describe, it, expect } from "vitest";
import { CompositeRetriever, type GroundingSourceState } from "../src/preprocessor/retrievers/composite.js";
import { buildCompositeRetriever } from "../src/preprocessor/retrievers/index.js";
import type { MemorySearchPort, MailboxListPort } from "../src/bridge/client.js";
import type { GroundingRetriever, RetrievedItem } from "../src/preprocessor/retriever.js";
import { makeRecalledItem } from "../src/grounding/index.js";
import { Preprocessor } from "../src/preprocessor/index.js";
import { SqliteSessionStore } from "../src/session/sqlite-store.js";
import { SqliteRegistry } from "../src/registry/sqlite-repository.js";
import { RegistryService } from "../src/registry/service.js";
import type { ChatBackend, ChatCompletionRequest, ChatCompletionResponse } from "../src/backend/index.js";

function fixed(items: RetrievedItem[]): GroundingRetriever {
  return { retrieve: () => items };
}

const personaItem = makeRecalledItem("persona", "persona text");
const memoryItem = makeRecalledItem("qdrant", "memory text");
const mailboxItem = makeRecalledItem("mailbox", "mailbox text");

function makeComposite(toggles: GroundingSourceState) {
  return new CompositeRetriever({
    toggles,
    persona: fixed([personaItem]),
    memory: fixed([memoryItem]),
    mailbox: fixed([mailboxItem])
  });
}

describe("CompositeRetriever toggles", () => {
  it("runs all enabled retrievers and concatenates their items", async () => {
    const c = makeComposite({ persona: true, memory: true, mailbox: true });
    const items = await c.retrieve("alden-1", "q");
    expect(items.map((i) => i.content)).toEqual(["persona text", "memory text", "mailbox text"]);
    expect(items.every((i) => i.trusted === false)).toBe(true);
  });

  it("skips disabled sources", async () => {
    const c = makeComposite({ persona: true, memory: false, mailbox: false });
    const items = await c.retrieve("alden-1", "q");
    expect(items.map((i) => i.source)).toEqual(["persona"]);
  });

  it("returns nothing when every source is disabled", async () => {
    const c = makeComposite({ persona: false, memory: false, mailbox: false });
    await expect(c.retrieve("alden-1", "q")).resolves.toEqual([]);
  });
});

describe("buildCompositeRetriever (production wiring)", () => {
  it("wires memory+mailbox against a single bridge port and scopes memory to the explicit collection", async () => {
    const seen: string[] = [];
    const bridge: MemorySearchPort & MailboxListPort = {
      async memorySearch(args) {
        seen.push(args.collection);
        return [{ collection: args.collection, score: 0.5, id: "x", information: "mem", metadata: {} }];
      },
      async mailboxList() {
        return [{ id: 1, timestamp: "t", sender: "s", recipient: "r", message: "msg", read: false }];
      }
    };
    const c = buildCompositeRetriever(bridge, { collection: "alden-cloud" });
    const items = await c.retrieve("cloud", "q");
    expect(seen).toEqual(["alden-cloud"]);
    expect(seen).not.toContain("all");
    expect(items.map((i) => i.source).sort()).toEqual(["mailbox", "qdrant"]);
    expect(items.every((i) => i.trusted === false)).toBe(true);
  });
});

describe("CompositeRetriever — taint flip through the REAL engine", () => {
  function backendSpy(): ChatBackend {
    return {
      chatCompletions(): Promise<ChatCompletionResponse> {
        return Promise.resolve({
          id: "spy",
          object: "chat.completion",
          choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }]
        });
      }
    };
  }

  it("flips session taint true when the composite returns any (untrusted) recall", async () => {
    const registry = new RegistryService(new SqliteRegistry());
    const bound = registry.createBackend({ kind: "local_alden1", endpoint: "10.0.0.1:8080", displayName: "B", enabled: true });
    const sessions = new SqliteSessionStore();
    const pre = new Preprocessor({
      registry,
      sessions,
      backendClient: backendSpy(),
      retriever: makeComposite({ persona: false, memory: true, mailbox: false }),
      resolveIdentity: (id) => (id === "alden-1" ? { identityId: id, backendId: bound.id } : undefined)
    });
    const req: ChatCompletionRequest = { model: "x", messages: [{ role: "user", content: "hi" }] };
    const out = await pre.handle({ sessionId: "s1", identityId: "alden-1", request: req });
    expect(out.tainted).toBe(true);
    expect(sessions.get("s1")?.taintFlag).toBe(true);
  });

  it("does NOT taint when all composite sources are disabled (only the trusted user item)", async () => {
    const registry = new RegistryService(new SqliteRegistry());
    const bound = registry.createBackend({ kind: "local_alden1", endpoint: "10.0.0.1:8080", displayName: "B", enabled: true });
    const sessions = new SqliteSessionStore();
    const pre = new Preprocessor({
      registry,
      sessions,
      backendClient: backendSpy(),
      retriever: makeComposite({ persona: false, memory: false, mailbox: false }),
      resolveIdentity: (id) => (id === "alden-1" ? { identityId: id, backendId: bound.id } : undefined)
    });
    const req: ChatCompletionRequest = { model: "x", messages: [{ role: "user", content: "hi" }] };
    await pre.handle({ sessionId: "s2", identityId: "alden-1", request: req });
    expect(sessions.get("s2")?.taintFlag).toBe(false);
  });
});
