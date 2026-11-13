# Security Audit: BUGS #86 — one persistent SSH connection per dev machine

Finding: the console poller logged in to every ready dev machine every 5 seconds (BUGS #86). Karl's ruling (A,
2026-11-10): one persistent connection per machine, with the security requirement that disabling or removing a machine
and rotating its key each close the open connection, pinned by tests that fail if the connection survives. Design:
ADR-0011.

Base commit a114dd3. Change: `src/devmachine/connection-pool.ts` (new), `src/devmachine/connection.ts`,
`src/registry/service.ts`, `src/server.ts`; tests `test/devmachine-connection-pool.test.ts` (31) and
`test/server-ssh-pool-wiring.test.ts` (4).

## Headline

**Verdict: SHIP, with the residuals below.** One adversarial review (fable, max effort, fresh agent, 2026-11-12) of the
uncommitted change found one hole in the security requirement, reachable only under a narrow race, and one test gap
against it. Both are fixed. Three minor findings reachable in normal use are fixed. The rest are recorded as residuals.
No finding reachable in normal use broke key custody, the key-only rule or the delivery contract.

The reviewer ran its experiments in a clone against an in-process ssh2 server on 127.0.0.1; no real machine was
contacted and no repository file was changed by it.

## Findings and dispositions

| # | Severity | Finding | Reachability | Disposition |
|---|---|---|---|---|
| 1 | Major | A command already inside `run()` (waiting on custody) when the registry closed the machine dialled the old target again; nothing ever closed that connection. Reproduced by the reviewer with real ssh2, custody and registry | Narrow race (custody read ≈ 0.05 ms) | **Fixed.** `close(name)` and `closeAll()` bump a generation that `run()` re-checks after the custody read; a changed generation refuses the command before exec. Three tests; mutation killed |
| 2 | Major (test gap) | Nothing failed if the `server.ts` lines that create the pool, bind it to the registry or close it were removed | Regression risk | **Fixed.** `test/server-ssh-pool-wiring.test.ts` drives the real `createServer` against a loopback ssh2 server: shared login, disable, re-provision, address change, delete, server close, key-only login. Mutations of the binding and of `closeAll` are killed |
| 3 | Minor | `ssh.pool_closed` spread the ssh2 cause into the log line, overwriting the line's own `level`; no test covered the log content | Normal use | **Fixed.** Fields are `errName`, `sshLevel`, `sshCode` (the poller's names); one test asserts the exact objects, including that an error message carrying an address and key text is not logged |
| 5 | Minor | The login backoff survived a registry change, so a re-provisioned machine was refused for up to 15 s | Normal use | **Fixed.** `close(name)` clears the backoff; one test; mutation killed |
| 8 (part) | Minor | The identity test changed only host and handle | — | **Fixed.** Port and user cases added |

## Residuals (not fixed, by reachability)

| # | Finding | Why left |
|---|---|---|
| 4 | A timed-out command whose remote process never exits keeps its sshd session. With successful probes in between, the three-in-a-row rule never fires; after 10 such commands every command fails as `exec_error` until restart. Emulated only; not run against a real sshd | Needs a command class that hangs forever while probes succeed. Follow-up if seen: count channel-open refusals toward recycling |
| 6 | Three commands timing out together close the connection and fail an unrelated in-flight delivery as `ssh_failed` ("may have run"); three timeouts during one slow login abandon it with no backoff | Needs a slow machine and several operator actions at once. The delivery is reported unconfirmed, never as not sent |
| 7 | The cap refusal (a ninth concurrent command) is reported to the poller as the machine being unreachable | Theoretical for one operator: reaching 8 needs six concurrent route commands |
| 8 (rest) | Pool unit tests that do not bite: a channel that opens after its command timed out, a late `ready` on a closed entry, the `end` handler, the instant `execRequested` is set, agent or keyboard-interactive auth being offered, the handshake timeout | The code is correct today (the reviewer's own checks S1–S3 confirmed it) and the key-only login is pinned end to end by the wiring test |
| 9 | Every registry save closes the connection, including a no-op save, so a poll in flight logs unreachable then reachable; one `ssh.pool_closed` line per login attempt during an outage; ssh2 keepalive fires after about 4 intervals (≈40 s), not 3; stale comments naming `runRemoteCommand` | Cosmetic or self-healing |
| — | With the poller stopped, an idle pooled connection is not re-checked against custody until its next command | The registry path still closes it on disable, remove and re-provision |
| — | Direct edits to the database or key directory by another process are seen only on the next command (key or identity compare), not at once | Same as before the change for key edits; the two CLIs run out of process by design |
| — | No host-key verification | Pre-existing (BUGS #17), recorded at `src/devmachine/enrollment-ssh.ts` |

## Checked and found sound (reviewer)

- Through the real `createServer`: three commands share one login; disable, delete, re-provision, a connectivity
  change and `app.close()` each end the connection at the machine; a disabled machine answers 409 with nothing dialled;
  the login offers `none` and `publickey` only.
- Close during a dial fails the waiting command before exec and a late `ready` is ignored; close during a command
  fails it as `ssh_failed`, after exec.
- The failure phases match `runRemoteCommand`: a timeout before ready is before exec and the command is never sent
  later; a timeout with the exec request in flight is after exec and the late channel is closed; cap and backoff
  refusals are before exec; message shapes match `remoteCommandFailure`.
- `error` then `close` then `end` is handled once; no pool timer survives `closeAll`; the entry map shrinks on every
  close.
- ssh2 1.17.0: `Channel.close()` exists and leaves the connection usable; a keepalive failure emits `error` with level
  `client-timeout` and then `close`.
- Every HTTP mutation of a dev machine goes through the three notifying `RegistryService` methods.

## Verification (2026-11-12, this session)

- `npx vitest run`: 78 files passed, 1 skipped; 1468 tests passed, 5 skipped, 1 todo.
- `npx tsc -p tsconfig.json --noEmit`: exit 0. `npx eslint .`: exit 0.
- Mutations killed: key compare, identity compare, custody-miss close, update notify, delete notify, channel cap,
  backoff, keepalive, registry binding in `server.ts`, `closeAll` on server close, close-generation guard, backoff reset.
- Not yet verified: behaviour against the real machines. On deploy, the journal must show one `ssh.pool_connected`
  per machine instead of a login per poll, and disabling a machine must write `ssh.pool_closed` with
  `reason: closed_by_registry`.
