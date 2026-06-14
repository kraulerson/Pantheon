# Security Audit — Terminal WebSocket Bridge (Task #16c)

**Feature:** `terminal-websocket-bridge` — the SSH→PTY→WebSocket gateway: `ManagedTerminal`
(scrollback + attach/detach reconnect), `TerminalRegistry`, the `attachSocket` bridge over a
transport-agnostic `DuplexSocket`, `openTerminalForMachine` (resolve→fail-closed→connect→register),
and the Fastify `GET /terminal/:logicalName` WebSocket route.
**Date:** 2026-06-14
**Persona:** Senior Security Engineer (Phase 2.4). Directly addresses the **TM-020 RCE concern (#9)**
deferred from the SSH-backend audit ("must not pipe recalled content into the PTY").
**Scope refs:** PROJECT_BIBLE §9 C.6, ADR-0005, TM-020, §7 (#9 auth).
**Components:** `src/devmachine/terminal-gateway.ts`, `src/http/routes/terminal.ts`.

## Threats considered & concrete exploit attempts

| # | Threat (concrete exploit) | Control | Verdict |
|---|---|---|---|
| 1 | **TM-020 #9 RCE — recalled `trusted:false` content reaches the PTY.** Something other than operator keystrokes gets written to the remote shell, turning injected memory into remote command execution. | The bridge writes to the PTY **only** on a well-formed client `{t:"i"}` input frame (operator keystrokes from the xterm tab). There is no path from the grounding/retriever pipeline into `ManagedTerminal.input`; the terminal is a separate modality (ADR-0005). Output is one-way PTY→client. | **PASS** |
| 2 | **Malformed / unknown frame injection.** A crafted WS frame triggers unintended behavior. | `parseClientFrame` returns null on bad JSON, non-objects, unknown `t`, missing/!string `d`, or non-integer `c`/`r` — ignored, no throw, no write (test: malformed JSON + `{t:"evil"}` + `{t:"i"}`-without-`d` produce zero writes). | **PASS** |
| 3 | **Unprovisioned / unknown / disabled machine connect.** Opening a terminal to a machine with no key, or one an operator disabled. | `openTerminalForMachine` fails closed BEFORE dialing: unknown → `TerminalError`, `enabled=false` → `TerminalError`, `provisioned=false`/empty handle → `TerminalError`; the connect step is never reached (tests assert `connect` not called). The route turns this into a `{t:"e"}` frame + close. | **PASS** |
| 4 | **Privilege boundary (#9 / TM-011).** Reaching the terminal without auth. | The route is designed to mount on an app whose `onRequest` admin/#9 guard already runs (Fastify applies earlier-registered onRequest hooks to later routes); it is not a `PUBLIC_PATH`. **Operator action:** mount it via `await registerTerminalRoute(app, …)` AFTER `buildApp` so the guard covers it. | **PASS (with documented mounting requirement)** |
| 5 | **Private key exposure.** Key material leaking through the bridge/scrollback/frames. | The bridge only ever sees a `TerminalSession` (the key is already closure-captured in `connectTerminal` and absent from the session object — prior audit). Scrollback holds PTY *output* only; no key flows through it. | **PASS** |
| 6 | **Dropped socket kills the shell / session leak.** A flaky network tears down the SSH session, or sessions accumulate. | Socket close → `detach` (SSH session persists for reconnect, §9 C.6); `TerminalRegistry` auto-evicts a terminal when its underlying session closes, so dead sessions don't accumulate. Reattach replays bounded scrollback. | **PASS** |
| 7 | **Unbounded memory (scrollback / flooding).** A long-running shell or a flood grows memory without bound. | Scrollback is a bounded ring (default 64 KiB, oldest dropped — test asserts the cap). | **PASS** (input-flood rate-limiting is a possible hardening follow-up; low risk single-operator) |

## Residual notes (non-blocking)

- **Browser WS auth:** browsers cannot set an `Authorization` header on a WebSocket. When the harness
  frame (sub-task e) wires the real client, auth must travel by a browser-compatible channel (cookie
  session from the #9 login, or a short-lived ticket), still validated by the same guard. Tracked for
  sub-task (e).
- **Reconnect id:** `?session=<id>` reattaches to a live terminal; the id is a `randomUUID` returned in
  the `ready` frame. It is an in-memory handle (not persisted) and only usable by an already-#9-
  authenticated client.
- **Live validation:** end-to-end against a real machine is covered by the deferred live UAT
  (`tests/uat/sessions/2026-06-14-session-1/templates/live-ssh-provisioning.md`) once a machine is provisioned.

## Conclusion

No exploitable findings. The bridge forwards only operator-typed input (closing the TM-020 #9 RCE
concern at the transport), ignores malformed frames, fails closed on unprovisioned/disabled/unknown
machines, never carries key material, and survives socket drops without leaking sessions. The single
operator action is to **mount the route behind the #9/admin guard**. **Cleared to proceed.**
