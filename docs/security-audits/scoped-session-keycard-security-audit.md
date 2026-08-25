# Security Audit — Scoped Session Keycard (M1 task 2, TP-3)

**Feature:** `scoped-session-keycard` — a narrow, deny-by-default read-only machine credential for
Claude-CLI sessions: closed scope enum (`usage:read | approvals:read | sessions:read`), its own auth
domain `/keycard/v1/*`, hash-only custody, mint/list/revoke on the D6 admin surface.
**Date:** 2026-08-25
**Persona:** Senior Security Engineer (Phase 2.4) — three parallel read-only audits (auth-domain /
threat model; input validation / persistence / rendering; doctrine conformance / CC1), consolidated
here; every finding re-verified against the code before a disposition was assigned.
**Scope refs:** `docs/machine-auth-design.md`, PROJECT_BIBLE §5 (custody Principle 1, Principle 3),
§7 (tiers; new tier 4), §9 C.5 + cross-cutting CB/TL/FS, TM-011, D6, D8, §8/TM-008, ADR-0008.
**Components:** `src/keycard/{types,service,sqlite-store}.ts`, `src/http/auth/keycard-guard.ts`,
`src/http/routes/keycard.ts`, `src/http/app.ts`, `src/http/config-page.ts`, `src/session/sqlite-store.ts`,
`src/server.ts`.

## Headline

