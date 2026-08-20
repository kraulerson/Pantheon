# Build Plan — M1 (Terminal Plane) + adopted cross-cutting items

> **HANDOFF to an Opus 5 (medium effort) executor, loop mentality.** Build → test →
> iterate until green → commit; merge at each milestone-unit boundary. Minimise operator
> interaction: decide everything you can from the canon; escalate only the items in
> §Escalation. Authoritative inputs: `docs/research/2026-08-20-capability-decisions.md`
> (decisions), `docs/research/2026-08-20-architecture-conflict-review.md` (reconciliations),
> `APPROVAL_LOG.md` (2026-08-20 rulings), `PRODUCT_MANIFESTO.md` §5 amendment,
> `PROJECT_BIBLE.md` capability-gap section. Read those before starting.

## Ground rules (non-negotiable)

1. **Framework Build Loop for every cutline feature:** `scripts/process-checklist.sh
   --start-feature`, tests written → verified failing → implement → security audit (write the
   findings file) → docs → `--record-feature`. Non-feature/tooling work is `chore:`/`build:`.
2. **TDD always.** No implementation before a failing test exists and is seen to fail.
3. **The UAT gate is real.** After every 2 cutline features the framework requires a UAT
   session (`scripts/test-gate.sh --check-batch`). You cannot run a human UAT yourself —
   when the gate trips, STOP, generate the UAT template (lint it clean with
   `scripts/lint-uat-scenarios.sh`), and hand it to Karl. Batch features so this happens as
   rarely as correctness allows.
4. **Doctrine is binding:** CC1 (colorblind-safe: shape/label/icon, never colour alone), CC2
   (fail closed), CC3 (enforce at the gateway, never trust the model). Every new surface obeys
   all three. Secrets never logged, committed, or echoed.
5. **Deploy target is VM 1093** (`pantheon@192.168.1.93`); admin console binds `172.17.0.1:8088`
   (LAN-refused; Caddy-only). Push to BOTH remotes (`origin` GitHub + `gitea`). After each
   merge, deploy to the VM (`git pull && npm run build && sudo systemctl restart
   pantheon-admin@pantheon`) and verify live.
6. **Verify before claiming done** (superpowers:verification-before-completion): run the
   command, read the output, then assert. Never report green without evidence.

---

## Phase 0 — Unblock (do FIRST; clears the current gate)

The test gate is tripped (2 features since last UAT). UAT session 2 is open with two agent
reports already filed under `tests/uat/sessions/2026-08-20-session-2/agent-results/`. Karl's
20-scenario run is pending.

- **0.1 (needs Karl):** await Karl's UAT-2 results. Cannot proceed past 0.3 without them.
- **0.2 Triage** all findings (agent + Karl) with Karl: assign Fix Now / Defer / Won't Fix.
  Known open items to triage: **BUGS #14** (gitea-live test masks a real scope failure — fix
  the guard to check scope, do NOT widen the token), **the fake `mcp-registration` live test**
  (`expect(true).toBe(true)` + bare `return` instead of `ctx.skip()` — new BUGS entry), **#18**
  (Enabled checkbox ignored on backends/service-endpoints — apply the dev-machine normalizer),
  **#19** (dead Edit/Remove buttons — the page ships no JS), **F-3** (zero audit logging —
  ties to M2 step-04 pino, note it), the **16-restart better-sqlite3 abort** during deploy
  (watch item; reproduce or characterise). F-1 (LAN cleartext) and the /help disclosure are
  already fixed.
- **0.3** Fix every Fix-Now bug test-first; re-run `scripts/test-gate.sh --check-batch` until
  it returns 0; `--reset-counter`. Gate cleared → M1 begins.

---

## M1 — Terminal plane (the operator's primary plane)

Order is dependency-sorted. Each numbered item is a Build-Loop unit unless marked *(tooling)*.
The freeze is re-scoped to M2 (ruling A-2), so M1 feature work is unblocked.

