## UAT-6 adversarial probe: Maestro Console F2

**Result: 2 FAILs, both SEV-3 (degraded but safe), and no SEV-1 or SEV-2.** No request got past auth, step-up, the cross-site rule, text validation or the folder-name rules. No probe returned a stack trace, a filesystem path or the request's text, apart from the reflections listed in NOTE N7.

- **FAIL-1:** a logged-in `HEAD /terminal/:name` answers 500 and writes no log line.
- **FAIL-2:** on the live host, WebSocket upgrades that are refused hang for 12 s about half the time.

### Setup
- Built at HEAD d2c3b99 with `npm run build`. tsc printed no errors. `dist/` is gitignored.
- Ran `node dist/server.js` on 127.0.0.1:18093 with `env -i` and:
  - a scratch DB, an empty key directory and a scratch console settings file;
  - a random ADMIN_API_TOKEN and a test operator password, both held in files.
- Machine `probe-m1` was registered at 127.0.0.1 port 1. I set `provisioned=1` and a projects root in the scratch DB, and seeded fake sessions and cards there.
- Because the key directory was empty, every dial failed at `CustodyError` and nothing was dialled over the network. The server log confirms this.
- Live host: unauthenticated GET and HEAD only, no login. Its build header reads `x-pantheon-build: 6594566`.

