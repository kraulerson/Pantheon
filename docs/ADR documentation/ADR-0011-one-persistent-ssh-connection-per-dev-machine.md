# ADR-0011: One persistent SSH connection per dev machine for non-interactive commands

**Status:** Accepted
**Date:** 2026-11-12
**Phase:** Phase 2 — bug fix (BUGS #86, Karl's ruling A, 2026-11-10)
**Relates to:** ADR-0005 (terminal tabs, key custody), ADR-0010 (Maestro Console poller); TM-020; ruling T11-18 (failure phases); BUGS #72 (machine drop-outs)

## Context

Every non-interactive command the control plane runs on a dev machine — the console poller's probe, the tmux
listing, reply delivery, session and project creation, card expansion — went through `runRemoteCommand`, which
dials a new key-only ssh2 connection, runs one command and closes it. With the console polling every 5 seconds
that is about 12 logins a minute per machine. Measured 2026-11-10: 12 connections in TIME_WAIT from VM 1093 to
Linux-Dev and 7 to Mac-Mini.

One property of the old design was valuable: because every command re-read key custody and the registry row,
disabling or removing a machine, or rotating its key, took effect within one poll. A persistent connection must
not lose that.

## Options Evaluated

| Option | Description | Pros | Cons |
|--------|------------|------|------|
| A | Keep one login per command; poll less often | No new code | Slower console; still one login per command for every other caller |
| B | OpenSSH `ControlMaster` through the system `ssh` binary | Connection sharing is built in | Abandons the in-process ssh2 path and its custody model (key resolved in memory, never on a command line); a second SSH stack to secure |
| **C (chosen)** | An in-process pool: one ssh2 connection per machine, each command its own `exec` channel | Same library, same custody path, same failure contract; one login per machine | The connection now has a lifetime that must be tied to the machine's right to be used |

## Decision

`src/devmachine/connection-pool.ts` holds at most one ssh2 connection per machine (keyed by logical name).

- **Commands.** Each command is one `exec` channel. At most 8 run at once per machine (sshd's default
  `MaxSessions` is 10); a ninth is refused before anything is sent.
- **Failure contract.** Messages and `phase` are those of `runRemoteCommand`, so `remoteCommandFailure` classifies a
  pooled failure exactly as before (ruling T11-18): refused before the exec request means "did not run".
- **Dead links.** ssh2 keepalives (10 s, 3 missed) close a silent connection. A command that outlives its timeout
  fails as `timeout` and closes only its own channel, so a slow probe cannot fail a delivery sharing the connection.
  Three timeouts in a row with no success between them close the connection.
- **Redial.** A failed login is not retried until a backoff has passed (1 s doubling to 15 s, reset by a good
  login). A connection that drops after a good login is redialled by the next command.
- **Lifetime (security).** The key is still resolved from custody on every command; a changed or missing key closes
  the open connection first. A changed address, user or key handle closes it. The registry tells the pool whenever a
  machine is updated, re-provisioned or deleted (`RegistryService.onDevMachineChange` →
  `closeOnDevMachineChange`), and the pool closes that machine's connection at once. Closing is always safe: if the
  machine may still be used, the next command dials again. A command that had already started when the machine was
  closed is refused before it can dial, so it cannot re-open a connection nobody would close; closing also clears the
  login backoff.
- **Scope.** Terminal tabs keep their own connections (`connectTerminal`). `runRemoteCommand` remains for one-off
  use and for its tests; the server no longer calls it.

## Consequences

- About 12 logins a minute per machine become one login per machine per connection lifetime.
- A machine now holds one long-lived connection from the control plane. `sshd` settings that reap idle connections
  (`ClientAliveInterval`) only cause a redial.
- Commands on one machine share fate with the connection: when it drops, every command running on it fails as
  `ssh_failed` ("may have run"). Before, each command failed alone.
- New log events: `ssh.pool_connected` and `ssh.pool_closed` with a `reason` (`closed_by_registry`, `key_changed`,
  `key_unavailable`, `target_changed`, `closed_by_peer`, `error`, `repeated_timeouts`, `shutdown`). They carry the
  machine's logical name and, for an error, the ssh2 error's class, level and code (`errName`, `sshLevel`,
  `sshCode`) — never its message.
- The wiring in `src/server.ts` is pinned end to end by `test/server-ssh-pool-wiring.test.ts` (the real server and
  ssh2 client against a loopback ssh2 server).
- Residuals from the security review are listed in `docs/security-audits/bugs-86-persistent-ssh-connection-security-audit.md`.
