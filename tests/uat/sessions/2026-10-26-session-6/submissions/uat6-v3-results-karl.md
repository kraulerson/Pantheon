# Pantheon Harness — UAT Session 6 v3 (owed checks) Results

**Date:** 2026-11-10 (run 2026-11-12 02:22 → 02:29 UTC)
**Tester:** Karl (Zen browser; the submitted form says "Unknown")
**Features:** UAT-6 v3 owed checks on build 2449999 (v2 #2 #3 steps 5-6 #5 #6 #9 #10 #12; BUGS #70 #71 #78 #79 #80 #85)

**Summary as submitted:** 1 passed, 3 failed, 4 skipped, 0 not tested

---

## Scenarios (as submitted)

| # | Scenario | Result | Notes |
|---|---|---|---|
| 1 | Zen delivers Ctrl+` to the console page (diagnoses v2 #3 and #6) | FAIL | addEventListener('keydown',e=>{if(e.ctrlKey)console.log('KEY  key='+e.key+' code='+e.code+' prevented='+e.defaultPrevented)}, {capture:true})  Result: undefined |
| 2 | New project on Linux-Dev runs claude, checked from Linux-Dev's drawer by key or by the Open shell button (v2 #3 steps 5–6, BUGS #71) | FAIL | ctrl+ does not open shell. Card does not refresh |
| 3 | A reply question with one option per line gets copy-only A1/A2 buttons and can be dismissed (v2 #5, UAT-6 #10) | FAIL |  |
| 4 | Cleanup: remove the Linux-Dev throwaway session and folder from Linux-Dev's drawer (v2 #6) | PASS |  |
| 5 | A signed-in HEAD request to a terminal address answers 404 and is not a server error, in Zen (v2 #9, BUGS #80 #85) | SKIP |  |
| 6 | A revoked keycard is refused and every keycard step is logged (v2 #10, UAT-6 #22 step 3, BUGS #79) | SKIP |  |
| 7 | Signing out in another tab shows the signed-out line, and sign-out is logged (v2 #12, BUGS #78 by eye, #79) | SKIP |  |
| 8 | A real CDF commit approval is answered from the ◆ Pantheon card by typing A1 twice (v2 #2, UAT-6 #8, BUGS #70) | SKIP |  |

## Cross-check against VM 1093 and Linux-Dev (pantheon-harness session, 2026-11-12)

Sources: `journalctl -u pantheon-admin@pantheon` since 2026-11-10 22:40 UTC (50 lines), read-only queries of
`data/control-plane.db` (`console_session`, `console_card`, `console_submit_log`), and `tmux ls` plus a folder
listing on Linux-Dev.

| # | System record | Verdict |
|---|---|---|
| 1 | Browser-only check; no system record exists. The note holds the listener line and its return value (`undefined`, which is what `addEventListener` returns). It reports no `KEY` line and does not say that Ctrl+` was pressed afterwards | Inconclusive. Not a recorded fail |
| 2 | `console.session_create` `created_project` on Linux-Dev at 2026-11-12 02:22:11Z. `console_session` row for `uat6v3-scratch` created 02:22:16Z. Card `029a7b51` created 02:22:37Z: "I replied "pong" as you asked…" | #71 still fixed (claude found and started). Ctrl+` did not open the drawer (tester note). "Card does not refresh" is a page observation the server cannot confirm: the card existed in the database 26 s after the create. The note does not say whether the bar button opened the drawer |
| 3 | Submit of the copy-box instruction at 02:27:19Z (150 bytes, `sent`). Card `d506438d` created 02:27:20Z with `asks_you 1`, `needs_kind reply_question`, `options_json ["A1","A2"]`. A second submit of the text `A1` (2 bytes, `sent`) at 02:27:51Z against that card; `answered_at` 02:27:52Z; `dismissed_at` null. Card `d0f8ed93` at 02:27:53Z: "You chose A1, so everything stays as it is…" | The question was raised with A1/A2 options (the v2 #5 fault did not recur). `A1` was sent to the session, which the scenario says must not happen; whether the A1 button sent it or Submit was pressed is unknown. Dismiss was never exercised. Fail stands; cause open |
| 4 | `console_session` `ended_at` 02:29:06Z. Linux-Dev `tmux ls` lists only `reminder` and `sh-Linux-Dev`; `/development/Claude Projects/uat6v3-scratch` does not exist | Pass confirmed |
| 5 | No record expected for a skip; 0 × `http.internal_error` in the window | Not run |
| 6 | 0 × `keycard.*` journal lines in the window | Not run |
| 7 | 2 × `auth.login outcome:"signed_in"` (2026-11-11 14:42Z, 2026-11-12 11:20Z), 0 × `auth.logout` | Not run. Sign-out logging still unverified |
| 8 | 2 × `console.submit`, both to `uat6v3-scratch` on Linux-Dev; none to the Pantheon session | Not run |
| — | 22 × `console.machine_unreachable` for Mac-Mini, all `phase after_exec`, `reason timeout`, between 2026-11-11 10:25Z and 10:41Z, each followed by `console.machine_reachable` | Outside the scenarios. Recorded for BUGS #72 and #86 |

## Agent re-run in Chrome (pantheon-harness session, 2026-11-12 14:19 → 14:22 UTC)

Karl signed in on a Chrome tab driven by the session; build stamp 2449999. Chrome results say nothing about Zen's
own key handling. No project was created (the page was "not elevated" and the passphrase is Karl's to type).

| # | What was done | Observed | Verdict |
|---|---|---|---|
| 1, 2 step 5 | Linux-Dev selected, a capture-phase and a bubble-phase `keydown` listener added, Ctrl+` pressed | Capture: `key=\` code=Backquote prevented=false`; bubble: `prevented=true` (the page's handler took the key). The drawer opened: `[data-drawer]` visible, text "[✓] connected to a shell on Linux-Dev", toggle reads "▾ Minimise". Its top edge was at 3358 px in a 898 px viewport on a 3662 px page; `drawer-wrap`, `drawer-panels` and `drawer` are all `position: static`; `scrollY` stayed 0 and focus stayed on the machine tab button | The key works in Chrome. The drawer opens below the fold, at the end of the page, with no scroll and no focus move, so nothing visibly happens. New defect; spec decision 18 says a bottom drawer |
| 2 "card does not refresh" | Page left open | Tab title went from "(7) Console" to "(8) Console" with no reload | Live update works in Chrome. Not reproduced; Zen unverified |
| 3 | Source read only (`src/http/console-page.ts` 1198–1209); no live card touched | A card with `needsKind` other than `sentinel` gets `copyLetter`, not `sendSentinel`. Card `d506438d` was `reply_question` | By code the A1 button only copies, so the `A1` send at 02:27:51Z needed a Submit press. Not confirmed live. Dismiss still unexercised |
| 5 | `fetch('/harness/terminal/Mac-Mini',{method:'HEAD'})` from the signed-in console tab | `status=404` at 14:21:21Z; 0 × `http.internal_error` in the journal since 14:00Z | Pass (Chrome) |
| 7 | Second tab opened on the console, Log out pressed there at 14:22:03Z; first tab left alone for 16 s | Second tab went to the sign-in page. First tab read "✕ signed out — reload to sign in". Journal: `auth.login outcome:"signed_in"` 14:19:46Z and `auth.logout hadSession:true` 14:22:03Z, same `sessionIdHash f29208a4c9da`; 0 × `pk1_` | Pass (Chrome). Sign-out logging (#79) verified. The sign-in-again half of step 5 not run |

## Still owed after v3

- 1: the Ctrl+` probe, with the console output after the key press.
- 2 step 5: whether the bar button opens the drawer.
- 3: the A1 button's copy-only behaviour and Dismiss.
- 5, 6, 7, 8: not run.
