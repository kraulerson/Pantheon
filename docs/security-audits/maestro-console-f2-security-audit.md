# Security Audit: Maestro Console F2 (answer from the page)

Feature: Maestro Console F2. The console can now send. A reply box and option buttons on a card, a passphrase step-up, one allow-listed delivery script that pastes Karl's text into a live Claude Code session in tmux, an append-only audit of every send, New Session and New Project, a Claude-session view, a machine shell drawer, and (Task 12, added on Karl's ruling) the commit-approval screen. Spec: `docs/superpowers/specs/2026-10-16-maestro-console-design.md` §6.4, §6.6, §7, §8, §14. ADR-0010 R1–R6 and its F2 follow-up. Plan: `docs/superpowers/plans/2026-10-18-maestro-console-f2.md` (committed 498a973). Execution ledger with every ruling: `.superpowers/sdd/2026-10-18-maestro-console-f2/progress.md` (git-ignored workspace). The five lens reports, the whole-branch review and the fix-wave reports sit in the same folder.

Audit date: 2026-10-20. Code tree at the time of this document: `5a26554db54fdf509ef4882152540b720e7916e2` (47 files, +10,704/−241 vs HEAD 498a973). The staged index now also holds these documents. No commit exists yet (operator ruling A1 of F1 carried: one commit per feature).

## Method

Phase 2.4 per CLAUDE.md, in this order:

1. **Five parallel lenses, each a fresh agent:** SAST (injection and quoting at every remote-command mint site, the POSIX-sh script bodies, HTML and JS sinks, regex robustness, prototype pollution, fail-open error paths); threat model (TM-020 and TM-025); data isolation (what is stored, masked, logged); input validation; logging. The scale is the one the project's CLAUDE.md names for Phase 2.4 (ruling T11-0).
2. **One whole-branch adversarial review** of the full staged diff, which also triaged every audit SEV-3 and every ledger line marked "minor (deferred)" or "residual" (84 rows: 33 fix before merge, 51 residual).
3. **One fix wave** (32 items, groups A–F) built by one implementer, then **one scoped re-review** of the fix diff.
4. **A per-task implementation, review and scoped re-review for Task 12** (the commit-approval screen), including three fix rounds. The `security_audit` Build Loop step is marked after Task 12's review so this record covers the addendum.
5. Every task before the audit had its own per-task review (Tasks 1–10), each followed by a scoped re-review when it needed a fix round.

**Method deviation.** Karl's dispatch rule asks for the top tier (Fable) at max effort for security work. The Fable quota ran out: all five lens auditors failed at their first step with HTTP 429 "You've reached your Fable limit" (request ids `req_011CgCmGQU4Dpay3dpRdiRp9`, `req_011CgCmGfVgy9Js7ASVK5QQH`, `req_011CgCmH3aEyHH2nRqTJnpGn`, `req_011CgCmHW5gFJ3uh26Gy2XVH`, `req_011CgCmHXXkTfB77GgLGvfm7`), and no audit file was written. Under ruling T11-2 the five audits, the whole-branch review, the fix-wave implementation and re-review, and every Task 12 review ran on Opus at max effort. The per-task reviews of Tasks 1–10 ran on Fable at max effort. The security audit and the final review are therefore one tier below Karl's rule, offset by five independent lenses plus the whole-branch review.

**Process breaches found during the build.** Tasks 1–2 edited `src/` without the Planning Zone plan being marked in progress; how those edits passed the hook is unexplained (Bash edits, or the zone was not yet armed). Task 9's implementer edited `src/http/terminal-client.ts` twice through Bash against the dispatch's Write/Edit-only rule. The Task 9 reviewer checked that block (`node --check`, no stray escapes, defined once per page). The resulting code is in the staged diff the whole-branch reviewer read. Two separate hook gaps were found:

- **(a) The Planning Zone marker could not be set by implementers.** The `plan_active` marker depends on task tools that subagent harnesses on the newer models do not expose. The cdf session filed this as CDF #38, and a sanctioned `mark-plan-active.sh` is being built in CDF 4.4.8.
- **(b) The hooks gate Write and Edit only, so a Bash edit passes.** This was filed by the cdf session as CDF #39 (2026-10-20; not yet fixed).

## Headline

**Verdict: SHIP after the fix wave, which is done.** The audit found two SEV-1s and eight SEV-2s (DI-1, DI-2, DI-3, IV-2, L1, L2, L3, F-2). Nine of the ten are fixed in the staged tree and each fix has a test that fails without it. The tenth, the SEV-2 F-2, is accepted under Karl's decision 18. The scoped re-review marked all 32 fix items addressed with no new Critical or Important finding. The composed properties:

