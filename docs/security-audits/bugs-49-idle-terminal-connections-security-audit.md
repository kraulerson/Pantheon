# Security Audit: BUGS #49 — idle terminal connections

Finding: a browser reload or dropped WebSocket left the broker's SSH session and its tmux client attached on the dev
machine until the tmux session ended; when the remote command exited with no browser attached, the broker never closed
its ssh2 connection (BUGS #49; 41 to 48 idle sessions on Mac-Mini during UAT-6, 18 again on 2026-11-10). Karl's ruling
(A, 2026-11-10, Defer → Fix Now): a grace timer of about 2 minutes after a socket closes without a close frame, then
close the SSH session; and end the connection when the remote side closes.

Base commit e7c1c59. Change: `src/devmachine/terminal-gateway.ts`, `src/devmachine/connection.ts`,
`src/http/routes/terminal.ts`; tests in `test/terminal-gateway.test.ts`, `test/terminal-route.test.ts`,
`test/devmachine-connection.test.ts`.

## Headline

**Verdict: SHIP, with the residuals below.** One adversarial review (fable, max effort, fresh agent, 2026-11-15) found
no regression and no new attach surface. It found one ordinary path on which the leak survived (present before the
change too), now fixed, and one way the new timer could end a terminal under an open socket, now fixed. The change
shortens how long an orphaned PTY stays attachable from forever to 2 minutes; a reattach still needs the admin guard,
the unguessable session id and the same machine and target.

The reviewer ran its experiments on scratch copies against fakes and ssh2's own Server on 127.0.0.1; no real host was
contacted and no repository file was changed by it.

## Findings and dispositions

| # | Severity | Finding | Reachability | Disposition |
|---|---|---|---|---|
| 1 | Major | A socket that closes while the SSH dial is in flight leaked the session forever: its close event had already fired, any close frame was lost, and attaching cleared the grace timer. Reproduced through the real route with a real WebSocket client | Uncommon (a reload or closed tab during "Connecting…"; likelier when a machine is slow) | **Fixed.** The route ends a newly dialled terminal when its socket is no longer open. Three route tests (drop, close without a frame, close frame then close); mutation killed |
| 2 | Minor | With two sockets on one terminal, the timer tore it down under the older, still-open socket, which was never told | Uncommon (a duplicated browser tab) | **Fixed.** One client at a time: a replaced client receives the exit frame and its later frames are ignored, so it can neither type into nor close the newer client's terminal. Two tests; mutations killed |
| 4 | Minor | A test that did not test its title (the fake kept one close subscriber); nothing pinned the 2-minute value; "remote exits, then the tab closes" untested | — | **Fixed.** The fake keeps every subscriber and the test asserts `isClosed`; the grace value is pinned; the order is tested; mutations killed |
| 7 | Nit | CHANGELOG and FEATURES.md overstated what reattaches | — | **Fixed** in both |

## Residuals (not fixed, by reachability)

| # | Finding | Why left |
|---|---|---|
| 3 | The grace period starts only when the service sees the WebSocket close. A browser that vanishes silently (closed lid, lost network, no FIN) is noticed only when a write times out at TCP level or a proxy in front closes the upstream; an idle terminal with no output can still leak. Reasoned only: how Caddy and the household edge treat dead clients was not checked | Needs a ping/pong sweep in the route: a separate change. The CHANGELOG says so |
| 5 | After a teardown calls `close()`, the terminal stays registered until ssh2 confirms: milliseconds normally, minutes if the machine is unreachable (terminal connections set no ssh2 keepalive). A reload in that window reattaches to the dying terminal | Theoretical for one operator; self-clearing |
| 6 | The connection is ended on stream close only if something drains the stream. `ManagedTerminal` always subscribes, so the route cannot hit it | Not reachable through the route |
| 4 (rest) | Surviving mutants: `unref` removed; the redundant `clearGrace()` in `close()` and at the top of `startGrace()`; the try/catch around `client.end()` | Redundant or unobservable in a unit test |
| — | Whether the tmux client detaches when the broker ends the connection is reasoned (sshd closes the PTY, the kernel sends SIGHUP, `tmux attach` exits), not reproduced: ssh2's Server has no PTY. It is the same `session.close()` the explicit close frame has used since BUGS #33 | To be verified on deploy: reload a terminal tab, wait over 2 minutes, count `tmux list-clients` |
| — | A plain login-shell tab cannot be reattached by any shipped client, so its shell was already unreachable after a drop; it is now also ended after 2 minutes | Behaviour as ruled |

## Checked and found sound (reviewer)

- A model check of 20,000 random event sequences against the real `ManagedTerminal` and `attachSocket` (before the
  fixes for findings 1 and 2): never closed under the last-attached open socket, always closed after a full ownerless
  grace period, no timer after the session ended, never two timers.
- The drawer and Claude views keep their WebSocket open while hidden or minimised, so the timer does not start.
- `connectTerminal` against ssh2's own Server: shell exit, exec-on-PTY exit, exit while detached, abrupt channel
  close, exit by signal and a 2 MiB burst then exit all deliver their output and end the connection; close twice,
  write or resize after close, and close after a drop do not throw.
- `makeSession` has one caller (the success path of `connectTerminal`); `runRemoteCommand`, the pool and enrollment
  are untouched.
- The timer is unref'd and its callback touches only the session, never the store.

## Second review: the post-review changes (2026-11-16)

The fixes for findings 1 and 2 above were written after the first review, so a second fresh reviewer (fable, max
effort) attacked only those: the dial-race guard, the exit frame to a replaced client, and ignoring a replaced
client's frames. **Verdict: minor concerns, safe to deploy as is.** It could not break any of the three in any
ordering, including a model check of every event sequence up to length 6 (3,257,436) plus 1.2 million random ones
against the real `ManagedTerminal`, `attachSocket` and registry, and the shipped console JavaScript in two jsdom
windows against the real route.

| # | Severity | Finding | Disposition |
|---|---|---|---|
| S1 | Minor | Five behaviours unpinned by tests: a replaced client's resize; a replaced client staying ignored after the newer one left; the guard on `?shell=1`, on a stale `?session=` id and on tmux targets | **Fixed.** Tests added (commit after `96bcc70`); the reviewer's mutations of each are killed by them |
| S2 | Minor | An abandoned dial was ended with no log line | **Fixed.** `terminal.open_abandoned` (warn) with machine, shell and correlation id, asserted on the three console URL shapes |
| S3 | Nit (theoretical) | `attach()` told the replaced client before swapping the sink in; a transport that reports its own close from inside `send()` would start a grace timer under the new client. Not reachable with ws 8.21.0 | **Fixed.** The sink is swapped first; one test |
| S4 | Nit (theoretical) | If `term.close()` throws inside the guard, the terminal stays registered with no timer. Not reachable with the real session | Residual |
| S5 | Nit | A replaced console view shows "[x] disconnected — close tab to dismiss" and cannot recover without a page reload | Residual (a duplicated browser tab) |
| S6 | Nit | `PROJECT_BIBLE.md` still described the old dropped-socket rule | **Fixed** |

Confirmed by that review: the socket is OPEN when the route handler starts and the guard-to-subscribe lines are
synchronous, so there is no window between them; no shipped client reconnects by itself, so two tabs cannot
ping-pong; before the change a replaced tab typed blind into the newer tab's terminal and its close killed the live
view; the replaced socket receives exactly `{"t":"x"}` and no scrollback; takeover still needs the admin guard, the
session id and the same machine and target.

## Verification (2026-11-16, this session)

- `npx vitest run`: 78 files passed, 1 skipped; 1490 tests passed, 5 skipped, 1 todo (after the second-review follow-ups; 1484 at `96bcc70`).
- `npx tsc -p tsconfig.json --noEmit`: exit 0. `npx eslint .`: exit 0.
- Mutations killed: detach starts the grace period, attach clears it, stale-socket guard, never-attached grace,
  session end clears the timer, remote exit ends the client, dial-race guard, replaced-client frames ignored,
  replaced client told, closed guard in `startGrace`, the 2-minute value.
- Not yet verified: behaviour on VM 1093 against the real machines.
