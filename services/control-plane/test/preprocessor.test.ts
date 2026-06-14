/**
 * Preprocessor orchestration tests.
 *
 * Pipeline (PROJECT_BIBLE §3 ADR / §9): resolve identity+backend (fail-closed) → assemble
 * grounded context (user trusted:true, recalled trusted:false) → update session taint
 * (monotonic) → stash assembled prompt for the inspector → forward via BackendClient → return.
 *
 * Security invariants under test:
 *  - fail-closed on unknown identity or unknown/disabled backend (no forward).
 *  - TM-002 / #14a: NEVER forwards to a backend named in the request body — only the
 *    identity's REGISTRY-bound backend is honored.
 *  - taint flips true (and stays true) whenever any trusted:false item is present.
 */

import { describe, it, expect } from "vitest";
import { Preprocessor, IdentityResolutionError } from "../src/preprocessor/index.js";
import { StubRetriever } from "../src/preprocessor/retriever.js";
import { SqliteSessionStore } from "../src/session/sqlite-store.js";
import { SqliteRegistry } from "../src/registry/sqlite-repository.js";
import { RegistryService } from "../src/registry/service.js";
import type { ChatCompletionRequest, ChatCompletionResponse } from "../src/backend/client.js";

/** A backend client spy that records what it was asked to forward, without any network. */
class SpyBackendClient {
  public forwardedTo: string[] = [];
  public lastRequest: ChatCompletionRequest | undefined;
  chatCompletions(backend: { endpoint: string }, req: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    this.forwardedTo.push(backend.endpoint);
    this.lastRequest = req;
    return Promise.resolve({
      id: "spy",
      object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }]
    });
  }
}

function harness(opts: { retriever?: StubRetriever } = {}) {
  const repo = new SqliteRegistry();
  const registry = new RegistryService(repo);
  const bound = registry.createBackend({
    kind: "local_alden1",
    endpoint: "10.0.0.1:8080",
    displayName: "Bound",
    enabled: true
  });
  // A second, registered-but-NOT-bound backend the attacker might try to name in the body.
  const other = registry.createBackend({
    kind: "local_alden1",
    endpoint: "10.0.0.99:9999",
    displayName: "Other",
    enabled: true
  });
  const sessions = new SqliteSessionStore();
  const spy = new SpyBackendClient();
  const pre = new Preprocessor({
    registry,
    sessions,
    backendClient: spy,
    retriever: opts.retriever ?? new StubRetriever(),
    // Identity directory: maps identity → its IMMUTABLE registry-bound backend (#14a).
    resolveIdentity: (identityId) => (identityId === "id-A" ? { identityId, backendId: bound.id } : undefined)
  });
  return { pre, spy, boundEndpoint: bound.endpoint, otherBackendId: other.id, sessions, registry };
}

const userReq: ChatCompletionRequest = {
  model: "whatever",
  messages: [{ role: "user", content: "what is my next task?" }]
};

