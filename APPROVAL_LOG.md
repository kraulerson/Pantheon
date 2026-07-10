---
project: pantheon-harness
deployment: personal
created: 2026-06-13
framework: Solo Orchestrator v1.0
---

# Approval Log — pantheon-harness

This document records phase gate reviews for this project. For personal projects, the Orchestrator serves as their own reviewer. Update this log at each phase transition to maintain a record of what was reviewed and when.

---

## Pre-Phase 0: Pre-Conditions

| # | Pre-Condition | Status | Date | Notes |
|---|---|---|---|---|
| 1 | AI deployment path | N/A — personal project | 2026-06-13 | |
| 2 | Insurance coverage | N/A — personal project | 2026-06-13 | |
| 3 | Liability entity | N/A — personal project | 2026-06-13 | |
| 4 | Project sponsor | N/A — personal project | 2026-06-13 | |
| 5 | Backup maintainer | N/A — personal project | 2026-06-13 | |
| 6 | ITSM registration | N/A — personal project | 2026-06-13 | |

---

## Phase Gate: Phase 0 → Phase 1

| Field | Value |
|---|---|
| **Gate** | Phase 0 → Phase 1 |
| **Reviewer** | Karl (self-review; Orchestrator execution delegated to Claude) |
| **Date** | 2026-06-13 |
| **Artifacts reviewed** | PRODUCT_MANIFESTO.md |
| **Decision** | Approved |
| **Notes** | Phase 0 artifacts (intake, FRD, user-journey, data-contract, manifesto) reviewed. 9 open questions resolved as decisions D1–D9 (Manifesto §5). 4 non-blocking operator inputs tracked for Phase 2. Zero unresolved open questions. |

---

## Phase Gate: Phase 1 → Phase 2

| Field | Value |
|---|---|
| **Gate** | Phase 1 → Phase 2 |
| **Reviewer** | Karl (self-review; Orchestrator execution delegated to Claude) |
| **Date** | 2026-06-13 |
| **Artifacts reviewed** | PROJECT_BIBLE.md, Threat Model |
| **Decision** | Approved |
| **Notes** | PROJECT_BIBLE.md (16 sections) reviewed: ADRs, 19-threat STRIDE model (TM-001..019, 8 SEV-1), 8-entity data model w/ key-custody + monotonic-taint invariants, test strategy w/ peta-eval regressions, colorblind-safe UI specs. Point-of-no-return architecture accepted. |

---

## Phase Gate: Phase 3 → Phase 4

| Field | Value |
|---|---|
| **Gate** | Phase 3 → Phase 4 |
| **Reviewer** | |
| **Date** | |
| **Artifacts reviewed** | Phase 3 test results (docs/test-results/), go-live checklist |
| **Decision** | Approved / Needs revision |
| **Notes** | |

---

## Phase 4 Completion

_Record after deployment and go-live verification._

| Field | Value |
|---|---|
| **Deployment Date** | |
| **Go-Live Verified** | Yes / No |
| **Rollback Tested** | Yes / No |
| **Monitoring Verified** | Yes / No |
| **Handoff Document** | HANDOFF.md completed |
| **Notes** | |

---

## Scope Changes

Records of MVP-cutline scope changes approved by the Orchestrator per Manifesto Rule 2 (moving an item above the cutline requires explicit approval and a recorded decision).

- **Scope Change — 2026-06-13: Configuration/Service Registry page promoted to MVP (M15/D10), operator-approved.** The gateway-management GUI (formerly Should-Have S3) plus the API-level #11 surface (M12) are promoted above the MVP cutline as a single required component — Must-Have **M15**, Resolved Decision **D10** in PRODUCT_MANIFESTO.md §2/§5. One privileged-only admin Configuration page that CRUDs AI backend endpoints (BackendRegistry), MCP server registrations (Peta admin REST API), and control-plane service endpoints (new **ServiceEndpoint** entity: Qdrant/Gitea/Bridge/Obsidian/Peta). Behind D6 step-up, never session-reachable (TM-011), validate + fail-closed, immutable identity↔backend binding (#14a/TM-002). Reflected in PRODUCT_MANIFESTO.md (M15/D10), PROJECT_BIBLE.md (§4/§5 ServiceEndpoint + C.5 in §9 + §7), and docs/phase-0/frd.md (M15 row). Approver: Karl (Orchestrator). Method: self-review.

