# Security Audit — The harness under the chat address + LibreChat theme (2026-08-27)

**Feature:** `harness-under-chat-address` — the console served at `https://pantheon.ferrumcorde.com/harness/*`
(Caddy `handle_path` + `X-Forwarded-Prefix`), mount-aware rendering (`src/http/base-path.ts`), shared
LibreChat-token stylesheet + theme boot (`src/http/theme.ts`), Chat tab (same-origin iframe), footer links.
**Date:** 2026-08-27
**Persona:** Senior Security Engineer (Phase 2.4) — two parallel read-only audits (A: prefix trust /
URL escaping / shared-origin cookies + CSRF / framing / path collisions / Caddy / theme boot; B:
root-mount regression / completeness under the prefix / client correctness / theme / Caddy semantics
(adapted with the real `caddy` binary) / test honesty), consolidated here; every finding re-verified
against the code before disposition.
**Scope refs:** design `docs/2026-08-27-harness-under-chat-address-design.md`; ruling 2026-08-27
(APPROVAL_LOG); ADR-0004 (LibreChat untrusted), ADR-0005; Bible §7/§8/§11; TM-008, TM-011, TM-020;
BUGS #26, #29, #36.

## Headline

**The mechanism is sound — every link, redirect, asset, socket and cookie is built correctly under the
prefix, the root mount's URLs/redirects/cookie are unchanged, the header cannot be forged on the chat
site, and the Caddy config does exactly what the design says (verified by `caddy adapt`).** The
substantive finding is **structural, not a bug: one address = one browser origin.** The chat page
(LibreChat, a large third-party SPA that ADR-0004 treats as untrusted) and the console are now the same
program to the browser, so any script that ever runs on the chat page can reach the console with the
operator's session — terminals included. No header or token fixes same-origin script; only origin
separation does, and the two alternatives are unavailable (a second hostname on 443 is defeated by the
household edge's Host rewrite; chat-inside-the-harness on the admin address breaks LibreChat's own
sign-in inside a cross-site iframe). The M2 chat-in-harness design carries the same property.
**Disposition: guardrails built (below); the residual is recorded for the operator's explicit
acceptance and the Caddy split is NOT deployed until he gives it.** Totals: 0 SEV-1, 4 SEV-2
(1 residual/ruling, 3 fixed), 8 SEV-3 (7 fixed, 1 tracked), ~14 SEV-4 (10 fixed, 4 tracked/accepted);
**suite 617 pass / 5 skips (+29 tests), `tsc` + `eslint` clean.**

## Threats considered (design invariants)

