# Maestro Console — design spec (Track 1, pantheon-harness)

- **Status:** APPROVED by Karl 2026-10-16 (Track 1, v2 — after the single adversarial review and his rulings R1–R6; relayed by the Maestro session and confirmed in the pantheon-harness window). Governance: ADR-0010, PRODUCT_MANIFESTO §5 amendment 2026-10-16, APPROVAL_LOG rows 2026-10-16, PROJECT_BIBLE §3/§4. Nothing is built until Karl approves the Track 1 implementation plan.
- **Date:** 2026-10-16 · **Drafted by:** Maestro session · **To be committed by:** the pantheon-harness session (D16 — one writer per repo).
- **Decision record:** D1–D16, S3, R1–R6 — each stored in Qdrant `dev-memory` (project `pantheon-harness`, session `2026-10-16-maestro-console-brainstorm`). Mockups: `layout-v2.html`, `machines.html` (brainstorm companion, Maestro scratchpad).
- **Companion spec:** `2026-10-16-karl-workflow-hooks-design.md` (Track 2).
- **Amended 2026-10-17:** §14. It adds two F2 additions approved after F1 planning, and notes that
  F1's state colours replace §6.2's (ADR-0010 follow-up).

## 1. Intent

Karl runs 3–6 Claude Code sessions at once (up to 18), one tmux session per project, across more than one dev machine, and coordinates them through a Maestro session in a terminal. That does not fit his work style: he loses track across projects, misses items that wait on him, and reads detail-free TL;DRs when deciding.

**Outcome:** one page inside the Pantheon harness where he sees every session on every machine, finds what needs him, reads the full detail behind any summary, and answers — without opening terminals unless he wants to.

