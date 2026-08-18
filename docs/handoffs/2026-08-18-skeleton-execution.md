# Session Handoff — 2026-08-18 — Walking-Skeleton Execution

## Where we are

Branch `main`, clean, in sync with BOTH remotes (GitHub `origin` + Gitea mirror — push
to both). **Every precondition for skeleton execution is met:** design complete and
household-ratified (dsh proposals P1–P9 approved by Karl AND consented unconditionally
by both full identities), security remediation 100% done (eval stack dead, both tokens
rotated with the fan-out lesson learned as BUG-010, mirror live, db perms, hardening
items folded into the charter), deploy artifacts + 9 junior-executable step designs
written, machine-auth design done. The walking-skeleton feature freeze (Ruling C) is
in effect until the acceptance checklist passes. **This session's job: execute
`docs/skeleton-steps/` steps 1–8 in order.**

Karl is a non-programmer: **every reply ends with a plain-English TL;DR** (memory
`user-plain-english-tldr`); proposals/decisions use plain-English cards with pros/cons
+ recommendation (memory `feedback-proposal-format`); **never write outside this repo
without express permission** (memory `feedback-project-scope-boundary`).

## What just shipped (recent sessions; all committed + pushed)

- `docs/skeleton-steps/` — the 9 step designs (README has the index + process rules).
- `deploy/` — compose (Peta/Postgres bound 127.0.0.1-only), Caddyfile, librechat.yaml,
  systemd units, `.env.example`; `scripts/install-debian.sh` extended (steps 4–7).
- `docs/machine-auth-design.md` (skeleton scope item 9 — DONE).
- `docs/research/dsh-pattern-map.md` + `dsh-decision-proposals.md` — RATIFIED; P6's
  UsageEvent amendments already folded into charter item 6 + Bible §5.
- Security: `docs/token-rotation-runbook.md` (EXECUTED banner + BUG-010 fan-out rule);
  APPROVAL_LOG rows for everything above.
- Comms: session-waker spike proven (`prototypes/cli-channel-loop`, 21 tests); bridge
  reachable via `services/control-plane/.env.local` (`BRIDGE_MCP_URL/TOKEN` — token
  rotated 2026-08-17; bus posts sign body-line "Claude-Pantheon-Project", sender arg
  `claude-code` explicitly ALWAYS — it defaults to alden-cloud otherwise).

## What's blocked / waiting

- Nothing blocks step 1. No pending-approval sentinel exists.
- Open with the alden-infra session (not blocking; will answer on the bus): Phase 0.2
  ledger-column conflict check for P6; P8-vs-Phase-4 gateway alignment.
- Karl-side, optional, non-blocking: enforce Winston's brain key on host 192.168.1.206
  (bridge-side key installed by infra; server currently ignores auth);
  claude.ai connector = internal-only ruling (2026-08-18) — OAuth deployed+off, no
  public DNS, don't revisit.
- Alden-side context: their Phases 0–4 are DEPLOYED (gateway live, fail-closed);
  `thread_id`/`sender_session` columns live on the bridge; envelope headers live.

## What's next (the work, in order)

Execute `docs/skeleton-steps/` **steps 1–8** (step 9 done). Each step doc has goal,
preconditions, exact commands/file:line seams, tests-first Build Loop plan (steps 3–7
touch cutline code — full Build Loop with `scripts/process-checklist.sh`), verify,
rollback, acceptance mapping. Sequence:

1. **step-01** VM provision + `install-debian.sh` — NEEDS KARL at the Proxmox UI to
   create the Debian VM (exact specs in the doc; 16 GB RAM; the Proxmox node is
   `ferrumcorde` 192.168.1.20, SSH as root works). Fill `deploy/.env` +
   control-plane `.env.local` on the VM BEFORE the installer (fail-closed).
2. **step-02** Peta hardened bootstrap (owner + identity users via
   `peta-eval/harness/peta.mjs` — the in-repo sanitized copy; FRESH tokens only).
3. **step-03** two-service split + pre-processor mount (the unmounted-seam note is at
   `services/control-plane/src/server.ts:15–17`).
4. **step-04** pino + correlation IDs → **step-05** SSE streaming
   (seam `src/backend/client.ts:92–97`) → **step-06** UsageEvent cost meter (schema =
   charter item 6 INCLUDING the P6 amendments — anchor, disjoint buckets,
   provider/model, failed-completion rows) → **step-07** session binding verify +
   brain-busy queue.
5. **step-08** LibreChat spike + decision-B verdict → run the full acceptance
   checklist (`docs/walking-skeleton-milestone.md`) → record the freeze-lift ruling in
   APPROVAL_LOG → archive results to `docs/test-results/`.

## References

- Charter + acceptance: `docs/walking-skeleton-milestone.md`
- Step designs: `docs/skeleton-steps/README.md` (start here)
- Deploy map: `deploy/README.md`
- Canon: `PROJECT_BIBLE.md` (§5 UsageEvent/DM-5/DM-6; §9 C.1–C.8; §11 VM enclosure),
  `APPROVAL_LOG.md` (full ruling history), `docs/README.md` (documentation map)
- Ratified patterns to honor while building: `docs/research/dsh-decision-proposals.md`
  (esp. P4 frozen-args/monotonic-guards and P6 — both skeleton-relevant)
- Comms: `docs/integration/alden-bridge.md` + bridge access via control-plane
  `.env.local`; identifiers registry gap noted in
  `docs/2026-07-10-agent-legibility-remediation-plan.md` (OPEN — steps 1–7 unexecuted;
  do not let it block the skeleton)

## Resume prompt

> Continuing from the 2026-08-18 handoff at `docs/handoffs/2026-08-18-skeleton-execution.md`.
> All skeleton preconditions are met (design ratified, remediation complete, deploy
> artifacts + step designs in place). Begin walking-skeleton execution: read
> `docs/skeleton-steps/README.md`, then execute steps 1–8 in order — step 1 starts by
> asking Karl to create the Debian VM in the Proxmox UI per
> `docs/skeleton-steps/step-01-vm-provision-and-install.md`. Steps 3–7 are full Build
> Loops (test-first, process-checklist). The freeze (Ruling C) means `chore:`/`build:`/
> `docs:` commits for assembly work; push to both remotes. End every reply with a
> plain-English TL;DR for Karl; decisions go to him as plain-English cards with
> pros/cons and a recommendation; never write outside this repo without his express
> permission.
