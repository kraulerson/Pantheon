# Maestro Console fixtures

Test inputs for the Maestro Console F1 session reader (Task 5 turn splitter, Task 6 card builder).
Every fixture file here (all but this README) was scrubbed with maskSecrets on 2026-10-17: each one was written by a one-off Node
script that imports `src/console/masking.ts` and passes the whole file text through `maskSecrets`
(no secret was removed by hand; the pass masked nothing, because the excerpts and synthetic files
contain no token-shaped text). The same scripts rewrite any `/Users/<other>` path to `/Users/karl`
(none occurred) and the transcripts' Git hosting handle to `karl`.

Machine: Mac-Mini (the registered dev machine). Date: 2026-10-17. Claude Code on the machine:
2.1.302 (`claude --version`); the running sessions were on 2.1.284, 2.1.292, 2.1.301 and 2.1.302.

"Captured" means copied from a real file or a real tmux pane on Mac-Mini. "Synthetic" means written
by hand, modeled on Claude Code 2.1.302, because a real capture would have meant driving a Claude
session.

## Transcripts

Excerpts of the two pantheon-harness transcripts in `~/.claude/projects/` (sessions `6e09d39d…`
and `ba3eabda…`), chosen for structure. Only whole lines were taken, in file order; inside each line
`tool_use` inputs are cut to 140 characters, `tool_result` content and `toolUseResult` to 160,
meta and system-sourced user text to 400, thinking signatures to 16, and every other field to 300.
A cut string ends in `…[fixture: truncated]`. Lines are re-serialised with `JSON.stringify`.
In the cross-session (peer) message line, the sender's messaging socket is rewritten to
`uds:/tmp/cc-socks/0.sock`, both in `message.content` and in `origin.from`. `origin.verifiedPeerPid`
is set to 0 and `origin.hopChain[0]` is cut to 16 characters.

| File | Origin | What it exercises |
|---|---|---|
| `transcript-basic.jsonl` | captured, session 6e09d39d, 2.1.302 | Two turns (`A1`, `done`), each with tool calls and two assistant text lines; `turnUuid` is the second text line (`792879cd…`, `bd252916…`). The replies use `**TL;DR**` on its own line, without a colon. |
| `transcript-tool-result-user.jsonl` | captured, session ba3eabda, 2.1.302 | One turn whose middle `user` line carries a `tool_result` and must not start a turn; 1 tool call; `turnUuid` `548e4bfc…`; reply uses `**TL;DR:**`. |
| `transcript-meta-and-system.jsonl` | captured, session 6e09d39d, 2.1.302 | Two turns: `93e78e9f…` (human prompt `A1`, 1 tool call; the `isMeta` stop-hook feedback reply joins it; closed by the `turn_duration` line) and `e9680652…` (promptSource `system`, 0 tool calls; the reply to the task notification). Also an `isMeta` user line (stop-hook feedback), an `isMeta` + `promptSource:"system"` line (cross-session message), a `promptSource:"system"` task notification, and 4 non user/assistant lines (`mode`, `permission-mode`, `system` stop_hook_summary, `system` turn_duration). No `summary` line occurs in these transcripts. |
| `transcript-partial-tail.jsonl` | captured, session ba3eabda, 2.1.302 | Four complete lines (one finished turn, then the prompt `A1` of a turn with no reply yet), then an assistant line cut in half with no trailing newline. |
| `transcript-empty-thinking.jsonl` | captured, session ba3eabda, 2.1.302 | One turn whose `thinking` block has `"thinking": ""` (thinkingChars 0). |

## Session files

From `~/.claude/sessions/<pid>.json` (never the `.key` files), with
`jq 'del(.bridgeSessionId, .messagingSocketPath)'`. One file per Claude version running on the machine.
`sessions-2.1.302.json` is an addition beyond the brief's list (2.1.284/292/301), because 2.1.302 was
also running.

| File | Origin | What it exercises |
|---|---|---|
| `sessions-2.1.302.json` | captured, the pantheon-harness session (pid 31192) | `status: "busy"`, `tmux` field present. |
| `sessions-2.1.301.json` | captured shape, identity rewritten | `status: "waiting"` with `waitingFor: "permission prompt"`. |
| `sessions-2.1.292.json` | captured shape, identity rewritten | `status: "idle"`. |
| `sessions-2.1.284.json` | captured shape, identity rewritten | `status: "idle"`, `nameSource: "user"`; the original lacked `bridgeSessionId` (removed from all files anyway). |
| `sessions-unknown-status.json` | copy of `sessions-2.1.302.json` | `status: "hibernating"`, a value no consumer knows. |