| # | Threat | Control | Verdict |
|---|---|---|---|
| 1 | **Forged `X-Forwarded-Prefix`** → open redirect, link/asset/socket hijack, cookie re-scoping. | Chat site: Caddy `header_up` SETS (overwrites) the header. Admin site: `header_up -X-Forwarded-Prefix` (fixed, A/F4). Value validated `^(/[a-z0-9-]+){1,3}$` — no scheme, `//`, `\`, `..`, encoding, unicode, query, >3 segments; arrays/non-strings → root; escaped into attributes; `withBase` refuses non-absolute paths. Direct LAN reach of `:8088` is self-only (bound to the docker bridge on the VM; noted BUGS #41). | **PASS** |
| 2 | **URL escaping the base** (a link landing on LibreChat, or LibreChat's `/login`/`/api`/`/assets` shadowing ours). | Every emitter routes through `withBase`/`BASE` (sweep + static invariant test with 17 pattern fixtures incl. ternaries, single quotes, DOM sets, fetch/open/redirect/location). `/harness/assets/*` disjoint from LibreChat's `/assets/*`. | **PASS** |
| 3 | **Shared origin — cookie leak to the chat backend.** | Cookie `Path` = the mount (`/harness` under the chat address, `/` at the root); cleared with the same Path on logout (fixed, A/F2 — test). | **FIXED** |
| 4 | **Shared origin — CSRF from sibling hosts / the chat page.** | Sec-Fetch-Site check now also covers `Upgrade: websocket` (fixed, A/F3 — closes the sibling-host half of BUGS #26). Same-ORIGIN script remains able to call the console — **residual #1 below**. | **FIXED (sibling) / RESIDUAL (same-origin)** |
| 5 | **Framing** — clickjacking of console pages; the chat page inside the harness. | Console HTML sends `Content-Security-Policy: frame-ancestors 'self'` (cross-origin ancestors, incl. LibreChat artifacts, refused; wins over Caddy's XFO) and busts a same-origin frame to the top window (`FRAME_BUST_JS`) — so the embedded chat page's footer link to the console pops the whole window to the harness instead of nesting or blanking (A/F5 + B/F-A). The chat page inside the harness is same-origin, allowed by Caddy's SAMEORIGIN. | **FIXED** |
| 6 | **Root-mount regression.** | URLs, redirects, cookie identical (588 pre-existing tests unchanged, green). Intended changes on the admin address: shared stylesheet, OS light/dark, `data-base=""`, CSP header, WS check. Claim wording corrected (B/F-C). | **PASS** |
| 7 | **Chat tab correctness.** | Under the chat address: same-origin `<iframe src="/">`. On the admin address: labelled link to `PANTHEON_CHAT_URL` (threaded from env, https-only; fixed, B/F-B), never a cross-site iframe (third-party cookie → login loop). | **FIXED** |
| 8 | **Theme / readability (CC1).** | Every state still words + glyph + `data-state`; terminals stay on the dark surface in both themes (xterm's default ANSI palette is unreadable on white — fixed, B/F-D); boot script accepts LibreChat's raw and JSON-quoted storage forms (fixed); `--text-tertiary` dark uses LibreChat's effective override value (`#999`-class), contrast ≥ 4.5:1 everywhere. | **FIXED** |
| 9 | **Caddyfile semantics.** | `caddy adapt`: `/harness` → 308 `/harness/`; `/harness/*` → strip + proxy with the header SET; catch-all → LibreChat; admin site deletes the header; security headers apply inside handle blocks. Reload closes live terminal sockets (README note). | **PASS** |
| 10 | **Theme boot / inline script.** | Reads one localStorage key, toggles a class, nothing leaves the page; one more inline script on every page incl. the public login (BUGS #29 grows by design; CSP script-src remains the tracked item). | **PASS** |

## Findings by audit (disposition)

**A — prefix trust / cookies / framing:** SEV-2 same-origin merge (**residual #1**, ruling) · SEV-2 cookie
`Path=/` reaches the chat backend (FIXED) · SEV-3 WS handshake accepts same-site (FIXED; BUGS #26
extended) · SEV-4 admin site forwards a client prefix header (FIXED, Caddy) · SEV-4 console frameable
by same-origin documents (FIXED — `'self'` + bust; BUGS #29 extended) · SEV-4 design item 3 deviation
(documented) · info: `HELP_AND_FAQ_URL` → `/harness/help` (FIXED), `PANTHEON_SECURE_COOKIES=true` to be
confirmed on the VM at deploy, password manager offers the shared credential on both forms (accepted —
deliberate reuse, APPROVAL_LOG 2026-08-19).

**B — regression / completeness / client / theme / Caddy / tests:** SEV-2 footer links inside the
embedded chat blank the frame under `'none'` (FIXED — `'self'` + frame-bust) · SEV-3 `chatUrl` never
supplied (FIXED — `PANTHEON_CHAT_URL`) · SEV-3 "byte-for-byte" claim (FIXED — wording) · SEV-3 light
terminals unreadable (FIXED — dark in both themes) · SEV-3 user-guide contradictions (FIXED — 4 spots) ·
SEV-3 static invariant blind spots (FIXED — pattern set + fixture test) · SEV-4 cookie shadowing on the
bare-IP host across ports (**BUGS #40**, accepted — the IP address is the edge's hop, not an operator
entrance) · SEV-4 `HOST` default `0.0.0.0` in `server.ts` (**BUGS #41**; the VM's env binds the docker
bridge) · SEV-4 token/font deviations (documented; effective LibreChat values) · SEV-4 quoted storage
form (FIXED) · SEV-4 terminal page white banner border (FIXED) · SEV-4 empty terminal page unthemed
(FIXED) · SEV-4 minted page door paths without base (FIXED) · SEV-4 `.chat-host` sizing only in the
shared sheet (FIXED — inline structural rule) · SEV-4 README two `.env` values + reload note (FIXED) ·
test gaps noted (Caddy 308/strip is Caddy-only — verified by adapt and live; WS check proven at the
hook, not with a real upgrade; keycard door under the prefix not exercised).

## Residual #1 — one origin (needs the operator's acceptance; APPROVAL_LOG row pending)

Script on the chat page = the operator's console: terminal on every enrolled dev machine, keycard
mint, registry edits. Preconditions: a LibreChat XSS; an uploaded file served inline with an active
type; an artifact sandbox self-hosted on a household host. Bound to the choice: `SANDPACK_BUNDLER_URL`
never on `*.ferrumcorde.com`; uploads never served inline; `ALLOW_REGISTRATION=false`; cookie scoped
to `/harness`; WS Fetch-Metadata check; `frame-ancestors 'self'` + bust; BUGS #36 (D6 step-up) gates
mint/config when it lands — it does not gate the terminal. Alternatives and why not: second hostname
on 443 (edge Host rewrite), chat-in-harness cross-site (LibreChat login loop), C (fork) has the same
origin property. **The Caddy split stays undeployed until the operator rules.**