- **Text reaches a session only as base64.** Karl's text is validated server-side (refuse, never strip: C0 and C1 controls, ESC, invalid UTF-8, lone surrogates, more than 4 KiB), then travels as base64 inside a quoted heredoc and is pasted as one bracketed paste. A decoded `& $(x)` backticks `;rm` and a newline were shown to arrive as literal bytes. Every other value in a remote script (pane id, session id, buffer id, directory, tmux name) passes an allow-list regex or an integer bound first and is single-quoted.
- **Four new mint sites, all allow-listed.** Deliver, list-projects, create-session and the machine shell attach line. All minted bodies pass `sh -n`, `dash -n` and `bash --posix -n`. Task 12 adds a fifth, a read-only pane-tail variant that reuses the F1 probe's `tail_of`.
- **Re-verify on the machine, then write.** The delivery script re-checks the session id, the raw `procStart`, the pid, the pane process chain, any menu or trust prompt on screen, and (after the fix wave) copy mode, before it pastes. Anything unexpected is a labelled refusal, never a send.
- **Write-ahead audit.** `console_submit_log` gets an `attempted` row before any dial and a `result` row after. No `attempted` row means no dial. The table is append-only by two triggers as well as by convention.
- **Step-up on a cookie session only.** Submit, New Session and New Project need the 15-minute passphrase window keyed on the cookie session. A bearer-only caller is refused. The terminal WebSocket now refuses a bearer-only upgrade while login is enabled.
- **Nothing a session wrote is sent back.** Option buttons either copy a letter into the visible box or send an option id of at most 8 characters. Commit approvals never get a button.
- **Fail visible.** Every outcome is a labelled state with glyph and word (CC1), including the new `unconfirmed` outcome for a send whose result could not be confirmed.
- **No page injection.** The page builds its DOM with `createElement` and `textContent` only. No `innerHTML`, `eval`, `Function` or `document.write`. The Task 12 screen text is set as text, with bidi controls replaced by visible marks.

## Threats considered

| Threat | Concrete attack tried | Result |
|---|---|---|
| TM-020 remote-command surface | Metacharacters, quotes, newlines, `$(…)` and backticks in text, directory, folder, tmux name and pane id; forged `PANTHEON_DELIVER:` lines inside a pane; crafted stdout from the list script naming `/etc/cron.d` | Every value allow-listed and single-quoted; forged lines land base64-encoded; the list parser and the create route share one admissibility rule, so nothing outside the root is startable. One SEV-1 found and fixed (IV-1, below) |
| TM-025 send path: stolen session | Cookie-less Submit, bearer-only Submit, expired window, window shared by a second cookie holder, terminal WebSocket with the bearer | Submit, New Session and New Project refuse without a live window on a cookie session. The bearer-only terminal upgrade was SEV-1 (F-1), fixed. Co-holder of the cookie and cookie-only terminal typing: accepted residual F-2 |
| TM-025 send path: wrong target | Session file edited, `procStart` changed, process gone, menu or trust prompt on screen, copy mode, `waiting` session, key replayed against another card or text | Each is a labelled refusal before the paste. Copy mode (F-3) and the replay binding (IV-4) were added by the fix wave |
| Replay and double send | Same idempotency key twice, concurrently and in sequence; a 5xx after the dial; a crash between the write-ahead row and the result row | One dial per key (in-process join plus a unique `(idempotency_key, row_kind)` index). A 5xx or a transport failure keeps the key, so the retry meets a 409 `unresolved` and no second dial (L1, fixed) |
| Secret leakage | Credential shapes in Submit text, machine status, tmux names, folder names; unprefixed 40-character secrets | Shared mask widened; an audit-only stronger mask for the stored copy; masked before storage in every route (DI-1, DI-2, DI-3, fixed). Unprefixed secrets pasted by Karl stay a residual |
| Log forgery and information in logs | Text, passphrase, raw session id, folder name, path or `user@host` in any log line | None reaches a log; tests pin it, probes confirmed. Missing reasons, levels and join keys fixed (L5, L6, L7, L9; L4 and L8 only in part, the rest is in Residual) |
| Input validation | Invalid UTF-8 on the wire, form bodies, lone surrogates, bidi and C1 controls in directories, `#` in a path, oversized JSON | `#`, C1, lone surrogates and bidi refused at the one shared rule; JSON bodies decoded as strict UTF-8; the four console POST routes require `application/json`. IV-1 and IV-2 fixed |
| Audit integrity | Raw UPDATE or DELETE of `console_submit_log`; a failed audit write | Triggers abort both; a failed write-ahead row means no dial (outcome `failed`, reason `audit_write_failed`) |
| XSS via dev-machine text | Hostile strings through the poller, store, route and page in jsdom; the Task 12 screen with RLO, RLI and RLM | No markup, attribute or handler from data; bidi formatting characters shown as `⟦U+XXXX⟧` |
| Availability | Quadratic regexes in the new reply-question rules, `sh` loop in `freeName`, 400 kB hostile inputs | Reply-question regexes linear (400 kB ≤ 5 ms). The controller's folded IV-3 ruling ("skip any `sh-` candidate") would have hung the event loop for base `sh`; the whole-branch reviewer caught it and the fix applies the `p-` rule to the final candidate (T11-13) |
| TM-027 Telegram | n/a in F2 | — |

