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
