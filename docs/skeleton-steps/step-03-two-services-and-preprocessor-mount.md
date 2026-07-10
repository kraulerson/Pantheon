# Step 3 — Two services from one codebase (ADR-0007) + mount the pre-processor

**Charter item 3. Build Loop required** (touches MVP-cutline code).
**Preconditions:** steps 1–2 done (VM up, Peta running). All work in
`services/control-plane/`. Run `scripts/process-checklist.sh --start-feature "adr-0007-service-split"`.

## Goal

Today one entrypoint (`src/server.ts`) builds ONE app, and the chat pipeline — the
project's reason to exist — is **built but unmounted**: `src/server.ts:15–17` says
*"The chat pre-processor (`/v1/chat/completions`) is a later wiring seam and is
intentionally not mounted here yet."* `createServer()` (`src/server.ts:59–86`) never
passes `preprocessor`/`peta` to `buildApp`, and `buildApp` mounts chat/inspector only
`if (opts.preprocessor)` (`src/http/app.ts:255–262`) and approvals only `if (opts.peta)`
(`:265–267`).

After this step: **two processes from one codebase**, separate ports + auth domains:

| | **Admin service** (port 8088) | **Facade** (port 8089) |
|---|---|---|
| Routes | `/api/*` CRUD, `/admin/config`, `/harness*`, `/terminal/:logicalName` (WS), `/approvals*`, `/login`/`/logout` | `/v1/chat/completions`, `/inspector/:sessionId/latest`, `/health` |
| Auth | operator cookie + bearer (`operatorGuard`) | chat route public-path + identity header (as today); machine-auth tier reserved (see below) |
| Owns | registry CRUD, terminal broker, approvals mirror | **Preprocessor instance** (chat + inspector share its `InspectorStash`, so they MUST live in one process — `src/preprocessor/index.ts:74`) |

## Design constraints (do not improvise around these)

1. **Both services share one SQLite file** (`PANTHEON_DB`). WAL mode is already on
   (`src/registry/sqlite-repository.ts:88`, `src/session/sqlite-store.ts`), which
   supports two processes. Do not open a second DB file.
2. **Admin-service failure must not interrupt conversations** (ADR-0007's point, and
   an acceptance-checklist item). No Facade code path may call into the admin process.
3. **Auth-guard seam for machine auth** (`docs/machine-auth-design.md` §8): the guard
   selection must dispatch on auth *domain*, not a hardcoded two-way branch — a fourth
   tier (machine bearer) must slot in at Phase 3 without touching tiers 1–3.
4. The route modules already take `(app, deps)` (`registerHarnessRoutes`,
   `registerChatCompletionsRoute`, `registerInspectorRoute`, `registerApprovalsRoutes`,
   `registerTerminalRoute`) — reuse them. The inline CRUD blocks in `buildApp`
   (`src/http/app.ts:164–252`) move to the admin builder unchanged.

## Build Loop — tests first

Write `test/service-split.test.ts` BEFORE implementing; verify each fails:

1. `buildAdminApp(...)` serves `/admin/config` (200 with auth) and returns **404** for
   `/v1/chat/completions`.
2. `buildFacadeApp(...)` serves `/v1/chat/completions` (uses the wiring pattern from
   `test/preprocessor-routes.test.ts:40–63` — construct `new Preprocessor({...})` with
   a `StubRetriever` and fake backend) and returns **404** for `/admin/config`,
   `/api/backends`, `/terminal/x`.
3. Facade `/inspector/:sessionId/latest` returns the stash written by a chat call
   through the SAME app instance.
4. A request with the operator cookie is rejected on the Facade's guard-protected
   surface, and vice versa where applicable (separate auth domains).

## Implementation outline

1. **Extract builders.** Split `buildApp` (`src/http/app.ts:114–270`) into
   `buildAdminApp(opts)` and `buildFacadeApp(opts)` in `src/http/` (new files;
   keep `buildApp` as a thin deprecated composition for existing tests, or update the
   tests — prefer updating tests). Shared middleware (guard factory, `PUBLIC_PATHS`
   handling, error handler — `src/http/app.ts:69–161`) moves to a shared module
   `src/http/shared.ts` so the two builders do not duplicate it (Bible §11:316 note).
2. **Two entrypoints.** `src/server-admin.ts` and `src/server-facade.ts`, both reusing
   the config/env pattern of `src/server.ts:88–102`. Env: admin keeps `PORT` (8088) /
   `HOST`; Facade reads `FACADE_PORT` (default 8089) / `FACADE_HOST`. Add both to
   `.env.local.example`. `package.json` scripts: `start:admin`, `start:facade`
   (mirror the existing `start` script's `--env-file-if-exists=.env.local`).
3. **Wire the Preprocessor in the Facade entrypoint** (this is the "mount" moment):
   `new Preprocessor({ registry, sessions: new SqliteSessionStore(dbPath), backendClient: new BackendClient(), retriever, resolveIdentity })`
   per `src/preprocessor/index.ts:40–51`. Retriever: `CompositeRetriever` with the
   bridge-backed memory+mailbox retrievers when `BRIDGE_MCP_URL`/`BRIDGE_MCP_TOKEN`
   are set, else `StubRetriever` (`src/preprocessor/retriever.ts:40–61`) — fail-open
   to no-recall, never crash (retrievers already warn:
   `src/preprocessor/retrievers/memory.ts:69`, `mailbox.ts:50`).
4. **Route assignment** per the table above. `registerTerminalRoute` moves from
   `src/server.ts:83` into the admin entrypoint.
5. `server.ts` becomes deprecated-but-working (or is deleted and its tests updated —
   pick ONE, record which in the commit message).

## Verify

- `npm test` green, including the new split tests; coverage thresholds still ≥90%
  (`vitest.config.ts:32–37`).
- Manual: run both services locally
  (`npm run start:admin` + `npm run start:facade`), then:
  - `curl -s localhost:8089/v1/chat/completions -X POST -H 'content-type: application/json' -H 'x-pantheon-identity: <identity>' -d '{"messages":[{"role":"user","content":"hi"}]}'` → 200/502 (502 acceptable if no live backend; NOT 404).
  - `curl -s localhost:8089/admin/config` → 404. `curl -s localhost:8088/v1/chat/completions -X POST` → 404.
  - Kill the admin process mid-conversation on the Facade → the Facade request
    completes (acceptance: "Admin-service restart does not drop an in-flight Facade
    conversation").
- Security audit substep (Build Loop): confirm no admin credential or guard weakening
  leaked into the Facade surface; `PUBLIC_PATHS` on the Facade is exactly
  `/v1/chat/completions` + `/health`.

## Rollback

Both new entrypoints are additive; rollback = revert the commit and run the old
`npm start`. The DB schema is untouched by this step.

## Acceptance-checklist mapping

Contributes: end-to-end smoke test plumbing (chat now mounted); the ADR-0007
failure-domain check; groundwork for every later step (4–8 all build on the Facade).
