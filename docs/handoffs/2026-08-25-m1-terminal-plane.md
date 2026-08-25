# Session Handoff — 2026-08-25 — Begin M1 (terminal plane)

## Where we are

Branch `main`, clean, in sync with BOTH remotes (`origin` GitHub + `gitea` mirror — push to
both) at **`74590f7`**. **UAT session 2 is closed 9/9, the feature gate is CLEAR** ("2 features
until next testing session"), no `pending-approval.json` sentinel, **0 open SEV-1/2 bugs**. Build
Loop state is reset (no feature in progress). The roadmap was restructured on 2026-08-20 into
**three milestones, terminal plane first** (ruling A-2); **M1 has not started yet** — this session
begins it.

Karl is a non-programmer: **every reply ends with a plain-English TL;DR** (memory
`user-plain-english-tldr`); proposals/decisions go to him as plain-English cards with pros/cons +
a recommendation; **never write outside this repo without express permission**. Deploy target is
**VM 1093** (`pantheon@192.168.1.93`, key-only SSH from the Mac); the admin console binds
`172.17.0.1:8088` (LAN-refused; reachable only through Caddy at `https://pantheon-admin.ferrumcorde.com`).

## What just shipped this session (all committed + pushed)

- **Capability-gap study ratified** — Karl ruled all 20 suggestions (19 adopt / 1 reject) from the
  four-harness study; four A-rulings; roadmap → three milestones. Governance commit `0c66eef`.
  Records: `docs/research/2026-08-20-capability-decisions.md`,
  `docs/research/2026-08-20-architecture-conflict-review.md`,
  `docs/research/2026-08-20-harness-capability-gap-study.md`; APPROVAL_LOG 2026-08-20 rows;
  PRODUCT_MANIFESTO §5 amendment; PROJECT_BIBLE capability-gap section.
- **M1 build plan written** — `docs/handoffs/2026-08-20-M1-build-plan.md` (the plan to execute).
- **`pantheon.ferrumcorde.com` + `pantheon-admin.ferrumcorde.com`** published via the household
  service-intake platform (internal-only DNS). Chat account created (`kraulerson`, ADMIN);
  "Switch to Admin" footer + Help→guide wired.
- **Security fixes** — admin console rebound to the docker bridge (was `0.0.0.0:8088`, cleartext on
  LAN); user guide stripped of internal paths/IPs. Commit `de6ee71`.
- **UAT session 2 remediation** — commits `0018065` (fixes) + `74590f7` (session close). All
  test-first, **349 tests pass / 5 honest skips**, tsc + eslint clean, verified live on VM 1093:
  BUGS #14, #18, #19, #20, #21, #22, #23 → Fixed (form-redirect, backend Enabled checkbox, logout
  control, persistent terminal launch bar, config-page Edit/Remove client JS, two lying tests made
  honest). See `BUGS.md` + `CHANGELOG.md [Unreleased]`.

## What's blocked / waiting

- **Nothing blocks starting M1.** The gate is clear.
- **New this session — BUGS #24 (Deferred):** MCP-server registrations cannot be deleted
  server-side (no Peta `DELETE_SERVER` action wired); the config-page MCP Remove button is rendered
  **disabled** on purpose. Fix requires verifying Peta's delete-server action code first.
- **Open household thread (non-blocking):** alden-infra session owes two confirmations (Phase 0.2
  ledger columns for P6; P8-vs-Phase-4). Karl-side optional: enforce Winston's brain key on
  192.168.1.206. claude.ai connector = internal-only ruling (do not revisit).
- **Framework rhythm:** the gate trips again after **2 more cutline features** → another UAT
  session (needs Karl at a browser). Batch M1 features to make that rare.

## What's next (the work, in order)

Execute **`docs/handoffs/2026-08-20-M1-build-plan.md`**. M1 order (each a test-first Build Loop,
commit `fix:`/`feat:`/`chore:` as appropriate, push both remotes, deploy to VM, verify live):

