# Step 5 — SSE streaming pass-through (charter item 5, decision F)

**Build Loop required.** `--start-feature "sse-streaming-passthrough"`.
**Preconditions:** step 3 (Facade exists, chat mounted). Step 4 recommended first
(correlation IDs make streaming bugs debuggable).

## Goal

`stream:true` chat requests stream SSE from the backend through the Facade to the UI
("words appear as generated" — acceptance item). The seam is already documented in
code, verbatim (`src/backend/client.ts:92–97`):

```ts
if (req.stream === true) {
  // ---- STREAMING SEAM (documented, not implemented this increment) ----
  // SSE pass-through (text/event-stream, `data:` chunks, `[DONE]`) needs the route to stream
  // the upstream body straight through. Implement in the streaming increment.
  throw new BackendError("streaming not yet implemented (documented seam)", 0, backend.id);
}
```

## Design constraints

1. **Grounding/taint/stash happen BEFORE the stream starts** — they depend on the
   request + retrieved items, not the completion (`Preprocessor.handle`,
   `src/preprocessor/index.ts:82–128`: everything up to L117 is pre-flight). Taint
   semantics are unchanged by streaming.
2. **Pass-through, not re-framing:** pipe the upstream `text/event-stream` body to the
   client verbatim, including the `data: [DONE]` terminator. Do not parse/re-emit
   chunks (except the usage tap in constraint 3).
3. **Cost-meter interplay (step 6):** request
   `stream_options: {"include_usage": true}` on the upstream call so the final chunk
   carries token counts; the pass-through TEEs the stream only to read that final
   usage object — content is never stored (DM-5 invariant). If the backend omits
   usage, record the event with null token counts rather than blocking the stream.
4. Fail-closed remains: transport error before first byte → 502 as today
   (`BackendError`); error mid-stream → terminate the SSE cleanly (the client sees a
   truncated stream + logged correlationId; never a silent hang).

## Build Loop — tests first

Extend `test/backend-client.test.ts` (the current expectation at L81–86 —
`.rejects.toThrow(/streaming not yet implemented/i)` — is DELETED and replaced) +
new `test/streaming-route.test.ts`. Verify failing first:

1. `BackendClient.chatCompletionsStream(backend, req)` with an injected `fetchFn`
   returning a mock SSE `ReadableStream` yields the exact chunk sequence + `[DONE]`.
2. Non-streaming path (`stream` absent/false) behaves exactly as before (regression).
3. Route test: POST `/v1/chat/completions` with `"stream":true` responds
   `content-type: text/event-stream` and relays the mock chunks in order.
4. Usage tap: a mock stream whose final chunk carries `usage` yields the parsed counts
   to the caller (hook consumed by step 6).

## Implementation outline

1. `src/backend/client.ts`: add `chatCompletionsStream(backend, req): Promise<StreamResult>`
   (`{ stream: ReadableStream<Uint8Array>, usage: Promise<Usage|null> }`) — the method
   name the module docstring (L10–11) already reserves. Force `stream:true` +
   `stream_options.include_usage` in the outgoing body. Extend the `ChatBackend`
   interface (`client.ts:124–126`).
2. `src/preprocessor/index.ts`: add `handleStream(input)` sharing all pre-flight logic
   with `handle` (extract the common private method), returning the stream + the
   pre-computed `tainted` + the usage promise.
3. `src/http/routes/chat-completions.ts`: branch on `body.stream === true` → set SSE
   headers (`text/event-stream`, `no-cache`, `keep-alive`), pipe via `reply.raw`,
   flush per chunk.
4. `claude_cli`-kind backends stay excluded (`OPENAI_WIRE_KINDS`, `client.ts:53–57`) —
   the Anthropic translation seam is separate and untouched.

## Verify

- Tests green, coverage holds.
- Manual (with the live 122B backend `192.168.1.89:8080`):
  `curl -N localhost:8089/v1/chat/completions -H 'content-type: application/json' -H 'x-pantheon-identity: alden-1' -d '{"stream":true,"messages":[{"role":"user","content":"count to 20 slowly"}]}'`
  → chunks arrive incrementally (not one flush), ends with `data: [DONE]`.
- Through LibreChat (after step 8): words appear as generated — the acceptance item.

## Rollback

Revert commit; the non-streaming path is regression-tested independently.

## Acceptance mapping

Directly satisfies "Streaming visibly works in the UI"; provides the usage tap step 6
depends on.

## Added requirement — per-conversation thinking control (ruling 2026-08-26)

Karl: the thinking level must be **selectable per conversation for every LLM selection, identity
or raw, with the full range the brain supports**. Measured 2026-08-26: both llama.cpp brains honour
exactly one per-request control, `chat_template_kwargs.enable_thinking` (on/off); `reasoning_effort`,
`reasoning_budget`, `thinking_budget` and flat keys are ignored. LibreChat's Parameters panel exposes
a **Reasoning effort** dropdown (`minimal | low | medium | high`) but cannot send a nested key, so the
Facade is the translator:

- The Facade MUST read `reasoning_effort` from the incoming request and translate it per bound brain
  into what that brain honours today: `minimal | low` → `chat_template_kwargs.enable_thinking=false`,
  `medium | high` → thinking on; when a brain gains a real budget/effort control, map the four levels
  onto it (a per-brain table, not code branches).
- Bare sessions (no identity — Bible §9 C.1 "none") route through the Facade too, so the same
  dropdown works on the Basic LLM entries; the four picker variants in `deploy/librechat.yaml`
  ("fast" / "thinking" per brain) are the interim and collapse back to one entry per brain then.
- The Facade MUST forward `reasoning_content` deltas so LibreChat shows the "Thinking" block; the
  title-generation request MUST run with thinking off regardless of the conversation's setting.
