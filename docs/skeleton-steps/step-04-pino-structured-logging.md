# Step 4 — pino structured logging + correlation IDs (charter item 4)

**Build Loop required.** `scripts/process-checklist.sh --start-feature "pino-structured-logging"`.
**Preconditions:** step 3 done (two services exist; this step instruments both).

## Goal

Bible §8 made concrete: pino JSON logs with a **correlation ID** tying one UI message →
grounding assembly → taint decision → backend call, in both services, before the first
assembled debugging session. Today pino is NOT a dependency, Fastify's logger is off
(`src/http/app.ts:115` `Fastify({ logger: false })`), interim logging is `console.error`
(`src/server.ts:110,115`; retriever warns at `src/preprocessor/retrievers/memory.ts:69`,
`mailbox.ts:50`), and **no correlation-id machinery exists anywhere**.

## Design constraints

1. **Allow-list redaction (D8, hard rule):** log only named non-secret fields. Never log:
   tokens, `Authorization` headers, message/prompt/response content, recalled text.
   The logger wrapper must make the safe path the easy path — a `log.info(obj)` helper
   that only serializes known keys.
2. Correlation ID is generated **at the Facade edge** (per inbound
   `/v1/chat/completions` request), propagated through `Preprocessor.handle` and into
   the backend call; the admin service generates its own per-request IDs.
3. Error bodies toward clients stay sanitized (code + correlation ID, never raw
   exception text) — the existing error handler in `buildApp` keeps that behavior.

## Build Loop — tests first

`test/logging.test.ts`, verify failing first:
1. A chat request through the Facade produces log lines (pino test stream) for
   `request_received`, `grounding_assembled` (fields: sessionId, identityId, itemCount,
   tainted — NO content), `backend_forwarded`, `request_completed`, all sharing one
   `correlationId`.
2. A log call handed a secret-bearing object (e.g. `{ authorization: "Bearer x" }`)
   emits NO secret (allow-list drop proven by test).
3. Startup logs are JSON (no bare `console.error` on the happy path).

## Implementation outline

1. `npm i --save-exact pino@<current 9.x>` (pin exact; update Bible §3 as-built list
   in the same commit).
2. New `src/logging.ts`: `makeLogger(service: "admin"|"facade")` returning a pino
   instance (level from `LOG_LEVEL`, default `info`) + `withCorrelation(log, id)`
   child-logger helper + the allow-list serializer.
3. Fastify wiring: pass `loggerInstance` (or keep `logger:false` and log explicitly in
   an `onRequest`/`onResponse` hook pair with `randomUUID()` correlation IDs — pick the
   explicit-hook route; it keeps the allow-list absolute).
4. Thread `correlationId` as an optional field on `PreprocessRequest`
   (`src/preprocessor/index.ts:53–57`) and log at the pipeline stages (resolve → ground
   → taint → forward, `index.ts:82–128`).
5. Replace the `console.error` sites in `src/server-admin.ts`/`src/server-facade.ts`
   startup paths and the two retriever `console.warn`s with the logger.
6. CLIs (`src/cli/*.ts`) keep `console.error` — they are interactive tools, not services.

## Verify

- Tests green; coverage ≥90% holds (add `src/logging.ts` to the vitest coverage include
  list, `vitest.config.ts:14–22`).
- Manual: one chat request → `journalctl -u pantheon-facade@<user> -o cat | tail` shows
  the four JSON stages with one shared correlationId; grep the log for the identity's
  Peta token and for message text → **zero hits** (this is also the Phase 3 secrets-grep
  pattern, TM-001/TM-008).

## Rollback

Revert the commit; nothing persistent changes (logs only).

## Acceptance mapping

Enables debugging of every later acceptance item; the secrets-grep check becomes part
of the smoke-test evidence.
