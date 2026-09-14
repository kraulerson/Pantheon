# Handoff — architecture pivot (hand-built chat plane), design-first (written 2026-09-14)

**State of the repo:** `main` at `1860d68` on both remotes (GitHub `origin` + Gitea `gitea`; VM 1093
pulls from Gitea, push both). VM 1093 runs build `8cd3ce5` (the waker stage-1 commit); everything after
it is docs only, nothing to deploy. Suite 671 pass / 5 skips, `tsc` + `eslint` clean at `8cd3ce5`.
**Test gate is TRIPPED (2/2)** — UAT-5 is open at checklist step `orchestrator_notified`; **no feature
work may start until UAT-5 closes.** Nothing in this handoff is feature work.

## Resume prompt (paste into the new session)

> Continue pantheon-harness from `docs/handoffs/2026-09-14-architecture-pivot-design-sheet.md`.
> Retrieve Qdrant `dev-memory` first (queries: "pantheon design sheet", "code-lifting rule",
> "hand-built chat plane"). Rules: Karl is a non-programmer — every reply ends with a plain-English
> TL;DR; decisions go to him as plain-English cards with pros/cons + recommendation; never write
> outside this repo without his express permission; Build Loop + test gate + UAT process as in
> CLAUDE.md; store decisions/root causes in Qdrant. First action: read the design sheet back
> (below) and report what Karl changed. No code, no ADR, no language choice until the sheet is read.

## 1. What this thread is

Karl asked (2026-09-01) whether Pantheon could stop being "LibreChat for chat + our harness for
sessions" and become one hand-built harness he owns. Assessment given and recorded (APPROVAL_LOG
2026-09-01, Qdrant): **yes, and the case has strengthened since ADR-0001** — its UI-plane rationale
eroded on 4 of 5 points (tabs now ours; auth duplicated = two sign-ins; Meilisearch replaceable by
SQLite FTS5; "Agents ≈ identities" dead since identities live in control plane + Facade; only
"one web UI" remains). Gains: closes the accepted one-origin residual (TM-024; a 100k-line third-party
app on our origin), one sign-in, first-class identity/thinking/effort controls, inline approvals +
taint inspector + wakes, colourblind-safe by construction, drop Mongo + Meilisearch + RAG. Risk: chat-UI
defect surface (streaming markdown, history, search, attachments, mobile). Mitigations: cutline by
product intent not LibreChat parity; LibreChat side-by-side until Karl retires it; Facade stays
OpenAI-compatible. **Peta stays adopted** (trust core). Fork-and-PR of LibreChat rejected.

Karl's response: **design first.** He wants to express what he wants visually before any
architecture or language is chosen.

## 2. Rulings recorded 2026-09-01 (commit `1860d68`)

| Ruling | Where |
|---|---|
| **Code-lifting rule, four lines:** (1) text only from MIT/Apache-2.0/BSD/ISC (Apache: carry NOTICE + state changes); AGPL (Odysseus), ELv2 (Peta), GPL/SSPL/BUSL = patterns only, "personal use" changes nothing because the repo is already copied to two remotes; (2) lift modules, never apps (no donor framework/build chain); (3) provenance header on each lifted file + full licence text in `THIRD_PARTY_NOTICES.md` **in the same commit**; (4) lifted code meets strict-TS/lint/test-first/audit bar before merge | `PROJECT_BIBLE.md` §10 "Third-party code: the lifting rule"; APPROVAL_LOG |
| **Repository licence = all rights reserved** | `LICENSE`; `"license": "UNLICENSED"` in `services/control-plane/package.json`; APPROVAL_LOG |
| Donor licences verified: deepseek-harness MIT, OpenClaw MIT, Hermes MIT (Python), LibreChat MIT (© 2026 LibreChat), Odysseus AGPL-3.0, Peta-core ELv2 | capability-gap study; `THIRD_PARTY_NOTICES.md` (first entry = LibreChat theme-token values already in `src/http/theme.ts`) |

## 3. The design sheet (the thing to read back first)

- **Source (owned):** `docs/design/pantheon-design-sheet.html` — single HTML file, plain JS, no
  framework. Drafting-sheet identity (IBM Plex faces; light "vellum" / dark "light-table" themes).
- **Published artifact (private):** https://claude.ai/code/artifact/7d613dd8-a9ec-48ac-928f-3442f1575079
  — capability `db`; the sheet saves itself to document **`design/current`** as Karl edits (chip reads
  "saved · Claude can read this"). Local-storage mirror + Copy/Paste JSON + "Copy brief" (Markdown)
  as fallbacks.
- **Seeded content ("Reset to proposal"):** 20 modules in six layers (UI plane, control plane, trust
  core, brains, storage, outside the harness), 21 wires, 5 workflows W1–W5 (identity chat turn,
  basic-LLM turn, gated write, session wake, terminal attach). Each module has: *What I want it to do*
  (Karl's words — the field that matters), *How it would work* (technical), *Open questions*, status
  ○ proposed / ● keep / ◐ change / ✕ remove. Layers are encoded by tag + border style + hue (never
  colour alone — Karl is colourblind).
- **Open questions seeded for Karl:** attachments in v1? mobile in v1? import LibreChat history or
  start clean? approve from the chat pane or only the Approvals tab? auto-titles via model call or
  plain? how long a side-by-side period before LibreChat is switched off?

**Read it back (Artifact tool):**
```
action: "read_db"   url: https://claude.ai/code/artifact/7d613dd8-a9ec-48ac-928f-3442f1575079
db_op: "get"        collection: "design"        doc_id: "current"
```
The document is the sheet's state: `{rev, updatedAt, notes, modules[], connections[], workflows[]}`.
Diff it against `proposal()` in the HTML source to report exactly what Karl changed (status flips,
rewritten "want" text, added/removed modules and wires, notes). If the doc does not exist, Karl has
not opened the sheet yet (the first open writes the proposal) — ask him to open the link.

**Update the sheet:** edit the source file and republish with the Artifact tool passing
`url` = the address above (keeps the URL; omit `favicon` and `capabilities` to keep them). Read the
live version first (`action: "read"` with that `url`) — a publish onto an unread artifact is refused.

## 4. What happens after the sheet comes back (in order, nothing skipped)

1. **Report the diff** to Karl in plain English; resolve his open questions into rulings (cards).
2. **ADR-0010** superseding ADR-0001's *UI plane — ADOPT LibreChat* bullet only (the three-layer
   shape survives; Peta stays). Record in APPROVAL_LOG; Bible §3 + §7 (residual TM-024 closes when
   LibreChat is retired, not before).
