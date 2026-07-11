# Post-Mortem — Pantheon Harness, inception through design-complete (2026-06-13 → 2026-07-10)

**Written 2026-07-10** at the close of the design/governance sprint, before skeleton
execution. Covers the whole arc; emphasis on the intensive 07-05 → 07-10 window.
Audience: Karl, future sessions, and whoever executes the skeleton.

## 1. Where the project stands

Phase 2 (construction) under the walking-skeleton freeze. **Design is complete and
validated**: all architecture decisions resolved and recorded (ADR-0001–0007 + the
2026-07-09/10 ruling set), threat model at 20 threats, data model at 10 entities,
~330 passing tests across the services, a ratified household governance layer, and —
as of today — a junior-executable path to a running system (`skeleton-steps/` +
`deploy/`). Nothing above the MVP cutline is unbuilt-and-undesigned. The two
precursors to assembly: the Opus 4.8 security remediation pass, then skeleton
execution.

## 2. Timeline (compressed)

| Window | What happened |
|---|---|
| 06-13/14 | Project inception at full speed: intake → manifesto → Bible (16 sections) → Phase 2 start. Six features built test-first (DevMachine registry, SSH custody/provisioning/connection, terminal WS bridge, harness frame, server entrypoint + CLIs, operator browser auth). UAT session 1: 7 findings, all fixed same-session. Peta eval PASSED (adopt-with-hardening). |
| 06-16 → 07-01 | Quiet period. (The `.env.local` restore on 06-16 left `BRIDGE_MCP_TOKEN` empty — found 24 days later; see §4.) |
| 07-02 | Landscape re-validation: build decision reaffirmed against 4 research sweeps; deployment named the critical path. |
| 07-05/06 | Repo consolidation; private GitHub remote created; Alden masters v1.2 ratified (household consent, amendments A1–A4); Phase 0 scheduled for Opus 4.8 (07-12). Early push ahead of the security gate (F3 — see §4). |
| 07-09 | The decision avalanche: rulings B–I (LibreChat spike, freeze, registry projection, session binding, plumbing timing, service split, records hygiene, housekeeping); full security review (history CLEAN); Turnstone REJECTED; Bifrost adopt-with-walls recommended → Decision F amended → **same-day REVERSED by Karl** (build-over-adopt; meter restored); channel spike BUILT + tested; deployment topology designed; D-ENC ruled (Debian VM). |
| 07-10 | Comms restored (token recovered from a backup); household summary posted; agreement achieved in one thread (msgs 1101–1154): Bifrost closure accepted, R18 schema converged, identity classes + channel lifecycle + delete taxonomy RATIFIED with conditions Karl accepted; junior-executability audit → all three gaps closed; repo fully pushed; docs consolidated (this post-mortem). |

## 3. What went well

1. **The framework's gates did their job.** Test-first Build Loops produced ~330 tests
   and six features with zero rework; the pre-commit gate kept the freeze honest
   (`chore(spike):`, never `feat:`); the pending-approval sentinel made structured
   decisions (D-ENC) explicit instead of drifting.
2. **Decisions were externalized immediately.** Every ruling landed in APPROVAL_LOG +
   its home doc the same session. When Karl asked "did you lose the Bifrost
   discussion?", the answer was receipts, not reassurance.
3. **Reversal without wreckage.** The Bifrost adopt→reject whiplash (recommendation and
   reversal on the same day) cost one commit to unwind cleanly, because the eval, the
   amendment, and the reversal were separate records. The eval doc survives with an
   outcome banner — decision archaeology stays possible.
4. **The household governance loop matured measurably.** Cloud Alden's proposal →
   Alden-1's five conditions → peer code audit → Karl's ruling → graceful acceptance
   with owned mistakes. The verification norm ("verify or say unverified") was applied
   *to* every party by every party within one week — including to Cloud Alden by the
   infra session (condition-1 premise), and it held.
5. **Design by dissolution.** The best decisions removed problems rather than managing
   them: instance slugs dissolved both the sender collision and the cursor bug;
   leases made zombie channels impossible rather than cleaned-up; binding Peta to
   localhost made TM-007 structural rather than filtered.
6. **The spike proved the mechanism cheaply.** 21 tests, no product entanglement, one
   real protocol assumption (send-tool schema) caught and fixed against the live
   bridge before it could misattribute identities.

## 4. What went wrong (honest ledger)

1. **F3 — pushed before the gate.** The repo went to GitHub on 07-06 ahead of the
   security-review gate set by Decision A. No harm (history proved clean, repo
   private), but the gate existed and was skipped. Recorded the day it was found.