## Findings

All findings below were fixed before the F2 commit unless the Resolution column says accepted. "Fix wave" items are the 32 items of `fix-wave-brief.md` (A1–F4). Line references are the lens reports' at the time; the fixes moved them.

**SEV-1 and SEV-2**

| Id | Sev | Title | Lens | Resolution | File reference |
|---|---|---|---|---|---|
| IV-1 = SAST-1 | SEV-1 | tmux format-expands the `new-session -c` start directory and `remoteDirProblem` did not refuse `#`; a parent folder named `#(…)` is a command-execution sink on the dev machine when Karl clicks the project | input validation, SAST | Fixed by A1 (ruling T11-5): `#`, C1 controls, lone surrogates and bidi controls refused at the one shared rule, which closes create, machine shell and settings root | `src/devmachine/tmux.ts` (`remoteDirProblem`), `src/console/session-command.ts`, `src/console/settings.ts` |
| F-1 | SEV-1 | The admin bearer alone could open the terminal WebSocket and type into any live session or open the machine shell, with no step-up, menu refusal or audit (inherited, widened by F2) | threat model | Fixed by B1 (ruling T11-3): a bearer-only upgrade is refused 403 `terminal_cookie_only` while login is enabled; the bearer keeps its API reach | `src/http/app.ts` (onRequest), `src/http/routes/terminal.ts` |
| DI-1 | SEV-2 | The delivery result row stored the machine's raw `status` unmasked in `status_at_send` and `reason` | data isolation | Fixed by D1 (ruling T11-6): every machine- or operator-derived text field of a submit-log row is masked before storage, in the routes | `src/http/routes/console.ts`, `src/console/deliver-command.ts` |
| DI-2 | SEV-2 | `maskSecrets` missed common bare credentials; the masked Submit copy is kept forever (R6) | data isolation | Fixed by D2 (rulings T11-7, T11-14): prefixed patterns, an assignment form, and an audit-only `maskSubmitText` for the stored copy. Unprefixed 40-character secrets stay a residual (see below) | `src/console/masking.ts`, `src/http/routes/console.ts` |
| DI-3 | SEV-2 | Tmux session names and folder names passed allow-lists but were never masked before the forever log, the project list or the creation response | data isolation | Fixed by D1 (ruling T11-8): the projects list drops and counts a path the mask would alter; the sessions POST refuses it `refused_name`; submit-log `tmux_session` is masked. A secret-shaped tmux name in F1 session rows is a residual | `src/console/cards.ts`, `src/http/routes/console-sessions.ts` |
| IV-2 | SEV-2 | Invalid UTF-8 on the wire was replaced by U+FFFD before `validateSubmitText`; spec §6.6.2 requires refusal | input validation | Fixed by C1 (rulings T11-9, T11-15): strict (fatal) UTF-8 decode of the raw JSON body, 400 `invalid_utf8`; the four console POST routes require `application/json` (415 otherwise) | `src/http/app.ts`, `src/http/routes/console.ts` |
| L1 = F-6 | SEV-2 | A completed dial could leave no log line and a 500; the page discarded the key on any answer, so the retry pasted twice | logging, threat model | Fixed by D3 (rulings T11-10, T11-16): `markAnswered` failure after a recorded `sent` is logged and does not change the answer; the "result row not written" path answers 409 `unresolved`; the page keeps the key after a 5xx | `src/http/routes/console.ts`, `src/http/console-page.ts` |
| L2 | SEV-2 | A `failed` result row could record a delivery or creation that happened (one 6 s timeout spanned connect and script; any SSH failure read `failed`) | logging | Fixed by D4 (rulings T11-11, T11-18): new outcome `unconfirmed` for an exec that failed after the command was requested; `SshConnectionError.phase` (`before_exec` or `after_exec`) decides | `src/devmachine/connection.ts`, `src/http/routes/console.ts`, `src/http/routes/console-sessions.ts` |
| L3 = F-11 | SEV-2 | Machine shells were audited once per machine per process and only after the shell existed; after a restart the first attach wrote a row for a shell nobody created | logging, threat model | Fixed by B2 (rulings T11-12, T11-17): every `?shell=1` open is audited write-ahead (`attempted`, then `result` `opened_shell` or `failed`); `created_shell` renamed `opened_shell` | `src/http/routes/terminal.ts`, `src/console/store.ts` |
| F-2 | SEV-2 | A stolen cookie types into a live session through the terminal view with no step-up, and the 15-minute Submit window is shared by any co-holder of the cookie | threat model | **Accepted** under Karl's decision 18 (2026-10-17, ruling T11-4); see Residual | `src/http/routes/terminal.ts`, `src/http/routes/console.ts` |

