# Security Audit — DevMachine Registry (Task #16a)

**Feature:** `devmachine-registry` — DevMachine entity CRUD (registry service + SQLite repo),
Config-page section, and admin-guarded `/api/dev-machines` HTTP routes.
**Date:** 2026-06-13
**Persona:** Senior Security Engineer (Phase 2.4 — hunt concrete exploits, not check boxes)
**Scope refs:** PROJECT_BIBLE §5 (DevMachine entity), ADR-0005, TM-020, §7 (auth tiers, #14a/#14b), §10 (#3 fail-closed).
**Components reviewed:**
`src/registry/types.ts`, `src/registry/service.ts`, `src/registry/sqlite-repository.ts`,
`src/http/config-page.ts`, `src/http/app.ts`.

## Threats considered & concrete exploit attempts

| # | Threat (concrete exploit) | Control | Verdict |
|---|---|---|---|
| 1 | **TM-020 / #14b — SSH private key reaches the registry.** Operator (or compromised admin form) pastes a raw OpenSSH/PEM private key into `sshKeyHandle` on create or update; it lands in the DB, the rendered Config page, an error body, or a log. | `assertKeyHandle` rejects PEM markers (`-----`/`BEGIN`/`PRIVATE`), multi-line, whitespace, and out-of-charset tokens → `ValidationError` → HTTP 400, **no write**. The rejection message does **not** echo the submitted value (no reflection into the 400 body or logs). The Config page renders only the *provisioned status*, never `sshKeyHandle`, and the Add form has **no key field**. | **PASS** — tests: custody create/update rejection (`devmachine-registry.test.ts`), page never displays handle (`config-page-devmachines.test.ts`), API 400 + no-persist (`http-app.test.ts`). |
| 2 | **SQL injection** via `logicalName`/`host`/`user`. | All statements are better-sqlite3 **parameterized** prepared statements with named params; no string interpolation of input into SQL. Reserved word `user` is quoted. | **PASS** |
| 3 | **Command injection into the future `ssh` argv** (sub-task c) via `user`/`host`/`port`. | Input is charset-restricted at the registry boundary: `user`/`logicalName` ∈ `[A-Za-z0-9._-]`, `host` is a bare IP/hostname (no whitespace/scheme/`;`/`$`), `port` is an integer 1–65535. No shell metacharacter can reach the SSH layer later. | **PASS** (defensive pre-emption) |
| 4 | **#14a — identity-binding handle rebind.** Attacker PUTs `logicalName` in the body to re-point an existing machine and break the immutable identity↔machine binding. | `DevMachinePatch` excludes `logicalName`; `updateDevMachine` never reassigns it and the UPDATE SQL does not touch `logical_name`. An extra `logicalName` in the body is silently ignored. | **PASS** — locked by HTTP boundary regression test (`PUT cannot mutate logicalName`). |
| 5 | **Privilege boundary (D6/TM-011).** Reaching dev-machine management from a non-admin/session context. | All `/api/dev-machines` routes sit behind the `onRequest` admin guard (not in `PUBLIC_PATHS`). | **PASS** — test: 401 without a token. |
| 6 | **Partial write on malformed input** (fail-open, §10 #3). | Validate-before-write in both create and update; a malformed field throws before any repo call. | **PASS** — tests: "no write" assertions on create; "row unchanged" on update. |
| 7 | **Duplicate `logicalName`** creating two machines for one binding handle. | Service checks `getDevMachineByLogicalName` before insert (synchronous, single-threaded better-sqlite3 — no intra-process race); DB `UNIQUE(logical_name)` is defense-in-depth. | **PASS** |

## Residual notes (non-blocking)

- **Self-reflected input echo.** `assertHost`/`assertUser`/`assertLogicalName` echo the *rejected, non-secret* value in their 400 detail. This is the requester's own input (no third-party secret disclosure) and is not persisted; Fastify logger is disabled (`logger:false`). Acceptable for the single-operator personal deployment. `assertKeyHandle` deliberately does **not** echo, since its input may be secret.
- **Deferred to later sub-tasks:** key generation + custody storage and the actual `ssh-copy-id` provisioning flow (sub-task b) and the SSH→PTY→WebSocket broker (sub-task c) are out of scope here; TM-020's runtime RCE/custody surface is validated when those land (Phase 3: `docs/test-results/threat-validation.md#TM-020`).

## Conclusion

No exploitable findings in the DevMachine registry surface. All TM-020 / #14a / #14b / §10-#3 controls
are implemented and covered by tests. **Cleared to proceed.**

## Post-UAT addendum (2026-06-14)
UAT-1 adversarial review found the leading-dash `logicalName`/`user` option-injection vector and the forgeable `provisioned`/`sshKeyHandle` via the generic PUT route; both fixed test-first (see `tests/uat/sessions/2026-06-14-session-1/TRIAGE.md`).
