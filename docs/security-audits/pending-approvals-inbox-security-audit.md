# Security Audit — Unified Pending-Approvals Inbox (M1 task 3, TP-2 amendment)

**Feature:** `pending-approvals-inbox` — one admin-guarded, server-rendered page (`GET /admin/approvals`,
linked as **Approvals** in the harness chrome) listing every approval waiting in Peta's queue across
all sessions/identities, REFERENCE-ONLY (D8); read-only until the M2 resolution surface (C.3). The
reference-only projection was lifted into ONE shared module (`src/approvals/projection.ts`) that the
keycard door now reads through as well.
**Date:** 2026-08-26
**Persona:** Senior Security Engineer (Phase 2.4) — two parallel read-only audits (A: input validation /
injection / D8 / XSS / bounds; B: authorization / confused deputy / door regression / fail-closed /
availability / correctness / test honesty), consolidated here; every finding re-verified against the
code, and the two correctness findings verified against LIVE Peta from VM 1093 before disposition.
**Scope refs:** build plan `docs/handoffs/2026-08-20-M1-build-plan.md` §3; capability ruling TP-2
(APPROVAL_LOG 2026-08-20); D8; CC1/CC2/CC3; §8/TM-008; ADR-0008 (door contract); BUGS #29, #35.
**Components:** `src/approvals/projection.ts`, `src/http/approvals-inbox.ts`, `src/http/routes/approvals.ts`,
`src/http/routes/keycard.ts`, `src/http/app.ts`, `src/http/harness-frame.ts`, `src/peta/client.ts`.

## Headline