**Whole-branch review**

| Id | Sev | Title | Lens | Resolution | File reference |
|---|---|---|---|---|---|
| I-1 | Important | A reply question without lettered options had no Dismiss, and the sticky flag kept NEEDS YOU up (reproduced for 3 of 4 asks) | whole-branch | Fixed by D6 (ruling T11-19): Dismiss on any card that asks and is neither dismissed nor answered | `src/http/console-page.ts` |
| I-2 | Important | An answered sentinel question came back as NEEDS YOU while Claude worked | whole-branch | Fixed by D5 (ruling T11-19): `answered_at` set on the submitted card and the session's latest card; `markAnswered` clears `needs_you` only for `reply_question` | `src/console/store.ts`, `src/http/routes/console.ts` |
| I-3 | Important (plan gap) | Spec §6.4's commit-approval second step was not built | whole-branch | Cheap status line by D8 first (ruling T11-20); then built in full as Task 12 on Karl's ruling "Build it" (ruling T11-22). See the Task 12 addendum below | `src/http/console-page.ts`, `src/http/routes/console.ts` |
| M-1 | Minor (plan gap) | A `waiting` card showed an enabled reply box; the script always refused it | whole-branch | Fixed by D7 (ruling T11-20): the page disables the box; the route answers 409 `menu_card` | `src/http/console-page.ts`, `src/http/routes/console.ts` |
| M-2 | Minor | The page never showed the stored `answered_at` | whole-branch | Fixed by D9: the meta line shows "answered HH:MM" | `src/http/console-page.ts` |
| M-3 | Minor | Review Focus 5 met narrowly: a reload does not restore the selected machine, project, view or drawer | whole-branch | **Accepted** as a narrow reading (ruling T11-20); UAT-6 judges. See Residual | `src/http/console-page.ts` |

**The rows the triage marked fix before merge (33 of 84), grouped.** All 33 were confirmed addressed by the scoped re-review. Most were fixed with a pinning test; rows 5, 47, 50, 71 and 72 were comment, doc or rename changes and have none.

| Group | Rows (triage number, audit id) | Fix id |
|---|---|---|
| Remote-command allow-lists and tmux | 15 IV-3 (`sh` plus a collision yielded `sh-2`); 17 IV-5 (one tmux buffer name per card); 18 IV-6 (C1, surrogates, bidi admitted; non-UTF-8 folder names listed); 19 F-3 (copy mode swallows the Enter while the record says `sent`); 50 (header comment on the trust prompt column); 70 (`segmentsUnderRoot("/", "/")`); 71 (stale `Resolution` comment) | A4 (T11-13), A7, A1 and A2, A6, A8, A3, F4 |
| Terminal and shells | 14 L12 (a failed terminal or shell open logged nowhere); 61 (log after `term.close()`) | B3 |
| Request bodies and ids | 6 L4 (no join key: correlation id and session hash); 11 L9 and 42 (malformed bodies answered 500); 23 F-7 (same-site POST without Fetch Metadata) | C2, C1, C1(b) |
| Submit route, store, masking | 3 DI-6 and 46 (append-only by convention only); 5 (gitleaks false positive in a store test); 7 L5 and 39 (refusals logged at info); 8 L6 (no reason or cause on lines); 9 L7 (denials on the typing routes unlogged); 10 L8 (no-dial outcomes leave no line, partial); 16 IV-4 and 53 (key not bound to card or text); 22 F-6 (post-dial 5xx discards the key) and 51 (post-dial throw untested); 37 (step-up suite skipped the production wiring); 47 (growth comment); 52 (`isUniqueViolation` matched message text); 82 (sticky ask while answered) | D12, F3, D13, D13, D13, D13, D10, D3, D14, D2, D11, D5 |
| Poller | 2 DI-5 (a sentinel in a shared folder put send buttons on every session there) | E1 |
| Fixtures and docs | 4 DI-7 (a local scratch path in a new fixture, headed for a public repo); 72 (fixtures README header) | F1, F2 |
| Terminal-adjacent | 27 F-11 (= L3) | B2 |

