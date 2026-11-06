# UAT-6 results — agent-driven run in Karl's Chrome (2026-10-27 → 2026-10-29)

Tester: the pantheon-harness Claude session driving Karl's Chrome (Karl's ruling A2: the agent drives the browser; Karl
types every passphrase and runs every deleting or secret-handling Terminal line). Template:
`templates/test-session-6-v1.html` (23 scenarios). System under test: VM 1093, build `6594566`, at
https://pantheon.ferrumcorde.com/harness/console. Evidence: page text and screenshots read by the agent, VM 1093
`journalctl -u pantheon-admin@pantheon` and read-only queries of `data/control-plane.db`, and local `tmux`/`log show`
on Mac-Mini.

## Tally

PASS 14 (1, 2, 4, 6, 7, 11, 12, 13, 15, 16, 17, 18, 19, 20) · PARTIAL 4 (3, 9, 10, 22) · FAIL 2 (5, 14) ·
INVALID 1 (8, scenario set-up; see the row) · NOT RUN 2 (21, 23; Karl's ruling A1, 2026-10-29) = 23.

## Scenarios

| # | Result | Observed |
|---|---|---|
| 1 | PASS (note) | Build stamp `build 6594566`; header `○ not elevated`, no Drop elevation button; machine row `◎ All machines`, `Mac-Mini`, `Linux-Dev`, each with a glyph and state words. At first load (16:40 MDT, 2026-10-27) a banner `✕ UNREACHABLE since 16:40 — Mac-Mini … SSH connection failed` showed for about 3 minutes, then cleared (see F-A). |
| 2 | PASS (retry) | The dialog lists folders marked `○ start Claude here` / `● running — open it` (see F-B). Step-up dialog titled `Confirm it is you`; after Karl's passphrase the header read `✓ elevated until 18:59` with `Drop elevation`. The first Create failed: `console.session_create … outcome:"failed", reason:"tmux_list_failed"` at 00:44:45Z while Mac-Mini was unreachable (F-A). The retry at 00:48:42Z logged `outcome:"created_project"`; tab `uat6-scratch` appeared (`… STARTING — not seen by the poll yet`, then `✓ IDLE`); `tmux ls \| grep -c uat6-scratch` → `1`. |
| 3 | PARTIAL | Claude Code v2.1.310 never asked to trust the new folder, so steps 1 and 3 (menu card, trust answer) could not be exercised. The Claude-session view showed the live terminal (`[✓] connected to Mac-Mini · uat6-scratch`); the window was already elevated, so "without asking for the passphrase" is not proven. Cards then showed `✓ IDLE`. See F-C and F-D. |
| 4 | PASS | Counter `50 / 4096 bytes` before Submit; after Submit `✓ sent — waiting for the session, 18:50`, box emptied, no passphrase dialog; a new card's TL;DR begins `I replied PONG …`. Submit log: `attempted` row (text_masked = the reply, card b01bb8db…, pane %21, status_at_send idle) at 00:50:31.542Z and `result` row `outcome:"sent"` at 00:50:32.252Z, same idempotency key a309ea62…. |
| 5 | FAIL (SEV-3) | `printf 'x%.0s' $(seq 1 4097) \| pbcopy` → `COPIED` (clipboard 4097 bytes). After Cmd+V the counter read `4096 / 4096 bytes` and Submit was ENABLED: the textarea has `maxlength="4096"` (DOM: maxLength 4096, value length 4096, bytes 4096, Submit disabled=false), so the paste was cut silently and a truncated reply could be sent without warning. Not submitted. After clearing: `0 / 4096 bytes`. Expected `4097 / 4096` with Submit off. |
| 6 | PASS | Copy mode confirmed (`tmux display -p -t uat6-scratch '#{pane_in_mode} #{pane_mode}'` → `1 copy-mode`). Submit of `hello` → `⚠ the session is in copy mode — press q in the Claude session, then Submit again`, `hello` kept. After `q` (pane mode `0`): `✓ sent — waiting for the session, 18:53`, box emptied. (The agent's first attempt typed the key name `bracketleft` as text into Claude's input; it was deleted before anything was sent.) |
| 7 | PASS | `WRITTEN`. Card `! PENDING APPROVAL` with buttons A1, A2 and `A button sends only its option id.`; A2 → `✓ sent — waiting for the session, 18:53`; the pane shows the typed line `❯ A2` only. |
| 8 | INVALID (scenario setup; re-run at the re-test) | **Withdrawn 2026-10-30:** the scenario wrote the sentinel into `uat6-scratch`, which has no CDF hooks, so Claude answered the first id itself. In a real CDF project `record-approval.sh` blocks the first id and no new card appears (BUGS #70, Won't Fix). Observed: `WRITTEN`. Card `! COMMIT APPROVAL`, no option buttons. First `A1` + Submit opened `THE SESSION'S SCREEN (MASKED)` (`✓ the session's screen at 18:54:23 — cut to its last 60 lines / 8 KiB`) and the line became `⚠ Check the staged change above, then type A1 again and press Submit to confirm`. The session answered that A1 within seconds, so a NEW `! COMMIT APPROVAL` card (file still present) became the newest; the original card turned into `REPLY … answered 18:54`, lost its panel and showed A1/A2 copy buttons. The second `A1` on the original card gave a plain `✓ sent — waiting for the session, 18:55`, never `✓ A1 sent again to confirm …`, and the newest card restarted at step 1 — it would ask for a THIRD A1, which would reach the session as a stray answer. |
| 9 | PARTIAL | On the newest commit-approval card: Show opened the panel; Hide closed it but no line said the screen `is not shown here` (the card was not in the confirm phase, see 8); Show reopened it (`at 18:56:26`); Refresh re-read it (`at 18:56:39`), no `✕ Can't show` message. |
| 10 | PARTIAL (scenario defect) | `REMOVED`. The reply `Option A1 – keep, Option A2 – change.` / `TL;DR: waiting on you to choose A1 or A2.` raised `! NEEDS YOU` with Dismiss but no A1/A2 buttons: `LETTERED_OPTION_RE` (`services/control-plane/src/console/cards.ts:129`) needs each option at line start as `A1`, `(A)` or `Option A` plus a separator, so `Option A1 –` with both options on one line never matches — the scenario text was wrong (note: the `Option A1` form is unrecognised). Copy-only buttons checked on an earlier card: A1 put `A1` in the box (`2 / 4096 bytes`), nothing reached the pane. Dismiss → `✓ dismissed`, card `REPLY ✓ IDLE … · dismissed`, tab count (8) → (7); Dismiss did not ask for the passphrase. |
| 11 | PASS | Steps 2–4 after the window lapsed at 18:59: `hello again` + Submit → `Confirm it is you`; Cancel → `⚠ step-up cancelled — nothing was sent`, text kept, header `○ not elevated`, card count unchanged, pane unchanged; `console.submit_denied reason step_up_required`. Step 1: Karl elevated (`console.step_up action:"elevate"` 01:24:29Z; header `✓ elevated until 19:39`); Drop elevation → `○ not elevated`, logged `console.step_up action:"revoke"` 01:25:01Z. |
| 12 | PASS | Karl typed `definitely-not-the-passphrase`: `✕ passphrase refused — try again`, dialog stays open, header `○ not elevated`; `console.step_up action:"refuse"` at 01:11:56Z; pane unchanged, card count unchanged. Cancel; box cleared. (Two of Karl's passphrase entries this session never reached the page — no POST, no log — until retried in the tab-group window.) |
| 13 | PASS (note) | Ctrl+` → `Shell · Mac-Mini`, `[✓] connected to a shell on Mac-Mini`; `pwd` → `/Users/karl/Documents/Claude Projects`, `PID=37448`; Esc → bar `▴ Restore` (Esc not sent to the shell); Ctrl+` again → `PID=37448`. No passphrase asked (by design: `docs/superpowers/specs/2026-10-16-maestro-console-design.md:302`). Audit rows `attempted` + `opened_shell` (sh-Mac-Mini) at 01:12:57Z. See F-E. |
| 14 | FAIL (environment) | `Shell · Linux-Dev`: `pwd` → `/development/Claude Projects`; `tmux 3.6`; `ls: cannot access '/home/karl/.local/bin/claude': No such file or directory` (no CLAUDE_FOUND). `command -v claude` in the interactive drawer shell → `/development/.nvm/versions/node/v24.14.0/bin/claude`; the Maestro session confirmed `NVM_DIR=/development/.nvm`, running claude processes execute `…/v24.14.0/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe`, and a non-login shell has no `claude` on PATH. The create script only prepends `$HOME/.local/bin` (`services/control-plane/src/console/session-command.ts:268-271`), so New session on Linux-Dev is expected to fail `claude not found` (not exercised). |
| 15 | PASS | `uat6-scratch — ● running — open it`; pressing it closed the dialog and opened the existing project; `tmux ls \| grep -c uat6-scratch` → `1`. |
| 16 | PASS (server side) | Karl ran the cleanup: `tmux ls \| grep -c uat6-scratch` → `0`; `ls … \| grep -c 'No such file'` → `1`. `console_session` uat6-scratch: `last_seen_at 2026-10-29T20:52:21.695Z`, `ended_at 2026-10-29T20:52:31.697Z` (10 s). The page display was not observed — the open tab was stale (F-G). |
| 17 | PASS | ◆ Pantheon newest card: kind label, state chip, age, TL;DR; `full text`, `why`, `what it did` each opened with text, no error, nothing sent. |
| 18 | PASS (scenario command note) | Default curl uses HTTP/2: `curl: (92) HTTP/2 stream 1 was not closed cleanly: PROTOCOL_ERROR` → `000` (the proxy resets the stream; nothing served). With `--http1.1`: `400`. Step 2: `401`. The scenario line needs `--http1.1`. |
| 19 | PASS | Terminals tab on `Mac-Mini · sh-Mac-Mini`: `seq 1 300` at 1841 px and at 1000 px wide — text to the bottom row and the tmux bar to the right edge, left columns clean, no resize needed. |
| 20 | PASS (agent-typed) | Status line `[✓] connected to Mac-Mini · sh-Mac-Mini`, no `software rendering`; an 86-character sentence was fully echoed by the next frame. Human typing feel not judged. |
| 21 | NOT RUN | Karl's ruling A1 (2026-10-29): carry to UAT-7 (second carry; UAT-5 #9). |
| 22 | PARTIAL | `uat-card-6` minted with `["approvals:read"]` only (created_at 20:54:59.834Z); `use_count 2, deny_count 0` → both curl lines were accepted (printed text not reported). Revoked at 21:12:16.560Z. No curl was re-run after the revoke (`deny_count 0`), so "error after revoke" is not proven here. |
| 23 | NOT RUN | Karl's ruling A1 (2026-10-29): carry to UAT-7 (second carry; UAT-5 #16). The chat page asked for its own sign-in. |

## Findings outside the scenario assertions

- **F-A — Mac-Mini flaps to UNREACHABLE and nothing logs why.**
  - A DOM sample every 1.5 s showed `reachable` → `UNREACHABLE since 16:45` at 16:45:51 → `reachable` at 16:45:56.
  - Mac-Mini's sshd log shows the VM's 5-second poll connections at 16:45:45, :50 and :55 all reaching user validation, yet the banner says `SSH connection failed`.
  - On 2026-10-27 no sshd line at all appears from 18:33 to 18:45 while the VM logged `terminal.open_failed … SshConnectionError` at 00:42–00:44Z. Mac-Mini sleep is off (`pmset -g`: `sleep 0`).
  - The poll failure writes no journal line, and `services/control-plane/src/devmachine/connection.ts:244` discards the ssh2 error (`client.on("error", () => fail(...))`).
  - Cause unknown.
- **F-A2 — lingering attach sessions (BUGS #49 shape).**
  - Mac-Mini held 41, then 45, `sshd-session: karl@ttysNN` sessions from 192.168.1.93, started from 2026-10-25 on.
  - The Maestro session measured 48 established VM→Mac-Mini:22 and 4 VM→Linux-Dev:22 connections.
  - Link to F-A unverified: MaxStartups counts only unauthenticated connections.
- **F-B — duplicate names in the New session folder list.** `powerpoint-voice` ×2, `solo-orchestrator` ×3; one folder each on disk.
- **F-C — false trust-prompt hint.** The Claude-session view shows `The new session is asking you to trust the folder — answer it in the Claude session.` when no trust prompt is on screen. It persisted after the session had answered several turns.
- **F-D — no reply box for a new session.** A brand-new session has no card, so the Cards view shows `no cards for this selection yet` and offers no reply box.
- **F-E — drawer opens off-screen.** The machine-shell drawer is `position: static` at the end of the page (y = 2989 px in a 907 px window), so with many cards Ctrl+` opens it off-screen.
- **F-F — `Open terminal ↗` goes to the wrong page.** The link is `<a href="/harness/harness">` with no target and no session, so it replaces the console with the generic Terminals page instead of that card's session.
- **F-G — stale data after sign-in expiry, with no warning.**
  - After the operator session expired the open console kept showing data from `updated 04:39:43` for ≈10.5 h (uat6-scratch still `✓ IDLE`).
  - No signed-out or UNREACHABLE banner was found in the page text.
  - A reload went to `/harness/login`.
- **F-H — keycard events are never logged.**
  - `services/control-plane/src/http/routes/keycard.ts` has no logging call.
  - The 2026-10-29 mint, both uses and the revoke left no journal line; the keycard row's timestamps and counters are the only record.
  - Journald itself is live.
  - Operator sign-in: no line seen; not traced in code.
- **Probe results** (`agent-results/adversarial-probe.md`): FAIL-1 (logged-in `HEAD /terminal/:name` → 500, no log line) and FAIL-2 (refused WebSocket upgrades hang 12–15 s on the live host), both SEV-3; notes N1–N8.
