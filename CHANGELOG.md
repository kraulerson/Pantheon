# Changelog

All notable changes to this project will be documented in this file.

Format based on [Keep a Changelog](https://keepachangelog.com/) with extended categories
for handoff clarity. Categories are ordered by impact severity.

<!--
  Category definitions:
  - Security: Vulnerability fixes, dependency patches for CVEs, auth changes
  - Data Model: Schema migrations, data format changes, rollback notes
  - Added: New features, new endpoints, new commands
  - Changed: Modifications to existing behavior
  - Fixed: Bug fixes (reference BUGS.md entry if applicable)
  - Removed: Removed features, deprecated endpoints
  - Infrastructure: CI/CD changes, dependency updates, configuration changes, tooling
  - Documentation: Significant doc updates (new ADRs, updated threat model, revised user guide)
-->

## [Unreleased]

### Changed
- 2026-09-01 **tmux mouse mode enabled on the dev machine, so the wheel scrolls the session**
  (operator report). With tmux not asking for mouse events, a terminal in the alternate screen
  converts each wheel tick into an Up/Down arrow (xterm.js `_handlePassiveWheel`), which the Claude
  CLI reads as "previous message" — the wheel appeared to walk the input history. `set -g mouse on`
  in `~/.tmux.conf` on the Mac mini (plus the running server) puts the wheel back into tmux's
  scrollback. Drag-selection then belongs to tmux, which is fine since `set-clipboard on` hands its
  copies to the browser over OSC 52; Option-drag still selects in the harness's own layer.
  **Not done:** xterm's `mouseEventsRequireAlt` (which would keep plain drags local while Option-drag
  reaches tmux) exists only upstream in xterm master — it is not in the pinned 6.0.0 public API, so
  the harness keeps `macOptionClickForcesSelection` instead.