Three Minor items found by the fix-wave re-review (literal bidi characters in test strings, a wrong BOM comment in `app.ts`, a stderr-parse flake risk in `server.test.ts`) were carried into Task 12 as labelled cleanup (ruling T11-23) and fixed there.

## Task 12 addendum: the commit-approval screen

Added on Karl's ruling (relayed 2026-10-20: "Build it") because the spec already required it (§6.4). One new route, `GET /console/api/cards/:id/pane`, behind the operator guard, no step-up (read-only, the expand posture), commit-approval cards only. The pane tail is read through an allow-listed script that reuses the probe's `tail_of`, masked before the cut, never logged and never stored.

The per-task review found no injection or leak path. Findings and their resolution:

| Id | Sev | Title | Resolution |
|---|---|---|---|
| I-1 | Important | The automatic read after `sent` raced CDF's render, so the card could say "Check the staged change above" over a screen without it | Fixed in fix round 1: a fresh read on `sent` plus one re-read at about 2 s, cancelled by Hide, the next send, the card leaving or `stop()` |
| M-1 | Minor | A failed or empty capture showed a tick over an empty screen | Fixed in fix rounds 1 and 3: an empty capture reads "the session's screen came back empty", the route answers 502 `empty_capture`, and the "Check the staged change above" sentence shows only while a successfully read screen is visible |
| M-4, T12-2, T12-3 | Minor | The browser reorders bidi characters in the screen text where the terminal does not (Trojan-source class) | Fixed in fix rounds 1 and 2 (rulings T12-2, T12-3): `bidi-override` style, and every one of U+202A–U+202E, U+2066–U+2069, U+200E, U+200F and U+061C is replaced with a visible `⟦U+XXXX⟧` mark before the text is set |
| B-1 | Important (new in the fix) | An earlier send's re-read overwrote a later Submit's status line, so following the line could send an unintended confirmation | Fixed in fix round 3: the send sequence is bumped at the start of every Submit and every async continuation checks it. Reads are isolated per card (ruling T12-4) |

The scoped re-review of round 3 marked M-1 and B-1 addressed with no new Critical or Important finding. It reproduced the B-1 overwrite failing on the fix base and passing at head, and ran 8 scratch probes: 8 of 8 pass at head, 8 of 8 fail on the fix base.

## Residual (accepted for the F2 exit; carry into UAT-6 and F3)

**Accepted design choice**

- **Esc inside the machine shell drawer is swallowed.** Esc minimises the drawer and is not forwarded to the shell, so programs in the drawer shell (vim, less, fzf) never receive it. Ctrl+backtick and the bar button also toggle the drawer. Karl kept this behaviour (A1, 2026-10-20). It is not a residual awaiting a ruling.

**Accepted by a ruling or decision**