**Authorization, confused-deputy and door-regression lenses were clean on first review; correctness
was not.** Both audits independently caught that the page matched a lowercase `pending` while Peta's
vocabulary is `PENDING` — the page would have said "No pending approvals" over a queue full of them,
fail-silent in the safety-relevant direction — and audit B caught that only Peta's first unfiltered
page was read, so with append-only history waiting items on page 2+ would never appear. **Live
verification (VM 1093 → Peta 9201, 2026-08-26):** `status:"pending"` → HTTP 500 `Invalid status filter:
pending`; `status:"PENDING"` accepted; `page` honoured; `pageSize` clamped to 100; envelope
`{ success, data: { requests, page, pageSize, hasMore } }` (queue empty at probe time — no row captured).
Totals: **1 SEV-1, 2 SEV-2, 7 SEV-3, ~10 SEV-4**; **14 fixed in-loop, test-first (+16 tests; suite
582 pass / 5 skips, `tsc` + `eslint` clean)**; 3 tracked in BUGS with rationale (#35 extended, #37,
#38); 1 already tracked (#29 CSP); 1 accepted.

## Threats considered (design invariants)

| # | Threat | Control | Verdict |
|---|---|---|---|
| 1 | **Tier crossing** — keycard bearer, identity header or logged-out browser reaching the inbox. | Route sits under the root `onRequest` guard; not in `PUBLIC_PATHS`; not a keycard path. Tests: no credential → 401 (Peta never read); keycard bearer → 403; identity header alone → 401; logged-out browser → 302 `/login`; session cookie → 200. | **PASS** (tests added — B SEV-3) |
| 2 | **Confused deputy** — the page reaching the decide verb. | Wired with a `listApprovals`-only reader (`ApprovalsReader`); handler is GET-only; markup has no form/button/script and no `/decide` link (asserted). | **PASS** |
| 3 | **D8 leak** — arguments / diff / payload through any cell, attribute, note or fallback. | Closed six-key allow-list, strings only (a finite epoch number accepted for the time field only), 256-char cap; canary test with `arguments`/`diff`/`payload`; probe with `__proto__`/`constructor`/non-object items → `{}`. | **PASS** |
| 4 | **Correctness of "pending"** — the page telling the operator nothing waits. | Lowercase-only match REPLACED: only Peta's resolved vocabulary (`approved | rejected | expired`, any case) is hidden and counted; `PENDING`, unknown or missing status is SHOWN (fail-visible; missing reads "(not given)"). Live-verified vocabulary. | **FIXED (SEV-1)** |
| 5 | **Coverage of "every session"** — first unfiltered page only. | `readPendingApprovals`: asks Peta `{ status:"PENDING", page, pageSize:100 }` and walks pages under ONE timeout; bounded by 10 pages / 200 items; dedupe by id; a no-progress page ends the walk with `more:true`; any page failing fails the read (never a partial list as complete). `PetaAdminClient.listApprovals(filter?)` passes Peta's own filter. | **FIXED (SEV-2)** |
| 6 | **Hostile Peta body** — multi-GB / millions of items / prototype keys / non-boolean `hasMore`. | Items ≤ 200, fields ≤ 256, whole-walk timeout, `hasMore` only as literal `true`, non-objects inert. The BYTE bound is upstream: the client has no abort / size cap — pre-existing **BUGS #35**, re-raised SEV-2 and still deferred (operator-only LAN surface; household Peta). | **PARTIAL — tracked #35** |
| 7 | **Upstream / query text reflection** (TM-008). | Failure texts are a literal union (`ReadFailureLabel`) — `PetaError.message` (carries upstream detail) is discarded; handler reads no query; every interpolation escaped. Test: thrown detail never appears. | **PASS** |
| 8 | **XSS incl. attribute context** (`data-approval-id` ← id, `datetime` ← createdAt). | One shared `escapeHtml` (escapes `& < > " '`), attributes double-quoted. Attribute-context fixture added. | **PASS** (test added — A SEV-3) |
| 9 | **Display spoofing** — bidi overrides / zero-width / control chars in a tool or identity name. | Stripped from every projected field at the projection (also hardens the door's JSON). | **FIXED** |
| 10 | **Fabricated rows** — `null` / `{}` items rendering as "pending" work. | Items without a reference id are counted (`data-unidentified-count`), never listed; status is never defaulted. | **FIXED** |
| 11 | **Header hygiene / caching** of a page listing who is asking for what. | `text/html; charset=utf-8`, `Cache-Control: no-store` on every outcome (200/502/503), `nosniff` from the app hook — asserted on all three. | **PASS** (test added) |
| 12 | **CC1 / CC2 states.** | `data-state` ∈ ok / empty / unavailable / failed with a sentence each; `[!]` glyph on banners; empty state labelled ("No pending approvals — nothing is waiting on you."); notes for more / hidden / unidentified; no colour used at all. | **PASS** |
| 13 | **Availability** — Reload storms, HEAD mirroring. | No rate limit on admin HTML GETs and Fastify exposes HEAD for them — consistent with the whole admin surface (only the door is metered); operator-only. **BUGS #37** (Post-MVP). Timeout honoured, rejection handled, no dangling worker. | **tracked #37** |
| 14 | **Keycard door regression** (`/keycard/v1/approvals` now reads through the shared module). | Byte-for-byte contract: `{ approvals, truncated }`, 503/502 labels, 200/256/10 s; `more` computed but not surfaced; existing door tests and `server.test.ts` unchanged and green. | **PASS** |

## Findings by audit (disposition)

**A — input validation / D8 / XSS / bounds:** SEV-2 status case (FIXED, test-first; see #4) · SEV-2 no
byte cap / abort (tracked **#35**, extended) · SEV-3 keycard-bearer-on-inbox untested (FIXED, test) ·
SEV-3 headers untested (FIXED, test) · SEV-3 attribute-context untested (FIXED, test) · SEV-4 garbage
items as pending rows (FIXED) · SEV-4 `opts.peta!` closure (FIXED — snapshot) · SEV-4 `message: string`
(FIXED — `ReadFailureLabel` union) · SEV-4 unicode spoofing (FIXED) · SEV-4 no CSP (pre-existing,
**#29**). All doctrine checks PASS except the byte bound (PARTIAL → #35).

**B — authz / confused deputy / regression / correctness / tests:** SEV-1 status case (FIXED; the same
finding as A's SEV-2, kept at B's severity because it inverts the acceptance criterion) · SEV-2 first
unfiltered page only + false "first 200" note (FIXED — page walk with Peta's filter; note reworded
and asserted not to name a number) · SEV-3 timeout does not abort (**#35**) / no rate limit / HEAD
(**#37**) · SEV-3 numeric `createdAt` would blank every age (FIXED — finite epoch accepted, ISO
rendered) · SEV-3 test gaps (FIXED — identity header, browser redirect, cookie, `PENDING`/unknown
status, filter-args assertion; weak `"M2"` assertion replaced by `data-resolution="m2-c3"`) ·
SEV-4 audit doc cited before it existed (this file) · SEV-4 two clocks (**#38**) · SEV-4 status
defaulted to "pending" (FIXED) · SEV-4 prose "every request" (FIXED — "every request Peta reports").
Lenses 1–3, 7 PASS; 4–6 now PASS after the fixes above. **Accepted:** a future `createdAt` renders
"just now" rather than flagging clock skew (harmless; skew is a host concern).

## Residuals

- **#35** — the Peta client buffers whatever Peta sends before any of our caps apply (SEV-2 on paper,
  deferred: operator-only, LAN-only, Peta is a household service under our control).
- **#37** — no rate limit / HEAD exposure on admin HTML GETs (Post-MVP, consistent with the surface).
- **#38** — two test clocks (Post-MVP).
- **#29** — no CSP on HTML responses (project-wide, pre-existing).
- No live row captured at probe time (queue empty): the projection's key list (`approvalId | requestId |
  id`, `tool | toolName`, `serverId | serverName | server`, `createdAt | requestedAt | timestamp`,
  `userId | requester | identity`) is still inferred from Peta's request shapes, not a returned row.
  The page fails visible on a mismatch (a row with no id is counted, not hidden), and the next UAT
  session should include one real pending request.
