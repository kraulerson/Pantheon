# Security Audit — Harness Frame + Terminal Tab (Task #16d/e)

**Feature:** `harness-frame-and-terminal-tab` — the server-rendered harness frame (New Session popup,
AI SYSTEM × IDENTITY, Claude-CLI→dev-machine routing), the xterm.js terminal-tab page, and the
serving routes (`/harness`, `/harness/terminal/:logicalName`, public `/assets/xterm.*`).
**Date:** 2026-06-14
**Persona:** Senior Security Engineer (Phase 2.4).
**Scope refs:** PROJECT_BIBLE §9 C.1/C.6, ADR-0005, TM-020, §7 (#9 auth).
**Components:** `src/http/terminal-tab.ts`, `src/http/harness-frame.ts`, `src/http/routes/harness.ts`,
`src/http/app.ts` (wiring + PUBLIC_PATHS).

## Threats considered & concrete exploit attempts

| # | Threat (concrete exploit) | Control | Verdict |
|---|---|---|---|
| 1 | **Stored XSS via a DevMachine field** (logicalName/host/user) rendered into the frame or terminal page. | Every interpolated value goes through `esc()` (the 5 HTML-significant chars). DevMachine fields are also charset-validated at the registry. Tested: a `<script>` logicalName renders as `&lt;script&gt;`, never executed. | **PASS** |
| 2 | **`</script>` breakout in the inline terminal JS.** A logicalName/wsPath embedded in the inline `<script>` closes the tag and injects script. | JS-embedded values use `jsString()` = `JSON.stringify(...).replace(/</g,"\\u003c")`, so `<` becomes `<` — `</script>` cannot form. The ws path also `encodeURIComponent`s the logicalName. Tested via the escape case. | **PASS** |
| 3 | **Private key exposure to the browser.** | The terminal page only opens a WebSocket speaking the JSON frame protocol; it never receives key material (the key is resolved server-side in the broker — prior audits). The page references no key. | **PASS** |
| 4 | **Connecting to an unprovisioned/disabled machine from the UI.** | The New Session picker offers `data-open-terminal` only for `provisioned && enabled` machines; others render as a non-actionable "not provisioned"/"disabled" line. The broker also fail-closes server-side regardless of the UI (defense in depth). | **PASS** |
| 5 | **Auth boundary (#9 / TM-011).** | `/harness` and `/harness/terminal/*` are NOT in PUBLIC_PATHS → behind the admin guard (test: `/harness` → 401 without auth). Only the static `/assets/xterm.*` (a public OSS library, no secrets) are exempted so the browser can load them. | **PASS** |

## Residual notes (non-blocking, tracked)

- **Browser session auth (follow-up, sub-task e wiring).** The guard is currently bearer-token
  (`ADMIN_API_TOKEN`), which a top-level browser navigation / WebSocket can't present. Real use needs
  the #9 login to establish a cookie/session (or short-lived ticket) that the same guard validates.
  Until then the pages are reachable only via an explicit bearer (API/inject), not a browser. This is
  the same browser-auth gap flagged in the terminal-bridge audit; both close together with #9 wiring.
- **No CSP header.** The pages use inline scripts; a `Content-Security-Policy` (and removing inline JS
  in favour of a served file with a nonce) is a hardening follow-up. Low risk for a single-operator
  homelab tool with escaped output, but worth a backlog item before any multi-user exposure.
- **Interactive behavior** (xterm rendering, reconnect UX, the four state transitions) is verified by
  the deferred live UAT in a real browser, not unit tests (these assert markup + wiring only).

## Conclusion

No exploitable findings in the rendered UI. Output is consistently escaped (HTML + JS contexts), the
key never reaches the browser, only ready machines are offered as terminals, and the frame/terminal
pages sit behind the admin guard while only the public xterm library is exempted. The two tracked
follow-ups (browser session auth, CSP) are wiring/hardening items for the #9 integration, not defects
in this feature. **Cleared to proceed.**
