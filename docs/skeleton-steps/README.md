# Walking-Skeleton Step Designs

Junior-engineer-executable step designs for the walking-skeleton charter
(`docs/walking-skeleton-milestone.md`), one document per scope item, in dependency
order. Same standard as the Alden Phase 0 step-design package: each step says what to
do, exactly where, how to verify it, and how to back out — no senior judgment assumed.

**Read first:** `docs/walking-skeleton-milestone.md` (the charter — scope, acceptance
checklist, exclusions), then the step docs in order. Every step ends by mapping its
result onto the charter's acceptance checklist.

**Process rules that bind every step:**
- The freeze (Ruling C) is in effect: assembly/deployment work commits as
  `chore:`/`build:`; documentation as `docs:`. Steps that touch MVP-cutline code
  (steps 3, 5, 6, 7) run the full framework **Build Loop** (test-first —
  `scripts/process-checklist.sh --start-feature`, tests written → verified failing →
  implement → security audit → docs → `--record-feature`).
- Every step's **Verify** section must pass before the next step starts. If a Verify
  fails twice, stop and report — do not improvise around it (escalate via
  `scripts/escalate-to-user.sh`).
- Secrets: never commit, never log, never paste into a transcript. `.env.local` files
  are gitignored; the deploy env template documents every variable.

| Step | Doc | Charter item | Commit type |
|---|---|---|---|
| 1 | `step-01-vm-provision-and-install.md` | Debian VM + install | `build:` |
| 2 | `step-02-peta-hardened-deploy.md` | Peta, hardened (ADR-0003) | `build:` |
| 3 | `step-03-two-services-and-preprocessor-mount.md` | ADR-0007 split + pre-processor mounted | Build Loop |
| 4 | `step-04-pino-structured-logging.md` | pino + correlation IDs (§8) | Build Loop |
| 5 | `step-05-streaming-passthrough.md` | SSE end-to-end (decision F) | Build Loop |
| 6 | `step-06-cost-meter-usageevent.md` | UsageEvent ledger seed (decision F restored, DM-5) | Build Loop |
| 7 | `step-07-session-binding-and-queue.md` | Facade binding + C.7 queue (decision E) | Build Loop |
| 8 | `step-08-librechat-spike.md` | LibreChat deploy + inspector verdict (decision B) | `build:` + ruling |
| 9 | `step-09-machine-auth-design.md` | Design note (decision F) | **DONE** — `docs/machine-auth-design.md` |

**Exit:** when the charter's acceptance checklist is green, record the freeze-lift
ruling in APPROVAL_LOG, archive results to `docs/test-results/`, resume cutline work.