### 1. tmux-aware launcher — live session listing (the operator asked for this first)
- **Goal:** the harness page shows one button per live tmux session on a provisioned machine
  (today: `Alden, cdf, ios-app, lancache, new-solo, pantheon, solo`), each opening a terminal
  tab **attached** to that session; plus a "new session" option.
- **Design (ruled):** live-list from the machine — on harness-frame render (or an async fetch),
  run `tmux ls` over the existing key-only SSH path and render a button per session. Timeout +
  an explicit "machine unreachable" state (CC1 text/icon, never colour). `tmux` is at
  `/opt/homebrew/bin` on macOS — resolve via login shell or an absolute-path probe (a
  non-login shell won't find it — see the step-12 execution note in the previous session).
- **Files:** `src/http/harness-frame.ts` (render), a small `src/devmachine/tmux.ts` (list +
  attach-command builder, injection-safe against session names), `src/http/routes/harness.ts`
  (an endpoint or server-side call), tests in `test/`.
- **Tests first:** session-list parsed correctly; unreachable machine → labeled error, no crash;
  a session name with shell metacharacters cannot break the attach command; the attach opens the
  right session id.
- **Acceptance:** from `/harness`, clicking `Mac-Mini · pantheon` opens a tab already inside that
  tmux session. Verify live on the VM against the Mac mini.

### 2. Scoped session keycard (TP-3, HIGH)
- **Goal:** CLI sessions get a narrow, deny-by-default API door: read/propose scopes only
  (`usage:read`, `approvals:read`, `sessions:read`) — never a management/write scope (TM-011).
- **Build on** `docs/machine-auth-design.md`. Token store + per-route scope guard in Fastify;
  minting only on the D6 admin surface. Deny-by-default; fail closed.
- **Tests first:** unscoped token → 403; each scope grants exactly its routes and no others; no
  management route exists at any scope; token in no log/response.

### 3. Unified Pending-Approvals inbox (TP-2 amendment, HIGH)
- **Goal:** one admin-surface view listing every pending approval across ALL sessions —
  reference-only (identity, tool, target, age; **no arguments/diff** in the list, D8). Opening one
  routes to the existing D6 resolution surface.
- **Note:** the durable ApprovalRecord store lives in Peta; this is a read view over it. Depends
  on M2's approval surface (C.3) for the resolution target — if C.3 isn't built yet, ship the
  inbox as read-only over whatever approval store exists and wire resolution when C.3 lands.
- **Tests first:** aggregates across sessions; never renders arguments/content; empty state is a
  labeled "no pending approvals", not blank.

### 4. Session-waker promotion + deterministic guardrails (TP-1 HIGH, TP-5 partial)
- **Goal:** promote `prototypes/cli-channel-loop` to product (its own ADR first — write it).
  Add: **deterministic per-pair rate cap** (sliding-window budget, no model call) + **deny-by-
  default allowlist** as config (empty = deny all); **light-context wake** (small briefing, not
  full history). **Do NOT** add cadence-backoff-on-subscription (ruling: wake when needed).
  Preserve WAKE-NOT-BODY (wakes carry sender + ids, never bodies) and idle-only delivery
  (prompt-cache/turn integrity).
- **XC-6 invariant:** the allowlist adapter must refuse to dispatch until an allowlist is set
  (one Bible sentence + a negative test) — write that here.
- **Tests first:** rate cap trips at the window boundary and cools down; empty allowlist denies;
  wake payload contains no body; delivery only when idle.

### 5. Cross-project task board (TP-4, promoted to MVP)
- **Goal:** durable SQLite board on the admin surface: create/claim/complete/block, atomic claim,
  text-labeled states (CC1), per-task history. Claim/lease semantics reuse the P5 residency/lease
  shape.
- **Amendment (the 30s poll):** each session runs a **harness-side** poll (~30s) that reads the
  board and injects a session turn ONLY when the board actually changed AND the session is idle —
  it must not wake the model every tick (reconciled in the conflict review).
- **Tests first:** two sessions cannot both claim one task (atomic); blocked/what-it-waits-on
  shown in words; poll injects on change-only; no injection while busy.

### 6. `pantheon doctor` *(tooling — folded into M2 acceptance, ruling A-3)*
- **Goal:** one command (+ admin-page mirror) printing labeled per-component health AND negative
  security checks: services up, db 0600, bridge reachable, disk, cert expiry; `/admin` &
  `GET_OWNER` denied, no public listener, CSP present, an **out-of-vault path refused by
  obsidian-mcp's HTTP transport** (which currently has zero test coverage — add that coverage
  here). Grows one check at a time; `chore:`.

