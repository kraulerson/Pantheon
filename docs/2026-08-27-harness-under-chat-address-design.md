# Design — the harness under the chat address, in LibreChat's clothes (2026-08-27)

**Ruling (Karl, 2026-08-27, APPROVAL_LOG):** option A of the three offered — the harness (machines,
live tmux sessions, attach / new session, terminal tabs, Approvals) is served **under the chat
address**, `https://pantheon.ferrumcorde.com/harness/`, one click from the chat page, with chat
available as a tab inside the harness; **registration stays on the Configuration (admin) page**;
the harness **matches LibreChat's theme so the two feel contiguous**. Resolves step-08 item 5
("collapse the two front doors — decide HOW") for the terminal plane: *the frame links into chat and
chat links into the frame, on one address*; the frame-replaces-chat variant stays open for M2.

Rejected here: **B** (harness as the outer shell on the admin address — keeps the "admin" door);
**C** (patch LibreChat for a sidebar tab — doctrine-legal, but we would build and carry a modified
image through every upgrade; may be revisited as an upstream "custom links" proposal once A exists,
since any embedded tab must show a **same-address** page — a cross-site iframe would make the
console cookie third-party and the browsers would block the sign-in).

## Constraints discovered

- LibreChat v0.8.7 has **no custom nav/tab hook**; only `CUSTOM_FOOTER` (markdown links under the
  chat box) and `HELP_AND_FAQ_URL`.
- The chat site already answers `X-Frame-Options: SAMEORIGIN` (our VM Caddy) → a page on the SAME
  address may embed it; the admin site answers `DENY` (unchanged).
- The household edge forwards the whole hostname to the VM → **no intake/DNS work**; the split is
  done in `deploy/Caddyfile` alone.
- LibreChat's own paths `/login`, `/api/*`, `/assets/*` collide with the console's → the console
  must live under a prefix on the chat site.
- LibreChat keeps its theme in `localStorage["color-theme"]` ∈ `dark | light | system` and applies
  the `dark` class on `<html>`; its tokens (v0.8.7 stylesheet): grays `#ececf1 #f7f7f8 #ececec
  #e3e3e3 #cdcdcd #999696 #595959 #424242 #2f2f2f #212121 #171717 #0d0d0d`; dark surfaces
  primary `#0d0d0d` / secondary `#212121` / tertiary `#2f2f2f`, text `#ececec` / `#cdcdcd`,
  borders `#2f2f2f` / `#424242`; light surfaces white / `#f7f7f8` / `#ececec`, text `#212121` /
  `#424242`, borders `#e3e3e3` / `#cdcdcd`; fonts `system-ui, Inter, …, sans-serif` and
  `Roboto Mono, monospace`; green-700 `#047857` submit, red-600 `#dc2626` destructive.

## Mechanism — mount-aware rendering (no route renames, no second config)

1. **Caddy (chat site):** `handle_path /harness/*` → `reverse_proxy host.docker.internal:8088`
   with `header_up X-Forwarded-Prefix /harness`; `redir /harness /harness/ 308`; everything else
   stays LibreChat. The admin site (`:8443`) is untouched — every existing URL (door, bookmarks,
   keycard `curl` lines) keeps working byte-for-byte.
2. **Service:** `basePathFrom(headers)` reads `X-Forwarded-Prefix`, accepts only
   `^(/[a-z0-9-]+){1,3}$` (anything else → `""`, i.e. root — fail closed to the plain mount); the
   service is reachable only through Caddy (docker-bridge bind), so the header is Caddy's, not the
   client's. Every rendered link / form action / asset / redirect / client fetch / WebSocket URL is
   built with `withBase(base, path)`. The client scripts read the base from
   `<html data-base="…">`. The session cookie is scoped to the mount (`Path=/harness` under the
   chat address, `/` at the root) so the chat backend never receives it (audit F2). The
   Sec-Fetch-Site check now also covers the terminal WebSocket handshake (audit F3); console HTML
   sends `frame-ancestors 'none'` (audit F5); the admin site strips a client-supplied prefix header
   (audit F4).
3. **Console root `/` keeps redirecting to the frame** (`<base>/harness`, BUGS #15 behaviour
   preserved), so `pantheon.ferrumcorde.com/harness/` lands on the harness after one hop
   (`/harness/harness`). Rendering the frame at `/` was considered and dropped to keep the existing
   contract and tests unchanged.
