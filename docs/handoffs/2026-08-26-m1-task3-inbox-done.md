# Session Handoff — 2026-08-26 — UAT-3 closed; M1 task 3 DONE (Pending-Approvals inbox)

## Where we are

Branch `main`, clean, in sync with BOTH remotes at **`5838dab`** (`origin` GitHub + `gitea`; the VM
pulls from Gitea — push both; Gitea push uses `GITEA_TOKEN` from `services/control-plane/.env.local`
via an inline credential helper, no keychain entry). VM 1093 deployed at `5838dab`, service active,
0 restarts, live-verified through `https://pantheon-admin.ferrumcorde.com`. **Test gate 1/2** (clear
for one more feature; UAT-4 trips after M1 task 4). 0 open SEV-1/2. Suite 582 passed / 5 honest
skips; `tsc` + `eslint` clean. Open BUGS: #17, #24, #25–#30, #34, #35 (extended today), #36, #37, #38.

Karl is a non-programmer: every reply ends with a plain-English TL;DR; decisions go to him as
plain-English cards with pros/cons + a recommendation; never write outside this repo without express
permission. Deploy: `git pull --ff-only && npm run build && sudo -n systemctl restart
pantheon-admin@pantheon` in `/opt/pantheon/pantheon-harness` (`services/control-plane` for the build;
add `npm ci` when the lockfile changed). LibreChat: `docker compose up -d librechat` after `deploy/.env`
changes, `restart` after yaml-only changes. The VM has no `jq` — use `node -e` for JSON probes.

## Done today (in order)

1. **UAT session 3 CLOSED** (`4473094`): Karl 22/23 PASS, 0 defects; scenario #2 unmarked but covered
   by #3/#4 (`tests/uat/sessions/2026-08-25-session-3/{submissions,triage.md}`); 9/9 checklist steps,
   `--reset-counter`.
2. **Chat-page sign-in = 30 days** (ruling, `cd6c930`): `REFRESH_TOKEN_EXPIRY=2592000000` (ms) set live
   in the VM's `deploy/.env`, LibreChat recreated, documented in `.env.example` + user guide +
   APPROVAL_LOG. Karl confirmed "(fast)" picker entries answer in ~1 s.
3. **M1 task 3 — unified Pending-Approvals inbox** (`5838dab`, Feature 10): `GET /admin/approvals`,
   admin-guarded, server-rendered, reference-only (D8), labelled states, read-only until M2 C.3;
   **Approvals** link in the harness chrome. Shared projection `src/approvals/projection.ts` (keycard
   door reads through it, contract unchanged). Two parallel audits + live Peta probe → 14 fixes
   in-loop (+16 tests): audit `docs/security-audits/pending-approvals-inbox-security-audit.md`,
   interface doc `docs/api and interfaces/approvals-inbox.md`.

## Live Peta facts learned (9201 LIST_APPROVALS, verified from the VM)

- Status vocabulary is UPPERCASE: `{ status: "pending" }` → HTTP 500 `Invalid status filter: pending`;
  `PENDING` accepted. A lowercase-only match would have hidden every live item — that was the SEV-1.
- `page` honoured (1-based); `pageSize` silently clamped to **100**; default 20; envelope
  `{ success, data: { requests, page, pageSize, hasMore } }`.
- The queue was EMPTY at probe time — **no real row was captured**, so the projection's key list
  (`approvalId|requestId|id`, `tool|toolName`, `serverId|serverName|server`, …) is still inferred.
  The page fails visible on a mismatch (rows without an id are counted, not hidden). **UAT-4 must
  include one real pending approval.**

## What's next (the work, in order)

1. **M1 task 4 — session-waker promotion + deterministic guardrails** (TP-1 HIGH, TP-5 partial) per
   `docs/handoffs/2026-08-20-M1-build-plan.md` §4. Full Build Loop (`--start-feature`, tests first,
   audit, docs, record). After it the gate trips 2/2 → generate + lint the UAT-4 template → hand to
   Karl (include a real pending approval scenario for the inbox).
2. Then tasks 5–6 per the build plan; M2 (walking skeleton / chat plane) afterwards.
3. Housekeeping candidates (not blocking): BUGS #35 client abort/byte cap; #37/#38 Post-MVP;
   `scripts/check-versions.sh` still hangs at session start.