describe("Preprocessor — fail-closed identity/backend resolution", () => {
  it("rejects an unknown identity (no forward)", async () => {
    const { pre, spy } = harness();
    await expect(pre.handle({ sessionId: "s1", identityId: "id-UNKNOWN", request: userReq })).rejects.toBeInstanceOf(
      IdentityResolutionError
    );
    expect(spy.forwardedTo).toEqual([]);
  });

  it("rejects when the identity's bound backend id is not in the registry (no forward)", async () => {
    const repo = new SqliteRegistry();
    const registry = new RegistryService(repo);
    const sessions = new SqliteSessionStore();
    const spy = new SpyBackendClient();
    const pre = new Preprocessor({
      registry,
      sessions,
      backendClient: spy,
      retriever: new StubRetriever(),
      // Binding points at a backend id that was never created.
      resolveIdentity: (id) => (id === "id-A" ? { identityId: id, backendId: "ghost-backend" } : undefined)
    });
    await expect(pre.handle({ sessionId: "s1", identityId: "id-A", request: userReq })).rejects.toBeInstanceOf(
      IdentityResolutionError
    );
    expect(spy.forwardedTo).toEqual([]);
  });

  it("handles a request with no user message (empty trusted input) without throwing", async () => {
    const { pre } = harness();
    const out = await pre.handle({
      sessionId: "s1",
      identityId: "id-A",
      request: { model: "x", messages: [{ role: "system", content: "boot" }] }
    });
    expect(out.completion.choices[0]?.message?.content).toBe("ok");
  });

  it("rejects when the bound backend no longer exists / is disabled (no forward)", async () => {
    const { pre, spy, registry, boundEndpoint } = harness();
    // Disable the bound backend.
    const be = registry.listBackends().find((b) => b.endpoint === boundEndpoint)!;
    registry.updateBackend(be.id, { enabled: false });
    await expect(pre.handle({ sessionId: "s1", identityId: "id-A", request: userReq })).rejects.toThrow();
    expect(spy.forwardedTo).toEqual([]);
  });
});

describe("Preprocessor — backend-binding (TM-002 / #14a)", () => {
  it("NEVER forwards to a backend named in the request body — only the identity's bound backend", async () => {
    const { pre, spy, boundEndpoint, otherBackendId } = harness();
    // Attacker stuffs the request with a different (registered) backend id + a rogue URL.
    const malicious: ChatCompletionRequest = {
      ...userReq,
      // @ts-expect-error — intentionally smuggling non-spec fields the body must not control
      backendId: otherBackendId,
      backend: "http://evil.example:9999",
      endpoint: "10.0.0.99:9999"
    };
    await pre.handle({ sessionId: "s1", identityId: "id-A", request: malicious });
    expect(spy.forwardedTo).toEqual([boundEndpoint]);
    expect(spy.forwardedTo).not.toContain("10.0.0.99:9999");
  });
});

describe("Preprocessor — taint (monotonic, by presence)", () => {
  it("flips session taint true when a trusted:false item is present, and it stays true", async () => {
    const { pre, sessions } = harness({ retriever: new StubRetriever() }); // stub returns a persona (untrusted)
    await pre.handle({ sessionId: "s1", identityId: "id-A", request: userReq });
    expect(sessions.get("s1")?.taintFlag).toBe(true);
    // A later turn cannot clear it.
    await pre.handle({ sessionId: "s1", identityId: "id-A", request: userReq });
    expect(sessions.get("s1")?.taintFlag).toBe(true);
  });

  it("does NOT taint when retrieval returns nothing untrusted (only the trusted user item)", async () => {
    const { pre, sessions } = harness({ retriever: new StubRetriever({ persona: false }) });
    await pre.handle({ sessionId: "s2", identityId: "id-A", request: userReq });
    expect(sessions.get("s2")?.taintFlag).toBe(false);
  });
});

describe("Preprocessor — stash for inspector + grounded forward", () => {
  it("stashes the assembled prompt and forwards the grounded messages", async () => {
    const { pre, spy } = harness();
    const out = await pre.handle({ sessionId: "s1", identityId: "id-A", request: userReq });
    expect(out.completion.choices[0]?.message?.content).toBe("ok");
    const stashed = pre.inspector.latest("s1");
    expect(stashed).toBeDefined();
    // The stash distinguishes trusted vs untrusted by TEXT/label, not color.
    expect(stashed?.items.some((i) => i.trusted === true && i.source === "user")).toBe(true);
    expect(stashed?.items.some((i) => i.trusted === false)).toBe(true);
    expect(stashed?.items.every((i) => typeof i.label === "string" && i.label.length > 0)).toBe(true);
    // Forwarded request carries the user's content somewhere in its messages.
    const fwd = JSON.stringify(spy.lastRequest);
    expect(fwd).toContain("what is my next task?");
  });
});
