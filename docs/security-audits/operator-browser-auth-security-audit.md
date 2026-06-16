# Security Audit — Operator Browser Auth (#9, Task #9)

**Feature:** `operator-browser-auth` — control-plane-native #9 login: `SessionStore`, the cookie-aware
`operatorGuard`, `/login`/`/logout` routes, the HTML-redirect-on-failure, and the server/entrypoint
wiring. Closes the browser/WebSocket auth gap flagged in the harness-frame + bridge audits.
**Date:** 2026-06-15
**Persona:** Senior Security Engineer (Phase 2.4) — auth is security-critical (Priority 1).
**Scope refs:** PROJECT_BIBLE §7 (tier-1 UI auth, D6), TM-008/TM-011, ADR-0005.
**Components:** `src/http/auth/{session,operator-auth}.ts`, `src/http/app.ts`, `src/server.ts`.

## Threats considered & concrete exploit attempts

| # | Threat (concrete exploit) | Control | Verdict |
|---|---|---|---|
| 1 | **Session forgery / guessing.** Forge or brute-force a session id. | The id is 256-bit `crypto.randomBytes` hex, validated by server-side lookup (no client-trusted claims). Not derived from the password; unguessable. | **PASS** |
| 2 | **Session theft via XSS.** Script reads the cookie. | The cookie is `HttpOnly` (no JS access) + `SameSite=Lax`. Rendered pages escape output (prior audits). | **PASS** |
| 3 | **CSRF.** A cross-site page drives a state change with the operator's cookie. | `SameSite=Lax` blocks the cookie on cross-site sub-requests/POSTs; mutating APIs are reachable cross-site only with the bearer (which a cross-site page lacks). | **PASS** (a per-request CSRF token is a defense-in-depth follow-up) |
| 4 | **Session fixation.** Attacker fixes a known id pre-login. | Login mints a **fresh** id server-side; no client-supplied id is ever adopted. | **PASS** |
| 5 | **Password compare leaks / timing / enumeration.** | Compared via fixed-length SHA-256 digests with `timingSafeEqual` (no length-based timing leak); the password is read from gitignored env, never logged/echoed; a wrong password returns a generic "Incorrect password" (single operator — no user enumeration). | **PASS** |
| 6 | **Browser can't reach the terminal / unauth WS slips through.** | The cookie rides the same-origin WebSocket handshake; `operatorGuard` validates it on the upgrade. **Live-verified:** cookie-only WS round-trips a real shell; an unauthenticated WS is rejected 401. | **PASS** |
| 7 | **Logout doesn't really log out.** | `/logout` destroys the session **server-side** (not just clears the cookie); the old cookie no longer validates (test). | **PASS** |
| 8 | **Info leak on the login boundary (§7).** | A logged-out browser navigation 302-redirects to `/login` (no identity/metadata in the body); API callers get a bare status code + reason code (never the token/exception text, §8/TM-008). | **PASS** |
| 9 | **Privilege model confusion.** Does #9 grant the privileged tier? | #9 is tier-1 UI auth only. The D6 privileged step-up (passkey/WebAuthn for write-approvals / gateway management) remains the separate `verifyStepUp` seam — this feature does not satisfy or bypass it. | **PASS** (by design) |

## Residual notes (tracked follow-ups)

- **`Secure` cookie behind TLS.** The cookie omits `Secure` by default so localhost-HTTP dev works; set
  `PANTHEON_SECURE_COOKIES=true` (and serve over HTTPS/`wss://` via the reverse proxy) in production.
  Without TLS the session cookie is sniffable on the wire — acceptable only on a trusted LAN.
- **Login rate-limiting.** No throttling on `POST /login` yet; for a single strong operator passphrase
  on a LAN the brute-force risk is low, but add rate-limiting/lockout before any non-LAN exposure.
- **CSRF token.** `SameSite=Lax` is the current CSRF control; a synchronizer token on state-changing
  POSTs is a reasonable defense-in-depth add later.
- **In-memory sessions.** Sessions reset on restart (re-login) — fine at one-operator scale; move to a
  shared store only if the control-plane is ever horizontally scaled.
- **Future federation.** §7 envisions #9 == the LibreChat login. This native login is the bridge until
  LibreChat is deployed; it can later accept/validate a LibreChat session instead.

## Conclusion

No exploitable findings. Sessions are unguessable, httpOnly, SameSite, server-validated, and properly
invalidated on logout; the password compare is constant-time and non-leaking; the browser/WebSocket
auth path is closed and live-verified; and #9 stays distinct from the D6 step-up. The residuals are
deployment hardening (TLS/Secure, rate-limiting, CSRF token), not defects. **Cleared to proceed.**