## Resume prompt

> Continuing from `docs/handoffs/2026-08-26-m1-task3-inbox-done.md`. Branch `main`, both remotes
> and VM 1093 at `5838dab`, live-verified. UAT-3 is closed (gate 1/2, clear); M1 tasks 1–3 are DONE
> (tmux launcher, scoped keycard, Pending-Approvals inbox). Next: M1 task 4 — session-waker promotion
> + deterministic guardrails (TP-1/TP-5) per `docs/handoffs/2026-08-20-M1-build-plan.md` §4, full
> test-first Build Loop, commit + push both remotes, deploy, verify live; the gate will trip 2/2 after
> it → UAT-4 template (include one real pending approval for the inbox) → hand to Karl. End every
> reply with a plain-English TL;DR; decisions to Karl as plain-English cards with pros/cons + a
> recommendation; never write outside this repo without his express permission; retrieve Qdrant
> dev-memory before starting.

## Added 2026-08-27 — operator corrections

1. **BUGS #39 FIXED (`d809a95`, deployed + asset-verified live):** terminal tabs never filled the
   tab — xterm sat at its 80×24 default because nothing ever fitted it (the `{t:"r"}` → `setWindow`
   chain existed but never fired). `@xterm/addon-fit` 0.11.0 (exact pin) now ships from our origin
   (`/assets/xterm-addon-fit.js`, public); fit on open / broker `ready` (explicit size frame) / tab
   switch / host `ResizeObserver` / window resize; hidden tabs never fitted; missing addon fails
   closed and labelled. Both the tab shell and the standalone terminal page. **Visual confirmation
   still owed by Karl** (Chrome extension was not connected to the session): hard-reload the
   harness, open a CLI tab, resize the window.
2. **OPEN — Karl: "the sessions should be in the main pantheon harness, not under admin".** Read as
   the 2026-08-19 "one front door" item brought forward (CLI sessions on `pantheon-admin.*` behind a
   door labelled admin; he chose then to wait for M2 step 8). Decision card sent 2026-08-27 with
   options (A: add `harness.ferrumcorde.com` for the frame now via the intake platform; B: swap the
   two hostnames; C: wait for step 8). The household Caddy/DNS are intake-owned (outside this repo)
   → needs Karl's explicit go for that cross-project step. If he actually meant the new Approvals
   page's `/admin/…` path, that is a one-line route move (`/harness/approvals`) + nav — ask, don't guess.

## Added 2026-08-27 (late) — harness under the chat address BUILT, deployed to the admin address, chat-address switch PENDING KARL

- **Feature `harness-under-chat-address` DONE** (`7dc2c93`; suite 617 pass / 5 skips; +29 tests; two
  audits → 13 fixes in-loop; audit `docs/security-audits/harness-under-chat-address-security-audit.md`;
  design `docs/2026-08-27-harness-under-chat-address-design.md`; FEATURES 11; BUGS #40/#41 new,
  #26/#29 extended). **Gate 2/2 — UAT-4 must run before any next feature** (template still to be
  generated: include a REAL pending approval for the inbox, the terminal fit, the theme, and — once
  switched on — the chat-address flow).
- **Deployed to VM 1093 = the admin address only**: pages themed (LibreChat tokens, OS light/dark),
  `frame-ancestors 'self'` + frame-bust, WS Sec-Fetch-Site check (verified 403 same-site / 101
  same-origin through the VM Caddy and the household edge — probe over HTTP/1.1; an HTTP/2 probe
  drops `Upgrade` and is meaningless), `PANTHEON_CHAT_URL` set in the VM `.env.local`.