- **F-2: cookie-only terminal typing and the shared step-up window.** SEV-2, design gap. Reachable by anyone holding Karl's operator cookie; they can type into any live session through the terminal view with no step-up, and can Submit inside Karl's open 15-minute window. Accepted under Karl's decision 18 (2026-10-17): terminal and Claude-session access is "operator sign-in like today's Terminals tab", no extra step-up, because Karl types directly; Submit and New Session keep R4 step-up. A stolen cookie is full operator power by design. Ruling T11-4. Karl can reopen D18.
- **F-4 = T10-4: stale session file with a recycled pid.** SEV-3. A session whose file is stale and whose pid was recycled into the same pane's process chain passes the probe's `kill -0` liveness check and the delivery script's re-verification. Needs a `procStart` versus live-process start comparison (`ps -o lstart=` or equivalent) in `src/console/probe-command.ts`. Tracked as a BUGS row. The same-pid-different-`procStart` case is handled (the old row ends, a new one starts).
- **F-5: concurrent sends are not serialised at the pane.** SEV-3. The operator drives both sends. The fix wave gave each Submit its own tmux buffer name (IV-5), which removed the shared-buffer cross-talk.
- **F-8: the projects list is an uncapped SSH dial.** SEV-3. LAN, operator session, one dial per dialog.
- **F-9 (ruling T3-0): no passphrase attempt throttle.** SEV-3. Refusals are logged at warn since L5. A cookie holder already has terminal access (D18), and `/login` is the same unthrottled oracle. The brief's "300 ms minimum response time" was void: `/login` has none.
- **F-10: the admin bearer is a static credential.** SEV-3. Project-wide (BUGS #36). B1 removes its reach to the PTY.
- **L10: creation rows do not record what was asked.** SEV-3. A design call for Karl (for example the masked request in `text_masked`). Can be added later with no constraint change.
- **L11: the fallback log sink writes no timestamp.** SEV-3. Used only when the primary sink throws; journald stamps every line.
- **DI-4: the card id excludes the machine.** SEV-3. Needs one Claude session id live on two machines. The script re-verifies on the machine it dials. The structural fix is a migration.
- **M-3: a reload does not restore the selected machine, project, view or drawer.** Accepted as a narrow reading of Review Focus 5. Terminals re-attach when Karl reopens them. UAT-6 judges.
- **T11-14: low-entropy human passwords in Submit text.** The audit-only mask covers prefixed credentials, assignment forms, 40-hex runs and long mixed runs. A short human-chosen password pasted without a keyword is stored as typed, and the log is kept forever (R6).
- **Unprefixed 40-character secrets (T11-7).** AWS secret keys, Cloudflare and Gitea tokens are not masked by the shared mask, because masking every 40-character hex or base64 run would eat the git SHAs and hashes Karl pastes. The audit-only copy masks 40-hex and long mixed runs. Reachable only if Karl pastes a raw unprefixed secret into Submit.
- **T8 lexical containment.** Root containment is lexical (`path.posix.resolve` plus a prefix test). A symlink inside the projects root can point outside it. The machine is Karl's own and the root is operator-configured.
- **T8-6: a tmux server cold-started by the console's create script has no locale.** The script no longer exports `LC_ALL=C`, and passes no `-e LANG`. Karl's servers are started by his login shells. `deploy/README.md` carries the note.
- **`PROJECT_NAME_RE` admits a trailing space or dot** (spec §14.1.4, plan-mandated). Noted in the spec.
- **T10-3(c) and edge.** After a sentinel vanishes, an unanswered reply question's copy buttons show the sentinel's ids until the next turn. A v1 or id-less sentinel on an asking card replaces the reply letters with an empty list.
- **O1 false positives.** The reply-question rule's measured precision is 23 of 30 (Karl approved the rule). False asks occur; Dismiss now shows on every asking card (I-1).
- **Fixture provenance (DI-7 class).** Two F1 fixtures (`test/fixtures/console/pane-trust-prompt.txt` line 4 and `test/fixtures/console/transcript-meta-and-system.jsonl` line 13) carry local `/private/tmp/claude-501/…` scratch paths and have been public since commit c58750c. Editing them now does not unpublish them. Accepted unless Karl rules a history rewrite. BUGS row.
- **Process.** Two hook gaps, neither of which changes the code under review. (a) The Planning Zone marker could not be set by implementers: filed by the cdf session as CDF #38; a sanctioned `mark-plan-active.sh` is being built in CDF 4.4.8. (b) The hooks gate Write and Edit only, so a Bash edit passes: filed by the cdf session as CDF #39 (2026-10-20; not yet fixed).
- **L4: no `actor` or `correlation_id` column on the submit log.** Triage row 6 fixed the cheap part (a request id per request, `correlationId` on `console.step_up`, `sessionIdHash` on submit and create lines). The new columns stay residual and can be added later.
- **L8: replay and text refusals leave no log line.** Triage row 10 fixed it in part (a warn on `unresolved`, an info on Dismiss). Replay and text refusals stay silent; tests pin that deliberately and nothing is dialled.

**The triage table's residual rows, by theme (51 rows; not repeated one by one)**

- Comment-only and test-only items in untouched files: stale docstrings, linearity comments, test gaps in the F1 transcript and masking suites, a timing assertion that may flake under CI load, test nits in the terminal and settings suites.
- Size and splits: `src/console/store.ts`, `src/http/routes/console.ts` and `src/http/console-page.ts` are large. The splits are mechanical and are a separate chore commit, not part of the F2 change.
- O1 rule edges recorded at Task 2: a skipped negated anchor can swallow a second clause; comma or dash lead-ins with a negation word do not fire; `[A-Z]\d{1,2}` label lines need two distinct ids and their buttons only copy.
- Step-up hygiene: a window entry outlives logout for at most 15 minutes in memory and is unreachable (validation fails first); a clock wound back extends the window as it does for `SessionStore`.
- Delivery script edges that fail closed with a label: no fence awareness in the sh menu check.
- Project-list and create-script edges (Task 8, triage rows 64 and 67): `running` is an exact-string match, so a session reached through a differently spelled (for example symlinked) root reads as not running, the list offers to start Claude there, and a second session (`‹name›-2`) can start in the same folder; checked: macOS and GNU `find` emit single-slash paths. `live.truncated` is ignored and fails closed (the `has-session` check still refuses).
- Page edges for UAT-6: a dead drawer stays dead until reload (note the "close tab to dismiss" wording for F3); under 900 px a view click is remembered; the cookie-only boot note is untested; colours are hard-coded hex.
- Duplicated constants (`"sh-"`, the machine-name rule, the unreachable wording) and sentinel ids parsed twice (backlog).

**Task 12 residuals**

- **B-2.** A Submit answered after `stop()` arms a new re-read (`paneAfterSend` has no `stopped` check). Reach is narrow: `stop()` runs only when a re-boot replaces the client. The stopped page still reads the pane twice (two SSH dials).
- **B-3.** A failing automatic re-read discards a good screen (`ui.pane = null`). Refresh restores it.
- **The screen view closes at the start of every Submit,** including a Submit whose step-up is then cancelled. There is no pre-send screen beside an unresolved or unconfirmed status line, and the confirming Submit shifts the layout. One Show restores it.
- **Test gap.** No shipped test holds a read across a later Submit or covers step-up on a confirmation. The re-reviewer's scratch probes (P2a, P3, P4) would pin it; they were never added to the repo.
- **M-2, M-3 (502 wording in five places), M-5 (the 64 KiB budget can fail on a very dense pane; the 502 is labelled).** Plan wording and plan-mandated limits; recorded for a later cleanup.
- **The pane text may predate CDF's render.** The automatic re-read at about 2 s and the Refresh control are the mitigation.

**Out of scope, unverified, noted for completeness.** A projects root ending in `;` may be split by tmux's argument parser (recalled from tmux's source, not tested; only the operator can set a root, so it is not an injection). A `sent` record beside a non-zero exit reads `failed`; in practice the script exits 0 right after its record.