### M1 exit
All of 1–5 pass their Build Loops with UAT checkpoints cleared; `pantheon doctor` green on the
VM; live-verified. Record an M1-complete ruling in APPROVAL_LOG; then M2.

---

## M2 — Walking skeleton / chat plane (existing charter; freeze gates its acceptance)

Execute `docs/skeleton-steps/` **steps 3–8** as chartered, with these adopted items woven in:
- **Step 3–5 (Facade/pipeline):** **XC-1 MCP tool-schema hardening** (cap/strip tool
  names/descriptions/schema text before they enter any prompt; fail-closed reject over-cap) lands
  in the tool-proxy path. **XC-4** — add the `tier` + result-integrity columns to
  ToolClassification now (metadata; no behaviour change).
- **Step 6 (cost meter):** fold in the **CH-3 token-sanitizer** (validate provider token fields:
  type-check, non-negative, missing→null, never silent-zero) at the ledger door.
- **C.3 approval surface:** **XC-5** — tighten-only invariant + large-payload gist-then-full-diff
  (gist never replaces the diff; D4 preserved).
- **Compaction (CH-2):** RAG-backed via Qdrant, **routed through the taint engine** — restored
  chunks + summaries are `trusted:false` and taint; D5 sticky-taint holds. No laundering path.
- Step 8 collapses the two front doors into one harness entry point (the "one front door"
  acceptance box) — chat tabs + terminal tabs in one frame.

## M3 — Chat-plane capability items (post-M2)
CH-1 (group mechanics into C.8), CH-4 (Compare via **subscription CLIs**, bare sessions only,
per-provider feasibility check first), CH-5 (memory consolidation as a **propose-only queue**),
CH-3 insights page, XC-3 egress allowlist (fold into deploy work), XC-7 (hadolint/Trivy/OSV CI),
XC-8 (Vaultwarden startup secrets, fail-closed if unreachable), TP-7 (terminal recording —
per-tab opt-in, off by default, redacted + NAS-encrypted; **its own ADR + ruling before any
code**).

---

## The loop protocol (how the executor runs)

```
for each task in order:
    process-checklist --start-feature      # (cutline features only)
    write failing tests; run; SEE them fail
    implement the minimum to pass
    run full suite + tsc + eslint until green
    write the security-audit findings file; run the audit
    update CHANGELOG / FEATURES / relevant docs
    process-checklist --record-feature; test-gate --record-feature
    commit (feat|fix|build|chore per the work); push BOTH remotes
    deploy to VM; verify live
    if test-gate --check-batch != 0:       # UAT due
        generate + lint the UAT template; HAND TO KARL; wait
```
Iterate a task until its acceptance holds; do not advance on a red suite. If a fix fails 3×,
STOP and question the design (systematic-debugging Phase 4.5), don't attempt fix #4.

## Escalation — the ONLY things to bring back to Karl

1. UAT results (§0.1) and any UAT the gate demands mid-run.
2. Triage dispositions (§0.2) — Fix Now / Defer / Won't Fix.
3. TP-7 default posture is already ruled (per-tab opt-in, off) but its ADR needs Karl's sign-off
   before code (it's a D8 exception).
4. CH-4 per-provider CLI feasibility: if a provider ships no headless-drivable subscription CLI,
   surface it — don't fall back to paid API without a ruling.
5. Any newly-discovered conflict with ratified doctrine (CC1–CC3, a Will-Not-Have, an ADR).
Everything else: decide from the canon and keep moving.
