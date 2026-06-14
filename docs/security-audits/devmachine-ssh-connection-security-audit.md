# Security Audit — DevMachine SSH Backend (Task #16b/c foundation)

**Feature:** `devmachine-ssh-connection` — harness SSH-key custody, the one-time provisioning
ceremony (`ssh-copy-id`), the key-only SSH→PTY connection broker, the real edge adapters
(`child_process` runner + `ssh-keygen` generator), the `provisionAndRecord` registry bridge, and the
provisioning CLI + Debian install script.
**Date:** 2026-06-13
**Persona:** Senior Security Engineer (Phase 2.4 — hunt concrete exploits). **This is the TM-020
SEV-1 surface (SSH key custody + remote command execution).**
**Scope refs:** PROJECT_BIBLE §5 (DevMachine), §7 (custody #14b), ADR-0005, TM-020, §10 (#3 fail-closed).
**Components:** `src/devmachine/{custody,provisioning,connection,runner,keygen,provision-and-record}.ts`,
`src/cli/provision-devmachine.ts`, `scripts/install-debian.sh`.

## Threats considered & concrete exploit attempts

| # | Threat (concrete exploit) | Control | Verdict |
|---|---|---|---|
| 1 | **TM-020/#14b — private key leaks to a client / log / session.** Anything that puts the harness private key into the browser, terminal buffer, an error body, or a log. | The private key is read from custody **server-side at connect time** and passed only to `ssh2.connect({privateKey})`. It is captured in a closure in `connectTerminal` and **never placed on the returned `TerminalSession`** (test asserts `JSON.stringify(session)` excludes it and there is no `privateKey` prop). Provisioning passes only the **public** key (a `.pub` scratch file) to `ssh-copy-id` — test asserts the private PEM appears in **no** command args. Error messages carry no key material. | **PASS** |
| 2 | **Private key readable by other host users.** Key file left group/world-readable on the Pantheon VM. | `FileKeyCustody` writes the private key `0600` in a `0700` dir and **refuses to resolve a key whose mode has any group/world bits** (`mode & 0o077`), failing closed. The install script creates the custody dir `0700` owned by the service user. | **PASS** (test: chmod 0644 → resolve rejects) |
| 3 | **Path traversal via key handle.** A handle like `../../root/.ssh/id_rsa` reads/writes outside the custody dir. | Handle is validated `^[A-Za-z0-9._-]+$` (rejecting `.`/`..`/separators) on **every** custody operation. | **PASS** (test: traversal handles rejected on resolve/has/store) |
| 4 | **Command injection into `ssh-keygen`/`ssh-copy-id`/`ssh`.** Malicious host/user/port reinterpreted as shell syntax. | `ChildProcessRunner` spawns with `shell:false` (default) and an **argv array** — no shell line is constructed. DevMachine `host`/`user`/`port` are already charset/range-validated at the registry boundary (no whitespace/metacharacters). | **PASS** |
| 5 | **Password auth fallback / credential prompt mid-session.** Connection silently falls back to password, or a password is stored. | `connectTerminal` sends **only** `privateKey` — no `password`, no `tryKeyboard` (test asserts `"password" in connectCfg === false`). Provisioning is the **only** place a password is entered, interactively by the operator via `ssh-copy-id`, and it is never captured by our code (stdio inherited). | **PASS** |
| 6 | **Machine marked usable without a real key install.** A failed `ssh-copy-id` still flips `provisioned=true`, so later connects assume key auth that was never set up. | `provisionMachine` throws on non-zero `ssh-copy-id` exit; `provisionAndRecord` updates the registry **only after** provisioning resolves — a failure leaves the row `provisioned=false`, `sshKeyHandle=""`. | **PASS** (tests: non-zero exit throws; row stays unprovisioned on failure) |
| 7 | **Unprovisioned connect.** Opening a terminal to a machine with no key. | `connectTerminal` resolves the key from custody **before** constructing/dialing a client; a missing key throws and **no connection is attempted** (test asserts the client factory is never called). | **PASS** (fail closed) |
| 8 | **Scratch-file key residue.** Temp key material left on disk. | The `ssh-keygen` scratch dir and the `ssh-copy-id` public-key scratch file are created under a temp dir and removed in a `finally`. Only the **public** key is ever written to scratch; the private key goes straight from the generator return value into custody. | **PASS** |
| 9 | **RCE surface (TM-020).** The Claude-CLI agent on the dev box can run commands; injected `trusted:false` content reaching it would be an RCE path. | Out of scope for the SSH transport itself: terminal sessions are **operator-driven** I/O (interactive), never auto-fed recalled `trusted:false` content (ADR-0005); Claude Code's own permission model is the inner guard on the remote. The transport here only brokers operator keystrokes ↔ remote PTY. | **DEFERRED** to the terminal-tab UI increment (must not pipe recalled content into the PTY) + Phase 3 threat-validation. |

## Residual notes (non-blocking)

- **`ssh-keygen`/`ssh-copy-id` availability** is assumed (installed by `install-debian.sh`, present on macOS/most Linux). The keygen unit test is guarded on the binary; the live SSH test is guarded on `PANTHEON_LIVE_SSH_HOST`.
- **Host-key verification:** `ssh-copy-id`/`ssh2` host-key trust-on-first-use applies. For a single-operator homelab on a trusted LAN this is acceptable for MVP; pinning `hostHash`/known_hosts is a hardening follow-up worth a backlog item before any non-LAN use.
- **DB path:** the CLI defaults the registry DB to `./data/control-plane.db`; the install script wires `PANTHEON_DB`. No secrets are in this DB (only the opaque key handle).

## Conclusion

No exploitable findings in the SSH backend. The TM-020 custody invariant (private key server-side
only, never to client/log, 0600-enforced, traversal-proof) and the fail-closed provisioning/connect
paths are implemented and covered by tests. The RCE concern (#9) is correctly a property of the
**terminal-tab UI** increment (do not feed recalled `trusted:false` content into the PTY) and Phase 3
validation, not the transport. **Cleared to proceed.**

## Post-UAT addendum (2026-06-14)
UAT session 1 ran a Phase 2.7 adversarial sweep against this surface and found additional input-validation / state-forgery gaps (leading-dash user → ssh option-injection; key-handle path-traversal charset; `provisioned`/`sshKeyHandle` forgeable via the generic admin PUT; custody symlink/TOCTOU + umask window). All were fixed test-first the same session. See `tests/uat/sessions/2026-06-14-session-1/TRIAGE.md` (Resolution) for the itemized fixes. Conclusion stands after remediation: no exploitable findings remain.