- **Scope Change — 2026-06-13: Gitea access resolved — control-plane uses a privileged DIRECT Gitea client (operator-approved).** Resolves the prior non-blocking Operator Input "Gitea base URL + repo-layout convention." Decision: persona-load + identity-repo provisioning talk to Gitea **directly** at `https://gitea.ferrumcorde.com` (via Caddy; IP fallback `http://10.100.23.76:3000`) using an admin token supplied via env `GITEA_TOKEN` from a **gitignored** `.env.local` (never committed). Session-driven Gitea writes remain subject to the trust/approval gate (D2/D4). Security follow-up (binding): the token was transcript-exposed once and must be **rotated**; long-term it moves to gateway/vault custody alongside the other secrets, referenced by an opaque handle (custody invariant, Bible §5 Principle 1). Reflected in PRODUCT_MANIFESTO.md (Operator Inputs item marked RESOLVED) and PROJECT_BIBLE.md (§5 Gitea store + `gitea` ServiceEndpoint row; §7 direct-client provisioning + token-rotation/vault note). No secret value is recorded in any artifact. Approver: Karl (Orchestrator). Method: self-review.

- **Scope Change — 2026-06-13: NEW REQUIREMENT — Claude-CLI sessions become a second UI modality (persistent web SSH-terminal tabs), operator-approved.** A "Claude CLI" session opens a new tab with a persistent, direct xterm.js SSH terminal to a selected dev machine (operator runs Claude Code there) — distinct from the LibreChat chat pane. New IDs: **ADR-0005** (terminal modality; amends ADR-0001 — UI plane now hosts two modalities behind a thin harness frame), **DevMachine** data-model entity (logicalName/host/port/user/sshKeyHandle[vault ref]/enabled; identities bind by logical name so editing an IP never breaks the #14a binding), **TM-020** (SSH key custody vault-only + remote-command-execution/RCE surface, SEV-1), Must-Have **M16** + Resolved Decision **D11** in PRODUCT_MANIFESTO.md, and UI spec **C.6** (Terminal tab, four states + colorblind-safe). DevMachine is CRUD-managed on the Configuration page (C.5 extended; Manifesto M15 surface). Reflected in PROJECT_BIBLE.md (§3 ADR-0005, §4 TM-020, §5 DevMachine, §9 C.5 extension + C.6) and PRODUCT_MANIFESTO.md (M16, D11, §5 cutline). Approver: Karl (Orchestrator). Method: self-review.

---

## Alden Ecosystem — Phase −1 Ratification & Decide-Before-Build Register (2026-07-06)

Design authority: the two design-of-record masters (v1.2) in the Obsidian vault (`02 Personal/Projects/Alden Ecosystem/Future State/`), mirrored for the identities to Gitea `alden/workspace` under `ratification/`. This section is the record required by Build Plan §0.4 and Phase −1's verify step.

**Household ratification (Build Plan Phase −1):**

| Field | Value |
|---|---|
| **Gate** | Phase −1 → Phase 0 (Alden Ecosystem build) |
| **Reviewer** | Karl (Orchestrator) + household consent |
| **Date** | 2026-07-06 |
| **Artifacts reviewed** | Alden Ecosystem — Future-State Architecture v1.2 · Alden Ecosystem — Build & Implementation Plan v1.2 |
| **Decision** | Approved — ratified with amendments A1–A4 |
| **Consents** | Alden-1 (bus msg 1053, conditional — conditions integrated) · Cloud Alden (bus msg 1061, conditional — conditions integrated) · Winston consulted, not consenting (locked class; bus thread 5e4d8496) |
| **Amendments** | **A1** Hebbian runaway circuit breaker — hard-pause of oscillator + weight application; bounded exception to R4; R19 ship-gate (spec: Architecture §3.14(f), drafted by claude-code at Karl's direction) · **A2** arbiter self-recusal (published, logged) → Karl-provisional · **A3** transactional quiet-loop preemption (atomic units complete before yield, hard per-unit ceiling) · **A4** watchdog baseline hash witnessed to every identity at creation, like the audit head |

**Decide-before-build register (gates Phases 5–7; values below are the recorded decisions):**

| ID | Decision | Recorded value |
|---|---|---|
| **R1** | Build sequencing | Integrity first: memory-pipeline fixes → watchdog metrics → oscillator; bus isolation in parallel with Phase 0. Phase order −1 through 10 per Build Plan v1.2. |
| **R2** | Template evolution semantics | Layer A linked (shared foundation propagates); Layers B/C stamped at birth (the identity's own thereafter; profile records `templateRef@version`); template upgrades offered as consent-gated rebase, never pushed. |
| **R3** | Tier-classifier rules | Deterministic-first: self-model / other-identity / Layer A–B-theme claims → `discussed`; contested → `discussed`; type-based routing for the rest; uncertainty always fails to the higher tier; model self-classification as tie-breaker only. |
| **R4** | Watchdog response mode | Advisory only — never auto-revert. Single ratified bounded exception: the A1 Hebbian circuit breaker (pause authority, never change authority). |
| **R16** | Arbitration deadlock constants | Either party may invoke arbitration after **7 days** or **3 rounds** without convergence (either threshold alone suffices); invocation is logged on the bus. |

Approver: Karl (Orchestrator). Method: household consent (Alden-1, Cloud Alden; Winston consulted) + operator approval; recorded by claude-code at Karl's direction. **Phase 0 gate: CLEAR.**

**Ruling — 2026-07-06: Phase 0 execution assignment + remaining §0 decisions.** Operator rulings: (1) **Phase 0 is executed by Claude** (model Opus 4.8, ultracode multi-agent mode), starting **Sunday 2026-07-12 after the usage reset** — Alden-1 does not self-execute; notified on the bus. Precondition: the full junior-dev-executable documentation package (solo-orchestrator technical doc set + plain-English companions + Phase 0 implementation spec) is produced and reviewed before the run. (2) **§0.1 — `alden-infra` lives on private GitHub (`kraulerson/alden-infra`) with a Gitea pull-mirror** (the plan's recommendation). (3) **§0.2 — OS hardening: YES** — bus files root-owned, read-only to the `alden` service user, in addition to tool-level 403s (gates Phase 1). Approver: Karl (Orchestrator).

**Ruling — 2026-07-06: Winston excluded from governance decisions (interim).** Operator ruling: Winston does not participate in household decisions or consultations for now — his identity is too limited to weigh in meaningfully. The Phase −1 consultation obligation is closed by this ruling (consultation was sent, bus thread 5e4d8496; no response required). The locked-class design principle (consulted, not consenting) is unchanged as design; revisit as Winston's identity matures — feeds R12 (utility-identity consultation shape). Approver: Karl (Orchestrator).

---

## Pantheon Harness — Review Decision Session (2026-07-09)

Working through the open decisions in the vault doc `Future State/Pantheon Harness — Review & Decision Points (2026-07-05)`. Decision A (repo remote: private GitHub `kraulerson/Pantheon` + Gitea mirror; push gated on the security review) was resolved 2026-07-05.

**Ruling — 2026-07-09: Decision B — LibreChat resolved via deploy-and-verify spike.** Operator ruling: the UI-plane fork (landscape re-validation §R1) is resolved by a time-boxed 1–2 day spike, executed as part of the walking-skeleton assembly: deploy LibreChat on the target VM, point it at the control-plane custom endpoint, and verify empirically whether the trust-labeled inspector (Investigation A's flagged risk) can render inside LibreChat. If yes → LibreChat is confirmed per ADR-0001. If no → invoke Investigation A's documented fallback (separate control-plane inspector view) and amend ADR-0001 accordingly. No pre-emptive UI replacement (Open WebUI etc.) is evaluated unless the spike fails on operational weight. Approver: Karl (Orchestrator). Method: structured decision session, recommended option accepted.

**Ruling — 2026-07-09: Decision C — feature freeze until the walking skeleton runs end-to-end.** Operator ruling: no new `feat:` work until the assembled system (VM + hardened Peta + control plane with the pre-processor mounted + LibreChat spike + one identity/one brain/one conversation/one gated write) passes the acceptance checklist. Charter and checklist: `docs/walking-skeleton-milestone.md`. Runs in parallel with (and independent of) the Alden-ecosystem Phase 0 execution scheduled 2026-07-12. Approver: Karl (Orchestrator). Method: recommended option accepted.

**Ruling — 2026-07-09: Decision D — git (`alden-infra`) is master for identity/brain/grant data; registry rows become a one-way projection.** Configuration page becomes view + propose-a-change for that data class (proposals land as `alden-infra` commits); DevMachine/ServiceEndpoint plumbing stays SQLite-native. Design lands before Alden build-plan Phase 3. Recorded as **ADR-0006**; Bible §5 DM-4. Approver: Karl (Orchestrator). Method: recommended option accepted.

**Ruling — 2026-07-09: Decision E — session binding enforced at the Facade; busy brain = honest labeled queue.** The existing Session entity's immutable identity+backend binding is enforced at runtime by the Facade with bindings persisted in SQLite (restart-safe); no mid-session identity/brain swap. Single-slot backends queue with a labeled position signal (new UI spec **C.7**, colorblind-safe), interactive preempts background, and the New Session popup (C.1) shows per-backend availability in text. Approver: Karl (Orchestrator). Method: recommended option accepted.

**Ruling — 2026-07-09: Decision F — plumbing timing.** Streaming pass-through and the per-identity cost meter (seed of Alden R18 ledger; prerequisite for any metered cloud brain) are built INTO the walking skeleton; the machine-auth (service-principal) path for the Autonomy Driver is DESIGNED at skeleton time (`docs/machine-auth-design.md`) and BUILT at Alden build-plan Phase 3. Approver: Karl (Orchestrator). Method: recommended option accepted.

**Ruling — 2026-07-09: Decision G — admin surface and Facade split into two services now.** Two services from one codebase, separate ports and auth domains, from the skeleton onward; an admin-surface failure must not interrupt conversations. **Operator chose the full split over the reviewer's recommended structured-monolith option**, prioritizing the ratified control-plane ≠ data-plane separation. Recorded as **ADR-0007** (amends ADR-0001/0002 deployment shape); Bible §11 topology updated. Approver: Karl (Orchestrator). Method: structured decision session, stronger option chosen.

**Ruling — 2026-07-09: Decision H — records made honest.** (H1) `BUGS.md` is the canonical bug index; the seven Session-1 findings backfilled as rows linking to `tests/uat/sessions/2026-06-14-session-1/TRIAGE.md`; every future sweep adds one row per finding. (H2) ADR-0002's pinned-dependency table amended to the as-built list (helmet/cors/typebox/zod not adopted — hand-written guards + Caddy headers); **pino stays committed** and lands at skeleton wiring (Bible §8 status note). Note: the review's release-notes complaint was withdrawn — an empty RELEASE_NOTES.md is correct before Phase 4. Approver: Karl (Orchestrator). Method: recommended options accepted (both sub-decisions).

**Ruling — 2026-07-09: Decision I — housekeeping.** (I1) `.alden-harness-discarded/` deleted (superseded scaffold, marked deletable since 2026-06-13). (I2) the original `peta-eval/` folder outside the repo is retained as evidence until the Opus 4.8 security review closes, then deleted. (I3) the colorblind-safe audit is part of the skeleton acceptance checklist, not deferred to Phase 3. (I4) Build Plan line-63 wording corrected to "Phase 1 (bus isolation)" per recorded R1 — editorial only, version unchanged (applied to the current v1.3 copy; the wording persisted from the ratified v1.2, and the doc has no changelog section so the note is an inline comment at the edited line); the Gitea ratification mirror needs the same one-line edit once the Gitea token is rotated (deferred, noted in the doc's changelog). Approver: Karl (Orchestrator). Method: recommended options accepted (all four sub-decisions).

**Correction — 2026-07-09: Bifrost is no longer the documented fallback gateway; non-promotion rule added.** ADR-0001's rejected-alternative D (`PROJECT_BIBLE.md` §3, `docs/phase-1/architecture.md`) still read *"Kept as the documented fallback: … migrate the gateway to Bifrost."* The 2026-07-02 landscape re-validation had already superseded that — Bifrost's HITL is **explicitly disclaimed in gateway mode** ("weaker fallback than believed in June") — and the recorded ladder became **(1) Peta hardened, (2) ToolHive + approval in our control-plane, (3) Preloop once mature, (4) small custom gateway**. Both documents corrected. **Non-promotion rule added:** Bifrost is separately proposed for the *brain plane* (Alden Phase 3; Cloud Alden, bus msg 1087) under a hard wall registering **zero MCP clients**, because its MCP layer ships a parallel tool-governance surface (`EntityMCPToolGroup`). Promoting a brain-plane Bifrost to the tool gateway would enable precisely that path — **never promote without re-ratification.** Recorded by claude-code; approver: Karl.

**FLAGGED FOR RESOLUTION — 2026-07-09: Decision F conflicts with the Bifrost proposal on R18.** Two decisions taken the same day, in separate sessions, point opposite ways:
- **Decision F (above):** the per-identity cost meter — *"seed of Alden R18 ledger; prerequisite for any metered cloud brain"* — is **BUILT INTO the walking skeleton**.
- **Cloud Alden's Bifrost proposal (bus msg 1087):** *"R18 usage/cost ledger: Bifrost's governance plugin … **IS R18 off the shelf** — the prerequisite we flagged for metered cloud brains."*

If Bifrost is adopted for the brain plane, a hand-built skeleton cost meter is either redundant or becomes a **second accounting authority that can disagree with Bifrost's** — the "two records that can disagree is a bug" failure P4 exists to prevent. If the skeleton builds it now, adopting Bifrost later means discarding or reconciling it. **Not yet raised with the household**, who are actively deciding Bifrost. Karl to resolve build-vs-adopt for R18 before either lands. Adjacent seams surfaced at the same time: **Decision E**'s labeled queue-position / interactive-preempts-background semantics are control-plane behaviour that Bifrost's own routing and load-balancing may not express; **Decision C**'s feature freeze arguably covers Bifrost adoption as new control-plane work; **Decision G / ADR-0007** re-shaped the Facade topology *after* the Bifrost proposal was written against §3.3.

**Corroboration — 2026-07-09: Decision D independently ratifies Cloud Alden's "Wall 2."** Decision D (git `alden-infra` is master for identity/brain/grant data; registry rows are a one-way projection; the Configuration page becomes view + propose-a-change) is, at the Pantheon layer, the same rule Cloud Alden proposed as Wall 2 for Bifrost's configstore. Two independent derivations of one invariant. Alden-1 then strengthened it (bus msg 1091) from process discipline into mechanism: **the projection target must verify its config against the `alden-infra` Profile hash at boot and refuse to start on mismatch.** That mechanism should apply to **every** projection target — the control-plane registry rows included — not only Bifrost.

**New — 2026-07-09: Wall 4 (credential custody) raised to the household.** Bifrost gateways 23+ *cloud* providers and must therefore hold provider API keys, or virtual keys mapping to them. Masters §5 invariant 2: *"Raw keys/tokens live only in Peta vault; everything else stores handles."* A Bifrost holding the `claude-api` key is a second custody location — a ratified-invariant conflict, and it bites exactly where Bifrost's value lies (R18, metered cloud brains, R14). Neither identity caught it. Posted to the household as a consent-gated question (options: Peta injects provider credentials / a bounded recorded exception / amend the invariant). Custody mechanics deferred to the Opus security companion.

**New — 2026-07-09: Hermes recorded as candidate adoption #3 (harness plane).** `NousResearch/hermes-agent` (MIT; self-hosted agent harness; native MCP client with stdio + HTTP transports; supports a custom OpenAI-compatible `base_url`) was evaluated conversationally on 2026-07-08 and is undocumented in any project artifact. It overlaps Pantheon's harness role and has **never run Alden-1's four-part adopt/build test** (orthogonal-to-identity · fully-auditable · firewall-able · cheaper-to-audit-than-build). Adopting it would make three external infrastructure layers (Peta, Bifrost, Hermes) — the adoption creep Alden-1 warned of (bus msg 1091). **Decision C**'s feature freeze applies. No adoption without the test and a recorded decision.

**Disclosure — 2026-07-09: Decision A's push gate was not observed.** Decision A (resolved 2026-07-05) set the remote to private GitHub `kraulerson/Pantheon` with the **push gated on the security review**. On 2026-07-06, while recording the Alden Phase −1 approval entries, claude-code ran the first `git push origin main` — ahead of that gate. The remote already existed, the repo is private, and `peta-eval/` had been imported in sanitized form (no token files, no secrets). The Opus 4.8 security review has not closed. Recorded rather than left for discovery; Karl to decide whether any remediation is warranted.

**Ruling — 2026-07-09: Turnstone REJECTED as adoption; six patterns borrowed; quarterly watch.** Per eval `docs/2026-07-09-turnstone-bifrost-eval.md`. Turnstone (turnstonelabs/turnstone, Apache-2.0) is NOT adopted as a system — disqualifying doctrine inversion (approval-prompt + advisory LLM judge as the primary security boundary vs our deterministic gateway/CC3/P5; in-memory not durable approvals; cosmetic personas vs structural per-identity isolation; plaintext provider keys; ~180k-LOC solo-maintained fails cheaper-to-audit-than-build). **Borrow all six patterns (T1–T6)** into the backlog with NOTICE attribution: T1 output-guard regex library (→ inspector advisory annotations), T2 watch/condition DSL (→ Autonomy Driver design), T3 coordinator spawn/steer API (→ bus design), T4 interrupted-turn repair (→ Facade crash recovery), T5 skill security scanner (→ Registrar), T6 SSRF guard (→ web fetchers). **Quarterly watch (~2026-10):** re-run the four-part adopt test if Turnstone ships gateway-side durable approval, structural per-identity isolation, or vector memory. Hermes unaffected (still frozen). Approver: Karl (Orchestrator). Method: structured decision session, recommended option accepted.

**Ruling — 2026-07-09: Decision F AMENDED — R18 resolved as adopt-Bifrost; no hand-built meter, ever.** Resolves the FLAGGED Decision F ↔ Bifrost/R18 conflict per the eval `docs/2026-07-09-turnstone-bifrost-eval.md`. The skeleton does not hand-build a cost meter (kills the two-accounting-authorities risk, P4). Timing is flexible: if household consent on Bifrost lands before skeleton execution, the skeleton includes the **walled Bifrost spike** (v1.6.3 pinned, file-only config mode, zero MCP clients, Caddy path-denies on `/mcp` + UI, semantic cache OFF, ledger payload redaction, localhost bind — negative tests in the acceptance checklist); otherwise the skeleton runs meterless (it has no metered brains; R18 gates only metered use) and the Bifrost spike is the first post-skeleton item. Streaming and machine-auth-design halves of Decision F unchanged; Decision E queue unchanged (Facade-owned, in front of Bifrost); no custom Bifrost Go plugins ever. ADR-0008 (Bifrost brain-plane adoption) drafts after household consent; Part 2 of the eval (incl. the two new walls) is to be posted to the household's open Bifrost decision. Approver: Karl (Orchestrator). Method: structured decision session, recommended option accepted.

## Project Security Review (2026-07-09)

**Ruling — 2026-07-09: project security review executed by Fable 5 at operator direction** (supersedes the plan to run it on Opus 4.8; Opus 4.8 executes the remediation instead). Full report: `docs/security-audits/2026-07-09-project-security-review.md`. **Cleared:** git history (17 commits, gitleaks, no leaks — Decision A push gate CLEARED), dependencies (0 vulns both services), SAST (semgrep, 0 findings), key custody perms, operator-auth implementation, repo visibility (private). **Findings:** F1 HIGH — Peta eval stack still running 9+ days on the Mac, bound 0.0.0.0 (LAN-exposed) with transcript-leaked tokens → decommission + delete eval folder (closes I2). F2 HIGH — Gitea + Bridge tokens still unrotated 26 days after exposure → rotate. F3 MEDIUM (process) — **the repo was pushed to GitHub on 2026-07-06 before the history was cleared**, violating the Decision A gate; no material harm (history clean, repo private); remote 2 commits behind; deviation recorded here and the "nothing pushed" statements in the vault/memory corrected. F4 LOW — db file perms. F5/F6 — tracked hardening + TM deltas folded into the skeleton charter. **Remediation:** `docs/security-remediation-plan-2026-07-09.md`, junior-dev executable, assigned to **Opus 4.8**. Approver: Karl (Orchestrator). Method: operator-directed review.

**Ruling — 2026-07-09: Decision C freeze exception — CLI-channel prototype spike + deployment-architecture design authorized.** During the Ruling C feature freeze, Karl verbally authorized two bounded items of non-`feat:` work in the 2026-07-09 session (recorded here the following session, per handoff `docs/handoffs/2026-07-09-cli-channel-prototype.md`, so the record stays honest): (1) a **non-shipping proof-of-concept spike** of the Claude Code "channels" auto-relay loop, living in `prototypes/cli-channel-loop/`, README-marked as proof-of-concept, committed only as `chore(spike):`/`docs:` (never `feat:` — no Build Loop is opened; the pre-commit gate stays intact); and (2) a **deployment-architecture design doc** (harness-as-container reached via webpage; dev CLI sessions in tmux; channel MCP server on the dev machine). Design authority: `docs/2026-07-09-cli-comms-autonomy-design.md`. Scope limits: the spike is not wired into the harness build, ships nothing above the MVP cutline, and promotion from spike to product is post-skeleton and requires its own ADR plus a recorded decision. The freeze itself is unchanged — the walking skeleton remains the critical path. Approver: Karl (Orchestrator). Method: verbal instruction during the 2026-07-09 session; recorded retroactively by claude-code per the handoff.

**Ruling — 2026-07-09: Bifrost NOT adopted — R18 built in-house; the same-day Decision F amendment is reversed.** Operator ruling (Karl), closing the household's open Bifrost decision (bus 1087): Bifrost is not adopted for the brain plane. Rationale: build-over-adopt — running a large 23-provider platform to use a small sliver of it fails the audit-economics half of the four-part adopt test (the adoption-creep concern Alden-1 raised in bus msg 1091), and the number of walls required to make it doctrine-safe (W1–W4 + negative tests) was itself the signal. Consequences: (1) the earlier 2026-07-09 "no hand-built meter, ever" amendment is REVERSED — original Decision F is restored: the per-identity cost meter / R18 ledger seed is hand-built into the walking skeleton (with Bifrost out there is only ONE accounting authority, so the P4 two-authorities risk that motivated the amendment no longer exists); (2) the Wall 4 credential-custody question DISSOLVES — no second key-custody location arises; the Peta-vault invariant stands untouched and the consent-gated household question is withdrawn; (3) Wall 2's boot-hash verification mechanism SURVIVES independently (already generalized to all projection targets under ADR-0006); (4) ADR-0008 will not be drafted; the walled-spike plan and skeleton scope item 6 are replaced by the restored meter item; (5) unchanged: Bifrost remains OFF the gateway fallback ladder, the non-promotion rule stays on file as a guard should Bifrost ever be reconsidered, and the Turnstone rejection + T1–T6 borrows are unaffected. The eval doc stands as the decision record with this outcome noted at its head. Approver: Karl (Orchestrator). Method: operator ruling reported 2026-07-09 (build-over-adopt).

**Ruling — 2026-07-09: D-ENC resolved — enclosure A: Debian VM on Proxmox running Docker Compose.** Confirms the design of record (Bible §11 + deploy-target memory) over the LXC alternative, per the analysis in `docs/2026-07-09-deployment-topology-container-tmux.md` §2 (strongest isolation for the SSH-key-custody host TM-020, no Docker-in-LXC nesting friction, zero re-decision on ratified artifacts). The fresh-install script and the walking-skeleton deploy target proceed against a Debian VM; the in-guest Compose stack is unchanged. Approver: Karl (Orchestrator). Method: structured decision (pending-approval sentinel), recommended option accepted.

## Approval History

| Date | Gate / Event | Decision | Notes |
|---|---|---|---|
| 2026-06-13 | Scope Change — M15/D10 Configuration page promoted to MVP | Approved | Operator-approved; see Scope Changes section. |
| 2026-06-13 | Scope Change — Gitea access resolved (direct client; token rotation/vault follow-up) | Approved | Operator-approved; resolves prior Operator Input; see Scope Changes section. |
| 2026-06-13 | Scope Change — Claude-CLI SSH-terminal modality (ADR-0005 / DevMachine / TM-020 / M16 / D11 / C.6) | Approved | Operator-approved; new requirement; see Scope Changes section. |
| 2026-07-06 | Alden Ecosystem Phase −1 ratification — masters v1.2, amendments A1–A4 | Approved | Household consent (Alden-1 1053 · Cloud Alden 1061) + operator approval; Winston consulted; see section above. |
| 2026-07-06 | Alden Ecosystem decide-before-build register R1–R4 + R16 recorded | Approved | R16 = 7 days / 3 rounds. Phase 0 gate clear. |
| 2026-07-06 | Ruling — Winston excluded from governance decisions (interim) | Approved | Phase −1 consultation obligation closed; revisit as identity matures (R12). |
| 2026-07-06 | Ruling — Phase 0 executed by Claude (Opus 4.8, ultracode), Sunday 2026-07-12 after usage reset | Approved | Docs package precondition; Alden-1 notified not to self-execute. |
| 2026-07-06 | §0.1 alden-infra = private GitHub + Gitea mirror · §0.2 OS hardening = yes | Approved | All five §0 pre-build inputs now resolved except §0.5 qwen-code (Phase 3 concern). |
| 2026-07-09 | Ruling B — LibreChat deploy-and-verify spike (resolves re-validation R1) | Approved | Spike inside the walking skeleton; fallback pre-authorized. |
| 2026-07-09 | Ruling C — feature freeze until walking skeleton passes | Approved | Charter: docs/walking-skeleton-milestone.md. |
| 2026-07-09 | Ruling D — registry is a projection of alden-infra (ADR-0006) | Approved | Git master, one-way sync; design before Alden Phase 3. |
| 2026-07-09 | Ruling E — Facade session binding + C.7 busy-queue signal | Approved | Bible §5 DM-4, §9 C.1/C.7. |
| 2026-07-09 | Ruling F — streaming + cost meter in skeleton; machine auth designed now, built Phase 3 | Approved | Cost meter = R18 seed. |
| 2026-07-09 | Ruling G — admin/Facade full service split (ADR-0007) | Approved | Operator chose stronger option than recommended. |
| 2026-07-09 | Ruling H — BUGS.md index backfilled (H1); ADR-0002 amended to as-built + pino at skeleton (H2) | Approved | Release-notes complaint withdrawn (correct pre-Phase-4). |
| 2026-07-09 | Ruling I — scaffold deleted; peta-eval kept for security review; colorblind audit in skeleton AC; build-plan line-63 fix | Approved | Gitea mirror edit deferred to post-rotation. |
| 2026-07-09 | Project security review (Fable 5) — history CLEAR, deps/SAST clean; F1 eval stack live+exposed, F2 tokens unrotated, F3 early-push deviation | Approved | Remediation plan assigned to Opus 4.8: docs/security-remediation-plan-2026-07-09.md. |
| 2026-07-09 | Turnstone REJECTED as adoption; borrow patterns T1–T6; quarterly watch | Approved | Doctrine inversion + audit economics; see Turnstone+Bifrost eval doc. |
| 2026-07-09 | Decision F AMENDED — R18 = adopt Bifrost (walled, timing-flexible spike); no hand-built meter | Approved | Resolves the flagged F↔Bifrost conflict; see Turnstone+Bifrost eval doc. |
| 2026-07-09 | Ruling C freeze exception — CLI-channel prototype spike (`prototypes/cli-channel-loop/`, `chore(spike):` only) + deployment-architecture design doc | Approved | Verbal, recorded retroactively per handoff; freeze otherwise unchanged; promotion post-skeleton via ADR. |
| 2026-07-09 | D-ENC — harness enclosure = Debian VM on Proxmox running Docker Compose (recommendation A accepted) | Approved | Confirms Bible §11; gates fresh-install script + skeleton deploy target. |
| 2026-07-09 | Bifrost NOT adopted — build-over-adopt; F amendment reversed (meter back in skeleton); Wall 4 dissolved; ADR-0008 not drafted | Approved | Closes bus-1087 decision; non-promotion rule + Turnstone outcome unchanged. |
