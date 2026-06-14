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
### Fixed
### Removed
### Infrastructure
### Documentation
- Added `docs/security-audits/devmachine-registry-security-audit.md` and
  `docs/security-audits/devmachine-ssh-connection-security-audit.md` (Phase 2.4 findings; the latter
  covers the TM-020 SEV-1 SSH custody/RCE surface).