- **NOT switched on yet (needs Karl's acceptance of the one-origin residual — see the audit's
  "Residual #1" and the design doc):** the Caddy split and the LibreChat footer/help links. The new
  `deploy/Caddyfile` is already ON DISK on the VM (git pull) but Caddy has not been reloaded — **a
  `docker compose restart caddy` for any other reason would apply it.** Go-live steps once ruled:
  (1) on the VM `deploy/.env`: `CUSTOM_FOOTER=[Terminals](/harness/) | [Configuration](/harness/admin/config)`
  and `HELP_AND_FAQ_URL=https://pantheon.ferrumcorde.com/harness/help`; (2) `cd deploy && docker
  compose exec caddy caddy reload --config /etc/caddy/Caddyfile` (closes live terminal sockets);
  (3) `docker compose up -d librechat`; (4) verify `https://pantheon.ferrumcorde.com/harness/` →
  302 → `/harness/harness` 200 with `data-base="/harness"`, `/harness/login` is OURS and `/login` is
  LibreChat's, `/harness/assets/harness.css` 200, cookie `Path=/harness` after login, a terminal tab
  attaches through the chat address, the Chat tab embeds the chat page, the footer links appear
  after sign-in, and `curl -H 'X-Forwarded-Prefix: /evil' https://pantheon-admin…/harness` renders
  `data-base=""`; (5) APPROVAL_LOG row for the accepted residual.
- Next after that: UAT-4 template + Karl's session; then M1 task 4 (session waker + guardrails).

## Added 2026-08-27 (final) — SWITCHED ON: the harness lives under the chat address

Karl ACCEPTED the one-origin residual (APPROVAL_LOG 2026-08-27, commit `0f60b92`). Live and verified
through the household edge: `pantheon.ferrumcorde.com/harness` → 308 → `/harness/` → 302 →
`/harness/harness` (200, `frame-ancestors 'self'`, `data-base="/harness"`, 0 bare links);
`/harness/login` = console login, `/login` = LibreChat; `/harness/assets/harness.css` 200;
approvals/config/help 200; keycard door 401 on both addresses; WebSocket via the chat address:
same-origin **101**, same-site **403**; admin address unchanged and now strips a forged prefix.
`deploy/.env` on the VM: `CUSTOM_FOOTER=[Terminals](/harness/) | [Configuration](/harness/admin/config)`,
`HELP_AND_FAQ_URL=https://pantheon.ferrumcorde.com/harness/help` (backup `.env.bak-2026-08-27`);
LibreChat recreated. **Gotcha fixed in README:** `caddy reload` read the OLD bind-mounted Caddyfile
inode after `git pull` — `docker compose up -d --force-recreate caddy` is the step. Karl's browser
checks still owed: footer links after sign-in, themed harness, terminal tab through the chat address,
Chat tab, light/dark following. Next: UAT-4 template (gate 2/2) → Karl's session → M1 task 4.

## Added 2026-08-28 — UAT-4 closed, BUGS #42 fixed, machines sidebar shipped

- **UAT-4 closed** (16/20 pass): `tests/uat/sessions/2026-08-27-session-4/` (submission + triage).
  **#14 → BUGS #42 (SEV-2), FIXED (`b169315`, ruling A):** the inbox read only Pantheon's Peta while
  Alden-1's live ticket sat in **Alden's capability-gateway Peta**. Inbox + keycard door now read a
  LIST of stores — this host's Peta (label `Pantheon`) plus `PANTHEON_APPROVAL_SOURCES`
  (`[{label,url,token}]`, env only, malformed → fail loud) — in parallel, each row stamped with its
  **Source**, a failed store named in a banner while the others still show, empty state naming what
  was checked. **Open:** the Alden gateway entry itself needs a token from the Alden infra session —
  prompt ready at `docs/handoffs/2026-08-28-prompt-for-alden-infra-approval-source.md` (Karl gives it
  to that session; then add the env line on VM 1093 and restart). #16/#19 were not reproducible
  (308 = `http://`); re-test in UAT-5.
- **Context health check done** (Bible §§4/5/7/9/11 + a health-check record; `e9c44b2`).
- **Feature 12 — machines sidebar SHIPPED** (`cd0f4a8`, deployed, live-verified): collapsible left
  sidebar, Chat entry + one foldable group per machine with its live tmux sessions, Refresh and
  new-session form; not-ready machines show the reason + Configuration link; sidebar and groups
  remember open/closed; folding re-fits the terminal. Self-audit (the parallel auditor died on a
  model limit — recorded) found and fixed the collapsed-group SSH dial. Suite 637/5.
- **Gate 1/2.** Next feature trips UAT-5 (must include: a real pending approval with the Alden source
  wired, the keycard commands over **https**, and the sidebar).
- Next work: **M1 task 4 — session-waker promotion + deterministic guardrails (TP-1/TP-5)** per
  `docs/handoffs/2026-08-20-M1-build-plan.md` §4.