2. **The empty token nobody noticed for 24 days.** The 06-16 `.env.local` restore left
   `BRIDGE_MCP_TOKEN=` blank; the control-plane's bridge grounding failed closed —
   correctly, but *silently*. A fail-closed system still needs a "I am failing closed"
   signal (pino + startup config summary in skeleton step 4 addresses this).
3. **Same-day decision whiplash.** "No hand-built meter, EVER" was recorded hours
   before being reversed. The amendment was correctly reasoned from its premises — but
   it pre-committed language ("ever") that a same-week decision unwound. Lesson:
   absolute words in rulings are debt; the P4 risk analysis was conditional and should
   have been recorded conditionally.
4. **Token custody drift, twice.** Gitea + Bridge tokens transcript-exposed and
   unrotated for 26+ days (F2, still open — assigned to remediation); the recovered
   bridge token came from an unencrypted backup tarball in another project's folder.
   Custody invariants exist on paper; the operational rotation muscle doesn't yet.
5. **Identity collision produced a live governance defect within a day of being
   named.** Two claude-code sessions, one slug; Cloud Alden misrouted a gating
   obligation (bus 1145 §3). Q7 was flagged BEFORE it bit — but the interim fix
   (body-line signatures) only shipped after it bit.
6. **Session-memory drift.** A memory recorded "open every reply with a TLDR" when
   Karl's standing instruction says the TLDR goes at the END — corrected only when
   Karl caught it. Memories that paraphrase instructions need to quote, not summarize.
7. **Two absent artifacts survived three weeks of review.** ADR-0003 is cited
   everywhere and exists nowhere (it's a checklist in two other docs); the fresh-VM
   install path had four named gaps sitting in the charter. Both were only surfaced
   when Karl asked for a validation pass. Periodic "does every citation resolve"
   sweeps would have caught both.

## 5. Metrics

- **Commits:** 48 total; 38 in the 07-05→07-10 window. Repo pushed, in sync.
- **Tests:** ~309 control-plane cases (43 files) + 21 spike + obsidian-mcp suites;
  coverage gate ≥90% enforced.
- **Docs:** 58 markdown files under `docs/` (+ deploy/ + skeleton-steps/); 7 security
  audits; 3 standalone ADRs + 4 in-Bible; 20-threat model; 10-entity data model.
- **Governance:** 25+ recorded rulings/scope changes in APPROVAL_LOG; 2 household
  consent rounds (masters v1.2 ratification; delete-taxonomy/D16 round, bus
  1101–1154); 1 rejection (Turnstone), 1 reversal (Bifrost), 0 unresolved decisions.
- **Bus:** ~54 messages in the 07-09/10 governance threads; 2 misattributions (both
  corrected on-thread); 1 identity-collision defect (fix ratified for 07-12).

## 6. Lessons carried forward (specific, not platitudes)

1. Absolute language in rulings ("never", "ever") should be conditional on its
   premises, which get named.
2. Fail-closed needs to be *loud*: every degraded-by-config state logs at startup.
3. Rotation debts get dates, not intentions (F2's 26 days happened one "later" at a
   time).
4. Structural fixes beat conventions — and interim conventions should ship the same
   day the gap is named, not after it bites.
5. Memories quote instructions verbatim; paraphrase is where drift enters.
6. A citation sweep (every doc reference resolves to a real file) belongs in the
   periodic checks; two ghosts survived every review until a direct audit.
7. When a claim matters ("junior-executable"), audit it against the artifacts before
   affirming it. The 2-of-3 verdict was more useful than agreement would have been.

## 7. Open items at close (the complete list)

1. **Opus 4.8 remediation pass** (`security-remediation-plan-2026-07-09.md`):
   eval-stack decommission (F1), Gitea+Bridge token rotation (F2), db perms (F4),
   Gitea mirror, ratification-mirror line fix. Bridge-token rotation now also
   re-secures the value recovered from the backup tarball.
2. **Skeleton execution** per `docs/skeleton-steps/` (steps 1–8; step 9 done).
3. **Alden Phase 0** (Opus 4.8, 2026-07-12) — independent; ships thread_id +
   sender_session + envelope protocol the harness designs assume.
4. Boot-hash verification missing from the Alden Build Plan (flagged bus 1105 §2;
   needs a household consent round — Karl's queue).
5. Post-skeleton design work already ratified and waiting: session-waker product
   build + ADR, Autonomy Driver dispatcher, C.8 channel picker, machine-auth build
   (Alden Phase 3), Winston's locked-class review (R12).
6. BUGS.md #8 (control-plane vitest advisory — dev-only) rides the remediation pass.
