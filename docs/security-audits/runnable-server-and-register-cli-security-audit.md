# Security Audit — Runnable Server + register-devmachine CLI (Task #16f)

**Feature:** `runnable-server-and-register-cli` — `createServer`/`configFromEnv` (composes the whole
control-plane into one runnable Fastify app + `npm start` entrypoint) and the `register-devmachine`
CLI (insert a DevMachine row directly so it can be provisioned).
**Date:** 2026-06-15
**Persona:** Senior Security Engineer (Phase 2.4).
**Scope refs:** PROJECT_BIBLE §7 (#9 auth), ADR-0005, TM-020.
**Components:** `src/server.ts`, `src/cli/register-devmachine.ts`, `package.json` (`start`).

## Threats considered & concrete exploit attempts

| # | Threat (concrete exploit) | Control | Verdict |
|---|---|---|---|
| 1 | **Server boots without an admin guard.** A missing/empty `ADMIN_API_TOKEN` starts an unguarded admin surface. | `createServer` throws if `adminToken` is empty (test: rejects). `npm start` then exits non-zero — fail closed, no open server. | **PASS** |
| 2 | **Terminal WebSocket reachable without auth.** The async-registered WS route escapes the guard. | The guard is an `onRequest` hook on the root app; Fastify cascades it to the later `registerTerminalRoute` scope. Verified: `GET /terminal/:logicalName` without auth → 401 (test). Browser session auth (cookie/ticket) remains the tracked #9 follow-up. | **PASS** |
| 3 | **Asset routes leak more than xterm.** The public exemption serves something sensitive. | Only `/assets/xterm.js` and `/assets/xterm.css` are exempted (a public OSS library, read once from `node_modules`); everything else stays guarded. No directory traversal — they are two fixed routes, not a static file server. | **PASS** |
| 4 | **Peta misconfiguration crashes / opens the server.** | When `PETA_URL`/`PETA_ADMIN_TOKEN` are absent the MCP admin is a stub that throws a clear "not configured" error; the Config page renders its error banner (already handled) and the rest of the app runs. No secret in the message. | **PASS** |
| 5 | **Secrets in the registry DB.** The persistent SQLite file holds key material. | The DB holds only addresses + the opaque key handle (no raw keys/tokens — §5 Principle 1, prior audits). Custody (the private key) is a separate `0700` dir. | **PASS** |
| 6 | **register CLI as an injection vector.** Crafted args write a malformed/dangerous row. | The CLI parses flags and delegates to `RegistryService.createDevMachine`, which applies the same fail-closed validation (charset, no leading dash, port range) as the API. It is a local operator tool requiring host + DB access; it adds no network surface. | **PASS** |

## Residual notes (non-blocking, tracked)

- **Browser/WS session auth** (cookie or short-lived ticket from the #9 login) is still required for real
  browser use — the guard is bearer-token today. Same follow-up as the harness-frame + bridge audits.
- **Bind host:** `HOST` defaults to `0.0.0.0`. On the Proxmox VM, bind to the LAN/VPN interface (or
  front with the existing Caddy/reverse proxy + TLS) rather than exposing the admin surface broadly.
  A `wss://` origin is required for the terminal once served over HTTPS.
- **Chat pre-processor** (`/v1/chat/completions`) is intentionally not mounted by the entrypoint yet
  (terminal-modality focus); wiring it is a later seam.

## Conclusion

No exploitable findings. The server fails closed without an admin token, the terminal WebSocket
inherits the guard, only the public xterm library is exempted, and the register CLI reuses the same
validated write path. The browser-session-auth and bind-host/TLS items are deployment/wiring
follow-ups, not defects. **Cleared to proceed.**
