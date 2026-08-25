# Feature Reference

<!--
  This document is a living index of all features built during Phase 2.
  Update at Step 2.5 of every Build Loop iteration alongside the CHANGELOG and Bible.
  Purpose: Give someone a quick orientation to what the app does without reading the Bible.
  For detailed analysis, follow the links to ADRs and interface docs.
-->

## Feature 1: DevMachine Registry (Claude-CLI SSH targets)

**Phase Built:** 2
**Status:** Complete
**Summary:** Registers and manages the dev machines that a Claude-CLI SSH-terminal tab connects to
(ADR-0005). Each DevMachine is referenced by an immutable `logicalName` so an identity's binding
survives an IP change (#14a); the SSH key lives in vault custody and is referenced only by an
opaque handle that the registry never accepts as raw key material and never displays (TM-020/#14b).
This is sub-task (a) of Task #16 — the foundation the provisioning flow and SSH broker build on.
**Key Interfaces:** `src/registry/{types,service,sqlite-repository}.ts`,
`src/http/app.ts` (`/api/dev-machines`), `src/http/config-page.ts` (Dev Machines section).
**Related ADRs:** ADR-0005 (Claude-CLI sessions are persistent web SSH-terminal tabs).
**Test Coverage:** Unit (`devmachine-registry.test.ts`, `config-page-devmachines.test.ts`),
Integration via Fastify inject (`http-app.test.ts` — Dev-machines API incl. admin-guard, custody
rejection, and #14a immutability boundary).
**Known Limitations:** Provisioning (`ssh-copy-id` + key custody) and the SSH→PTY→WebSocket broker
are later sub-tasks (b/c); `provisioned` is set by that flow. No live SSH yet.

---

## Feature 2: Claude-CLI SSH Backend (custody · provisioning · connection)

**Phase Built:** 2
**Status:** Complete (backend; WebSocket bridge + xterm.js frontend are later sub-tasks)
**Summary:** The server-side machinery for a Claude-CLI SSH-terminal tab (ADR-0005). Custodies the
harness's own SSH keypair on the Pantheon host (private key `0600`, resolved by opaque handle at
connect time, never to the browser/logs — TM-020/#14b); provisions a dev machine once via
`ssh-copy-id` (operator types the password once) and records it; then opens **key-only** ssh2
connections that bring up a remote PTY and expose a reconnectable `TerminalSession`. Ships a
`provision-devmachine` CLI and a guided `install-debian.sh` for fresh-VM setup.
**Key Interfaces:** `src/devmachine/{custody,provisioning,connection,runner,keygen,provision-and-record}.ts`
(barrel `src/devmachine/index.ts`), `src/cli/provision-devmachine.ts`, `scripts/install-debian.sh`.
**Related ADRs:** ADR-0005.
**Test Coverage:** Unit (custody, provisioning orchestration, connection lifecycle with a mocked
ssh2 client, child_process runner, ssh-keygen generator [guarded], provision-and-record, CLI usage);
guarded live SSH round-trip (`devmachine-ssh.live.integration.test.ts`, opt-in via `PANTHEON_LIVE_SSH_*`).
**Known Limitations:** WebSocket/PTY bridge and the xterm.js terminal tab + harness frame (sub-tasks
c/d/e) are not built yet. Host-key verification is trust-on-first-use (LAN MVP; pinning is a
hardening follow-up). Live provisioning requires the operator at the keyboard.

---

## Feature 3: Claude-CLI Terminal WebSocket Bridge

**Phase Built:** 2
**Status:** Complete (backend + route; xterm.js tab + harness frame are sub-tasks d/e)
**Summary:** Bridges a browser xterm.js terminal to a remote SSH PTY (ADR-0005 §9 C.6). A
`ManagedTerminal` wraps the SSH `TerminalSession` with bounded scrollback and an attach/detach
lifecycle so a dropped WebSocket does not kill the shell — the operator reconnects and reattaches to
the live session (replaying recent scrollback). The `attachSocket` bridge speaks a small JSON frame
protocol and forwards **only** operator keystrokes to the PTY (never recalled `trusted:false`
content — closes the TM-020 RCE concern). `openTerminalForMachine` fails closed on
unknown/unprovisioned/disabled machines before dialing. Exposed as `GET /terminal/:logicalName`.
**Key Interfaces:** `src/devmachine/terminal-gateway.ts`, `src/http/routes/terminal.ts`.
**Related ADRs:** ADR-0005.
**Test Coverage:** Unit (`terminal-gateway.test.ts` — scrollback, attach/detach reconnect, frame
parsing, registry eviction, openTerminal fail-closed); integration (`terminal-route.test.ts` — real
in-process WebSocket via `injectWS`: ready frame, input→PTY, PTY output→client, unprovisioned error).
**Known Limitations:** The xterm.js terminal tab + harness frame (d/e) are not built. The route must
be mounted behind the #9/admin guard; browser WS auth (cookie/ticket) is wired in sub-task (e). Live
end-to-end against a real machine is covered by the deferred live UAT.

---

## Feature 4: Harness Frame + xterm.js Terminal Tab

**Phase Built:** 2
**Status:** Complete (server-rendered UI + routes; live/visual verification is in the deferred UAT)
**Summary:** The top-level harness UI (ADR-0005 §9 C.1/C.6, amends ADR-0001) — a **single-page tabbed
shell** behind #9 auth. New Session (AI SYSTEM × IDENTITY) and per-machine shortcuts open Claude-CLI
terminals as **in-app, closeable, switchable tabs** (not new browser windows); each tab embeds an
xterm terminal + its own WebSocket to the broker (by logicalName, #14a), and closing a tab disconnects
it. Colorblind-safe state labels; xterm.js served from the control-plane's own origin; the SSH key
never reaches the browser; dynamic values escaped (HTML) or set via `textContent` (JS). Tab behavior
is jsdom-tested (`harness-shell.test.ts`). [The standalone `/harness/terminal/:name` page +
`terminal-tab.ts` also remain for direct links.]
**Key Interfaces:** `src/http/harness-frame.ts`, `src/http/terminal-tab.ts`, `src/http/routes/harness.ts`
(routes `/harness`, `/harness/terminal/:logicalName`, public `/assets/xterm.*`).
**Related ADRs:** ADR-0005.
**Test Coverage:** Unit (`harness-frame.test.ts`, `terminal-tab.test.ts` — popup, routing, the four
states, colorblind tokens, HTML/JS escaping); integration (`http-app.test.ts` — guarded pages, public
assets, populated terminal tab).
**Known Limitations:** Interactive behavior (xterm rendering, reconnect, state transitions) is verified
in the deferred live browser UAT, not unit tests. Browser session auth (cookie/ticket from #9 login)
and a CSP are tracked follow-ups for the #9 integration; the guard is currently bearer-token.

---

## Feature 5: Runnable Server Entrypoint + register-devmachine CLI

**Phase Built:** 2
**Status:** Complete
**Summary:** Makes the control-plane runnable. `createServer`/`configFromEnv` compose every piece —
registry, Config page, harness frame, the Claude-CLI terminal WebSocket (key-only via custody), and
the public xterm assets — into one Fastify app, with an `npm start` entrypoint that listens. It fails
closed without `ADMIN_API_TOKEN`, and the terminal WS route inherits the admin guard. The
`register-devmachine` CLI inserts a DevMachine row directly (via the same validated write path) so an
operator can register a machine and provision it without first standing up the guarded API.
**Key Interfaces:** `src/server.ts` (`npm start`), `src/cli/register-devmachine.ts`.
**Related ADRs:** ADR-0005.
**Test Coverage:** Unit (`register-cli.test.ts` — arg parsing); integration (`server.test.ts` — harness
behind auth, public assets, registry round-trip + terminal tab, guarded WS route, missing-token
rejection); manual smoke test (server boots, `/harness` 401→200, assets 200).
**Known Limitations:** The chat pre-processor (`/v1/chat/completions`) is not mounted by the entrypoint
yet. Browser/WS session auth and TLS/bind-host are deployment follow-ups (the guard is bearer-token).

---

## Feature 6: Operator Browser Auth (#9)

**Phase Built:** 2
**Status:** Complete (tier-1 UI auth; D6 passkey step-up remains a separate future layer)
**Summary:** The #9 UI auth gate (§7 tier-1) as a control-plane-native operator login, since LibreChat
isn't deployed to delegate to. The operator passphrase mints a 256-bit server-side session carried in
an httpOnly/SameSite=Lax cookie; the admin guard accepts that cookie OR the admin bearer. This lets a
**browser** authenticate the harness pages and — critically — the same-origin **terminal WebSocket**,
which can't carry an Authorization header. Logged-out browser navigations redirect to `/login`;
`/logout` invalidates the session server-side.
**Key Interfaces:** `src/http/auth/session.ts`, `src/http/auth/operator-auth.ts`, `src/http/app.ts`
(guard + `/login`/`/logout` + redirect), `src/server.ts` (`PANTHEON_OPERATOR_PASSWORD`).
**Related ADRs:** ADR-0005; PROJECT_BIBLE §7.
**Test Coverage:** Unit (`session-auth.test.ts` — id entropy, TTL/expiry, logout); integration
(`browser-auth.test.ts` — login form, wrong/right password, cookie-authed page, HTML redirect vs API
401, bearer still works, logout); manual live (login → cookie → real terminal WS round-trip; unauth WS
rejected).
**Known Limitations:** `Secure` cookie + `wss://` require TLS (set `PANTHEON_SECURE_COOKIES=true` behind
the reverse proxy); no login rate-limiting or CSRF token yet (SameSite=Lax is the current CSRF
control); in-memory sessions reset on restart. The D6 privileged step-up (passkey/WebAuthn) is unbuilt.

## Feature 7: Dev-Machine Enrollment from the UI (password bootstrap)

**Phase Built:** 2
**Status:** Complete
**Summary:** Turns "register a machine" into a job that finishes where it starts. Registering only
records where a machine is; it becomes usable when the harness public key is installed on it, and
that step used to need `ssh-copy-id` — which prompts on a TTY, so the operator had to run a command
on their own machine. The Configuration page now shows a Provision form for any unprovisioned
machine: it takes the target's password, and the server opens ONE password-authenticated ssh2
connection, appends the harness PUBLIC key to `authorized_keys` (idempotently, guarded by
`grep -qxF`), then proves the result by reconnecting KEY-ONLY before recording `provisioned`.
A failed enrollment leaves the row untouched rather than half-recorded.

**Security posture:** the password is request-scoped — never persisted, logged, echoed into any
response (including errors, which are rewritten rather than forwarded), or placed on a remote
command line. The private key never leaves custody (TM-020); only the public half is installed, and
it is validated against a strict OpenSSH grammar before being interpolated into the remote command.
Known gap: no host-key verification on either SSH path (BUGS #17).

**Interfaces:** `POST /api/dev-machines/:id/provision` (admin-guarded; form post → 303 back to
`/admin/config`, JSON post → the updated record).
**Code:** `src/devmachine/enrollment.ts`, `src/devmachine/enrollment-ssh.ts`,
`src/http/routes/enrollment.ts`, `src/http/config-page.ts`.
**Tests:** `test/devmachine-enrollment.test.ts`, `test/enrollment-route.test.ts`,
`test/config-page-devmachines.test.ts`.
**Audit:** `docs/security-audits/devmachine-ui-enrollment-security-audit.md`.

---

## Feature 8: tmux-aware Launcher (live tmux session listing + attach)

**Phase Built:** 2 — M1 (terminal plane), task 1
**Status:** Complete
**Summary:** The harness launch bar asks each ready dev machine for its LIVE tmux sessions and shows
one button per session (`<machine> · <session>`) that opens a terminal tab already attached to that
session, plus a "+ tmux session" attach-or-create form — so a long-running Claude session survives
closing the tab and can be picked up again from any browser. Listing runs `tmux list-sessions` over
the same key-only SSH path as the terminal (10 s timeout, output cap, connection always closed); a tab
runs `tmux attach-session -t =<name>` (exact match) or `tmux new-session -A -s <name>` on the PTY
instead of a login shell. Session names are allow-listed before any remote command exists (server)
and again before any button is offered (client). Ruled design (2026-08-20): live-list, not a
per-machine field. `tmux` is resolved via an absolute-path PATH prefix (`/opt/homebrew/bin` first).
**Key Interfaces:** `src/devmachine/tmux.ts` (allow-list, command builders, parser, labeled results),
`src/devmachine/connection.ts` (`runRemoteCommand`; `connectTerminal` `command` option),
`src/devmachine/terminal-gateway.ts` (`resolveConnectableMachine`),
`src/http/routes/harness.ts` (`GET /harness/tmux/:logicalName` → `{ machine, state, … }`),
`src/http/routes/terminal.ts` (`?tmux=<name>[&create=1]`), `src/http/harness-frame.ts` (launch bar +
client). Wired in `src/server.ts` (`AppOptions.tmux`).
**Related ADRs:** ADR-0005; ruling A-2 (APPROVAL_LOG 2026-08-20); attach-or-create line from
`docs/2026-07-09-deployment-topology-container-tmux.md` §4.
**Test Coverage:** Unit (`devmachine-tmux.test.ts`, `devmachine-connection.test.ts`); route
integration via Fastify inject / injectWS (`harness-tmux-route.test.ts`, `terminal-route.test.ts`);
render + jsdom behavior (`harness-frame.test.ts`, `harness-shell.test.ts`).
**Known Limitations:** the list is a snapshot (results are cached ~3 s per machine, at most 4
dials in flight, one request per machine at a time; Refresh re-reads; the list re-reads itself a few
seconds after you create a session); attaching to a session that ended after listing fails with a
labeled error rather than silently creating one; names outside the allow-list (or longer than 64
characters) are shown but not attachable (rename on the machine); at most 100 sessions are listed
(labelled "list truncated"); host-key verification is still TOFU on this path too (BUGS #17).
