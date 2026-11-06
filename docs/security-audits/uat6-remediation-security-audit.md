# Security Audit: UAT-6 remediation (BUGS #69, #80, #72, #79, #85; #84 in its own audit)

Finding: UAT-6 (2026-10-27 → 2026-10-29, agent-driven in Karl's browser against VM 1093 build `6594566`, plus an
exploratory probe) produced the BUGS rows #69–#85. Karl's triage (A1, 2026-10-29/30) made these Fix Now: #84 (standard-
terminal copy; audit `docs/security-audits/bugs-84-terminal-copy-security-audit.md`), #69, #80, #72 (log the SSH failure),
#79 (keycard and operator sign-in logging) and #85 (log unexpected 500s, added by Karl to the logging change). #70 and #78
were withdrawn as not defects (the UAT checks behind them were flawed; see their rows). #71 is an environment fix on
Linux-Dev (native `claude`), no code.

Base commit d2c3b99. Ledger: `.superpowers/sdd/2026-10-29-uat6-remediation/progress.md` (git-ignored).

## Headline

**Verdict: SHIP.** One adversarial review (opus, max) of the combined change found no leak, no changed response and no
broken fix; its two test gaps and four nits were fixed in one round, and two items are recorded as residuals below. No
new input path, route, permission or stored data. The logging changes add lines only, each carrying a correlation id and
only first-party, shape-checked fields.

## Fixes

| BUGS | Change | Security relevance |
|---|---|---|
| #69 | The console reply textarea loses `maxlength` (UTF-16 units truncated an over-long paste silently with Submit on); the existing byte counter and Submit gating refuse > 4096 bytes; the server's own 4096-byte refusal is unchanged. | Integrity of what is typed into a Claude session: nothing is ever cut silently. Verified for multi-byte text (é, €, 😀, lone surrogates) and a 100 kB paste. |
| #80 | `exposeHeadRoute: false` on the terminal WebSocket GET route. @fastify/websocket 11.2.0 returns early for HEAD, so Fastify's cloned HEAD route ran the raw WebSocket handler → 500. | Removes an unlogged 500 reachable by any signed-in caller; HEAD now 404 (logged out still 401). |
| #72 | `SshConnectionError` keeps an ssh2 cause `{errName, level?, code?}` (shape-checked; never the message — project rule D13 L6 / triage 14 L12); the console poller writes one `console.machine_unreachable` warn line on going down and one `console.machine_reachable` info line on recovery; `terminal.open_failed` gains `sshLevel`/`sshCode`. | Diagnosis without leakage: ssh2's message can carry an address or quote an unparsable key, so it is never kept. |
| #79 | `keycard.minted`, `keycard.revoked`, `keycard.revoke_unknown`, `keycard.denied` (unknown / revoked / expired / wrong scope) and `auth.login` (signed in / refused) / `auth.logout` lines. | Security events become traceable. Never a `pk1_` token or its hash, never the password tried, never a raw session id (`sessionIdHash`, 12 hex); a revoke path that is not a UUID logs `[not a card id]`. |
| #85 | The app error handler writes one `http.internal_error` error line (class and code only, method, matched route PATTERN, status, correlation id) before answering 500 `internal_error`. | Unexpected failures leave a trace; never the message, a stack, the raw path, the query, the body or a header. 4xx branches unchanged and unlogged. |

## Threat review

| Question | Answer | Evidence |
|---|---|---|
| Can a secret reach a log line? | No. Scanned real-socket, journal-style output for the keycard token, its hex and sha256, the session id, fragments of a password with spaces, `%26`, `&` and non-ASCII, the admin token, the raw path and the query: all absent. A token in an unmatched door URL logs `route:"(no route)"` (Fastify gives `routeOptions.url === undefined` on 404s). ssh2 1.17.0 sets `code` only as a number on DISCONNECT (dropped) and `level` only from literals. `requestIdHeader` defaults off, so the correlation id is always server-generated. | Review, in an APFS clone with a base worktree |
| Can an unauthenticated caller flood the log? | Door with no bearer: 0 lines. Bad token: 120 lines per sliding minute (the door-wide pre-auth budget), then unlogged 429s — now pinned by a test. Admin API unauthenticated: 0. Unauthenticated 404: 0. `POST /login` and `POST /logout`: one line each per request (accepted residual — the standard password-guessing trail on a LAN/NetBird-only host). No route found that an unauthenticated caller can push into a 500. | Review: 300 requests per class |
| Did any answer change? | No: 34 error-path requests (validation, invalid UTF-8, malformed/empty/prototype JSON, 413, 500, keycard 401/403/scope/revoked, mint, revoke, login variants, logout, CSRF-blocked logout) are byte-identical between base and change apart from the build cache-buster. | Review |
| Do the reachability lines fire once per outage? | Yes across store errors mid-outage, a failed probe while down, a dropped catch-up after an ok probe, a machine disabled while down, and a slow poll with skipped ticks. | Review cases S1–S6 |

## Verification

- Full control-plane suite, lint, `npx tsc --noEmit` and build reproduced by the controller after each round (tally in the
  ledger; final tally recorded at commit time).
- Mutations: implementer rounds caught every mutant (M1–M5, N1–N3, K1–K6, A1–A3, P1–P5); the review's 18 mutants: 15 caught,
  the 3 survivors closed by the fix round's new tests.

## Residuals (recorded, not fixed)

- Sign-in and sign-out lines are unbounded (one per request).
- The keycard door's 401 / 429 / 503 answers and served uses are not logged per request (the card's use count and
  last-used time keep the latter).
- A machine removed from the registry while down gets no recovery line; a refused probe plan counts as reachable.
- `listTmuxSessions` (`src/devmachine/tmux.ts`) still drops the ssh2 cause, so a New-project `tmux_list_failed` carries no
  level or code.
- `errorClass` / `causeOf` copy an error's `name` without a shape check; every error class in `src` sets a literal name.
- One call-time-only import cycle, `operator-auth.ts` ↔ `step-up.ts`.
