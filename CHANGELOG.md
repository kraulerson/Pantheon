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

### Security
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
### Documentation
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