4. **Chat tab:** `openChatTab` embeds `<iframe src="/">` when the base is non-empty (same
   address → allowed by SAMEORIGIN); on the admin site (base empty, cross-site) it stays a labelled
   link to the chat address. New Session dialog: "Chat" option opens that tab.
5. **Footer:** `CUSTOM_FOOTER=[Terminals](/harness/) | [Configuration](/harness/admin/config)`.
6. **Theme:** one shared stylesheet `/assets/harness.css` (public asset, served from our origin) —
   LibreChat's token values on `:root` / `html.dark`, base typography, header/nav/tab/button/table/
   form/banner styles; a 6-line boot script on every console page applies `color-theme` (same-origin
   localStorage) or `prefers-color-scheme`, and follows `storage` events; xterm gets a matching
   `theme` (surface-primary background, text-primary foreground) and `Roboto Mono, monospace`.
   CC1 unchanged: state is still words + glyph + `data-state`; colour is decoration only.

## Files

`deploy/Caddyfile`, `deploy/.env.example` (+ VM `deploy/.env`), `src/http/base-path.ts` (new),
`src/http/theme.ts` (new: CSS + boot script), `src/http/app.ts`, `src/http/routes/harness.ts`,
`src/http/harness-frame.ts`, `src/http/terminal-tab.ts`, `src/http/config-page.ts`,
`src/http/approvals-inbox.ts`, `src/http/routes/approvals.ts`, `src/http/routes/keycard.ts`,
`src/http/routes/enrollment.ts`, `src/http/auth/operator-auth.ts`; tests `base-path.test.ts`,
`theme.test.ts` + header-driven cases in the page/route tests; docs: user guide §1/§4, FEATURES,
CHANGELOG, APPROVAL_LOG, this record; security audit file.

## Tests first

- `basePathFrom`: absent → `""`; `/harness` → `/harness`; `/harness/` and `//x`, `..`, `%2e`,
  `http://`, `/UPPER`, 4 segments, `/a?b` → `""`.
- Every page and redirect: without the header identical to today; with `x-forwarded-prefix:
  /harness` every `href`/`action`/`src`/`Location`/WS URL starts with `/harness/`; no bare
  `href="/…"` survives.
- Frame client: `wsUrl` and the tmux fetch use the base; Chat tab = iframe when base set, link
  when not; theme boot reads `color-theme`; pages link `/assets/harness.css` (public).
- Live: `pantheon.ferrumcorde.com/harness/` 200 frame, `/harness/login` is OUR login, `/login` is
  LibreChat's; the door on the admin site unchanged; WS attach through the chat site; footer link.

## Acceptance (charter box, step-08 item 5 — terminal half)

From `pantheon.ferrumcorde.com` alone: open chat, open Terminals, list machines + tmux sessions,
attach / create a session, return to chat — without visiting a second address.

## Residual risk — needs the operator's explicit acceptance (audit 2026-08-27 F1)

One address means one browser **origin**: the chat page (LibreChat, a large third-party SPA that
ADR-0004 already treats as untrusted) and the console are now the same program to the browser.
Any script that ever runs on the chat page — a LibreChat XSS, an uploaded file served inline with an
active type, an artifact sandbox self-hosted on `*.ferrumcorde.com` — can call the console with the
operator's session: open a terminal on every enrolled dev machine, mint a keycard, edit the
registry. No header or token fixes same-origin script; only origin separation does, and the
household edge's Host rewrite rules out a second hostname on 443, while the cross-site alternative
(chat inside the harness on the admin address) breaks LibreChat's own sign-in inside an iframe
(third-party cookies). The M2 chat-in-harness design has the same property. Guardrails bound to
this choice: `SANDPACK_BUNDLER_URL` never on a household host; uploads never served inline;
`ALLOW_REGISTRATION=false`; cookie scoped to `/harness`; WebSocket handshake Fetch-Metadata check;
`frame-ancestors 'none'`; BUGS #36 (D6 step-up) gates mint/config when it lands. **Recorded in
APPROVAL_LOG as accepted only once Karl says so; until then the Caddy split is not deployed.**
