# Step 7 — Session binding at the Facade + brain-busy queue (charter item 7, decision E)

**Build Loop required.** `--start-feature "session-binding-busy-queue"`.
**Preconditions:** step 3 (Facade + preprocessor mounted). Step 5 helps (streaming) but
is not required.

## Goal

Two halves of decision E:

1. **Binding** — the immutable identity+backend binding enforced at runtime, persisted,
   no mid-session swap. GOOD NEWS: this is **already implemented** in the preprocessor
   (`src/preprocessor/index.ts:84–98`: backend resolved ONLY from the identity, request
   body never consulted; `SqliteSessionStore.getOrCreate` never rebinds —
   `src/session/sqlite-store.ts:53–64`) and became LIVE when step 3 mounted it. This
   step's binding work is **verification + one gap**: a request whose header identity
   does not match an existing session's `identityId` must be rejected (assert the
   stored binding on every call, not just at creation).
2. **Queue** — NO queue code exists today (verified: zero grep hits for queue/preempt
   in `src/`). Build the single-slot admission gate: one interactive conversation at a
   time per single-slot backend; waiters get an honest labeled position (C.7);
   interactive preempts background.

## Design constraints

- The queue lives in the **Facade process**, in front of `BackendClient` calls, keyed
  by `backendId`. Single-slot-ness is a `BackendRegistry` property — add a
  `singleSlot` boolean column (default `true` for `local_alden1`; additive
  schema-at-boot change to `src/registry/sqlite-repository.ts:50–80` SCHEMA + row
  mapper + types).
- **Honest labeling (C.7, CB/TL):** while queued, the client must be able to SEE
  "Brain busy — position N" as text. Two surfaces, both cheap:
  - `GET /v1/queue-state?backend=<id>` on the Facade (public path, read-only, no
    content) returning `{ position, depth }` for polling UIs;
  - while queued on a streaming request, emit SSE **comment** frames
    (`: queued position N`) every few seconds — legal SSE, ignored by parsers that
    don't understand them, visible in the inspector; the real C.7 chat-pane treatment
    arrives with the UI integration (post-skeleton).
- **Priority field now, preemption later:** the queue entry carries
  `priority: "interactive" | "background"`; everything is `interactive` at skeleton
  time (background arrives with machine auth, Phase 3) — but the ordering logic
  (interactive ahead of background) is implemented and tested NOW, so the Driver slots
  in without a queue rewrite.
- Fail-closed: on queue/backend failure the waiter gets an explicit error ("Backend
  unreachable — message not sent"), never a silent drop or infinite retry (C.7 spec).

## Build Loop — tests first

`test/brain-queue.test.ts` + binding additions to `test/preprocessor.test.ts`, failing first:

1. Two concurrent requests to a `singleSlot` backend: the second does not reach the
   (fake) backend until the first completes; its queue-state reports position 1.
2. Three waiters drain FIFO; positions update.
3. A `background`-priority entry never runs ahead of a queued `interactive` one.
4. Non-single-slot backends bypass the queue entirely.
5. Binding gap: a request carrying identity B against a session created for identity A
   is rejected 403 (no silent rebind — #14a at runtime).
6. Queue/backend failure → waiter receives the labeled error; queue does not deadlock
   (the slot frees).

## Implementation outline

1. `src/facade/brain-queue.ts` (new): `class BrainQueue` — `acquire(backendId, priority)`
   → `Promise<Release>` with FIFO + priority ordering + position notification callback;
   pure in-memory (queue state is process-local by design — an admin restart must not
   touch it, and a Facade restart honestly drops waiters with errors: ADR-0007
   failure-domain).
2. Wrap the backend call in `Preprocessor.handle`/`handleStream`
   (`src/preprocessor/index.ts:122–126`) with `acquire`/`release` (finally-safe).
3. `singleSlot` column + `GET /v1/queue-state` route + SSE comment emission while queued.
4. Session-binding assertion at `index.ts:98` (compare `session.identityId` to the
   resolved identity; mismatch → `IdentityResolutionError` 403 path).

## Verify

- Tests green; coverage holds.
- Manual: two terminals, two simultaneous long prompts to the 122B backend → second
  curl's queue-state shows `position:1`, then it proceeds when the first finishes; a
  third session against a non-single-slot backend is unaffected.
- With step 8 live: the C.1 popup's availability text ("busy — N waiting") can read
  `GET /v1/queue-state` (wire if the spike leaves time; else record as post-skeleton).

## Rollback

Queue is additive + in-memory; revert commit. The `singleSlot` column is additive.

## Acceptance mapping

Directly satisfies "Busy-brain queue: two concurrent sessions … the second shows the
C.7 labeled queue state, then proceeds" + strengthens the smoke test's binding claims.
