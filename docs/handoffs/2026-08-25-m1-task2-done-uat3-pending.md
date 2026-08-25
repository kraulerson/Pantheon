# Session Handoff — 2026-08-25 (late) — M1 task 2 DONE (session keycards); UAT session 3 PENDING with Karl

## Where we are

Branch `main`, clean, in sync with BOTH remotes (`origin` GitHub + `gitea` — the VM pulls from
Gitea; push both). VM 1093 deployed at **`cb1dcbf`** and live-verified through the household Caddy
entrance. **Test gate: 2/2 — TRIPPED.** UAT session 3 is open (`process-checklist` steps
`agents_dispatched`, `template_generated`, `orchestrator_notified` done; next step is
`results_received`). **No new feature may start until UAT-3 is run, triaged, remediated and the
gate reset.** 0 open SEV-1/2. Suite 548 passed / 5 honest skips; `tsc` + `eslint` clean.

Karl is a non-programmer: every reply ends with a plain-English TL;DR; decisions go to him as
plain-English cards with pros/cons + a recommendation; never write outside this repo without express
permission. Deploy: `git pull --ff-only && npm run build && sudo -n systemctl restart
pantheon-admin@pantheon` on `pantheon@192.168.1.93` (add `npm ci` when the lockfile changed).

## Shipped today (both M1 tasks, in order)

1. **M1 task 1 — tmux-aware launcher** (Feature 8): `65a88fe` feat, `94b1b9b` fix #32 (zsh
   `=name` quoting), `39316fa` fix #33 (explicit close frame), `82a92c5` better-sqlite3 12.11.1
   (BUGS #31, ruling A), audit `docs/security-audits/tmux-aware-launcher-security-audit.md`.
2. **M1 task 2 — scoped session keycard** (Feature 9, TP-3, ADR-0008): `f5af8bf` feat (three
   audits → 28 fixes in-loop), `383b9d9` fix (Peta approvals backend wired into `createServer` —
   the admin `/approvals` proxy had never been live), `cb1dcbf` fix (Peta's real
   `data.requests` shape), audit `docs/security-audits/scoped-session-keycard-security-audit.md`,
   interface doc `docs/api and interfaces/keycard-door.md`.
3. **UAT session 3 prepared** (`b9aacca`): `tests/uat/sessions/2026-08-25-session-3/templates/
   test-session-3-v1.html` — 23 scenarios (tmux launcher 9, keycards 11, regressions 3), lint clean;
   agent results in `agent-results/` (automated suite from verbatim output; adversarial probe
   consolidating the six audits + live probes).

## What's blocked / waiting

- **UAT-3 needs Karl at a browser + his Mac's Terminal** (a few copy-paste `curl` lines). He opens
  the template HTML in a browser, works the 23 scenarios, presses *Copy Results to Clipboard*, and
  pastes the text to the session (save under `submissions/`). Then: `results_received` →
  `completeness_verified` → `bugs_consolidated` → triage with Karl → `triage_complete` → fix
  Fix-Now items test-first → `remediation_complete` → `scripts/test-gate.sh --check-batch` →
  `gate_passed` → `--reset-counter`.
- **Data-model doctrine ruled A (2026-08-25, APPROVAL_LOG):** Bible §5 Principle 3 now carries the
  additive-DDL exception for the control-plane's SQLite tables; destructive changes still need a
  numbered migration + backup. Nothing pending on this.
- Open BUGS: #17 (host-key pinning, 3 paths), #24 (MCP delete), #25–#30 (tab-shell / CSP /
  config-page pre-existing), #34 (log redaction + AuditEntry when pino lands), #35 (Peta client
  timeout/size cap), #36 (D6 step-up stub, project-wide).
- `scripts/check-versions.sh` hangs >2 min at session start (killed); worth a look.

## What's next (the work, in order)

1. UAT-3 with Karl (above). 2. Triage + remediation + gate reset. 3. **M1 task 3 — unified
Pending-Approvals inbox (TP-2)**: a read view over Peta's approval queue on the admin surface —
the admin `/approvals` proxy is now live and answers `{ success, data: { requests, page, pageSize,
hasMore } }`; the keycard door already has the reference-only projection to reuse. Then tasks 4–6
per `docs/handoffs/2026-08-20-M1-build-plan.md`.

## Resume prompt

> Continuing from `docs/handoffs/2026-08-25-m1-task2-done-uat3-pending.md`. Branch `main`, both
> remotes synced, VM 1093 deployed at `cb1dcbf` and live-verified; M1 tasks 1 and 2 are DONE
> (tmux-aware launcher, scoped session keycard); the test gate is TRIPPED (2/2) and **UAT session 3
> is open** — template `tests/uat/sessions/2026-08-25-session-3/templates/test-session-3-v1.html`,
> agent results filed, checklist at `results_received`. First ask Karl for his UAT-3 results (or
> take them from `submissions/`), then run the UAT checklist to `gate_passed` and
> `--reset-counter` before any new feature. Then M1 task 3 — the Pending-Approvals inbox (TP-2). End every
> reply with a plain-English TL;DR; decisions to Karl as plain-English cards with pros/cons + a
> recommendation; never write outside this repo without his express permission.