1. **tmux-aware launcher — live session listing** (Karl asked for this first). Harness page shows a
   button per live tmux session on a provisioned machine (`tmux ls` over the existing key-only SSH
   path), each opening a tab **attached** to that session. Ruled: live-list, not per-machine field.
   `tmux` is at `/opt/homebrew/bin` on the Mac (a non-login shell won't find it). Seam:
   `services/control-plane/src/http/harness-frame.ts` + `routes/harness.ts` + new
   `src/devmachine/tmux.ts`.
2. **Scoped session keycard** (TP-3) — read/propose scopes only, on `docs/machine-auth-design.md`.
3. **Unified Pending-Approvals inbox** (TP-2 amendment).
4. **Session-waker promotion + deterministic guardrails** (TP-1/TP-5; WAKE-NOT-BODY invariant).
5. **Cross-project task board** (TP-4, promoted to MVP; 30s harness-side poll, inject-on-change-while-idle).
6. **`pantheon doctor`** (XC-2; tooling, folded into M2 acceptance) — health + negative-security
   checks; also add the first tests for `obsidian-mcp/src/server.ts` vault-confinement transport.

Then M2 (walking skeleton / chat plane, `docs/skeleton-steps/` 3–8, freeze still gates its
acceptance) and M3 (chat-plane capability items). Cross-cutting adoptions are woven in at the
points named in the build plan.

## References

- **Start here:** `docs/handoffs/2026-08-20-M1-build-plan.md` (the plan + loop protocol + escalation rules).
- Decisions: `docs/research/2026-08-20-capability-decisions.md`;
  conflict reconciliations: `docs/research/2026-08-20-architecture-conflict-review.md`.
- Canon: `PROJECT_BIBLE.md` (§5 amendment + capability-gap section), `PRODUCT_MANIFESTO.md` §5,
  `APPROVAL_LOG.md` (2026-08-20 rows: A-1..A-4 + batch), `docs/walking-skeleton-milestone.md`
  (now M2), `docs/README.md` (doc map).
- Bugs / changes: `BUGS.md` (#24 open), `CHANGELOG.md` [Unreleased].
- Comms/deploy: `deploy/README.md`; bridge access via `services/control-plane/.env.local`
  (`BRIDGE_MCP_*` currently UNSET on the VM — a decision Karl deferred; see the step-02 note).
- Prior handoff (superseded by this one): `docs/handoffs/2026-08-18-skeleton-execution.md`.

## Resume prompt

> Continuing from the 2026-08-25 handoff at `docs/handoffs/2026-08-25-m1-terminal-plane.md`.
> Branch `main` @ `74590f7`, both remotes synced, working tree clean; UAT session 2 closed 9/9,
> feature gate CLEAR, 0 open SEV-1/2 bugs, no pending-approval sentinel. The roadmap is three
> milestones, terminal plane first (ruling A-2, 2026-08-20); M1 has not started. Begin M1 by
> executing `docs/handoffs/2026-08-20-M1-build-plan.md`, starting with **task 1 — the tmux-aware
> launcher** (live `tmux ls` over the existing key-only SSH path → one button per live session,
> opening a tab attached to it; seam in `services/control-plane/src/http/harness-frame.ts` +
> `routes/harness.ts` + a new `src/devmachine/tmux.ts`; `tmux` is at `/opt/homebrew/bin` on the
> Mac). Test-first Build Loop, commit + push both remotes, deploy to VM 1093
> (`pantheon@192.168.1.93`, console bound `172.17.0.1:8088`, verify via
> `https://pantheon-admin.ferrumcorde.com`). The gate trips after 2 cutline features → a UAT
> session that needs Karl at a browser, so batch features. End every reply with a plain-English
> TL;DR for Karl; decisions go to him as plain-English cards with pros/cons + a recommendation;
> never write outside this repo without his express permission.
