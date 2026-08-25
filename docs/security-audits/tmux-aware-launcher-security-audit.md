# Security Audit — tmux-aware Launcher (M1 task 1)

**Feature:** `tmux-aware-launcher` — the harness launch bar lists each ready dev machine's LIVE tmux
sessions (`GET /harness/tmux/:logicalName` → `tmux list-sessions` over the key-only SSH path) as one
button per session that opens a terminal tab ATTACHED to that session (`/terminal/:name?tmux=<s>`),
plus an attach-or-create form (`&create=1`).
**Date:** 2026-08-25
**Persona:** Senior Security Engineer (Phase 2.4) — three parallel audits (input validation /
injection; threat model, authz, secrets, DoS; client-side + CC1), consolidated here. All three were
read-only; every finding below was re-verified against the code before a disposition was assigned.
**Scope refs:** PROJECT_BIBLE §9 C.6, ADR-0005, TM-020 (remote-command surface + key custody),
§8/TM-008 (no raw exception text to clients), D6/TM-011, CC1/CC2/CC3.
**Components:** `src/devmachine/tmux.ts` (new), `src/devmachine/connection.ts` (`runRemoteCommand`,
command-aware `connectTerminal`), `src/devmachine/terminal-gateway.ts` (`resolveConnectableMachine`,
`TerminalOrigin`), `src/http/routes/harness.ts` (tmux route), `src/http/routes/terminal.ts`
(`?tmux`/`?create`, reattach check), `src/http/harness-frame.ts` (launch bar + client),
`src/http/app.ts` (`nosniff`), `src/server.ts` (wiring).

## Headline

**No reachable command injection, no XSS, no key-material or raw-exception leakage, no way past the
admin guard.** The auditors' delta was real but different in kind: (a) the new GET was an
**unmetered SSH-dial amplifier**, and (b) the feature opened a **new channel from a (possibly
compromised) dev machine into the trusted harness chrome**. Both are closed below. Totals raised:
0 SEV-1, 1 SEV-2, 8 SEV-3, ~25 SEV-4; disposition: 22 fixed in-loop (test-first, 42 new tests),
6 deferred to BUGS with rationale, 2 accepted as residuals, rest were PASS confirmations.

## Threats considered (design invariants)

| # | Threat | Control | Verdict |
|---|---|---|---|
| 1 | **Remote command injection via a session name** (TM-020). | Exactly one interpolation point (`buildTmuxAttachCommand`), and it interpolates the *return value* of `assertTmuxSessionName` (`^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$`) — no shell metacharacters, no tmux target syntax (`= : . $ % @`), no leading `-`; `-t =<name>` is exact-match. The list command is a constant. Commands are the branded `RemoteCommand` type minted only in `tmux.ts`. Verified: repeated query keys arrive as arrays and fail `typeof === "string"`; `%0A`, `%00`, `+`, fullwidth and over-long inputs all rejected; `$` is end-of-input in JS. | **PASS** |
| 2 | **Reaching the new route or the new WS query without the guard.** | `onRequest` guard is added before `registerHarnessRoutes`; `PUBLIC_PATHS` is an exact `Set` of route patterns (no prefix); HEAD/OPTIONS/trailing-slash/case variants all fall to the guard; `@fastify/websocket` routes the upgrade through the same hooks. 401 with zero SSH activity. | **PASS** |
| 3 | **Private key / handle / raw exception text on the wire.** | Key stays in a closure; the tmux JSON carries `{machine,state,message|sessions,…}` only; the route swallows a throwing lister into a fixed string (proved with `SECRET-DO-NOT-LEAK`); `CustodyError` (names a handle) collapses to a generic phrase; unreachable messages now carry the logicalName only — **no `user@host`** (fixed, finding T3). | **PASS (after fix)** |
| 4 | **Fail-closed dial rule.** | `resolveConnectableMachine` is the single gate for both routes: unknown → 404, disabled/unprovisioned → 409, no dial. tmux name validated BEFORE `openTerminalForMachine`. | **PASS** |
| 5 | **XSS from machine-controlled strings.** | Every remote value reaches the DOM via `createTextNode`/`textContent`; `logicalName` is `esc()`'d server-side and `encodeURIComponent`'d in URLs; the inline client contains zero server-interpolated data. Hostile `<img onerror>` names proven inert. | **PASS** |
| 6 | **SSH-dial amplification (authenticated flood, per-page-load fan-out, mashed Refresh).** | **Fixed:** `createTmuxLister` — per-machine in-flight coalescing, 3 s result cache (failures too), global cap of 4 concurrent dials (beyond → labeled `failed`, no dial); client in-flight guard + 15 s `AbortController` timeout; list re-fetch after create is delayed past the cache window. | **FIXED** |
| 7 | **Compromised dev machine injecting text into first-party chrome.** | **Fixed:** machine stderr travels as a separate `remoteDetail` (first line, ANSI/control-stripped, ≤140 chars) and the page renders it as `— machine said: "…"`; first-party `message` is fixed text; names capped at 64 chars (never trimmed before validation), count capped at 100 with a `truncated` flag; foreign stdout lines are counted, not rendered. | **FIXED** |
| 8 | **Robustness against hostile/odd output.** | **Fixed:** sentinel-prefixed records (`PANTHEON_TMUX:`) so `~/.zshenv` banners / direnv chatter are ignored + counted instead of wiping the list; bounded digit runs make `new Date` unable to throw; per-line anchored "no server running" (no substring match, no `.*` backtracking); byte-accurate output cap with one-pass UTF-8 decode (no split-sequence U+FFFD). | **FIXED** |
| 9 | **Connection lifecycle.** | **Fixed:** overall timeout on BOTH ssh2 paths (handshake + channel open — `connectTerminal` previously had none); synchronous `connect()` throws converted to `SshConnectionError` with teardown; `finish()` settles exactly once and always `client.end()`s. | **FIXED** |
| 10 | **`?session=<id>` reattach swapping machine/target.** | **Fixed:** `ManagedTerminal.origin` records machine + command; a reattach for a different machine or tmux target gets a labeled error frame (pre-existing UUID-keyed registry, new check). | **FIXED** |
| 11 | **Reflective echo / content sniffing.** | **Fixed:** the 404 echoes only a registry-shaped name (else `(invalid name)`); `X-Content-Type-Options: nosniff` on every response (guard denials included). | **FIXED** |
| 12 | **CC1 states.** | **Fixed:** success state labeled `[✓] N tmux session(s)`; window count + "attached elsewhere" in VISIBLE button text (was tooltip-only); dead-socket tab status now says `[x] disconnected` (was attribute-only — SEV-2); `novalidate` so the form's `[!]` text error is the real path (native bubbles swallowed submit); 401 labeled "you are signed out"; buttons rendered beside, not inside, the `role=status` region; per-machine controls carry the machine name in visible text; unguarded `new Terminal` now fails closed with a labeled error. | **FIXED** |