"Identity rewritten": no pantheon-harness session ran on 2.1.284, 2.1.292 or 2.1.301, so those files
come from other projects' sessions with `cwd`, `sessionId` (synthetic `00000000-…`), `name` and `tmux`
rewritten to pantheon-harness values. The keys, version, status, pid and timestamps are as read.

## Pane captures

All captures are `tmux capture-pane -p -J -S -40` output, read-only (no keys were sent to any pane
but the scratch window). In the three captures of other projects' panes (permission x2,
AskUserQuestion), only the prompt region was kept. The lines that showed that project's content
were replaced with neutral pantheon-harness text. In the two permission captures that means the
command text and paths, the description and the agent name. In `pane-askuserquestion.txt` it means the
`⏺` reply line (line 1), the header chip ` ☐ Layout` (line 3), the question, and the option and
description texts. Each replacement keeps the line's leading whitespace and box glyph, or its lack of
one. The description line is drawn as captured: ` │ …` on the 2.1.301 capture and ` …` with no glyph
on the 2.1.292 capture. Every Claude UI line is exactly as captured: rules,
`Bash command · from the … agent`, the warning lines, the menu, the footer, `Type something.`,
`Chat about this`.

| File | Origin | What it exercises |
|---|---|---|
| `pane-trust-prompt.txt` | captured, Claude 2.1.302: `claude` started in an empty scratch directory in a new tmux window, no prompt sent; prompt region kept exactly as captured (the two lines above it, a startup warning quoting a rule from the operator's global settings, were dropped) | The real folder-trust prompt: one-space indent (` ❯ No, exit`), unnumbered options, footer ` Enter to confirm · Esc to cancel`. |
| `pane-permission-prompt.txt` | captured, Claude 2.1.301 (another project's pane, content lines replaced) | A real permission prompt raised by a background agent: ` Do you want to proceed?`, ` ❯ 1. Yes`, `   2. No`, footer ` Esc to cancel · Tab to amend · ctrl+x ctrl+k twice to stop background agents`. All one-space indented. |
| `pane-permission-while-busy.txt` | captured, Claude 2.1.292 (another project's pane, content lines replaced) | The same prompt on 2.1.292, raised by a background agent while the session runs agents (the `ctrl+x ctrl+k twice to stop background agents` footer). That session's file read `status: "waiting"`, `waitingFor: "permission prompt"` at capture time. Its warning line differs from the 2.1.301 one. |
| `pane-askuserquestion.txt` | captured, Claude 2.1.292 (another project's pane, content lines replaced) | A real AskUserQuestion menu. Unlike the permission and trust prompts it is at column 0: `❯ 1. … (Recommended)`, `  2. …`, `  3. Type something.`, `  4. Chat about this`, footer `Enter to select · ↑/↓ to navigate · Esc to cancel`. |
| `pane-cdf-render.txt` | synthetic, modeled on Claude Code 2.1.302 and the block text of the CDF approval hook | Negative: the CDF approval render ("Reply with the option id again"); must not count as a menu. |
| `pane-bare-prompt.txt` | synthetic, modeled on the input box seen on Claude Code 2.1.302 | Negative: an empty `❯ ` input line at column 0 between two rules. |
| `pane-quoted-menu-in-fence.txt` | synthetic, modeled on Claude Code 2.1.302 | Negative: the user pasted copies of all three real menus (permission, AskUserQuestion, trust) between ``` fence lines, with their real indentation. Indentation cannot tell them from a live menu, only the fence can; must not count. |

Indentation as observed on 2026-10-17: the permission prompt (2.1.292 and 2.1.301) and the trust
prompt (2.1.302) are drawn one column in, while the AskUserQuestion menu (2.1.292) starts at
column 0. The plan's column-0 anchors `❯ 1. `, `Do you want to proceed?` and
`Esc to cancel · Tab to amend` (as a whole line) therefore do not match the real permission prompt.

`1 to review · 2 to send · 0 to dismiss` is asserted by the plan and the spec but was never seen
on screen. It is unverified, and no fixture contains it.

The plain permission footer ` Esc to cancel · Tab to amend` (without the
` · ctrl+x ctrl+k twice to stop background agents` tail) is also plan-asserted and unverified.
Both permission captures carry the tail, so a footer anchor must accept the line with and without it.

## Sentinels

| File | Origin | What it exercises |
|---|---|---|
| `sentinel-schema2.json` | synthetic | Schema 2: `options[]` objects with `id`, `text`, `approves` (`commit` / `none`). |
| `sentinel-v1.json` | synthetic | The older shape: `options` are strings (`"A1: …"`), no `schema` key. |