3. **Chat v1 cutline** by product intent (identity/mode switch, thinking + effort controls, SQLite
   conversations + FTS5 search, inline approvals, taint inspector, wake relay) — NOT LibreChat parity.
   Attachments/mobile/history import only if Karl ruled them in.
4. **Language/stack choice** — present as cards. Default position to test against Karl's sheet: stay on
   the existing Fastify 5 + strict TypeScript + server-rendered pages + plain browser JS stack the
   harness already uses (ADR-0002); markdown + code highlighting as pinned libraries, not lifted code.
   Any lifted code follows the four-line rule.
5. **Roadmap edit:** this becomes the M2 deliverable ("Pantheon Chat pane inside the owned harness"),
   Facade built as planned; LibreChat side-by-side until Karl says retire.
6. Only then: Build Loop per feature, gate every 2 features, UAT.

## 5. Other open items (unchanged, all wait on Karl)

- **UAT-5** — template `tests/uat/sessions/2026-08-31-session-5/templates/test-session-5-v1.html`
  (18 scenarios); checklist at `orchestrator_notified`. Closing it resets the gate.
- **Alden gateway approval-source token** — still owed by the Alden infra session; Karl must paste
  `docs/handoffs/2026-08-28-prompt-for-alden-infra-approval-source.md` into Alden-2 himself (typing
  into that tmux session from here was blocked by the permission classifier; do not work around it).
  Then `PANTHEON_APPROVAL_SOURCES` in VM `.env.local` + restart.
- **Waker stage 2** (MCP channel runner, bridge poll, loop judge) — after UAT-5; full parallel audit +
  live smoke test (ADR-0009 §"Residual for stage 2").
- **`~/.claude/settings.json`** was reset to `{"agentPushNotifEnabled": true}` by the 2.1.251→2.1.252
  auto-update on 2026-09-01 07:01; no recoverable copy; rebuild only if Karl specifies contents.
- Open BUGS (SEV-3/4): #17, #24–#30, #34–#38, #40, #41.

## 6. Operational facts learned this arc (do not re-derive)

- **Mouse wheel in a harness terminal walked the input history** — xterm.js `_handlePassiveWheel`:
  on the alternate screen with no mouse reporting, wheel → Up/Down arrows → Claude Code's history.
  Fix on the Mac mini: `set -g mouse on` in `~/.tmux.conf` (applied live too). Both dev-machine tmux
  lines (`set -g set-clipboard on`, `set -g mouse on`) are recorded in the user guide §4 because that
  file lives outside the repo. `mouseEventsRequireAlt` exists only in xterm master, **not** in the
  pinned 6.0.0 — do not promise it.
- Deploy: `ssh pantheon@192.168.1.93 'cd /opt/pantheon/pantheon-harness && git pull --ff-only && npm run build && sudo -n systemctl restart pantheon-admin@pantheon'` (+ `npm ci` if the lockfile changed; set `PANTHEON_BUILD=<short sha>` in VM `.env.local`). Caddyfile changes need `docker compose up -d --force-recreate caddy` (bind-mounted file; `caddy reload` is a silent no-op). LibreChat `.env` changes need `docker compose up -d librechat`.
- Gitea push: `GITEA_TOKEN="$TOKEN" git -c credential.helper='!f(){ echo "username=kraulerson"; echo "password=$GITEA_TOKEN"; }; f' push gitea main` with the token from `services/control-plane/.env.local`.
- WebSocket probes: `curl --http1.1` and the real site address (VM Caddy answers an unmatched Host with an empty 200).
- Persistence verified 2026-09-01: `pantheon-admin@pantheon` is `enabled`; all six containers `restart: unless-stopped`; every dependency exact-pinned. VM-only secrets (`services/control-plane/.env.local`, `deploy/.env`) exist nowhere else — Karl to confirm VM 1093 is in the PBS backup.

## 7. Memory

- Qdrant `dev-memory`: session `2026-09-01-architecture-pivot-design-sheet` (rulings, assessment,
  sheet, next steps) plus the 2026-08-2x entries this arc built on.
- Local: `~/.claude/projects/-Users-karl-Documents-Claude-Projects-Pantheon/memory/MEMORY.md`
  (index line updated 2026-09-01).

---
**TL;DR:** Karl wants to replace the borrowed chat program with one we build and own. Before any
building, he is marking up an interactive drawing of the proposed design (link above); it saves
itself, and the next session's first job is to read his changes back and report them in plain
English. After that come the written decision, the list of what version 1 must do, and the choice of
tools — in that order, with no code before all three. Testing round 5 is still waiting on Karl and
blocks any new feature.