### Probe table
| # | Route | Input | Expected | Actual | Verdict |
|---|---|---|---|---|---|
| L1 | POST /login | wrong password | 401 | 401, login page with error | PASS |
| L3/L4 | POST /login | no body; password as an array | 401 | 401 | PASS |
| L5 | POST /login | Sec-Fetch-Site: cross-site | 403 | 403 `cross_origin_rejected` | PASS |
| S1/S4 | GET/POST step-up | no cookie | 401 | 401 `unauthenticated` | PASS |
| S2 | GET step-up | bearer only | null window | 200 `{"elevatedUntil":null}` | PASS |
| S5 | POST step-up | bearer only, right passphrase | 403 | 403 `step_up_cookie_only` | PASS |
| S6 | POST step-up | wrong bearer plus a valid cookie | refused | 403 `invalid_token` | PASS |
| S7/S8/S33 | POST step-up | wrong, empty, or right plus a trailing space | 403 | 403 `step_up_refused` | PASS |
| S9–S13, S19 | POST step-up | both keys; `revoke:false`; `revoke:"true"`; array; null; passphrase as a number | 400 | 400 `bad_request` | PASS |
| S14–S16 | POST step-up | form-encoded; text/plain; no content-type | 415 | 415 `unsupported_media_type` | PASS |
| S20/S21 | POST step-up | `__proto__` / `constructor.prototype` | 400 | 400 `bad_request` | PASS |
| S22 | POST step-up | malformed JSON | 400 | 400 `bad_request` | PASS |
| S23/S24/S35 | POST step-up | forged cookie; empty cookie; bad cookie before a good one | 401 | 401 | PASS |
| S25/S26 | POST step-up | Sec-Fetch-Site same-site / cross-site | 403 | 403 `cross_origin_rejected` | PASS |
| S27/S28 | POST step-up | `CROSS-SITE` in capitals; the header sent twice | (browsers never send these) | passes the rule; `step_up_refused` | NOTE N1 |
| S30–S32 | step-up | right passphrase; read back; second login | window opens; not shared | 200 with until = +15 min; second login reads null | PASS |
| S36–S39 | step-up | revoke, revoke again, then Submit | 204, 204, 403 | 204, 204, 403 `step_up_required` | PASS |
| S40/S41 | POST step-up | 900 KB passphrase / 2 MB body | refused / 413 | 403 / 413 `payload_too_large` | PASS |
| S42/S43 | step-up | cookie after logout | 401 | 401 | PASS |
| S44 | POST /logout | cross-site | 403 | 403 | PASS |
| S47 | POST step-up | gzip Content-Encoding | refused | 400 `invalid_utf8` | PASS |
| S48/Z5 | POST step-up | Content-Length mismatch; chunked plus CL | 400 | 400, Fastify's default JSON body (no echo) | NOTE N2 |
| R1/R2 | step-up, submit | old cookie after a server restart | 401 | 401 | PASS |
| V0/V0b/V0c | submit | bearer only / no auth / not elevated | 403 / 401 / 403 | `step_up_cookie_only` / `unauthenticated` / `step_up_required` | PASS |
| V1–V3 | submit | "", whitespace, NBSP + U+3000 + BOM | 400 empty | 400 `empty` | PASS |
| V3b | submit | only U+200B (zero-width space) | refuse? | 200, went on to delivery | NOTE N3 |
| V4–V6 | submit | text missing, a number, an array | 400 | 400 `not_text` | PASS |
| V7/V9 | submit | 4,097 ASCII bytes; 2,049 × é (4,098 bytes) | 400 | 400 `too_long` | PASS |
| V8 | submit | exactly 4,096 bytes | accepted | 200 (dial failed at custody) | PASS |
| V10–V14 | submit | raw 0xFF; overlong C0 AF; CESU ED A0 80; `\ud800`; `\udc00` | 400 | 400 `invalid_utf8` | PASS |
| V15 | submit | `\u001b[31m` | 400 | 400 `escape` | PASS |
| V16–V22, V24 | submit | NUL, CR, BEL, DEL, U+009B, U+0085, raw C2 9B, Ctrl-C | 400 | 400 `control_char` | PASS |
| V23 | submit | raw ESC byte inside a JSON string | 400 | 400 `bad_request` (JSON parse) | PASS |
| V25 | submit | `[201~ rm -rf` (no ESC) | accepted as text | 200 | PASS |
| V26/V27 | submit | U+202E, U+2066…U+2069 | (not in the refusal set) | 200 accepted; stored raw in `text_masked` | NOTE N4 |
| I1 | submit | key replayed, same text | stored outcome, no dial | 200 stored | PASS |
| I2 | submit | key replayed, **different text** | ? | 200 with the stored outcome | NOTE N5 |
| I3 | submit | key replayed on a different card | 400 | 400 `invalid_key` | PASS |
| I4–I9 | submit | uppercase, missing, newline, number or long key; bad key with bad text | 400 | 400 `invalid_key` (key checked first) | PASS |
| race | submit | 20 parallel, same key and text | one dial | 20 identical answers; 1 attempted row + 1 result row | PASS |
| race2 | submit | 10 parallel, same key, two texts | in-flight mismatch refused | 1 × 400 `invalid_key`; the rest 200 replays (N5) | PASS / N5 |
| B1–B4 | submit | form, text/plain, multipart, `application/jsonx` | 415 | 415 | PASS |
| B5 | submit | 2 MB JSON | 413 | 413 | PASS |
| B6–B8, B10 | submit | empty body; JSON string; null; nesting 10,000 deep | 400 | 400 `bad_request` / `invalid_key` | PASS |
| B9 | submit | duplicate `text` keys (ESC first, then "ok") | the last value is validated | 200 | PASS |
| C1 | submit | unknown 32-hex id | 404 | 404 `no such card` | PASS |
| C2–C4, C9, C10 | submit | uppercase; 33 chars; 500 chars; `%2e%2e`; `%2F` | 400 | 400 `unexpected card id` / `bad_request` | PASS |
| C5/C7 | submit | menu card; session status waiting | 409 | 409 `menu_card` | PASS |
| C6 | submit | card whose session is `sh-` | 409 | 409 `not_reachable` | PASS |
| X-* | submit, dismiss, sessions, step-up, /api/dev-machines, PUT, DELETE | Sec-Fetch-Site same-site / cross-site | 403 | 403 `cross_origin_rejected` on every one | PASS |
| X-* | same five routes | same-origin / none | passes to the route | the route's own answer | PASS |
| W1/W2/W9 | WS /terminal | cross-site / same-site / `Upgrade: WebSocket` | 403 | 403 `cross_origin_rejected` | PASS |
| W3/W4 | WS /terminal | no cookie / bearer only | 401 / 403 | 401 / 403 `terminal_cookie_only` | PASS |
| W5–W7 | WS /terminal | `shell=1&tmux=x`, `shell=2`, `shell=1&shell=1` | 400 | 400 `bad_request` | PASS |
| WS frames | WS /terminal | create through `sh-`; tmux `a;b`, `..%2F`; unknown machine; no root | labelled frame | labelled `{"t":"e"}` frames, no dial | PASS |
| WS frames | WS /terminal | name `<img src=x>` or U+202E | not echoed | echoed raw in the error frame | NOTE N7 |
| P1/P2 | pane | reply / menu card | 409 | 409 `not_commit_approval` | PASS |
| P3 | pane | unknown id | 404 | 404 `no such card` | PASS |
| P4/P11 | pane | 33-char id; `<script>` | 400 | 400 `unexpected card id` | PASS |
| P5/P6 | pane | 101 / 5,000-char id | 400 | 400 `bad_request` | PASS |
| P7/P12 | pane | commit card (fake machine) | 502 labelled | 502 `…could not read the session's screen over SSH` (no user@host) | PASS |
| P8 | pane | bearer only | (operator guard only) | 502 (reaches the dial) | NOTE N8 |
| P9 | pane | no auth | 401 | 401 | PASS |
| D1/D2 | dismiss | dismiss, then dismiss again | 200 | 200; the second call moves `dismissedAt` | NOTE N6 |
| D3/D4/D6 | dismiss | form / empty JSON / bad id | 415 / 400 / 400 | as expected | PASS |
| D5 | dismiss | bearer only | allowed (no step-up by design) | 200 | PASS |
| E1/E2 | expand | bad id / fake machine | 400 / 502 | 400 / 502 labelled | PASS |
| M (25 URLs) | every console route, /terminal, /harness, /api | `%`, `%zz`, `%E0%A4%A`, `%ff`, `%c0`, trailing `%` | 400 `bad_request`, with or without auth | 400 `bad_request` on all | PASS (#55) |
| M | /console/api/state | `//`, `/console//`, trailing `/`, capitals, `;x`, `./`, `x/../`, `%00`, `%2F`, `%73tate` | no data without auth | 401 without auth on all; with cookie, fixed 404 bodies; `%73tate` decodes to `state` (200 with cookie only) | PASS |
| U | all 10 console routes and /terminal | GET, POST, PUT, DELETE, PATCH, OPTIONS, TRACE, PROPFIND where unrouted | 401 without auth, fixed 404 with cookie | as expected; no 200, no echo | PASS |
| H | HEAD on every GET API route | without auth / cookie | 401 / 404 | 401 / 404 | PASS |
| **H** | **HEAD /terminal/:name** | **cookie or bearer** | **404** | **500 `{"error":"internal_error"}`, no log line** | **FAIL-1** |
| G1–G13 | GET projects | fake machine; no root; unknown; `..`, `%2e%2e`, quote, 65 chars, bidi, C1, `#` | 502 / 409 / 400 | 502 labelled / 409 `no_projects_root` / 409 `not_connectable` / 400 `unexpected machine name` | PASS |
| G11 | GET projects | machine `sh-probe-m1` | 409 | 409 `not_connectable` | PASS |
| N | POST sessions (newProject and folder) | `#`, `..`, `../evil`, `.`, `/etc`, the root itself, `/projectsX`, `'`, `"`, backtick, `$(id)`, `;`, U+202E, U+0085, U+200B, `.hidden`, `-rf`, `~`, backslash, 300 chars, a `ghp_` token, NUL, newline, lone surrogate, "" | 400 refused | 400 `refused_root` / `refused_name`, audit rows written, no dial | PASS |
| N | POST sessions | `sh-x`, `sh-` | renamed out of the shell namespace | tmux `p-sh-x`, `p-sh-` | PASS |
| N | POST sessions | `a ` and `a.` | (known residual) | both map to tmux `a-` | NOTE (already in the audit's Residual) |
| N | POST sessions | folder `a/b` | allowed (parent segments are free, T8-7) | 200 | PASS |
| N | POST sessions | both keys; a number; bearer only; form | 400 / 400 / 403 / 415 | as expected | PASS |
| state | GET state | projection | no cwd, procStart or waitingFor | none present; no-store | PASS |
| trig | console_submit_log | UPDATE / DELETE through a direct DB connection | blocked | `console_submit_log is append-only` on both | PASS |
| page | GET /console | headers; logged-out navigation | CSP and no-store; redirect to /login | `frame-ancestors 'self'`, no-store, nosniff; 302 to /login; no innerHTML, eval or document.write | PASS |
| XFP | GET /login | X-Forwarded-Prefix carrying injected markup | ignored | `data-base=""`; Caddy strips the header on the admin site | PASS |
| Z1/Z2 | any | 20 KB cookie; 4,000 query parameters | 431 | 431 | PASS |
| PR1–PR5, PR8, PR9, PR14–PR19 | live /harness/… | GET/HEAD without auth, forged cookie, bogus bearer | 401 / 302 / 403 | 302 to /harness/login; 401 `unauthenticated`; 403 `invalid_token` for the bogus bearer | PASS |
| PR6/PR7/PR21 | live | `%`, `%zz` | 400 | 400 plain text from Caddy, or an HTTP/2 PROTOCOL_ERROR at the edge (never reaches the app) | PASS |
| PR10/PR20 | live | `%ff`; 200-char card id | 400 | 400 `bad_request` | PASS |
| PR11 | live | HEAD /terminal/x without auth | 401 | 401 | PASS |
| **PR12/PR13** | **live WS upgrade over HTTP/1.1** | **cross-site, same-site, none, or no Sec-Fetch-Site; no auth** | **403 / 401 at once** | **6 of 11 attempts hung for 12–15 s with no bytes; the rest answered 403 / 401 in about 20 ms. Plain GETs: 0 of 6 hung** | **FAIL-2** |

### FAILs
**FAIL-1: SEV-3 (minor, degraded but safe).**
- Fastify adds a HEAD route for the WebSocket GET route `/terminal/:logicalName`. That HEAD route runs the WebSocket handler as an ordinary HTTP handler. The handler throws `TypeError: Cannot destructure property 'logicalName' of 'req.params' as it is undefined` at `dist/http/routes/terminal.js:193`, which I captured with `inject` and an `onError` hook.
- The app-wide error handler answers 500 and writes no log line. That conflicts with the "fail loud" rule.
- No side effect, no leak, and the process keeps running.
- Reproduce: log in, then `curl -I -H "Cookie: pantheon_session=<sid>" http://127.0.0.1:<port>/terminal/anything`. The bearer token also works.
- Suggested fix: `exposeHeadRoute: false` on the terminal route in `src/http/routes/terminal.ts`. Optionally, have `setErrorHandler` in `src/http/app.ts` log the error's class and code.

**FAIL-2: SEV-3 provisionally; the cause is not known.**
- On https://pantheon.ferrumcorde.com/harness/terminal/x, unauthenticated WebSocket upgrades over HTTP/1.1 sometimes get no response until curl times out. This happened with Sec-Fetch-Site cross-site, same-site, none, or the header absent.
- Locally, 10 of 10 same-site upgrades answered 403 in under 1 ms.
- Locally, the raw answer to a refused upgrade carries `Connection: keep-alive` and the socket stays open. That may be why Caddy waits, but I have not confirmed it.
- Impact: when a terminal upgrade is refused (cookie expired or cross-site), the page may hang instead of showing an error. Whether a real, authenticated upgrade is affected is untested, because there was no login to production.
- Reproduce with this loop:
```
for i in 1 2 3 4; do curl -sS -o /dev/null -w '%{http_code} %{time_total}s\n' --http1.1 --max-time 12 -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: <base64-nonce>' https://pantheon.ferrumcorde.com/harness/terminal/x; done
```
- Worth watching in UAT-6: how long the shell drawer and the Claude-session view take to open.

### NOTEs (not failures; candidates for SEV-4 or confirmation)
- **N1:** the cross-site check is an exact lowercase compare. `CROSS-SITE` in capitals, or the header sent twice (which Node joins with a comma), slips through. Browsers never send either, so this is not reachable through CSRF.
- **N2:** when a request is malformed at the framing level, Fastify answers with its own clientError JSON (`{"error":"Bad Request","message":"Client Error","statusCode":400}` / 431) instead of the app's `bad_request` shape. Nothing is echoed.
- **N3:** text made only of zero-width characters (U+200B) is not `empty`, because JS `\s` does not cover format characters. It would paste invisible text plus Enter. SEV-4 candidate.
- **N4:** bidi controls (U+202E, U+2066–U+2069) are accepted in Submit text and stored raw in `console_submit_log.text_masked`. This is consistent with the documented refusal set, which is C0, C1, ESC and invalid UTF-8. It is a display risk only if something renders the audit copy. The folder-name rules do refuse bidi characters.
- **N5:** a replayed key that already has a stored result returns that result even when the text differs. A key still in flight with different text gets 400 `invalid_key`, so the two paths disagree.
  - Only a crafted client can reach it: the page mints a new key whenever the text changes (`console-page.ts:1270`).
  - If the stored outcome were `sent`, the caller would be told "sent" for text that was never sent.
  - SEV-4 candidate. A possible fix is to compare a text hash on replay as well.
- **N6:** dismissing an already dismissed card overwrites `dismissedAt`.
- **N7:** WebSocket error frames echo the raw decoded machine name (`no dev machine with logicalName '<img src=x>'` and the U+202E name). The terminal client renders it through `hooks.status` as text, and the cross-site rule blocks a sibling site from opening such a URL, so this is not exploitable. The HTTP projects and sessions routes echo only names that already passed the name pattern.
- **N8:** the bearer token can read the pane and expand routes (operator guard only, no step-up). This matches the design, since those routes type nothing.
- **Not testable live:** expiry of the 15-minute window needs a fake clock. It is covered by unit tests only. Replay after revoke, after logout and after a restart was tested, and all three were refused.

### Clean-up and scratch paths
- The local server was stopped twice by PID (the original run and the restart test). No `dist/server.js`, `ws.cjs` or `head.mjs` process is left, and port 18093 is free.
- I printed a change card, then removed the 10 files it listed:
  - `probe.db`, `probe.db-shm`, `probe.db-wal`, `inject/inject.db`;
  - `admin-token`, `operator-pass`, `cookie`, `cookie2`, `req/login.h`, `req/login2.h`.
- Still in `/Users/karl/.cache/uat6-probe-2026-10-26/` (no secrets in them):
  - `console-settings.json`, `start.sh`, `seed.cjs`, `p.sh`, `ws.cjs`, `inject/head.mjs`;
  - `logs/probes.log` (every probe), `logs/server.log`;
  - `req/` (request bodies, `state.json`, `console.html`, `pr1.h`, `body.tmp`);
  - empty folders `home/` and `keys/`.
- `probes.log` also holds some junk lines from a first run of the malformed-URL loop that failed because of a shell variable clash.
- **Log hygiene:** `pgrep -fl` once printed the local test session cookie into this transcript. It belonged to the stopped local instance and is now invalid.
- **Repo:** no edits and nothing staged by me. `npm run build` regenerated the gitignored `dist/`. An untracked `.claude/pending-approval.json` that is not mine appeared during the run.

### TL;DR
I tried to break the console's reply, step-up, commit-approval screen, shell, New Session and New Project features on a throwaway local copy, plus read-only checks on the live site. Nothing got past the login, the passphrase step or the input checks. Two minor (SEV-3) problems turned up:
1. A rare kind of request to the terminal address returns a server error and leaves no trace in the logs. The fix is a one-line setting.
2. On the live site, refused terminal connections sometimes hang for 12 seconds instead of failing straight away. The cause is unknown and needs a look at the proxy.

There are also eight smaller oddities, none exploitable from a browser. The two to decide on:
- An invisible-only reply (zero-width spaces) is accepted.
- A hand-crafted retry with changed text is told the old result.

Waiting on Karl:
- Triage FAIL-1 and FAIL-2, and decide whether N3 and N5 get BUGS rows.
- Options for FAIL-1: (a) fix now, which is cheap and safe; (b) defer as SEV-3. Recommendation: (a).
- Options for FAIL-2: (a) look at the proxy's handling of refused upgrades before UAT-6 judges the drawer; (b) watch terminal open times during UAT-6 and decide after. Recommendation: (b) first, because a hang only matters if Karl sees one.
- If he does nothing, the 500 stays silent and a logged-out terminal may hang without an error.

Nothing needs running. The local server is stopped, the probe database and test credentials are deleted, and the repo is unchanged.