**The auth-domain separation holds in both directions and every build-plan acceptance criterion is
met by a real test:** no keycard reaches any admin route by any method; neither the admin bearer nor
the operator cookie reaches the door; no request can skip both guards (verified against Fastify's
404-handler hook inheritance and find-my-way's decoding); each scope grants exactly its route and
nothing else; no management route exists at any scope (the route table is asserted to be exactly
four `GET`s); the token appears in no listing, log, URL or error body. Totals raised across the three
audits: 0 SEV-1, 2 SEV-2 (one of which is a local-dev-file misread — see below), 16 SEV-3, ~20 SEV-4;
**28 fixed in-loop, test-first (27 new tests)**; 4 deferred to BUGS with rationale; 1 needs a ruling.

## Threats considered (design invariants)

| # | Threat | Control | Verdict |
|---|---|---|---|
| 1 | **Tier crossing** — a keycard on an admin route, an admin bearer / cookie on the door, or a request skipping both guards. | Prefix dispatched FIRST by raw path AND route pattern (bare `/keycard/v1` included — fixed); admin guard rejects any non-admin bearer (403); door ignores cookies; 404s inherit root hooks; find-my-way never decodes `%2F`, dot segments do not normalise. Tested both directions across 7 admin routes + POST. | **PASS** |
| 2 | **Privilege via scope** — mint or read with an unknown/empty/laundered scope; a write reachable through the door. | Closed `as const` enum, `Set` membership at mint, non-empty list, JSON scopes NOT coerced (`"usage:read"` string / nested array → 400 — fixed); door has four `GET` routes; `requireScope` runs BEFORE any backend call. The door's Peta dependency is now `Pick<…,"listApprovals">` — the decide verb is structurally out of reach (fixed). | **PASS** |
| 3 | **Custody** — token or hash on any surface. | `SHA-256(token)` only; `token_hash` never in `COLUMNS`; 256-bit `pk1_` tokens; JSON mint is `no-store`; the form mint is now Post/Redirect/Get to a **one-shot slot page** (read-and-burn, 5-min TTL, nonce — never the token — in the URL), so a reload cannot re-mint (fixed). | **PASS** |
| 4 | **Fail closed** — revoked, expired, corrupt, unwired. | Revoke fails closed on the next call (idempotent, first time kept); expiry always set at mint (`expiresAt` now non-nullable — fixed); a row whose stored scopes are not a JSON array of known scopes reads as `[]` and is **invalid**, never unscoped-but-live (fixed); counters coerced on read and escaped on the page (fixed); no service → 503 for the whole domain. | **PASS** |
| 5 | **Deny visibility** (design §7). | Refused authentications are counted door-wide (`stats()`), a replayed revoked/expired card is charged on the card (`denyCount`), 429s are counted, `useCount` now means "served" (recorded after the rate check) — all shown on the Configuration page (fixed). Per-call `AuditEntry` rows arrive with M2 step-04 (BUGS #34). | **FIXED (interim)** |
| 6 | **DoS / amplification** — unmetered pre-auth store reads; Peta amplification; unbounded lists. | Door-wide **pre-auth budget** (120 refusals / sliding minute → 429 without a lookup — fixed); per-card 60/min; approvals read bounded by an upstream timeout (10 s), 200 items (`truncated` flag) and 256 chars per field (fixed); `list()` capped at 500 (fixed); rate map evicts idle entries (fixed). | **FIXED** |
| 7 | **CSRF** on mint/revoke (and every pre-existing config form). | `SameSite=Lax` still sends the cookie on a same-SITE cross-origin POST (the chat UI is same-site). A state-changing request the browser labels `Sec-Fetch-Site: cross-site|same-site` is now refused before any guard (fixed; topology-safe — the edge proxy rewrites `Host`, so `Origin==Host` was not usable). Same-origin forms and non-browser API clients pass. | **FIXED** |
| 8 | **D8** — approval arguments/diff/payload through the door. | Closed allow-list projection (six string fields); canary test with `arguments`/`diff`/`payload`. `requester` = Peta user id (a hash, not a secret) — a conscious inclusion. | **PASS** |
| 9 | **Rendering / XSS** — principal, scopes, counters, timestamps, token page. | Every interpolation escaped (one shared `escapeHtml` — fixed); counters escaped; token only ever a text node; `CONFIG_CLIENT_JS` cannot touch the new forms except the deliberate Revoke confirm. | **PASS** |
| 10 | **Malformed URL bypassing hooks.** | `frameworkErrors` handler: sanitized 400 body, `nosniff` header (fixed). | **FIXED** |
| 11 | **CC1 / four states on the Configuration section.** | Pill contract reused (`data-status` + `role=img` + human `aria-label` + glyph); `invalid` state; Empty labeled; **Error** = field-level banner via allow-listed `?error=` codes (fixed — was raw JSON); **Success** = receipts via `?notice=` (fixed); Revoke has a labeled confirm and a unique accessible name per card (fixed). | **FIXED** |

## Findings by audit (disposition)

**Auth-domain / threat model** — 20 PASS; SEV-3: no audit trail (FIXED interim: counters +
stats; BUGS #34 for AuditEntry/pino), network wall not applied (ACCEPTED deviation, recorded in
ADR-0008 with corrected wording); SEV-4: pre-auth unmetered (FIXED budget), bare `/keycard/v1`
(FIXED), full `ApprovalsBackend` handed to the door (FIXED `Pick`), Peta amplification (FIXED
bounds at the door; upstream client timeout/size cap → BUGS #35), `sessions:read` discloses identity
ids (ACCEPTED — metadata by design; the chat entry's header-only auth is M2's problem, noted in the
ADR), malformed-URL headers (FIXED), PRG + card-count (FIXED PRG; no per-principal cap — admin-only,
listed cap 500), JSON scope laundering (FIXED).

**Input validation / persistence / rendering** — 17 PASS (coercion airtight, ASCII-closed principal,
no ReDoS, no prototype pollution, no traversal bypass, escaping complete, token page safe, client JS
inert on the new forms); SEV-2 "cleartext LAN listener" — **NOT a production finding**: the auditor
read the local dev `.env.local`; the VM binds `HOST=172.17.0.1`, `PANTHEON_SECURE_COOKIES=true`,
and Caddy terminates TLS with HSTS (verified live 2026-08-25); SEV-3: pre-auth DB reads (FIXED),
auth failures invisible (FIXED interim), same-site CSRF (FIXED), Peta bounds (FIXED at the door),
stored-scopes type confusion + unescaped counters (FIXED); SEV-4: `list()` unbounded + rate map
(FIXED), form error → raw JSON (FIXED), non-PRG re-mint (FIXED), repeated `ttlDays` laundered
(FIXED), hygiene (shared `escapeHtml`, scope value escaped, JSDoc — FIXED; `recordUse` on an
unknown id stays a silent no-op, acceptable).

**Doctrine / CC1** — 21 PASS (all four acceptance criteria, impersonation boundary, hash custody,
labeled states); SEV-2 form error dead end (FIXED); SEV-3: revoke without confirm (FIXED), duplicate
accessible names (FIXED), pill contract (FIXED), no success receipt (FIXED), reload re-mints (FIXED),
confused deputy (FIXED), zero audit of auth failures (FIXED interim), rate cap after auth (FIXED),
**data-model doctrine** (additive DDL vs "versioned migrations"; `updatedAt` added — the wording
question **needs Karl's ruling**, offered as a card), **D6 step-up not enforced** on the privileged
tier (pre-existing, project-wide — BUGS #36, mint/revoke named as the first consumers); SEV-4: ADR
wording (FIXED), network-wall clause overclaim (FIXED), "token in no log" half-vacuous (BUGS #34),
bare prefix (FIXED), nullable expiry (FIXED), requester correlator (ACCEPTED, noted), rate-map
memory (FIXED), missing audit file / interface doc (this file + `docs/api and interfaces/keycard-door.md`).

## Residual notes (tracked)

- **BUGS #34** — when structured logging lands (M2 step-04), `authorization` must be in the
  redaction allow-list and keycard `auth_deny` / `authz_deny` / `mint` / `revoke` become the first
  `AuditEntry` actions; pin with a captured-log test.
- **BUGS #35** — the Peta client itself has no fetch timeout or body-size cap; the door bounds the
  *output*, not the upstream buffering.
- **BUGS #36** — D6 step-up (`verifyStepUp`) is still a stub project-wide; keycard mint/revoke are
  the first routes that must require it when implemented.
- Network wall: the door rides the admin service behind the internal-DNS Caddy entrance (CLI
  sessions live on LAN dev machines). The *prefix* fails closed without a card; the *entrance* keeps
  serving the admin service's existing public paths.
- Rate/refusal state is per process and resets on restart (single-process deployment).

## Conclusion

Every tier-crossing, custody, scope and D8 check passed with a test behind it; the audits' real
delta — visibility of denials, pre-auth metering, same-site CSRF, upstream bounds, corrupt-row
handling and the Configuration page's four states — is fixed in-loop with 27 regression tests.
Suite 545 passed / 5 honest skips, `tsc` + `eslint` clean. **Cleared to proceed** (pending the
data-model wording ruling, which does not block).