**The ssh2 AES-GCM native abort on VM 1093.** SEV-2 candidate, a process abort about once a month with an automatic restart. `pantheon-admin@pantheon` aborted on 2026-10-19 at 07:06:34Z (journal: `Assertion failed: (env) != nullptr` at `../src/api/hooks.cc:142`, native frame `AESGCMDecipher::~AESGCMDecipher()` in `node_modules/ssh2/lib/protocol/crypto/build/Release/sshcrypto.node`, `status=6/ABRT`, systemd restarted it 3 s later, `NRestarts=1`). The only other `AESGCMDecipher` abort since 2026-09-01 is 2026-09-16T12:22:04Z. Node v24.19.0, ssh2 1.17.0. Same assertion class as BUGS #31 (better-sqlite3, marked Fixed), a different native module, during normal running. F2's write-ahead model already covers a crash mid-delivery: the `attempted` row survives with no `result`, the page keeps the key (T11-10), and the retry meets the 409 `unresolved` with no second dial. Mitigation options for Karl, checked 2026-10-20 against ssh2's docs through Context7 and this tree's `node_modules/ssh2` 1.17.0:

1. Restrict the cipher list so AES-GCM is not offered: documented, `Client.connect({ algorithms: { cipher: { remove: [/gcm/] } } })`. Caveat: every cipher family has a native "Binding" class used whenever the addon loads, and the default list puts `chacha20-poly1305` first or right after the GCM ciphers, so removing GCM moves negotiation to ChaCha20-Poly1305 or AES-CTR, which are still native. Whether the abort is specific to the GCM destructor is unknown.
2. Run ssh2 without its native binding: no documented switch. `crypto.js` reads an internal `forceNative` flag that selects the pure-Node classes; `Client.connect` does not expose it. It would need a patch or deleting the built addon, which is fragile across `npm ci`.
3. Accept the automatic restart.

Disposition: Karl accepted the automatic restart (A1, 2026-10-20). BUGS #51 is Won't Fix, and `NRestarts` is watched.

## Verification

Controller-run, from `services/control-plane`, with the results quoted from the ledger:

```
Fix wave (tree 71124c4):
npm run lint                           # clean
npx tsc -p tsconfig.json --noEmit      # clean
npm test                               # Test Files 74 passed | 1 skipped (75); Tests 1351 passed | 5 skipped | 1 todo (1357)   (baseline 1256)
npm run build                          # clean
gitleaks git --pre-commit --staged --redact --config .gitleaks.toml   # no leaks found (~585 KB scanned)

After Task 12 (tree 5a26554, measured at resume on 2026-10-20):
npx vitest run                         # Test Files  74 passed | 1 skipped (75)
                                       # Tests  1375 passed | 5 skipped | 1 todo (1381)
```

At the final head, measured by the controller on 2026-10-20 at code tree 5a26554, from `services/control-plane` unless noted:

```
npm run lint                                                  # exit 0
npx tsc -p tsconfig.json --noEmit                             # exit 0
npm run build                                                 # exit 0
npm test                                                      # Test Files  74 passed | 1 skipped (75); Tests  1375 passed | 5 skipped | 1 todo (1381)
semgrep scan --config p/owasp-top-ten --config p/security-audit --metrics=off src   # semgrep 1.181.0: "Ran 92 rules on 93 files: 0 findings."
gitleaks git --pre-commit --staged --redact --config .gitleaks.toml   # (repo root) "no leaks found", ~761.70 KB scanned, exit 0
```

The Semgrep run uses the same two configs as CI's step. Task 12's reviewers did not re-run lint, tsc or build; only its implementers reported them, at exit 0 on their trees.

- **IV-1 `#S` reproduction (controller, 2026-10-20, tmux 3.6a, this Mac, throwaway sessions in the scratchpad, killed after).** `tmux new-session -d -c "<scratch>/fmtcheck/a#Sb"` gave `#{pane_current_path}` = `/Users/karl`: the `#S` was expanded, the path did not exist, and tmux fell back to `$HOME`. The control `-c "<scratch>/fmtcheck/plain"` gave the plain path. Format expansion of `-c` is confirmed. Execution through `#(…)` follows from the FORMATS section of the tmux manual and was deliberately not exercised. IV-1 stands as SEV-1 and is fixed by refusing `#`.
- **Copy-mode check (A6).** On a throwaway tmux 3.6a server, `#{pane_in_mode}` read `0`, `1` in copy mode and `0` after cancel.
- **Other scans that ran.** `gitleaks detect --no-git --source services/control-plane --redact` (gitleaks 8.30.1): `leaks found: 8` before the fix wave including `test/console-store.test.ts` line 117; `leaks found: 6` after (three `.env.local`, gitignored and untracked, and two allow-listed test files). With the project config `--config .gitleaks.toml`: `leaks found: 3`, all `.env.local`, never committed. Fix-wave re-reviewer: `semgrep` 1.181.0 with a local one-rule bidi config, `--metrics=off`, found 0 findings across `services/control-plane` (its default ignore skips `test/`) and 5 findings when `test/devmachine-tmux.test.ts` was targeted directly; those lines were then rewritten as `\u` escapes in Task 12. The SAST lens report (`audit-sast.md`) records no Semgrep run (the controller ran the scan quoted above); it used esbuild-bundled command builders, `sh -n` and `dash -n` on each minted body, pathological-input regex probes, `tsc --noEmit` (exit 0) and 76 passing tests in the deliver, session, step-up and submit suites.
- **GitHub CI's Semgrep and gitleaks have never run on a pushed commit.** All 91 of 91 CI runs failed (newest 2026-10-20, commit 498a973). `.github/workflows/ci.yml` runs `actions/setup-node` with `cache: 'npm'` at the repository root, but the only lockfile is `services/control-plane/package-lock.json`, so the job stops at "Dependencies lock file is not found". The CI Semgrep (`p/owasp-top-ten`, `p/security-audit`, `semgrep-action` v0.58.0) and gitleaks steps are never reached. The F2 scans listed above are local, including the controller's Semgrep run with the same two configs. BUGS row. Karl ruled (A1, 2026-10-20) that the fix lands in its own `ci:` commit right after the F2 commit.
- **Reviewer evidence.** The whole-branch reviewer re-ran the suite at the pre-fix tree (1256 passed | 5 skipped | 1 todo), tsc and lint at exit 0. The fix-wave re-reviewer ran read-only checks (greps over every `-c` interpolation, the installed Fastify 5.8.5 and secure-json-parse 4.1.0 sources, a bidi scan). Task 12 re-reviewers ran 8 scratch probes against the fix base and head.
- **Deploy verification (Task 11 step 6): still to come.** Not yet run on VM 1093: the settings file's `machines` key, tmux 3.2 or later and the `claude` path on Linux-Dev, the 6 s Submit budget and 0.5 s settle on a waking Mac, a live Submit against a throwaway session, the database backup. What a pasted bracketed text does inside Claude Code's input (a leading `/`, `!`, `#` or `@`, paste plus Enter while busy) is assigned to UAT-6 and cannot be proven by unit tests.

Per-task reports: `.superpowers/sdd/2026-10-18-maestro-console-f2/task-N-report.md`; lens reports `audit-sast.md`, `audit-threat-model.md`, `audit-data-isolation.md`, `audit-input-validation.md`, `audit-logging.md`; `review-final.md`; `fix-wave-brief.md`, `fix-wave-report.md`, `review-fix-wave.md`; `task-12-brief.md`, `task-12-report.md`, `review-task-12.md`, `review-task-12-fix.md`, `review-task-12-fix3.md`; and the ledger `progress.md` with every ruling and its cost if wrong.
