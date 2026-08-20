# Capability-Gap Study — Operator Decisions (2026-08-20)

> **STATUS: DECISION LEDGER, in progress.** Karl's ruling on each suggestion in
> `docs/research/2026-08-20-harness-capability-gap-study.md`, taken one at a time on
> 2026-08-20. This ledger is the input to (a) the Fable architecture-conflict review,
> (b) the doc/Bible/README updates, and (c) the Opus 5 build plan. Amendments Karl added
> beyond the study text are marked **[AMENDMENT]** and are themselves binding.

Legend: **ADOPT** = approved, tracked at the stated priority · **DEFER** = accepted in
principle, not scheduled · **REJECT** = not doing it.

## Terminal plane

| # | Suggestion | Study prio | Decision | Notes |
|---|---|---|---|---|
| TP-1 | Deterministic wake/relay guardrails (rate cap + deny-by-default allowlist) | HIGH | **ADOPT** | Into the waker promotion. |
| TP-2 | Approval-pending push notification (notify-only) | HIGH | **ADOPT + [AMENDMENT]** | Plus a **dedicated "Pending Approvals" section** that aggregates every waiting approval across ALL sessions in one place — Karl must not have to hunt session-by-session. The ping stays reference-only (D8); resolution stays on the D6 admin surface; the aggregated inbox is a new admin-surface view. |
| TP-3 | Scoped machine tokens for CLI sessions (read/propose only) | HIGH | **ADOPT** | Builds on `docs/machine-auth-design.md`. No management scope, ever (TM-011). |
| TP-4 | Durable cross-project task board (kanban) | MEDIUM (new scope) | **ADOPT — PROMOTED TO MVP + [AMENDMENT]** | Karl promoted this from post-skeleton to **MVP scope** (overrides the study's milestone-2 placement and the freeze-defer). **[AMENDMENT]** each session runs a cron that checks/updates the board every ~30s so tasks don't get ignored. **Open reconciliation for the architecture review:** the 30s poll must NOT wake the model every tick (Max-quota + TP-5 wake-cost + TP-1 "new turn only when idle" conflict) — implement as a lightweight harness-side poll that injects a turn only on an actual board change while the session is idle. |
| TP-5 | Wake-cost levers | MEDIUM | **ADOPT (partial) + [AMENDMENT]** | Adopt the **light-context wake** (small briefing, not full history — also serves WAKE-NOT-BODY). **REJECT the cadence-backoff-on-subscription lever** per Karl: "wake when needed, period; the plan caps itself; no budget risk." Design note (not a budget point): keep TP-1's idle/no-cache-bust delivery rule for prompt-cache + turn-integrity correctness, and be aware needless wakes can pause interactive work at a rate limit. |
| TP-6 | Claude Max quota gauge in the harness | MEDIUM | **REJECT** | Claude Code's own `/status` covers it; fragile undocumented surface; near the misuse line. |
| TP-7 | Durable terminal transcripts + search | LOW (study: skip) | **ADOPT (override) + [AMENDMENT] + DOCTRINE EXCEPTION** | Karl overrode the skip recommendation. Store records on the **NAS** (not local) to spare local storage. **CRITICAL:** NAS-vs-local addresses storage only, NOT the D8 issue — terminals display secrets, so recording creates an exfiltratable secret store wherever it lives. Adopted **only with**: redaction-before-write, encryption-at-rest on the NAS, access control, retention policy. This is a **deliberate exception to D8 + ADR-0005 (CLI sessions kept out of the data pipeline)** and REQUIRES its own APPROVAL_LOG ruling. Architecture review must surface **default-on vs per-tab opt-in** for Karl's final call. |

## Chat plane

| # | Suggestion | Study prio | Decision | Notes |
|---|---|---|---|---|
| CH-1 | Group-conversation mechanics (turn-taking/etiquette) for #7 | MEDIUM | **ADOPT as design input** | Applied when the C.8 group/channel surface builds. Presentation borrowed; bus substrate + per-identity provenance kept (no client-side authorship authority). |
| CH-2 | Context compaction policy for the Facade | MEDIUM | **ADOPT + [AMENDMENT]** | **[AMENDMENT]** architect it to **leverage Qdrant**: not just summarize but tag + offload older context to Qdrant and pull relevant pieces back on demand to save context. **Architecture reconciliation (REQUIRED):** Qdrant retrieval = recalled content ⇒ `trusted:false` + taints the session per the grounding pipeline (#13/#4); the compaction/restore path must run THROUGH the taint engine so it cannot launder tainted content into a "clean" summary. Ties CH-2 to the grounding pipeline design. |
| CH-3 | Usage insights view + token-sanitizer sub-item | MEDIUM-LOW | **ADOPT — sanitizer NOW, view later** | Fold the provider-token sanitizer into **step 6** while it builds this week (hours; hardens a charter item). Insights page = MEDIUM-LOW post-skeleton. Reads the single ledger only (P4); no content shown. |
| CH-4 | Model comparison (blind A/B + MoA) | LOW (new scope) | **ADOPT + [AMENDMENT] + HARD GUARDRAILS** | **[AMENDMENT, ruling A-4]** extend Compare to frontier models **via their SUBSCRIPTION CLI clients** (Claude Code, Gemini CLI, a ChatGPT CLI) — the same way Claude Code CLI is already used — NOT paid APIs. Karl holds Gemini + ChatGPT subscriptions. Goal: prove a local model can handle a task before reaching for a frontier one. **Consequences:** (1) **no out-of-plan per-token billing** — flat subscription cost; this moves Compare toward the terminal plane (drive each CLI, compare) rather than API calls; (2) **feasibility per provider must be verified** — each needs a headless-drivable CLI that authenticates on subscription (Claude ✓; Gemini CLI exists; ChatGPT/OpenAI CLI path TBD); (3) **#14a still binding** — Compare runs ONLY in bare/ungrounded sessions; no identity-grounded/tainted context to any frontier client; (4) egress (XC-3) must allow each CLI's phone-home. |
| CH-5 | Memory auto-consolidation — propose-only queue | LOW | **ADOPT (propose-only ONLY)** | Build the propose-only approval queue (drafts land as pending writes with mandatory provenance + prior-version kept). **Doctrine lock:** propose-only is the ONLY permissible form; background memory-writing by model judgement stays rejected (D2 + CC3). Alden-side owns memory-tier semantics; harness hosts the queue. |

## Cross-cutting

| # | Suggestion | Study prio | Decision | Notes |
|---|---|---|---|---|
| XC-1 | MCP tool-schema hostile-input hardening | HIGH | **ADOPT** | Deterministic caps + control-char stripping in the Facade/tool-proxy path; fail-closed (over-cap schema rejected + labelled). Extends CC3 to tool metadata. |
| XC-2 | `pantheon doctor` — health + negative-security checks | HIGH | **ADOPT — START DURING SKELETON** | Begin now; serves the assembly/debugging phase + a non-programmer operator. Negative checks include the untested obsidian-mcp vault-confinement transport. Grows one check at a time. |
| XC-3 | Outbound egress allowlisting for the VM stack | MEDIUM | **ADOPT** | Post-skeleton hardening, folded into deploy work. Allowlist must include CH-4's frontier endpoints (Anthropic/Gemini/OpenAI) once Compare lands, plus apt/npm mirrors + LAN services. Ship with a doctor (XC-2) egress check. |
| XC-4 | Tool-effect taxonomy beyond read/write | MEDIUM | **ADOPT** | Do it while tool tables are young (retrofit is expensive — cf. P6). Populates R4's mandated `tier` column with Odysseus's taxonomy (effect axis + result-integrity axis). Metadata only; MVP gating semantics unchanged. |
| XC-5 | Approval-mechanics harvest (tighten-only + large-payload gist/diff) | MEDIUM | **ADOPT** | Lands with C.3. Records the P4/P8/C-12 convergence as validation; adopts tighten-only invariant + gist-then-full-diff (gist never replaces the diff, only stages it behind one labelled click; D4 stays honest). |
| XC-6 | Fail-closed inbound-adapter allowlist as written invariant | LOW (free) | **ADOPT** | One sentence in the Bible next to CC2 + a negative test per adapter. |
| XC-7 | Security-CI additions (hadolint + Trivy + OSV) | LOW | **ADOPT** | Closes the container-image scan gap over the now-real deploy artifacts. |
| XC-8 | External secret source at process start | LOW (was UNKNOWN) | **ADOPT + [AMENDMENT]** | Target confirmed: **Karl's existing Vaultwarden on Proxmox**. Startup-fetch of service tokens; complements (never replaces) Peta's vault for tool creds. Architecture must decide fail-behaviour if Vaultwarden is unreachable at start (availability vs. fail-closed). |

## Tally

- **19 ADOPT, 1 REJECT** (TP-6 quota gauge).
- **Binding amendments beyond the study:** TP-2 (unified Pending-Approvals inbox), TP-4 (promoted to MVP + per-session 30s board cron), TP-5 (light-context yes / cadence-backoff no), TP-7 (override to build + NAS storage + **D8/ADR-0005 exception**), CH-2 (Qdrant-backed compaction), CH-4 (frontier-model Compare), XC-8 (Vaultwarden target).
- **Start during the skeleton (need freeze handling):** XC-2 `pantheon doctor`; CH-3 token-sanitizer (folds into step-06, already a skeleton step).
- **Everything else is post-skeleton** roadmap under Ruling C.

> **STATUS: DECISIONS COMPLETE 2026-08-20.** Next: architecture-conflict review, then
> architecture/doc/README updates, then the Opus 5 build plan.