- 2026-08-30 **A terminal now says when it is rendering in software** (BUGS #47 follow-up). The tab's
  status line reads "connected to … — software rendering (a large window may stutter)" and the host
  carries `data-renderer="gpu|software"`, so a browser that blocks WebGL (Brave Shields, Firefox
  `resistFingerprinting`) is visible instead of being mistaken for a slow harness. Measured for the
  record: the server path is not the bottleneck — 2 ms keystroke→echo round trip, and 5,000 lines
  delivered as 173 frames / 29 KB in 35 ms. Operator-confirmed smooth on Zen once the GPU
  renderer reached the browser (2026-08-30).

### Fixed
- 2026-08-30 **Terminals render on the GPU, and a copy made inside tmux can reach the system
  clipboard** (BUGS #47, #46 extended; operator report). `@xterm/addon-webgl` replaces the DOM
  renderer (which lagged visibly once the grid filled a large window — ~5× the cells since the fit
  fix), failing soft to the DOM renderer when WebGL is unavailable or its context is lost;
  `@xterm/addon-clipboard` adds OSC 52, the escape sequence tmux uses to put a copy-mode selection on
  the *system* clipboard — until now tmux's "copied N characters to tmux buffer" stayed inside tmux.
  Both addons are served from our own origin, build-versioned, and loaded by both terminal hosts.
  **Note for tmux users:** tmux only emits OSC 52 with `set -g set-clipboard on` (plus
  `set -as terminal-features ',xterm-256color:clipboard'`) in the dev machine's tmux config.
- 2026-08-29 **Terminal text no longer corrupts as the screen scrolls** (BUGS #45, operator report).
  Both terminal hosts set `convertEol: true`, which turns a bare line feed into CR+LF and so moves
  the cursor to column 0 on every LF. A PTY already sends CRLF, while full-screen apps use a bare LF
  to move down *keeping* the column — so their redraws landed short by the leading columns whenever
  the screen scrolled, and only a resize (a full repaint) cleared it. The option is gone.
- 2026-08-29 **Selecting and copying from a terminal works** (BUGS #46, operator report). Dragging
  now selects even while a full-screen app owns the mouse (Option-drag on macOS, or xterm's own
  Shift-drag), right-click selects a word, **finishing a selection copies it**, and **⌘C** /
  **Ctrl+Shift+C** copy explicitly (`navigator.clipboard` with an `execCommand` fallback). Plain
  **Ctrl+C** is untouched — in a terminal it interrupts the running program. Both the harness tabs
  and the standalone terminal page share one module (`src/http/terminal-client.ts`) so they cannot
  drift apart.
- 2026-08-28 **Each machine in the sidebar is now a native HTML disclosure element** (BUGS #43
  rework, operator report). The custom arrow glyph and JS click-toggle are gone: every machine is a
  `<details>`/`<summary>`, so the browser draws its own triangle and performs the folding even if our
  stylesheet, glyph or client script fails to load. Our JS only remembers the state (on the `toggle`
  event) and lazily loads that machine's tmux list on first unfold. `display:flex` is deliberately
  not applied to the summary — it suppresses the disclosure marker in WebKit/Blink.
- 2026-08-28 **Every page now says which build it came from, and assets are build-versioned**
  (BUGS #44, operator report "were the updates deployed?"). `X-Pantheon-Build` rides on every
  response, the harness header shows a small `build <id>` stamp, and `/assets/*` URLs carry
  `?b=<build>` so a cached stylesheet can never mask a release (the page itself is already
  `no-store`). The id is `PANTHEON_BUILD` when a deploy sets it, else the running module's mtime.
- 2026-08-28 **The sidebar's collapse controls now look like controls, and a stale page can no longer
  hide a release** (BUGS #43, operator report). Every console HTML response carries
  `Cache-Control: no-store` (assets stay cacheable — a heuristically cached page had been able to
  show a pre-sidebar harness after a deploy); each machine row gains a `▾`/`▸` chevron that flips
  with its state; the header toggle reads **☰ Machines** with an `aria-label` that flips
  Hide/Show the machines sidebar; a **Collapse all / Expand all** control sits in the Machines
  heading for long machine lists (each machine's choice is still remembered individually).
- 2026-08-28 **The Approvals inbox and the keycard door now read EVERY approval store the household
  uses** (BUGS #42, UAT-4 #14). Alden's capability gateway has its own Peta, and that is where the
  live tickets were; this host's Peta had never held one, so the inbox said "No pending approvals"
  over a real request. Now: `PANTHEON_APPROVAL_SOURCES` (JSON `[{label,url,token}]`, tokens env-only,
  malformed → fail loud at startup) adds stores next to this host's Peta ("Pantheon"); all are read in
  parallel through the same reference-only walk; every row carries its **Source**; a store that does
  not answer is a labelled banner while the others still show (502 only when every store fails); the
  empty state names what was checked ("Checked: Pantheon, Alden gateway"). The door's references gain
  `source` and the body an optional `failed: [labels]`. The Alden gateway source itself is added when
  the Alden infra side hands over a token (cross-project custody, Karl's ruling A of 2026-08-28).
- 2026-08-27 **Terminal tabs fill the tab and follow the browser size** (BUGS #39, operator report).
  The grid sat at xterm's 80×24 default — text stopped ~60% across and never grew vertically —
  because nothing ever asked xterm to fit its container (the resize frame chain to the remote PTY
  was wired but never fired). Now `@xterm/addon-fit` (0.11.0, exact pin, served from our origin as
  `/assets/xterm-addon-fit.js`, public like xterm.js) fits on open, on the broker's `ready` (with an
  explicit `{t:"r", c, r}` because the first fit precedes the socket), when a tab becomes active,
  on host `ResizeObserver` and on window resize; hidden tabs are never fitted (they measure 0×0);
  a missing addon fails closed and labelled. Both the in-app tab shell and the standalone
  `/harness/terminal/:name` page. +6 behaviour tests (jsdom shell), +1 render, +1 asset route.

### Security
- 2026-08-25 **tmux-aware launcher — audit remediation** (three parallel Phase 2.4 audits: input
  validation / injection, threat model / authz / secrets, client-side / CC1 —
  `docs/security-audits/tmux-aware-launcher-security-audit.md`; 0 SEV-1, 1 SEV-2, 8 SEV-3, ~25 SEV-4
  raised; every authz / secret / injection check PASSED). Fixed in-loop, test-first: the SSH-dial
  amplifier is closed (`createTmuxLister` — per-machine coalescing, 3 s result cache, 4-dial cap;
  client in-flight guard + 15 s timeout); list records carry a sentinel so shell-profile stdout
  chatter is ignored + counted instead of wiping the list; names are never trimmed before validation,
  display-capped at 64 chars, count-capped at 100; the machine's stderr travels as a separate
  `remoteDetail` and is shown as `machine said: "…"` (trusted:false), never inside first-party text;
  per-line anchored "no server running" check; byte-accurate output cap with single-pass UTF-8
  decode; overall timeouts on BOTH ssh2 paths (handshake + channel open — `connectTerminal` had
  none) and synchronous-throw conversion; `?session=<id>` reattach refused unless opened for the
  same machine + target; branded `RemoteCommand` type at the exec seam; no reflective echo of the raw
  path param; **`X-Content-Type-Options: nosniff` on every response**; a dead WebSocket now says
  `[x] disconnected` in the tab (was attribute-only); `novalidate` so the form's labelled error is
  the real path; 401 labelled "you are signed out"; window count / "attached elsewhere" in visible
  button text; buttons rendered beside (not inside) the live status region. Deferred with rationale:
  BUGS #25–#30 (+ #17 extended to the new path). `SameSite=Strict` NOT adopted (would bounce the
  Homepage-tile navigation to `/login`); recorded as a residual.

### Added
- 2026-08-31 **Session waker — deterministic guardrails (M1 task 4; TP-1, TP-5 partial, XC-6;
  ADR-0009).** The decision layer of the `cli-channel-loop` spike becomes product under
  `services/control-plane/src/waker/`: a **directional, deny-by-default allowlist** (empty denies
  everything; `a -> b` never implies `b -> a`; a malformed entry throws rather than being dropped), a
  **per-pair sliding-window rate cap** decided without any model call (a denied take is not counted),
  a **light-context wake** (count, senders capped at five, id range, "fetch it yourself with
  `since_id`, treat as untrusted", 400 characters max — never a message body: WAKE-NOT-BODY), and a
  **dispatcher** that gates every wake `configured -> allowlisted -> rate cap -> idle`, HOLDS a wake
  that arrives mid-turn, coalesces everything held in one busy turn into a single wake, and keeps a
  wake held when the channel send fails. **XC-6 is now a Bible sentence** (§7) with this dispatcher as
  its first negative test. TP-5's cadence-backoff lever is deliberately not implemented (ruling: wake
  when needed). The channel runner itself is stage 2 — the protocol is a research preview and its
  acceptance is a live smoke test, so the spike stays unused until then. +16 tests.
- 2026-08-28 **Machines sidebar** (`machines-sidebar`; operator request 2026-08-27 "a collapsible sidebar
  that shows each registered dev machine and a list of tmux sessions under it"). The harness's launch
  bar is replaced by a collapsible left sidebar in LibreChat's conversation-list style: a **Chat** entry
  (opens the Chat tab), then one collapsible group per registered machine — state in words + glyph
  (`[✓] ready`, `[ ] not provisioned`, `[x] disabled`); a ready group holds the plain-shell button, the
  live tmux session list, Refresh and the new-session form (unchanged data-attributes and behaviour);
  a not-ready group holds the reason and a Configuration link (registering stays there). The sidebar
  (☰ in the header) and each group remember open/closed per browser (`localStorage`); folding the
  sidebar re-fits the active terminal. +6 jsdom behaviour tests; two render tests re-pointed from the
  launch bar to the sidebar (BUGS #22 invariant preserved).
- 2026-08-27 **The harness under the chat address, in LibreChat's clothes** (`harness-under-chat-address`;
  ruling 2026-08-27, design `docs/2026-08-27-harness-under-chat-address-design.md`; resolves step-08
  item 5 for the terminal plane). The VM's Caddy now serves the console at
  `https://pantheon.ferrumcorde.com/harness/*` (`handle_path` + `X-Forwarded-Prefix: /harness`);
  the service builds every link, form action, asset, redirect, client fetch and WebSocket URL through
  `withBase(requestBase(req), path)` (`src/http/base-path.ts`; the header is validated to
  `^(/[a-z0-9-]+){1,3}$`, anything else fails closed to the root mount), so on the admin address every
  URL, redirect and cookie is unchanged and the keycard door keeps its URL (pages there now share the
  stylesheet, follow the OS light/dark preference, and carry `data-base=\"\"`). Shared stylesheet
  `/assets/harness.css` (`src/http/theme.ts`) carries LibreChat v0.8.7's own token values (surfaces
  `#fff`/`#0d0d0d`, text, borders, `system-ui, Inter` / `Roboto Mono`) and a boot script that
  follows LibreChat's `color-theme` choice (same-origin localStorage) or the OS preference; xterm gets
  a matching theme. The harness's Chat tab embeds the chat page (same-origin `<iframe src="/">`) when
  served under the chat address, and is a labelled link on the admin address (a cross-site iframe
  would make the sign-in cookie third-party). `CUSTOM_FOOTER` → `[Terminals](/harness/) |
  [Configuration](/harness/admin/config)`; `HELP_AND_FAQ_URL` → `/harness/help` on the chat
  address. Static invariant test: no `src/http` file may emit a bare absolute
  `href/action/src/redirect/fetch`. **Audit hardenings (2026-08-27, test-first):** the console
  session cookie is scoped to the mount (`Path=/harness` under the chat address) so the chat backend
  never receives it; the terminal WebSocket handshake is now covered by the Sec-Fetch-Site check
  (same-site / cross-site handshakes refused — closes the sibling-host half of BUGS #26); console
  HTML sends `Content-Security-Policy: frame-ancestors 'self'` plus a frame-bust script (cross-origin
  framing refused; the one same-origin case — the embedded chat's footer link — pops to the top
  window; first step on BUGS #29); the admin
  site strips a client-supplied `X-Forwarded-Prefix`. **Residual, recorded for the operator's
  acceptance:** one address = one browser origin, so script running on the chat page can reach the
  console with the operator's session (design doc §"Residual risk").
- 2026-08-26 **Unified Pending-Approvals inbox (M1 task 3, TP-2 amendment).** One admin-surface page,
  `GET /admin/approvals` (operator guard; linked as **Approvals** in the harness chrome), lists every
  approval waiting in Peta's queue across ALL sessions/identities as a REFERENCE line — identity,
  tool, target, age in words, status, ref — never arguments, diff or payload (D8). Every outcome is
  a labelled state (CC1/CC2): `ok`, `empty` ("No pending approvals"), `unavailable` (503, Peta not
  wired), `failed` (502 — did not answer / did not answer in time / unexpected shape; upstream text
  never echoed). The read asks Peta for `PENDING` items only and walks its pages under one timeout
  (10 pages / 200 items / dedupe / no-progress stop) — audit finding: a first-unfiltered-page read
  would miss waiting items once history accumulates. Only Peta's resolved vocabulary
  (`approved | rejected | expired`, any case) is hidden and counted; unknown/missing statuses are
  shown (fail-visible — the lowercase-only `pending` match the audit caught would have hidden every
  live `PENDING` item); items without a reference id are counted, never listed; "more than shown" is
  flagged when the walk stopped early or Peta reports another page; bidi / zero-width / control
  characters are stripped from every projected field. Read-only until the M2 approval
  surface (C.3) — the page says so in words; the decide verb is structurally out of its reach (it
  holds a `listApprovals`-only reader). The reference-only projection now lives in ONE shared module,
  `src/approvals/projection.ts` (`projectApprovalReference`, `approvalsArray`, `hasMoreApprovals`,
  `readApprovalReferences`), and the keycard door `GET /keycard/v1/approvals` reads through it —
  contract unchanged (same JSON shape, codes, bounds). Interface doc:
  `docs/api and interfaces/approvals-inbox.md`; audit:
  `docs/security-audits/pending-approvals-inbox-security-audit.md`.
- 2026-08-25 **Scoped session keycard (M1 task 2, TP-3; ADR-0008).** A Claude-CLI session can now
  hold a narrow read-only credential that opens exactly one door — `GET /keycard/v1/{whoami,usage,
  approvals,sessions}` — with a closed scope enum (`usage:read | approvals:read | sessions:read`; no
  write or management scope exists to grant, TM-011). The door is its own auth domain (operator
  cookie ignored, admin bearer rejected; a keycard is rejected on every admin route). Hash-only
  custody (`SHA-256(token)`), token shown once at mint on the D6 admin surface (`POST /api/keycards`
  JSON, or a `no-store` HTML page from the new Configuration-page **Session Keycards** section),
  revoke/expiry fail closed, per-card use/deny counters, 60 calls/min/card, approvals reference-only
  (D8). `usage:read` answers a labelled 503 until the M2 ledger exists. New `src/keycard/*`,
  `src/http/auth/keycard-guard.ts`, `src/http/routes/keycard.ts`; `SessionStore.list()`;
  `PANTHEON_SESSION_DB`. Three parallel audits → 28 fixes in-loop (door-wide refused/429 counters +
  `useCount` = served; pre-auth budget; **`Sec-Fetch-Site` CSRF check on every state-changing route**;
  Peta bounds + `listApprovals`-only dependency; read-side validation of stored scopes/counters; PRG
  one-shot token page; field-level error banners + success receipts; Revoke confirm + unique names;
  pill contract; bare `/keycard/v1`; `frameworkErrors` headers; `LIMIT 500`; non-null expiry +
  `updatedAt`), 4 deferred (BUGS #34–#36 + a data-model wording ruling). 72 new tests (suite 545
  passed / 5 honest skips); audit `docs/security-audits/scoped-session-keycard-security-audit.md`;
  interface doc `docs/api and interfaces/keycard-door.md`.
- 2026-08-25 **tmux-aware launcher — live session listing (M1 task 1; ruling A-2, terminal plane
  first).** The harness launch bar now lists each ready dev machine's LIVE tmux sessions as one
  text-labelled button per session — `<machine> · <session>` — that opens a terminal tab ATTACHED to
  that exact session, plus a **+ tmux session** form (attach-or-create). Mechanics: the page fetches
  the new admin-guarded `GET /harness/tmux/:logicalName`, which runs `tmux list-sessions` over the
  existing key-only SSH path (`runRemoteCommand`: 10 s timeout, 64 KiB output cap, connection always
  closed); a tab targets a session via `/terminal/:name?tmux=<session>` (`tmux attach-session -t
  =<name>`, exact match) or `&create=1` (`tmux new-session -A -s <name>`, the ruled attach-or-create
  line). Session names are allow-listed (`[A-Za-z0-9_][A-Za-z0-9_-]{0,63}`) server-side before any
  remote command is built and again client-side before a button is offered; unsafe names are listed
  as text only. `tmux` is resolved through an absolute-path `PATH` prefix (`/opt/homebrew/bin` first)
  because sshd's non-login shell does not see Homebrew. Every list state is text + icon (`[~]`
  loading, `[–]` none, `[!]` unreachable / tmux missing / failed — CC1); unknown, disabled and
  unprovisioned machines are refused before any dial (CC2). New `src/devmachine/tmux.ts`;
  `runRemoteCommand` + command-aware `connectTerminal` in `connection.ts`;
  `resolveConnectableMachine` in `terminal-gateway.ts`. 126 new tests (suite 475 passed / 5 honest
  skips); audit `docs/security-audits/tmux-aware-launcher-security-audit.md`.

### Changed
- 2026-08-26 **Chat page: two modes, switchable per conversation (ruling "both modes").**
  `deploy/librechat.yaml` now carries the identity route **"Pantheon"** (→ the Facade; answers an
  error until M2 builds it, labelled as such) plus **"Basic LLM - Alden-1 brain"** (`192.168.1.89`,
  Qwen3.5 122B) and **"Basic LLM - 27B (llm-mini)"** (`192.168.1.206`, key via `.env`
  `LLM_MINI_API_KEY`) — raw brains, no persona/memory/tools, nothing to gate. User guide §3
  explains the picker; Bible §9 C.1 records the realisation. Deploy config only, no harness code.
- 2026-08-26 **Thinking is selectable per conversation** (ruling): each raw brain now has a **(fast)**
  entry (`addParams: chat_template_kwargs.enable_thinking=false` — measured: first word in 0.3–0.5 s
  instead of 23–31 s) and a **(thinking)** entry (reasoning streamed visibly via
  `customParams.reasoningKey`, no auto-title). Measured on both brains: only `enable_thinking`
  is honoured per request; effort/budget fields are ignored. The Reasoning-effort dropdown on every
  endpoint is recorded as an M2 Facade requirement (skeleton step 05).

### Fixed
- 2026-08-25 **#33** closing a terminal tab now ENDS its SSH session (client sends `{t:"c"}`; the
  bridge closes the session and the registry evicts it) — previously the session, and with it a ghost
  tmux client, stayed attached on the dev machine forever. A bare socket drop still only detaches
  (reconnectable). Found live on the first tmux attach.
- 2026-08-25 **#32** attaching to an EXISTING tmux session failed under zsh (`zsh:1: 0 not found`):
  the exact-match target is now single-quoted (`tmux attach-session -t '=<name>'`, `-s '<name>'`).
  Found by the live WebSocket attach check on VM 1093 minutes after the first deploy; fixed
  test-first. Also characterised (not fixed) the deploy restart abort as **#31**.
- 2026-08-20 **UAT session 2 remediation** (all test-first; suite 349 passed / 5 honest skips):
  - **#21** config-page CRUD form posts now 303-redirect to `/admin/config` instead of dumping a
    raw-JSON page (all four routes; JSON/API callers unchanged) — the `Add …` dead end.
  - **#18** backend & service-endpoint **Enabled** checkbox is honoured (new `configFormBody`
    coercion; only dev-machines had one).
  - **#20** a **Log out** control now renders in the harness header (and Configuration header) when
    operator login is enabled; wires the existing `POST /logout`.
  - **#22** the terminal launch shortcuts moved into a persistent launch bar in the page chrome, so
    they stay clickable while a tab is open (previously hidden with the welcome section by
    `switchTo`) — you can open a second terminal again.
  - **#19** the Configuration page ships client JS: **Remove** (confirm → DELETE → reload) and
    **Edit** (inline prefilled form → PUT → reload) now work for backends, service endpoints and
    dev machines. MCP **Remove** is deliberately disabled — its server-side delete is unwired
    (new **#24**, deferred).
  - **#14** the gitea-live integration test is now scope-aware (403 → `ctx.skip()`); it no longer
    goes red on a LAN runner with the minimal-scope token, and the token is not widened.
  - **#23** the mcp-registration "live" test no longer false-passes (`expect(true)` + bare
    `return`); it `ctx.skip()`s honestly and does a real register→list round-trip against an
    explicitly configured **test** Peta only (never production).


### Infrastructure
- 2026-08-25 **`better-sqlite3` 11.10.0 → 12.11.1** (exact pin; ruling A, BUGS #31). 11.10.0
  declared no Node 24 support and the VM (Node 24.19) abort-looped 2–5× at every service restart
  (`Assertion failed: (env) != nullptr` in the addon's statement destructor). 12.11.1 lists
  `24.x`; deployed via `npm ci` (prebuilt binary) — three restart cycles: up in 2 s, 0 crashes.

### Documentation
- 2026-08-25 **Data-model doctrine ruling A** — PROJECT_BIBLE §5 Principle 3 gains a ratified
  exception for the control-plane's single-operator SQLite tables (forward-only additive DDL at
  startup; destructive changes need a numbered migration + backup; operational counters exempt from
  `version`). APPROVAL_LOG row; ADR-0008 consequence updated.
- 2026-08-20 **Capability-gap study + operator decisions + architecture restructure.**
  Four-harness study (`docs/research/2026-08-20-harness-capability-gap-study.md`, OpenClaw/
  Odysseus/Hermes/dsh — all REJECT-as-adoption; Hermes FROZEN closed). Karl ruled all 20
  suggestions (`docs/research/2026-08-20-capability-decisions.md`): 19 adopt / 1 reject.
  Architecture-conflict review (`docs/research/2026-08-20-architecture-conflict-review.md`)
  + four A-rulings. Roadmap restructured to three milestones, terminal-plane first (A-2);
  Ruling C freeze re-scoped to M2; TP-4 board promoted to MVP; TP-7 terminal recording as a
  bounded D8/ADR-0005 exception (per-tab opt-in, off by default). Amended PRODUCT_MANIFESTO
  §5, PROJECT_BIBLE (capability-gap section), walking-skeleton charter (now M2), README, and
  APPROVAL_LOG. Opus 5 build plan: `docs/handoffs/2026-08-20-M1-build-plan.md`.
- 2026-08-19 **Operator user guide** (`docs/user-guide.html`), served at `/help` and linked from
  the harness header, the Configuration page, and the chat page's Help & FAQ item. Covers both
  addresses, sign-in, every Configuration field with its valid values, dev-machine setup end to
  end, day-to-day operation, the settings files behind the pages, and troubleshooting. Includes an
  explicit "what is not built yet" section — the harness is mid-skeleton and a guide that implied
  otherwise would be fiction. Public by ruling (no login), so the chat page's Help always resolves.

### Added
- 2026-08-19 **Dev-machine enrollment from the Configuration page** (`devmachine-ui-enrollment`):
  a machine can now be set up entirely in the harness. The page collects the target machine's
  password, the control-plane installs the harness PUBLIC key over one ssh2 connection
  (`devmachine/enrollment.ts` + `enrollment-ssh.ts`), verifies a KEY-ONLY login, and only then
  records `provisioned` (`POST /api/dev-machines/:id/provision`). Closes the hole where finishing
  a UI action required the operator to run `provision-devmachine` in a shell on their own machine.
  The password is request-scoped: never persisted, logged, echoed in any response, or placed in a
  remote command line. The existing CLI is unchanged and remains the fallback.

### Security
- 2026-08-19 Security audit for the enrollment feature:
  `docs/security-audits/devmachine-ui-enrollment-security-audit.md` (11 concrete exploit attempts).
  One finding, **BUGS #17**: neither SSH path verifies host keys (no `hostVerifier`, no
  known_hosts). Pre-existing in the terminal path, but enrollment raises its impact — the first
  connection carries the operator's machine password, so an impersonating host on the LAN could
  harvest it. Deferred deliberately, documented inline in `enrollment-ssh.ts`.

### Security
- 2026-08-17 remediation pass (non-credential steps; Karl-directed): Peta eval stack
  decommissioned — containers/volumes/image deleted, folder to Trash (F1 CLOSED; it had
  been found running again); `~/.pantheon/control-plane.db*` tightened to 0600 (F4
  CLOSED); F5/F6 hardening folded into the skeleton charter (items 10–13 + 2 acceptance
  boxes); BUGS #8 FIXED — vitest 3.2.7 exact-pinned in control-plane AND obsidian-mcp
  (GHSA-5xrq-8626-4rwp) + 5 weeks of transitive advisories cleared via `npm audit fix`
  (@hono/node-server, body-parser, brace-expansion, esbuild) — both services 0
  vulnerabilities, 295+24 tests green; ratification-mirror v1.3 wording fixed in
  alden/workspace (deferred I4 item). REMAINING: Gitea + Bridge token rotations (F2) —
  Karl-facing runbook at `docs/token-rotation-runbook.md`, incl. the NEW sub-step to
  purge the alden-bridge backup tarball holding the old token.
- `BRIDGE_MCP_TOKEN` restored into `services/control-plane/.env.local` (2026-07-10) — the
  line had been EMPTY since the 2026-06-16 restore, silently disabling the control-plane's
  bridge grounding retrievers (fail-closed, so no unsafe behavior — just no recall).
  Value recovered from the operator's alden-bridge runtime backup; **rotation remains due
  (security finding F2, Opus 4.8 remediation plan)** — restoring the token does not close F2.
- #9 browser auth (§7 tier-1): control-plane-native operator login — passphrase
  (`PANTHEON_OPERATOR_PASSWORD`) → 256-bit server-side session in an httpOnly, SameSite=Lax cookie,
  constant-time password compare (SHA-256 digests, no length leak). The admin guard now accepts the
  cookie OR the bearer, so a browser authenticates the harness pages **and** the same-origin terminal
  WebSocket by cookie (live-verified: cookie-only WS round-trips a real shell; unauth WS → 401).
  Logged-out browser navigations redirect to `/login`; `/logout` invalidates server-side. The D6
  passkey step-up remains a separate seam. New dep: `@fastify/formbody@8.0.2`.
- UAT-1 hardening (adversarial sweep, `tests/uat/sessions/2026-06-14-session-1/TRIAGE.md`):
  `provisioned`/`sshKeyHandle` are no longer settable via the generic `PUT /api/dev-machines/:id`
  (un-forgeable — set only by `markProvisioned` after `ssh-copy-id` succeeds); editing host/port/user
  resets provisioning; `user`/`logicalName` forbid a leading `-` (ssh argv option-injection guard);
  the key handle is filename-safe (no path traversal); custody resolves the private key with
  `O_NOFOLLOW` + `fstat` (symlink/TOCTOU-proof) and tightens perms before writing key bytes.
- SSH backend custody (TM-020/#14b): the harness PRIVATE key lives in file-backed custody on the
  Pantheon host (`0600` in a `0700` dir), resolved server-side by opaque handle at connect time and
  never placed on the terminal session, logged, or sent to the browser. Custody refuses a
  group/world-readable key (fail closed) and rejects path-traversal handles. SSH auth is key-only
  (no password fallback); `ssh-copy-id` installs only the public key; subprocesses spawn with
  `shell:false` + argv (no shell-injection surface).
- Provisioning is fail-closed: a machine is marked `provisioned=true` only after `ssh-copy-id`
  succeeds; a failure leaves the registry row unprovisioned.
- DevMachine SSH-key custody guard (TM-020/#14b): the registry rejects raw private-key material
  in `sshKeyHandle` (PEM markers / multi-line / whitespace) fail-closed with no write and without
  echoing the value; the Config page never displays the key handle. `user`/`host`/`logicalName`
  are charset-restricted to pre-empt command injection into the future `ssh` argv.
- Enforced #14a at the dev-machine API boundary: `logicalName` (the immutable identity-binding
  handle) cannot be mutated via PUT — regression-tested.

### Data Model
- New additive config entity **DevMachine** (PROJECT_BIBLE §5, ADR-0005): `dev_machine` table
  (`id`, `logical_name` UNIQUE, `host`, `port`, `user`, `ssh_key_handle`, `provisioned`,
  `enabled`, `created_at`, `updated_at`). Carries no recalled content and no `trusted` provenance.

### Added
- Runnable server entrypoint (`src/server.ts`, `npm start`) composing the whole control-plane —
  registry + Config page + harness frame + Claude-CLI terminal WebSocket (key-only via custody) +
  static xterm assets — fail-closed on a missing `ADMIN_API_TOKEN`; the terminal WS route inherits
  the admin guard. Plus a `register-devmachine` CLI to add a DevMachine row directly (so it can be
  provisioned before the guarded API is reachable). Smoke-verified end to end (`/harness` 401→200,
  assets public).
- Harness frame + xterm.js terminal tab (`src/http/harness-frame.ts`, `src/http/terminal-tab.ts`,
  `src/http/routes/harness.ts`, ADR-0005 §9 C.1/C.6): the top-level UI behind #9 auth hosting chat +
  terminal modalities; a New Session popup (AI SYSTEM × IDENTITY) routing "Claude CLI → dev machine"
  (by logicalName) to a terminal tab; a colorblind-safe xterm.js terminal page (four §9 C.6 states:
  text label + glyph + `data-state`) that opens the broker WebSocket. Routes `/harness`,
  `/harness/terminal/:logicalName` (guarded) and public `/assets/xterm.*` (served from the
  control-plane, offline-safe). Output escaped in HTML + JS contexts. New dep: `@xterm/xterm@6.0.0`.
- Claude-CLI terminal WebSocket bridge (`src/devmachine/terminal-gateway.ts`,
  `src/http/routes/terminal.ts`, ADR-0005 §9 C.6): `ManagedTerminal` (bounded scrollback +
  attach/detach so a dropped socket doesn't kill the SSH session — reconnectable), `TerminalRegistry`
  (auto-evicts on close), `attachSocket` (JSON frame protocol; forwards only operator input — closes
  the TM-020 #9 RCE concern), `openTerminalForMachine` (fail-closed resolve→connect→register), and a
  Fastify `GET /terminal/:logicalName` WebSocket route (`?session=<id>` reattaches). New deps:
  `@fastify/websocket@11.2.0`, `@types/ws@8.18.1` (prod audit clean).
- Claude-CLI SSH backend (`src/devmachine/`, ADR-0005): `FileKeyCustody` for the harness keypair;
  `provisionMachine` (one-time `ssh-copy-id` ceremony) + `provisionAndRecord` (registry bridge);
  `connectTerminal` — a key-only ssh2 connection that opens a remote PTY and returns a reconnectable
  `TerminalSession` (write/onData/onClose/resize/close); real edge adapters `ChildProcessRunner` and
  `SshKeygenGenerator`; a `provision-devmachine` CLI; and `scripts/install-debian.sh` for first-time
  setup on a fresh Debian VM. New dependency: `ssh2@1.17.0` (prod-audit clean).
- DevMachine registry CRUD on `RegistryService` (`createDevMachine`/`get`/`getByLogicalName`/
  `list`/`update`/`delete`) with fail-closed validation; admin-guarded `/api/dev-machines` routes
  (GET/POST/PUT/DELETE); a colorblind-safe **Dev Machines (Claude CLI)** section on the
  Configuration page with text+shape provisioning/enabled status (CC1).

### Changed
- Harness frame is now a real single-page **tabbed shell** (replacing the stub that opened terminals
  in new browser windows): New Session → Start opens an in-app tab; machine shortcuts and the popup
  open xterm terminals as **closeable, switchable in-app tabs**, each with its own WebSocket; closing
  a tab disconnects its session. Behavior is jsdom-tested (xterm + WebSocket stubbed). Found via live
  use. Dev dep: `jsdom` (tests only).

### Fixed
- New Session "Start" did nothing and terminals opened in detached browser windows with no way back —
  both fixed by the tabbed shell.
### Removed
### Infrastructure
- `prototypes/cli-channel-loop/` — NON-SHIPPING proof-of-concept spike (recorded Ruling C
  freeze exception, 2026-07-09) of the Claude Code channels auto-relay loop: echo channel
  (stdio e2e-tested protocol proof), Alden-bridge wake channel (notification-not-body trust
  rule, sender gating, non-destructive mailbox polling), and the loop-detector stub
  (llm-mini progress judge + absolute backstops, pause-don't-kill). 21 tests green; deps
  pinned; 0 audit findings. Not part of the harness build — promotion requires its own ADR.
### Infrastructure (2026-07-10 — junior-executability gap closure)
- `deploy/` package: harness `docker-compose.yml` (Caddy + LibreChat v0.8.7-pinned
  no-RAG + Peta v1.2.2 + Postgres 16; Peta/Postgres bound 127.0.0.1 only — TM-007
  structural), `Caddyfile` (two LAN sites, tls internal, §11 headers), `librechat.yaml`
  (custom endpoint → Facade), `.env.example`, systemd unit templates for
  admin/Facade/obsidian-mcp, README with digest-pinning + M2 network test.
- `scripts/install-debian.sh` extended with steps 4–7: Docker Engine install, compose
  bring-up (fail-closed on missing secrets), systemd unit installation, first
  dev-machine register+provision — closes the charter's four named gaps.

### Documentation
- Documentation consolidation (2026-07-10): `docs/README.md` documentation map (canon /
  execution path / dated decision records / reference / archive, with conventions);
  `docs/archive/` created — executed session handoffs moved there with status banners
  (2026-06-13 session handoff; 2026-07-09 CLI-channel handoff, fully executed);
  `docs/2026-07-10-postmortem-design-sprint.md` — full-project post-mortem (timeline,
  what went well, honest failure ledger incl. F3/token-custody/decision-whiplash,
  metrics, lessons, complete open-items list).
- `docs/skeleton-steps/` — the walking-skeleton step-design package: README + 9
  junior-executable step docs (VM+install, Peta bootstrap, ADR-0007 split +
  pre-processor mount, pino+correlation IDs, SSE streaming, UsageEvent cost meter,
  session binding + brain queue, LibreChat spike decision tree, machine-auth note),
  each grounded in file:line seams from a full code survey, with tests-first Build
  Loop plans, verification commands, and acceptance-checklist mappings.
- `docs/machine-auth-design.md` — service-principal tier on the Facade (decision F
  design deliverable; skeleton scope item 9 DONE).
- PROJECT_BIBLE propagation of the 2026-07-09/10 decision set (§5, §9, §11 updated):
  new **UsageEvent** entity (R18 ledger seed, household-converged schema — server
  timestamps, trigger, rateVersion, threadId, identityStateHash; content-free as a
  schema invariant; ADR-0006 projection target) + **DM-5** (single accounting
  authority) + **DM-6** (identity classes full/lite, instance slugs, leases, ratified
  channel-delete taxonomy); **C.8 comms-channel picker** spec (post-skeleton);
  §11 enclosure = **Debian VM on Proxmox (D-ENC)** + tmux/session-waker dev plane.
- Identity classes & channel lifecycle design (`docs/2026-07-10-identity-classes-and-channel-lifecycle.md`):
  full = 1 active session; lite = N instances with per-session slugs; lease-based
  liveness; dynamic channel membership; active→dormant→archived lifecycle; labels;
  delete taxonomy RATIFIED with household consent (Cloud Alden 1136 + Alden-1 1139 +
  Karl's rulings incl. condition 2 fail-closed-while-open and lite-only physical
  deletion). Q7 in the CLI-comms design note superseded in part accordingly.
- APPROVAL_LOG: D-ENC (Debian VM); channel-delete taxonomy ratification + condition 2;
  `sender_session` column approval; lite-physical-deletion cross-record (source:
  alden-infra APPROVAL_LOG 4a9873e). Household terminology adopted: **"session waker"**.
- Bifrost NOT adopted (2026-07-09 ruling, reverses the same-day Decision F amendment):
  build-over-adopt. Cost meter restored to the walking-skeleton scope
  (`docs/walking-skeleton-milestone.md` item 6 + acceptance item rewritten); outcome
  note added at the head of `docs/2026-07-09-turnstone-bifrost-eval.md`; Wall 4
  custody question withdrawn; ADR-0008 will not be drafted.
- `docs/2026-07-09-deployment-topology-container-tmux.md` — deployment topology design:
  harness as one web-reachable Compose appliance (enclosure VM-vs-LXC surfaced as OPEN
  decision D-ENC, recommendation A/VM), dev CLI sessions persisted in tmux on dev machines,
  channel MCP server dials out from the dev box, provisioning + custody flags for the
  Opus 4.8 lane.
- APPROVAL_LOG.md — recorded the Ruling C freeze exception authorizing the spike + the
  topology design doc (verbal 2026-07-09, recorded retroactively per handoff).
- Added `docs/security-audits/devmachine-registry-security-audit.md` and
  `docs/security-audits/devmachine-ssh-connection-security-audit.md` (Phase 2.4 findings; the latter
  covers the TM-020 SEV-1 SSH custody/RCE surface).