**Success criteria**
1. Every Claude session in tmux on every registered machine appears without setup; nothing that waits on Karl can scroll out of sight.
2. A decision asked **in a reply** can be read in full and answered from the page (desktop or phone) in under a minute, with nothing sent until Submit. **Terminal menus** (permission, trust, `AskUserQuestion`) are shown with their options but answered in the terminal in v1 (R5).
3. A session blocked on input is shown as needing Karl within ~5 s, without the session reporting it.
4. Reminders repeat until answered or dismissed (Karl's June rule: one notification gets missed).
5. The VM keeps no bulk copy of session content (R1); every Submit is recorded, append-only (R6).
6. Failures are visible, never shown as "all quiet".

**Inputs:** Karl's 2026-10-16 workflow review (7,288 prompts / 216 sessions; habits fail, mechanisms hold; accommodations: visual separation between projects, colourblind, low-contrast headaches, losing track, lettered decisions); Pantheon's current state (live build `8cd3ce5`, machines sidebar, terminal tabs, approvals inbox, keycard door).

## 2. Scope

**In v1 (F1–F5, §11):** session reader, cards, machine + project tabs, state, expand-on-demand full text / why / what it did, reply box + Submit (step-up) + answer buttons for reply-borne decisions, Submit audit log, read-only menu cards with "Open terminal", in-page banner, Telegram reminders, suggestions + tag-filtered cheat sheet, "Ask Maestro" + "Check this", phone decision view, settings file.

**Not in v1:** answering terminal menus from the page (R5; a later compare-and-select feature); cross-card search; full phone layout; model-picked suggestions (D6); automatic Maestro checks (D15); per-session push hooks (D9); any LibreChat change; the chat-pane pivot (parked, §12); the TP-4 task board (stays planned; complemented, not replaced — R3).

**Separate track:** past-mistakes check and Claude-runs-own-skills hooks → karl-workflow plugin (D4, D6, D13; companion spec).

## 3. Decisions this spec implements

| # | Decision (Karl, 2026-10-16) |
|---|---|
| D1 | New tab inside pantheon-harness (not a separate app). UAT-5 closes first. |
| D2 | Default view = status cards; every card expands in place to the full message. |
| D3 | "Thinking history" = **why** (reasoning prose + any saved thinking snippets) + **what it did** (tool calls). True thinking replay not offered. Learning → Qdrant (Track 2). |
| D4 | Past-mistakes check = Track 2; console shows "memory checked: N apply" on cards. |
| D5 | Reply box + answer buttons; terminal optional. Commit approvals are **never a button**. (Narrowed by R5.) |
| D6 | Fixed event→skill suggestions + always-visible cheat sheet; Claude-run skills in Track 2. |
| D7 | Layout A: tabs across the top; left panel "Suggested now" ↔ "Suggested for ‹project›"; state colours; reply box + Submit; "Open ‹project› terminal ↗". |
| D8 | Cheat-sheet filtering via one settings file (skill → areas, project → areas); untagged shown everywhere, labelled. |
| D9 | Pantheon pulls transcripts + pane state over its existing SSH access; secrets masked at ingest. |
| D10 | Telegram "Needs you" topic, dedicated bot; first after 15 min, every 4 h, quiet 20:00–07:00 America/Denver. |
| D11 | Phone v1 = decision view only. |
| D12 | Projects auto-discovered from tmux; settings give name/glyph/border/areas/hidden; non-tmux sessions listed "not reachable". **Two tab rows: machines, then that machine's projects**; machines from the DevMachine registry. |
| D13 | Track 2 hooks in the karl-workflow plugin. |
| D14 | Submit refused while a menu shows; masking with no unmask; cards 90 days; no search; 5 s poll; banner every 30 min. |
| D15 | Maestro on request: "Ask Maestro" + "Check this"; answer attached as a card note. |
| D16 | Two tracks in parallel; F1 read-only first. |
| S3 | Telegram carries no card text. |
| **R1** | **Store only the card face** (masked TL;DR + pointers). Full text / why / what it did are **fetched live over SSH on expand** — no durable bulk copy (satisfies APPROVAL_LOG A-1 / TP-7). |
| **R2** | Karl's typed Submit = operator I/O (Bible C.6). "Check this" / "Ask Maestro" are inbound relays: **fixed string through the ADR-0009 dispatcher** (XC-6 allowlist + rate cap + negative test). |
| **R3** | Console **complements** the TP-4 task board; TP-4 stays planned. |
| **R4** | **Submit requires the operator passphrase again**, opening a 15-minute elevated window (D6 step-up). |
| **R5** | **Terminal menus are shown read-only** with options + "Open terminal"; not answered from the page in v1. |
| **R6** | **Submit audit rows are append-only and never deleted** (Bible D8) — supersedes S3's 1-year purge. |

## 4. Verified facts (2026-10-16)

| Fact | Evidence |
|---|---|
| Each running Claude Code process writes `~/.claude/sessions/<pid>.json` with `pid`, `sessionId`, `cwd`, `name`, `status`, `waitingFor`, `tmux` (`"<session>:@<win>.%<pane>"`), `procStart`, `version`, `kind`. Observed `status` values: `busy`, `idle`, `waiting`, `shell`. | `jq` on `99953.json` (`status:"shell"`, `tmux:"cdf:@3.%3"`, `version:"2.1.292"`); review saw `status:"waiting"`, `waitingFor:"input needed"`. **Undocumented — may change on update (§9).** Directory also holds `<pid>.<hex>.key` files: never read. |
| Transcript = `~/.claude/projects/<cwd with non-alphanumerics → "-">/<sessionId>.jsonl`; locate by `sessionId`, not by path rule. | `…-lancache-orchestrator` for cwd `lancache_orchestrator` (`_` → `-`). |
| Pane → Claude: usually the pane process is a shell whose child is Claude; sometimes the pane process is Claude. `pane_current_command` shows the version (e.g. `2.1.292`), never `claude`. | `ps -ax -o pid=,ppid=` chains for cdf/homelab/solo/lancache/Maestro; pantheon `pane_pid == claude pid`. |
| Four Claude versions run at once (2.1.284 / .292 / .293 / .301); fields differ by version. | review, `4111.json` lacks `bridgeSessionId`. |
| Thinking text barely stored. | lancache 42 non-empty / 218 empty, max 357 chars. |
| Subagent transcripts: `<sessionId>/subagents/agent-*.jsonl`. | review. |
| SSH layer: one connection per command, always closed; 64 KiB output cap; 10 s default. | `devmachine/connection.ts:110,230,241`. |
| CDF approval = **two exchanges** (render, then confirm); sentinel schema 2 `options[].{id,text,approves}`, `approves == "commit"` marks a commit approval; v1 sentinels (`options: ["A1: …"]`) are refused by CDF 4.4.5 until rewritten. | `record-approval.sh:7-12`, `_helpers.sh:217-223`. |
| Pantheon is reachable only on the LAN / NetBird (internal DNS). | `dig +short pantheon.ferrumcorde.com` → `10.100.23.52`; public DNS empty. |
| Machines registered: `Mac-Mini`, `Linux-Dev`. | UAT-5 run 3. |

## 5. Architecture

Inside the existing control-plane service (ADR-0002: Node/TypeScript/Fastify; server-rendered pages + plain browser JS), SQLite tables per **ruling A** (additive DDL), behind the operator sign-in. **Nothing installed on dev machines.**

| Component | Purpose | Reuses |
|---|---|---|
| **Machine probe** | **One allow-listed remote script per machine per poll** (new branded command builder beside `tmux.ts`). Bound as built (F1, amended 2026-10-17): at most 4 SSH dials per machine per tick, 1 main probe plus up to 3 catch-up probes. An oversize retry counts as a catch-up, not an extra. Typically 1 per tick, and each probe's output cap stays 2 MiB. Emits a sentinel-framed report: tmux panes; each `sessions/<pid>.json` (allow-listed fields only); per session the transcript bytes after the stored offset (capped per file, catch-up loop when capped); `capture-pane -p -J` tail per Claude pane; existence + content of `<cwd>/.claude/pending-approval.json`. Per-call cap raised to 2 MiB for this builder only. | DevMachine registry, SSH custody (Features 1–2). |
| **Card builder** | Parses the report: turns → card faces (§6.4), state (§6.2), needs-you (§6.3). Masks before anything is stored. Partial trailing JSONL lines wait for the next poll. | — |
| **On-demand reader** (R1) | On expand: one SSH call that reads the turn's lines by offset from the transcript, masks, renders full text / why / what it did; nothing persisted. | Same builder. |
| **Console store** | Card faces + pointers, sessions, reminders, submit log (§7). | Ruling A. |
| **Console page** | Two tab rows, left panel, cards, decision view (phone). | Harness shell, theme, build stamp, `no-store`, versioned assets. |
| **Send path** (F2) | Step-up check (R4) → one remote delivery script with target + menu checks (§6.6) → append-only audit. | SSH custody; existing Sec-Fetch-Site refusal. |
| **Reminder sender** (F3) | Banner + Telegram. | Bot key via file custody. |
| **Suggestions** (F4) | Event→skill rules; skill catalogue gathered by the probe; tag filtering. | Settings. |
| **Maestro bridge** (F5) | Fixed-string relay via the ADR-0009 dispatcher; Maestro's tagged reply → card note. | Waker dispatcher (XC-6). |
| **Settings** | Projects, skill tags, areas, reminder timing (§7). Malformed → **the console module disables itself with a banner naming the entry; terminals, approvals and the rest of the harness keep running.** Justified in the console ADR against PRODUCT_MANIFESTO M15/D10. | — |

## 6. Behaviour

### 6.1 Discovery and tabs
- Machines = enabled DevMachines. Top row: **◎ All machines** + one tab per machine. A machine tab shows its **worst** project state (NEEDS YOU > WORKING > IDLE) plus per-state counts, e.g. `! 3 NEED YOU · ⟳ 1`.
- Projects = Claude sessions found via `sessions/*.json` whose `tmux` field (fallback: pane process chain) names a pane on that machine. Second row = selected machine's projects. Project key = tmux session name. A project on two machines appears under each.
- Unconfigured sessions appear as **"new — not set up"**; settings may mark one `hidden`.
- Claude processes with no tmux pane are listed under **"not reachable — start it in tmux"**: read-only cards, reply box disabled, project key = `<cwd basename>@<machine>`.

### 6.2 Tab state (colour + symbol + word, never colour alone)
| State | Shown as | Rule |
|---|---|---|
| NEEDS YOU | red top edge · `!` · "NEEDS YOU" | `status == "waiting"` (reason = `waitingFor`), or any open item from §6.3 |
| WORKING | yellow top edge · `⟳` · "WORKING" | `status == "busy"` |
| IDLE | blue top edge · `✓` · "IDLE" | `status == "idle"` |
| SHELL | `$` · "IN SHELL" | `status == "shell"` (reply box disabled) |
| UNKNOWN | `?` · "UNKNOWN STATUS ‹value›" | any other `status` value — shown, never mapped to IDLE |
| UNREACHABLE / CAN'T READ / ENDED | `✕` / `⚠` / `○` + words | §9 |

### 6.3 Needs-you signals
0. **`status == "waiting"`** in `sessions/<pid>.json` (covers `AskUserQuestion`, elicitation and dialogs).
1. **Menu on screen while `busy`** (prompts raised by background agents leave `status` busy) — pane tail matches a captured fixture. Fixtures anchor on real menu strings: `❯ 1. `, `Enter to select · ↑/↓ to navigate · Esc to cancel`, `Do you want to proceed?`, `Esc to cancel · Tab to amend`, `1 to review · 2 to send · 0 to dismiss`. The bare `❯` prompt glyph and the CDF render text ("Reply with the option id again … to confirm") must **not** match.
2. **Pending-approval sentinel** present.
3. **Reply-borne question** (O1, **fixed 2026-10-18, Karl A1**, from 654 reply turns across 39 transcripts / 15 projects + 500 console card faces; evidence in the F1 ledger "O1 SURVEY"): the card NEEDS YOU when the reply's TL;DR block contains a "waiting on you" / "waiting on Karl" clause whose following words do not start with *nothing*, *none*, *no*, *not*, *only your* or *your usual*; a reply with no TL;DR marker is scanned whole. The TL;DR block is the paragraph after the last marker, where the marker accepts `**TL;DR**`, `**TL;DR:**`, an optional parenthetical before the closing bold (`**TL;DR (plain English):**`) and an unbolded or heading-style `TL;DR` at line start (F2 widens F1's marker, which 132 of 654 replies — 20.2 % — did not match). Answer buttons come from two or more **lettered** option lines (`A1`/`A2`, `Option A`/`B`, `(A)`/`(B)`); numbered lists never count. A sentinel for the session wins (signal 2). Measured: recall 0.64 against Karl's option-id answers, 0.80 with option lines, every miss a sentinel question; hand-labelled precision 23 of 30 (3 false: lettered lines quoting another session's options, a numbered completion list). A trailing `?` is not a signal (recall 0). Accepted false positives: quoted lettered options; a "waiting on you" that names an action rather than a question (that is needs-you by this console's definition).

Leaving the queue: signal 0/1/2 items leave only when the signal disappears (a sentinel only when its file is deleted — never on Submit). Signal-3 items leave on Submit or **Dismiss**. Dismiss on a signal 0/1/2 item marks it "dismissed" but keeps it listed while the signal persists.

### 6.4 Cards
- **Turn** = from a `user` line that is not `isMeta`, whose content is text (not `tool_result`) and whose `promptSource` ≠ `system`, to the last assistant `text` block before the next such line. `turn_uuid` = that final assistant line's `uuid`. One card per turn.
- **Card face** (stored, masked): kind, title, the reply's TL;DR block (fallback: first 280 chars), age, "reminded N×", "memory checked: N apply" (from the turn's `hook_additional_context` attachment / `hookAdditionalContext`, written by Track 2).
- **Expand (fetched on demand, R1):** ▸ full text (sanitised Markdown) · ▸ why (reasoning prose + non-empty thinking) · ▸ what it did (the parent transcript's tool calls, masked, outputs truncated; subagent work shown as "N agent runs (not expanded)").
- **Menu cards** (signals 0–1, R5): options shown read-only + **"Open ‹project› terminal ↗"**; no Submit.
- **Sentinel cards** (signal 2): parse schema 2; `kind = COMMIT APPROVAL` when any option has `approves == "commit"`; v1 sentinels shown "cannot be answered until the session rewrites it as schema 2". Buttons send **only the option id**. Commit approvals: no buttons (D5) — Karl types the id; after the first Submit the card shows the masked pane tail (CDF's render: question, staged change, hooks) and the next step "type ‹id› again to confirm".
- **Reply-borne decision cards** (signal 3): option lines that parse cleanly (`Option A – …`) become buttons that **copy the literal letter into the reply box** for Karl to read; nothing hidden is sent.
- Every reachable card: reply box (≤ 4 KiB) + **Submit**; Enter adds a newline; "Open ‹project› terminal ↗ (Pantheon)".

**Note 2026-10-20 (§6.4, commit-approval screen built as Task 12).** The plan omitted the commit approval's second step (whole-branch review I-3); Karl ruled "Build it" and it is plan Task 12. `GET /console/api/cards/:id/pane` returns the session's screen for a `commit_approval` card: masked, the last 60 lines and at most 8 KiB, behind the operator guard with no step-up (read-only, never stored, the expand posture). After the first id is sent the card opens the view and says "… ‹id› sent, HH:MM — reading the session's screen" until the read succeeds, then "Check the staged change above, then type ‹id› again and press Submit to confirm"; the box is not prefilled (D5). The view reads again about two seconds later (CDF draws its render after the hooks finish), and bidi formatting characters are shown as `⟦U+XXXX⟧`. When the screen is not shown (Hide, or a failed or empty read) the card says it "is not shown here" and points to the Claude session.

### 6.5 Left panel
"Suggested now" (All) / "Suggested for ‹glyph› ‹project›"; fixed event→skill rules (PR opened → `/merge-gate`; session ending → `/handoff`; credential needed → `/secret-intake`; deleting → `/change-card`). Cheat sheet below: skills whose areas intersect the tab's (All = fleet-sessions + general); project-local skills only on their tab; untagged everywhere, labelled; proposed-but-missing skills labelled "not installed".

### 6.6 Send path (F2)
1. **Step-up (R4):** Submit requires an elevated window (operator passphrase re-entered; 15 min). Without it the page asks for the passphrase first.
2. **Validation (server):** refuse — never strip — C0/C1 controls other than `\n`/`\t`, any ESC, invalid UTF-8, > 4 KiB. Idempotency key per Submit; a replayed key returns the stored outcome.
3. **Write-ahead audit row** `attempted` (§7).
4. **One remote delivery script** (allow-listed builder), atomically from the console's view:
   a. re-read `sessions/<pid>.json`; refuse `target_changed` unless the file exists, `sessionId` and `procStart` (compared as epoch seconds — JSON is UTC, `ps` is local time) equal the card's, and `kill -0 <pid>` succeeds;
   b. verify the pane's process chain still contains that pid;
   c. refuse `menu_visible` unless `status ∈ {idle, busy}` and the `capture-pane -p -J` tail matches no menu fixture;
   d. deliver as **one bracketed paste**: the text travels base64-encoded (`printf %s '<b64>' | base64 -d | tmux load-buffer -b console-<id> -`, then `tmux paste-buffer -p -d -b console-<id> -t <pane>`), then `tmux send-keys -t <pane> Enter`;
   e. re-capture after ~500 ms; return the tail hash.
5. **Result audit row** appended (`sent` / `refused_target_changed` / `refused_menu_visible` / `failed`), never an update. On refusal or failure the text stays in the box.
6. Card shows "answered by you, HH:MM" (signal-3 items) or "sent — waiting for the session" (sentinels); a send while `busy` shows "queued" (Claude Code queues typed input).

**Residual (threat model):** a sub-second race between step 4c and 4d remains; prompts raised by background agents are not reflected in `status`.

**Note 2026-10-20 (§6.6.4a, as built in F2).** Step 4a compares `procStart` as the **raw stored string**, byte for byte, not as epoch seconds. The poller stores the value masked, so ruling T6-0 pins that the mask leaves ISO-8601 timestamps (several shapes, fractional seconds and `Z`) unchanged, and the poller's own pid-reuse comparison is masked-versus-masked (ruling T10-4). Recorded deviation; the script refuses `target_changed` on any difference. Also as built: step 4c refuses a pane in tmux copy mode (`refused_menu_visible`, detail "pane in copy mode"), the buffer name is fresh per Submit, and a command that was requested but cannot be confirmed is recorded `unconfirmed` (rulings T11-11, T11-18).

### 6.7 Reminders (F3)
- **Page:** banner every 30 min while anything waits; tab title count.
- **Telegram:** topic "Needs you" in "Homelab Alerts", created by Karl (its `message_thread_id` is a setting); **dedicated bot**, key provisioned by the deploy script into the same file-custody class as the SSH key, rotation added to `docs/token-rotation-runbook.md`. Post = `<kind> · <project> · card <id>` + link — **no card text** (S3) — with link previews disabled. The link works only while the phone is on NetBird or the home network; the post says so.
- **Timing:** first post when an item has been NEEDS YOU for 15 min (from first seen); repeat every 4 h; posts falling in 20:00–07:00 America/Denver are deferred and sent at 07:00 as one digest, and the 4 h clock restarts then.
- **Failure:** page banner "Telegram reminders failing since …"; Kuma push monitor on the sender.

### 6.8 Maestro bridge (F5, R2)
- "Check this" sends the fixed string `check card <id>` (`id` matches `^[0-9a-f-]{8,36}$`); "Ask Maestro" sends Karl's typed text (same validation and step-up as Submit). Both go through the **ADR-0009 dispatcher** with an allowlist pair console→Maestro and a rate cap; negative test: dispatch refused when the allowlist is empty.
- Maestro reads the card itself and answers with `[card <id>]`; the card builder attaches that reply as a **Maestro note**.
- Failure states: Maestro pane absent or ended → buttons disabled with the reason; no tagged reply → "check requested HH:MM — no answer yet".

### 6.9 Phone (F5)
Decision view only: the Needs-you queue and one card at a time with expand, buttons, reply box and Submit (step-up applies). Menu cards show "answer in the terminal".

## 7. Data (SQLite, additive DDL per ruling A; all rows carry `version`, `createdAt`, `updatedAt`)

| Table | Key fields |
|---|---|
| `console_session` | machine, tmux_session, pane_id, claude_pid, session_id, proc_start, cwd, project_key, status, waiting_for, state, state_reason, transcript_offset, last_seen_at |
| `console_card` | id, machine, project_key, session_id, turn_uuid (unique), transcript_offset_start/end, created_at, kind, title, tldr_masked, needs_you, needs_kind, options_json (ids/letters only), answered_at, dismissed_at, maestro_note, purge_after (90 d) |
| `console_submit_log` | id, at, idempotency_key, row_kind (`attempted` / result), outcome, reason, machine, tmux_session, pane_id, claude_pid, session_id, proc_start, status_at_send, card_id, text_masked, pane_tail_hash — **append-only, never deleted (R6)** |
| `console_reminder` | card_id, first_seen_needs_you_at, first_sent_at, last_sent_at, count |

No full text, reasoning or tool output is stored (R1). Size: card faces only (≤ 1 KiB each).

**Settings file** (on VM 1093, path per Pantheon convention; schema-validated at start):
```json
{
  "pollSeconds": 5,
  "retention": { "cardsDays": 90 },
  "reminders": { "firstAfterMin": 15, "everyHours": 4, "quiet": "20:00-07:00", "tz": "America/Denver", "bannerEveryMin": 30, "telegramThreadId": null },
  "areas": ["gate-safety","delivery","homelab-ops","fleet-sessions","memory-hygiene","learning-recovery","general"],
  "projects": {
    "lancache": { "display": "lancache", "glyph": "⬢", "border": "solid",  "areas": ["gate-safety","delivery","homelab-ops","general"] },
    "solo":     { "display": "solo",     "glyph": "▲", "border": "dashed", "areas": ["gate-safety","delivery","general"] },
    "cdf":      { "display": "cdf",      "glyph": "●", "border": "double", "areas": ["gate-safety","delivery","general"] },
    "homelab":  { "display": "homelab",  "glyph": "■", "border": "dotted", "areas": ["homelab-ops","general"] },
    "pantheon": { "display": "pantheon", "glyph": "◆", "border": "thick-left", "areas": ["gate-safety","delivery","general"] },
    "Dogfood":  { "hidden": true }
  },
  "allTabAreas": ["fleet-sessions","general"],
  "skills": { "handoff": ["general"], "change-card": ["general"], "add-service": ["homelab-ops"], "merge-gate": ["gate-safety"] }
}
```

## 8. Security

1. Console routes are operator-session only; keycards cannot reach them; no new keycard scope (TM-011).
2. **Submit is tier-3 privileged** (R4): step-up window; Sec-Fetch-Site refusal; idempotency; exact target verified on the machine (§6.6 4a–c); base64 transport + bracketed paste; refused (not stripped) control bytes; ≤ 4 KiB; append-only audit.
3. **Card content is untrusted** (a session may have read hostile content): rendered as escaped text / sanitised Markdown; no raw HTML; links show their target. **Nothing a session wrote is ever sent back into a session**: buttons send only option ids or copy a letter into the visible reply box; "Check this" sends a fixed string (TM-020).
4. **Masking** applies to every string before storage, display and Telegram: mask the decoded JSON strings, complete lines only. Patterns: NetBird `nbp_…`; GitHub `ghp_/gho_/ghs_/github_pat_…`; Cloudflare API tokens; Pantheon keycards `pk1_` + 64 hex; Anthropic `sk-ant-…`; AWS keys; private-key blocks; `Bearer …`; Telegram bot tokens `\d{8,10}:[A-Za-z0-9_-]{35}`; JWTs `eyJ…`; Proxmox `PVEAPIToken=`; Tailscale/Headscale `tskey-`; Gitea 40-hex in token contexts; URL credentials `://user:pass@`; `.env`-style `KEY=value` for secret-named keys; high-entropy strings ≥ 32 chars in `key|token|secret|password` contexts. The probe reads only allow-listed `sessions/*.json` fields and never `*.key` files, `bridgeSessionId` or `messagingSocketPath`. **Residual:** an unrecognised format can be missed; because only masked card faces are stored (R1), a miss is limited to the face and the live expand view.
5. Inbound relays (Check this / Ask Maestro) pass the XC-6 dispatcher (R2).
6. Telegram: no card text; bot key in file custody.

## 9. Failure handling (fail visible)

| Failure | Shown as | Behaviour |
|---|---|---|
| Machine unreachable / probe timeout | machine tab `✕ UNREACHABLE since HH:MM` | cards kept; retry next poll |
| A complete line is not JSON, or a `user`/`assistant` line lacks `uuid`, `timestamp` or `message`; or `sessions/*.json` lacks `pid`/`sessionId`/`status` | tab `⚠ CAN'T READ — format changed` | other line types are counted and ignored; the count is shown on the tab |
| Unknown `status` value | `? UNKNOWN STATUS ‹value›` | never mapped to IDLE |
| Session ended | `○ ENDED`; "ended" list after 12 h (proposed default) | cards kept to retention |
| Target changed at Submit | "The session this card came from has ended or was cleared" | audit `refused_target_changed` |
| Menu visible at Submit | "This session is showing a prompt — open its terminal" | audit `refused_menu_visible` |
| Send failed | error on the card; text kept | audit `failed` |
| Expand fetch fails | "Can't load the full text now — machine unreachable" | face stays |
| Telegram down | page banner | Kuma push monitor alerts |
| Settings invalid | console module disabled with a banner naming the entry | rest of the harness unaffected |

## 10. Testing

Pantheon Build Loop per feature (tests first, RED verified; implement; security audit; docs; `--record-feature`), UAT every 2 features, one adversarial review per PR at max effort.

- **F1:** real (masked) transcript fixtures: turn boundaries per §6.4 (multiple assistant lines per message id, `tool_result` user lines, `isMeta`, `promptSource: system`), TL;DR extraction, empty thinking, unknown line types counted not failed, partial trailing lines; `sessions/*.json` fixtures from each observed Claude version, every `status` value incl. unknown; pane fixtures: trust prompt, permission prompt (incl. background-agent prompt while busy), `AskUserQuestion` menu, CDF render (must NOT match), bare `❯` prompt (must NOT match); masking against every §8.4 pattern with mutation tests; probe budget, amended 2026-10-17 to the implemented bound: at most 4 SSH dials per machine per tick, 1 main probe plus up to 3 catch-up probes. An oversize retry counts as a catch-up, not an extra. Typically 1 per tick, with a 2 MiB output cap per probe. Also: catch-up when capped; on-demand expand stores nothing; failure states §9.
- **F2:** hostile input refused or delivered as plain text: `$(…)`, backticks, `;`, `|`, quotes, tmux key names, ESC, Ctrl-C/Ctrl-D bytes, leading `!`, `/`, `#`, `@` (prove what Claude Code does with each when pasted); multi-line arrives as one message and Enter is not swallowed; `target_changed` (pid gone, `sessionId` changed by `/clear`, `procStart` differs, pane now a shell); `menu_visible`; write-ahead + result rows, never updated; idempotent replay; step-up required and expiring; cross-site POST refused; commit-approval two-step flow end to end against CDF 4.4.5 in a test project.
- **F3:** deferral + 07:00 digest; 15 min from first seen; DST (2026-11-01); no card text in payload; link previews disabled; failure banner; Kuma monitor.
- **F4:** tag filtering; untagged visible; project-local skills only on their tab; "not installed".
- **F5:** fixed-string relay via dispatcher; allowlist-empty negative test; tagged reply → note; Maestro-absent and no-answer states; phone view.
- **After every deploy:** `curl -sI https://pantheon.ferrumcorde.com/harness/assets/harness.css | grep -i x-pantheon-build` matches the commit.

## 11. Build order (Track 1)

| Step | Feature | Acts on sessions? | Exit |
|---|---|---|---|
| F1 | Machine probe + card builder + store + tabs + cards with on-demand expand + state + settings | **No — read-only** | tests green; deployed; read-only real-use period ≥ 3 days (proposed; section 4 said "a few days"); O1 rule fixed from that data and approved by Karl. **Exit met 2026-10-18:** Karl approved F1 at trial day 1 ("good for the features that have been implemented") and the O1 rule (A1); trial findings 1–6 recorded (0 code defects). |
| F2 | Step-up + reply box + Submit + buttons + delivery script + audit + read-only menu cards + Open terminal | Yes | tests green |
| UAT | session 6 | | gate passed |
| F3 | Banner + Telegram | No | tests green |
| F4 | Suggestions + cheat sheet | No | tests green |
| UAT | session 7 | | gate passed |
| F5 | Ask Maestro + Check this (dispatcher) + phone view | Yes (Maestro) | tests green |
| UAT | session 8 | | gate passed |

## 12. Prerequisites and governance (pantheon-harness)

1. UAT-5 closed; BUGS #48 fix deployed and hand-tested (in progress 2026-10-16).
2. Pantheon framework synced from CDF 4.2.5 to 4.4.5 (approved; after the #48 deploy).
3. Chat-pane pivot formally parked (Bible + APPROVAL_LOG).
4. Governance entries, in the same change as the spec commit: PRODUCT_MANIFESTO cutline (the console as new MVP scope; TP-4 kept and complemented — R3); a console ADR (number assigned by the Pantheon session) covering R1–R6 and the settings-file choice; APPROVAL_LOG entries for R1 (A-1 satisfied by not storing content), R2 (Submit = C.6 operator I/O; relays under XC-6), R4 (Submit added to BUGS #36's step-up route list; D6 step-up implemented for Submit first), R6 (D8 append-only kept); threat-model entries for the send path, the probe and Telegram.
5. After F1 proves the feed, the "send your TL;DR to @Maestro" lines in CLAUDE.md files become redundant (D15); removing them is Karl's call.

## 13. Open items

| # | Item | When resolved |
|---|---|---|
| O1 | ~~Rule for reply-borne questions (§6.3 signal 3)~~ — closed 2026-10-18: rule and evidence in §6.3 signal 3 (Karl A1); the widened TL;DR marker ships with F2 | — |
| O3 | ~~Delivery mechanism~~ — closed: base64 + bracketed paste (§6.6) | — |
| O4 | Which suggested skills exist yet (`/merge-gate`, `/secret-intake` are proposals) | F4; missing → "not installed" |
| O5 | `sessions/*.json` is undocumented | permanent residual; covered by CAN'T READ / UNKNOWN STATUS |
| O6 | Optional sturdier signal: a Track 2 `Notification` hook (`permission_prompt`, `idle_prompt`, `elicitation_dialog`, `agent_needs_input`) writing a state file the probe reads (pull, consistent with D9) | after F1 data, if pane fixtures prove brittle |
| O7 | Answering terminal menus from the page (compare-and-select protocol) | post-v1, separate design (R5) |

## 14. Additions approved after F1 planning (2026-10-17)

These were relayed by the Maestro session and approved by Karl. They go into the F2 plan; F1 does
not build them. The source notes are
`.superpowers/sdd/2026-10-16-maestro-console-f1/f2-new-session-flow-maestro-2026-10-17.md`.

**Note — state colours (§6.2).** F1 shipped with needs-you orange (solid edge), working grey (dashed)
and idle blue (solid), always with glyph + word, replacing the red / yellow / blue in §6.2. See the
ADR-0010 follow-up 2026-10-17.

### 14.1 F2 addition 1 — new-session flow (Karl approved: "new-session flow: yes in F2, empty folder")

Why: the harness "+ New Session" opens only a shell, so Karl has to cd and start claude by hand.

Flow, inside the console:
1. "+ New session" on the machine row → pick a machine (DevMachine registry).
2. The console lists that machine's projects: every folder under the machine's projects root, plus one level deeper where a folder contains a git repo (Mac example: Pantheon/pantheon-harness); projects with a running Claude session show "running — open it" instead of starting a duplicate; hidden sessions from settings are excluded.
3. Pick a project → create a tmux session named after the folder (sanitise to tmux-legal; suffix -2 on collision), with -c set to that folder, running claude. Insert the tab immediately; don't wait for the 5 s poll.
4. "New project" → name (letters, digits, space, - _ . only; no slash, no leading dot; the resolved path must stay inside the root) → mkdir an EMPTY folder (no git init) → same tmux + claude.

Settings: a per-machine projectsRoot. Mac-Mini "/Users/karl/Documents/Claude Projects" (32 folders; nested projects exist). Linux-Dev "/development/Claude Projects" (verified 2026-10-17, 6 projects). Both contain a space. A rename to Claude_Projects is planned after F1 ships, so the roots must come from settings, never code.

Safety, same rules as Submit: R4 step-up; one allow-listed remote script; names travel base64, never shell-interpolated; append-only audit row (created_session / created_project + refusals). A brand-new folder triggers Claude Code's "trust this folder" prompt; it must surface as a read-only menu card (R5) with Open terminal; never auto-answer it. Unverified: whether the existing harness dialog's "Claude CLI (terminal)" path can be reused (it opens only a shell).

**Note 2026-10-20 (§14.1.4, as built).** The name rule for "New project" is `PROJECT_NAME_RE`, the letter of the text above, so it admits a **trailing space or dot** (`"a "`, `"a."`). Plan-mandated and recorded as a residual, not corrected. Also as built: the one admissibility rule for an existing folder (resolved under the root, no dot-segment below it, `remoteDirProblem` clean including no `#`, basename matches `PROJECT_NAME_RE`) is shared by the project list and the create route, so parent folders are not held to the name rule; a tmux name that would start with `sh-` (the machine-shell namespace) is rewritten `p-sh-…`; `has-session` runs before `mkdir`.

*Settings impact:* the console settings file (§7) needs per-machine entries (`projectsRoot`). F1's
settings schema accepts unknown top-level keys, so the F2 key can be added without breaking an F1 file.

### 14.2 Decision 18 (revised 2026-10-17) — machine shell drawer (Karl: "drawer settled — send it to Pantheon for F2")

This replaces the earlier drawer text (one terminal per session), which was held on 2026-10-17 and is
not to be planned from. Mock: artifact `GuCSoGZ1KqdmZM7rKT3Pnj` v2 (source copied to
`console-drawer-mock.html` in the F1 workspace).

1. ONE shared shell per machine: plain shell, tmux session `sh-<machine>`, started in that machine's projectsRoot; the SAME shell (cwd and history) whichever project tab on that machine is selected; each machine has its own shell, intact when switching back; sh-* excluded from project discovery, never shown as project tabs.
2. Drawer pinned to the bottom of the console: minimise/restore via the bar button, Ctrl+`, and Esc from inside the shell; minimised = slim bar "Shell · <machine>" + current folder; resizable by dragging the top edge plus ArrowUp/ArrowDown on the focused grip; height remembered per viewer (Karl tested 241 px).
3. Each project tab has a view switch "Cards" | "Claude session": the latter is Pantheon's existing LIVE interactive terminal (xterm over SSH→PTY→WebSocket broker, BUGS #48 clipboard fix) attached to that project's tmux session, filling the main area, full read/write like the Terminals tab; the machine shell drawer stays available beneath both views.
4. Card buttons "Open Claude session" (incl. menu cards, R5) switch to that view in place; nothing navigates to another browser tab; R5 menus are answered in the Claude session view on the same page.
5. Access = today's Terminals tab (operator sign-in, no extra step-up: Karl types directly); Submit and New Session keep the R4 step-up; audit row when a machine shell is created.
6. Desktop only (D11). Tests: Ctrl+` toggles even with focus inside xterm (or document the exception); switching project tabs keeps the same shell; switching machines swaps shells; reload re-attaches both; sh-* never appear as project tabs.

Note 2026-10-20: Esc inside the shell drawer minimises it and is not forwarded to the shell; Karl kept this behaviour (A1, 2026-10-20).

**What F1 already does about this.** F1 never makes a tmux session named `sh-*` a project tab. The
poller files such a session under `<cwd basename>@<machine>` as not reachable, so the name stays
reserved for these shells. F1's card button stays **Open terminal ↗** to the Terminals tab; F2 renames
it and switches the view in place.
