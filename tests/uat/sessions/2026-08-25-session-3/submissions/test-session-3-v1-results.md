# Pantheon Harness — UAT Session 3 Results

**Date:** 2026-08-25 (run 2026-08-26)
**Tester:** Karl (operator)
**Features:** tmux launcher, Session keycards, Regressions
**Template:** ../templates/test-session-3-v1.html

**Summary:** 22 passed, 0 failed, 0 skipped, 1 not tested

---

## Scenarios

| # | Scenario | Result | Notes |
|---|---|---|---|
| 1 | The launch bar lists the tmux sessions running on the Mac mini | PASS |  |
| 2 | Attach to an existing session and land inside it | - | not marked; attach path exercised by #3 and #4 (both PASS) |
| 3 | Attaching from the harness shows up as an attached client on the Mac | PASS |  |
| 4 | Closing the tab detaches the client but the session keeps running | PASS |  |
| 5 | Create a brand-new tmux session from the harness | PASS |  |
| 6 | A bad session name is refused with a text message and no tab | PASS |  |
| 7 | A button for a session that no longer exists fails visibly, not silently | PASS |  |
| 8 | Refresh re-reads the list from the Mac | PASS |  |
| 9 | A machine that is not provisioned gets no tmux controls | PASS |  |
| 10 | The Configuration page has a Session Keycards section | PASS |  |
| 11 | Minting with no scope ticked is refused with a readable message | PASS |  |
| 12 | Minting a keycard shows the code exactly once | PASS |  |
| 13 | Reloading the keycard page does not reveal the code again | PASS |  |
| 14 | The keycard opens the door from the Mac | PASS |  |
| 15 | Scopes are enforced exactly — granted, refused, and not-built-yet each say so in text | PASS |  |
| 16 | A keycard cannot open any admin address | PASS |  |
| 17 | Your browser sign-in cannot open the keycard door | PASS |  |
| 18 | The use and deny counters move | PASS |  |
| 19 | A made-up keycard is refused and counted | PASS |  |
| 20 | Revoke asks first, then refuses the card from the very next request | PASS |  |
| 21 | Bare address and sign-out still behave (regressions #15, #20) | PASS |  |
| 22 | The Help page explains both new features in plain language | PASS |  |
| 23 | Configuration Edit and Remove still work (regression #19) | PASS |  |

## Operator notes (same message)

- "(fast)" chat entries: first word in about 1 second — confirms LibreChat forwards the nested
  `chat_template_kwargs.enable_thinking=false` addParam.
- Sign-in length: Karl chose 30 days (`REFRESH_TOKEN_EXPIRY` in the VM's `deploy/.env`).
