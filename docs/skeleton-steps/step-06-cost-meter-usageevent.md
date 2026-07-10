# Step 6 — Per-identity cost meter: UsageEvent (charter item 6; decision F restored; DM-5)

**Build Loop required.** `--start-feature "usage-event-cost-meter"`.
**Preconditions:** step 3 (Facade). Step 5 provides the streaming usage tap (this step
can land before step 5 for the non-streaming path and pick up the tap after).

## Goal

The R18 ledger seed: every completion writes one append-only `usage_event` row.
The schema is **household-ratified** (bus 1102/1104, Bible §5 UsageEvent + DM-5) — do
not deviate from it without a recorded decision. **No prompt or response content, ever
— a schema invariant, not a convention** (there is no column it could go in).

## Schema (from Bible §5 — copy exactly)

```sql
CREATE TABLE IF NOT EXISTS usage_event (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  at                   TEXT NOT NULL,        -- server-authoritative ISO 8601; NEVER caller-supplied
  identity_slug        TEXT NOT NULL,        -- the identity CLASS (aggregates stay meaningful)
  session_id           TEXT NOT NULL,
  thread_id            TEXT,                 -- nullable until the bridge exposes it (Alden 0.2, 2026-07-12)
  brain_slug           TEXT NOT NULL,
  brain_classification TEXT NOT NULL CHECK (brain_classification IN ('local','cloud_ok')),
  prompt_tokens        INTEGER,
  completion_tokens    INTEGER,
  total_tokens         INTEGER,
  cost                 REAL,                 -- null for local brains
  rate_version         TEXT,                 -- null until rate tables exist (ADR-0006 projection)
  trigger              TEXT NOT NULL CHECK (trigger IN ('interactive','wake','quiet_loop','consolidation')),
  identity_state_hash  TEXT                  -- nullable until alden-infra Profile hashes exist
);
CREATE INDEX IF NOT EXISTS idx_usage_thread  ON usage_event(thread_id);
CREATE INDEX IF NOT EXISTS idx_usage_trigger ON usage_event(trigger);
CREATE INDEX IF NOT EXISTS idx_usage_at      ON usage_event(at);
```

Skeleton-time values: `trigger='interactive'` always (wake/quiet_loop arrive with the
Autonomy Driver); `brain_classification` mapped from `BackendRegistry.kind`
(`local_alden1`→`local`; `future_cloud`→`cloud_ok`); `thread_id`/`rate_version`/
`identity_state_hash` null with their arrival notes above. Nullable-now columns exist
NOW because retrofit is expensive — that was the household's whole point.

## Build Loop — tests first

`test/usage-store.test.ts` + `test/usage-meter.integration.test.ts`, failing first:

1. Append + list round-trip; `at` is generated in the store (a caller-supplied `at` is
   ignored/rejected — server-authoritative by test).
2. **No-content proof:** the store's insert API accepts only the schema fields — a test
   asserting the table has no content-capable column beyond the enumerated ones
   (introspect `PRAGMA table_info(usage_event)`).
3. Per-identity isolation: rows for identity A never appear in identity B's rollup
   (the acceptance item "no cross-identity blending").
4. Pipeline integration: a chat call through the Facade (fake backend returning a
   usage object) appends exactly one row with the right identity/session/brain/counts.
5. Append-only: the repository exposes no update/delete method (API-shape test).

## Implementation outline

Follow the existing repository pattern exactly (`src/registry/sqlite-repository.ts` is
the canonical template — SCHEMA const, ctor with WAL pragma, prepared statements,
`toX()` mappers):

1. New module `src/usage/`: `types.ts` (`UsageEvent`, `UsageRepository` — `append`,
   `listByIdentity`, `totalsByIdentity`, `listByThread`), `sqlite-store.ts`
   (`SqliteUsageStore`), `index.ts` barrel. Add `src/usage/**` to the vitest coverage
   include list (`vitest.config.ts:14–22`).
2. Wire in the Facade entrypoint (same DB file) and pass into the `Preprocessor`
   (new optional `usage?: UsageRepository` in `PreprocessorOptions`,
   `src/preprocessor/index.ts:40–51`); append after the backend returns
   (`index.ts:122–126`), and from the streaming path's usage promise (step 5).
   A missing/null usage object records the event with null counts — the meter must
   never fail a conversation (record-or-log, never throw into the chat path).
3. Admin visibility (minimal, skeleton-honest): `GET /api/usage?identity=<slug>` on the
   **admin** service (operator-guarded) returning rollups — enough to verify the
   acceptance item without building UI.

## Verify

- Tests green; coverage ≥90% holds.
- Manual: two identities (or one identity + a bare-session variant), one conversation
  each → `curl -s -H "Authorization: Bearer $ADMIN_API_TOKEN" localhost:8088/api/usage?identity=alden-1`
  shows that identity's counts only; `sqlite3 data/control-plane.db "SELECT * FROM usage_event"`
  shows counts and NO message text anywhere.

## Rollback

Additive table + optional wiring; revert commit. (Schema-at-boot convention means no
migration file to unwind — the table simply stops being created on fresh DBs.)

## Acceptance mapping

Directly satisfies the cost-meter acceptance item (attribution + no-content +
no-blending).
