# Pantheon Harness — UAT Session 4 Results

**Date:** 2026-08-27 (run 2026-08-28)
**Tester:** Karl (operator)
**Features:** Harness under the chat address + theme, Pending-Approvals inbox, Fixes & regressions
**Template:** ../templates/test-session-4-v1.html

**Summary:** 16 passed, 3 failed, 1 skipped, 0 not tested

---

## Scenarios

| # | Scenario | Result | Notes |
|---|---|---|---|
| 1 | The chat page's footer offers Terminals and Configuration | PASS |  |
| 2 | Terminals opens the harness under the SAME address | PASS |  |
| 3 | The harness wears the chat page's colours | PASS |  |
| 4 | The harness follows the chat page's Light/Dark setting | PASS |  |
| 5 | A tmux session attaches through the chat address | PASS |  |
| 6 | Chat opens as a tab INSIDE the harness | PASS |  |
| 7 | A footer link clicked inside the embedded chat takes the whole window to the harness | PASS |  |
| 8 | Configuration from the chat page is the setup page, on the same address | PASS |  |
| 9 | Help opens the guide on the same address, from both places | PASS |  |
| 10 | Logging out of the harness does not log you out of chat | PASS |  |
| 11 | The old admin address still works and offers chat as a link, not an embed | PASS |  |
| 12 | Approvals and Configuration show the same data on both addresses | PASS |  |
| 13 | The Approvals inbox has a labelled empty state | PASS |  |
| 14 | A real pending request appears as a reference line | FAIL | Alden performed the action but no ticket appeared in the Approvals window. Checked within 2 minutes, re-ran the test, same issue. From the CLI side it thinks the ticket went in (tmux session Alden-2 has the exact info). |
| 15 | Deciding elsewhere makes the row disappear | SKIP |  |
| 16 | A keycard sees the same reference-only view | FAIL | (no note — output requested from the tester) |
| 17 | The terminal fills the whole tab (fix for bug #39) | PASS |  |
| 18 | The bare admin address still lands on the harness (regression #15) | PASS |  |
| 19 | A keycard is still refused on every page and revoke still works | FAIL | Step 1 prints 308 |
| 20 | Existing tmux sessions on the Mac are untouched | PASS |  |

Sidebar redesign: "Yes on sidebar".
