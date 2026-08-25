# Adversarial / Exploratory Probe — UAT Session 3

**Agent role:** "Malicious User" (Phase 2.7) — consolidated from six read-only security audits run during the two Build Loops (three per feature) plus live probes against VM 1093 through the household Caddy entrance.
**Date:** 2026-08-25
**Target:** `https://pantheon-admin.ferrumcorde.com` → VM 1093 `pantheon-admin@pantheon` (control-plane admin service), Caddy (two hops), the Mac mini as the SSH/tmux target.
**Full write-ups:** `docs/security-audits/tmux-aware-launcher-security-audit.md`, `docs/security-audits/scoped-session-keycard-security-audit.md` (findings, dispositions, PASS evidence).

**Verdict in one line: no SEV-1; every authorization, custody, injection and tier-crossing check passed with a test behind it; the real findings (SSH-dial amplification, hostile-machine text in first-party chrome, same-site CSRF, invisible auth denials, unbounded upstreams) were fixed in-loop before this session.**

## What was probed and what happened

| Probe | Result |
|---|---|
| Shell-metacharacter / tmux-target-syntax session names on attach and create (`;`, `$( )`, backticks, `=`, `:`, `.`, leading `-`, unicode, over-length, repeated query keys) | Refused before any SSH dial with a labeled error frame; the allow-list is the only interpolation path and it is a branded type. |
| Hostile `tmux ls` output from the machine (banner lines, malformed records, 10k names, 64-KiB names, ANSI/control chars, `<img onerror>` names) | Ignored + counted / capped / rendered as text only; the page never crashes and never renders markup. |
| Hammering `/harness/tmux/:name` and mashing Refresh | One SSH dial per machine per 3 s (coalesced + cached), at most 4 in flight; client refuses overlapping requests; 15 s client timeout. |
| Closing a tmux tab | Sends the explicit close frame; the tmux client detaches; the session survives (verified with `tmux list-clients` on the Mac). |
| Keycard on every admin route (GET + POST), admin bearer on the door, browser cookie on the door, `/keycard/v1` bare, `%2F`/`..`/case variants, unknown paths under the prefix | All refused with the right tier's labeled error; no route can be reached by both tiers; unknown paths still meet the keycard guard (401). |
| Mint with no / unknown / laundered scopes (JSON string, nested array, repeated `ttlDays`, unicode principal) | 400 (API) or a field-level banner (form); nothing persists. |
| Reload of the minted-token page; token in URLs/history/listings | One-shot slot page: second load is "already collected"; the token never appears in a URL, listing, log or error body. |
| Cross-site / same-site POST to mint or revoke (and to the pre-existing config forms) | 403 `cross_origin_rejected` via the browser's `Sec-Fetch-Site` label. |
| Garbage bearers at scale; replay of a revoked card | Counted door-wide (refused attempts + last time) and on the card (denied); after 120 refusals/min the door answers 429 without a store lookup. |
| Hostile Peta answers to `approvals:read` (multi-GB body, 5M items, hung socket, nested objects, prototype keys) | Door bounds output (200 items, 256 chars/field, 10 s) and projects a closed allow-list — no arguments/diff/payload ever; upstream client bounds are BUGS #35. |
| Tampered SQLite rows (scopes as a JSON string, TEXT in counters) | Read-side validation: card becomes **invalid** (never unscoped-but-live); counters coerced and escaped. |

## Live results on the deployed server (2026-08-25, through Caddy)

- tmux: list = the Mac's real sessions; attach to `0` lands inside tmux; attach-or-create works; unsafe name refused; close frame drops the tmux client to 0.
- keycards: whoami/sessions 200; usage labeled 503; no-credential 401 + `nosniff`; admin bearer on door 403; keycard on admin routes 403; same-site POST 403; counters visible; revoke → `keycard_revoked`, deny counted; approvals via keycard now reaches Peta (wired in the fix commit before this session).

## Open items for the human session to keep in mind

- BUGS #25–#30 (pre-existing tab-shell / CSP / config-page items) and #34–#36 (audit log when pino lands, Peta client bounds, D6 step-up) are tracked, not regressions.
- The scenarios that ask for `curl` on the Mac exercise the door *exactly* as a CLI session would.