## Findings by audit (disposition)

**Input validation / injection audit** — 1 PASS (no injection path), 2 SEV-3 + 8 SEV-4 raised:
foreign-line wipe (FIXED, sentinel), parse-error message bypassing the sanitizer (FIXED, no line
content echoed at all), trim-before-validate (FIXED), substring/backtracking `NO_SERVER_RE` (FIXED),
UTF-16 cap (FIXED), no timeout on `connectTerminal` channel open (FIXED), sync throw escaping the
executor (FIXED), no host-key verification on the new path (**DEFERRED → BUGS #17 extended**),
`?session` overriding machine/target (FIXED), `as string` cast (FIXED, explicit narrowing).

**Threat-model / authz / secrets audit** — 16 PASS, 2 SEV-3 + 5 SEV-4: dial amplifier (FIXED),
untrusted text in chrome (FIXED), `SshConnectionError` text to client (FIXED), reflective echo +
`nosniff` (FIXED), unenforced trust boundary on `command` (FIXED, branded type), hostile epoch /
malformed line (FIXED), key re-read per request (**mitigated** by the cache/cap; returning a
zeroable `Buffer` from custody is a follow-up, not started). `SameSite=Strict` — **RESIDUAL, not
adopted**: the household Homepage tile (different site) links into the console, and Strict would
drop the cookie on that navigation and bounce a signed-in operator to `/login`; the trigger it would
remove is one cross-site top-level navigation → N cached/capped dials, which finding 6's fix already
bounds. Recommend keeping `Lax`; revisit if the console is ever linked from an untrusted site.

**Client-side / CC1 audit** — no XSS; 1 SEV-2 (FIXED), 5 SEV-3, 14 SEV-4. Fixed: 401 labelling,
tooltip-only state, overlapping loads, no client timeout, selector round-trip (element passed
directly), `"undefined"` name, caps, duplicate accessible names, buttons in live region, success
glyph, post-create refresh, unguarded `Terminal`, `nosniff`. **Deferred (pre-existing tab-shell
issues this feature only surfaced):** keyboard-unreachable tab close (BUGS #25, SEV-3), no WebSocket
`Origin` check (BUGS #26, SEV-3 — a naive `Origin == Host` check would break the live terminal
because the household edge proxy rewrites `Host`; needs the header facts first), New-Session dialog
silent empty state (BUGS #27), tab ARIA linkage (BUGS #28), CSP/`frame-ancestors` (BUGS #29 — the
long-tracked residual; inline script + inline `onclick` must move first), config-page `innerHTML`
with a weaker local escaper (BUGS #30, not exploitable today).

## Residual notes (tracked)

- **Host-key verification** (BUGS #17, now three call sites). Until pinned, a LAN host that wins the
  race for the dev machine's IP controls the listing and the PTY — it cannot obtain the harness key
  (pubkey auth is session-bound) and cannot inject markup, but it *is* the trust assumption the parser
  rests on. Pin at enrollment, verify on every connect. Own Build Loop (needs a registry column).
- **CSP** (BUGS #29) remains the one tracked page-hardening item; `nosniff` landed here.
- The key is still re-read from custody per dial (same as the terminal path); the cache/cap bound the
  rate. A zeroable `Buffer` return from custody is a follow-up.

## Conclusion

The feature's security posture rests on three enforced invariants — allow-list before any command
string exists (branded type), fail-closed machine resolution before any dial, and `trusted:false`
treatment of everything the machine sends back (sentinel parsing, caps, labelled provenance) — plus
bounded resource use (coalescing, cache, concurrency cap, timeouts on every path). Every authz,
secret and injection check passed; every in-scope SEV-2/SEV-3 is fixed with a regression test; the
deferred items are pre-existing and tracked with rationale. Suite 475 passed / 5 honest skips.
**Cleared to proceed.**
