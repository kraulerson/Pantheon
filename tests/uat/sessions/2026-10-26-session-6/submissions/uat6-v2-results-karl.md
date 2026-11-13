# Pantheon Harness — UAT Session 6 v2 (re-test) Results

**Date:** 2026-11-07 (run 2026-11-09 → 2026-11-10)
**Tester:** Karl (Zen browser)
**Features:** UAT-6 re-test on build 2449999 (BUGS #69 #71 #72 #78 #79 #80 #84 #85; scenarios 8 10 18 21 22 23)

**Summary as submitted:** 10 passed, 3 failed, 1 skipped, 0 not tested

---

## Scenarios (as submitted)

| # | Scenario | Result | Notes |
|---|---|---|---|
| 1 | The console opens on the new build | PASS |  |
| 2 | A real CDF commit approval is answered from the console by typing A1 twice (UAT-6 #8, BUGS #70) | PASS |  |
| 3 | New project on Linux-Dev finds claude and starts it (BUGS #71) | FAIL | ctrl+ did not open the drawer |
| 4 | An over-long paste shows as over the limit and cannot be sent (BUGS #69) | PASS |  |
| 5 | A reply question with one option per line gets copy-only A1/A2 buttons and can be dismissed (UAT-6 #10 reworded) | FAIL | Claude's TL;DR reply: it never offered A1/A2, so it didn't know what they referred to and changed nothing |
| 6 | Cleanup: remove the Linux-Dev throwaway session and folder | FAIL | CTL+ does nothing |
| 7 | Copying works like a standard terminal in a Terminals tab (BUGS #84; UAT-6 #21) | PASS |  |
| 8 | Copying works the same in the machine-shell drawer (BUGS #84) | PASS |  |
| 9 | A signed-in HEAD request to a terminal address answers 404 and is not a server error (BUGS #80, #85) | SKIP | Running test on Zen browser. commands are different. |
| 10 | A revoked keycard is refused and every keycard step is logged (UAT-6 #22 step 3, BUGS #79) | PASS |  |
| 11 | A malformed address is refused, not served (BUGS #55 regression; UAT-6 #18 reworded) | PASS |  |
| 12 | Signing out in another tab shows the signed-out line, and sign-out and sign-in are logged (BUGS #78 by eye, #79) | PASS |  |
| 13 | The chat page, the harness and Configuration still work together (UAT-5 #16; UAT-6 #23) | PASS |  |
| 14 | Machine drop-outs and server errors left a trace in the journal (BUGS #72, #85) | PASS |  |

## Cross-check against VM 1093 (pantheon-harness session, 2026-11-10)

Sources: `journalctl -u pantheon-admin@pantheon` since 2026-11-08 02:24 UTC (16 lines), and read-only queries of `data/control-plane.db`.

| # | System record | Verdict |
|---|---|---|
| 2 | No console submit to Pantheon after the deploy. The approval of `66e06a3` was one A1 typed in the terminal (approvals.jsonl) | Not run |
| 3 | `created_project` on Linux-Dev at 2026-11-09 14:44:47Z, plus a card "You asked me to reply "PONG" and I did…" | #71 fixed. Step 5 (drawer) failed |
| 5 | Text sent: `A1 - keep / A2 - Change / TL;DR: waiting on you…` (a pick, not the instruction). Card: `asks_you 0` | Not run as written |
| 6 | `uat6v2-scratch` is still running on Linux-Dev and the folder exists | Not done |
| 10 | `keycard` table has no row created, used or revoked since the deploy; no `keycard.*` journal line | Not run on this system |
| 12 | 4 × `auth.login outcome:"signed_in"`, 0 × `auth.logout` | Sign-in logging confirmed; sign-out unverified |
| 14 | 0 × `http.internal_error`, 0 × `console.machine_unreachable` | Pass |
| — | No `pk1_` string in the journal | No keycard code leaked |
