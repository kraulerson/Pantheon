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

<!-- Copy the section above for each new feature. Number sequentially. -->
