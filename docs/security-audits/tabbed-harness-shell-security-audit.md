# Security Audit — Tabbed Harness Shell (Task #16e redo)

**Feature:** `tabbed-harness-shell` — the single-page tabbed harness frame: in-app terminal tabs
(xterm + WebSocket per tab), a working New Session popup, and tab switch/close. Replaces the stub
frame that opened terminals in new browser windows.
**Date:** 2026-06-15
**Persona:** Senior Security Engineer (Phase 2.4).
**Scope refs:** PROJECT_BIBLE §9 C.1/C.6, ADR-0005, TM-020.
**Components:** `src/http/harness-frame.ts` (`renderHarnessFrame` + `HARNESS_CLIENT_JS`).

## Threats considered

| # | Threat | Control | Verdict |
|---|---|---|---|
| 1 | **XSS via DevMachine name in the rendered frame.** | All interpolated values (`logicalName`/`host`/`user`) go through `esc()` in the `<option>`/shortcut markup; DevMachine fields are charset-validated at the registry. | **PASS** |
| 2 | **XSS via DevMachine name in the client JS** (names flow into tab labels / WS URLs at runtime). | The client builds labels with `document.createTextNode`/`textContent` (never `innerHTML`), and the WS URL uses `encodeURIComponent(name)`. A hostile name can't inject DOM or break the URL. | **PASS** |
| 3 | **New attack surface.** | None — no new routes/handlers. The frame is the same guarded `GET /harness`; terminals use the existing cookie/bearer-authed `GET /terminal/:logicalName` WS (prior audits). | **PASS** |
| 4 | **Private key / secret exposure to the browser.** | Unchanged: the page only speaks the JSON frame protocol over the WS; the key stays server-side in custody (TM-020/#14b). | **PASS** |
| 5 | **Unprovisioned/disabled machine offered as connectable.** | Only `provisioned && enabled` machines render as shortcuts / dev-machine `<option>`s; others render as non-actionable text. The broker also fail-closes server-side regardless of the UI. | **PASS** |
| 6 | **Dangling sessions on tab close.** | Closing a tab calls `ws.close()` (and `term.dispose()`); the server-side `ManagedTerminal` detaches and the `TerminalRegistry` evicts on the underlying SSH close (prior audit). | **PASS** |

## Residual notes (tracked, unchanged from prior audits)

- **CSP.** The page still ships inline `<script>` (now larger). A `Content-Security-Policy` (and moving
  the client to a served file with a nonce) remains the tracked hardening follow-up before any
  multi-user exposure. Low risk here: all dynamic output is escaped / `textContent`.
- **Browser session auth** for the WS is the #9 cookie (built + live-verified); `wss://` + Secure cookie
  require TLS in production.

## Conclusion

No new exploitable surface. The rewrite is client-side UX over the already-audited guarded routes;
dynamic values are escaped or set via `textContent`, the key never reaches the browser, only ready
machines are offered, and closing a tab tears down its WebSocket. CSP remains the one tracked
hardening item. **Cleared to proceed.**
