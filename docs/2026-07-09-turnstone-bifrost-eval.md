# Turnstone + Bifrost — Adoption Evaluation & Harness Build-Out Plan (2026-07-09)

**Purpose:** Karl asked for one more system to be evaluated before final decisions:
Turnstone (`turnstonelabs/turnstone`), plus a code-level look at Bifrost
(`maximhq/bifrost`) — which the household is actively deciding for the brain plane (bus
msg 1087) and which conflicts with Decision F (skeleton cost meter) per the APPROVAL_LOG
flag. This document is (1) the deep-dive eval of both against the ratified architecture,
and (2) the comprehensive plan for what is usable from each to build out the harness.

**Method:** both repos shallow-cloned 2026-07-09 (Turnstone `main` @ v1.7.0rc1 /
release v1.7.2 same day; Bifrost core v1.6.3) and mapped file-by-file by reader agents;
the four load-bearing Bifrost claims (file-only config mode, always-registered `/mcp`,
pre-request budget short-circuit, self-hosted provider support) were then verified
directly in source by the evaluator. Extends `docs/2026-07-02-landscape-revalidation.md`.

**Evaluation criteria:** Alden-1's four-part adopt/build test (orthogonal-to-identity ·
fully-auditable · firewall-able · cheaper-to-audit-than-build), the ratified principles
(P4 single source of truth, P5 permission-at-the-gateway/CC3, D4 durable approval,
identity isolation), the walls from the Bifrost proposal round (Wall 2 config
projection, Wall 4 credential custody, non-promotion rule), and Decision C's freeze.

---

## Executive verdicts

| System | Verdict | One-line reason |
|---|---|---|
| **Turnstone** (whole system) | **REJECT as adoption** — register as pattern quarry + watch item | Opposite security doctrine (approval-prompt + advisory LLM judge as the boundary vs our deterministic gateway), cosmetic identity model, in-memory (not durable) approvals, plaintext provider keys, 180k-LOC solo-maintained codebase fails cheaper-to-audit-than-build |
| **Turnstone** (patterns) | **BORROW** — 6 specific patterns identified | Apache-2.0 permits it; each pattern is small, auditable, and lands in a component we're building anyway |
| **Bifrost** (brain plane only) | **ADOPT with walls, via a skeleton spike** — pending household consent | Verified: it genuinely is R18 off the shelf (and *stronger* — pre-spend blocking, not post-hoc), plus it deletes the Facade's Anthropic-translation and retry/failover build items; every ratified wall is implementable and testable |
| **Bifrost** (tool plane) | **REJECT — unchanged** | Non-promotion rule stands; `/mcp` endpoints are unconditionally registered in code, so the wall must be enforced at Caddy + config, with negative tests |
| **Hermes** (candidate #3) | **UNCHANGED — still frozen** | Not evaluated here; must pass the same four-part test before any adoption discussion |

The 2026-07-02 re-validation conclusion **survives Turnstone**: nobody ships the
composition (gateway HITL × taint-by-presence × trust-labeled inspector × per-identity
isolation). Turnstone is the closest anyone has come on the harness plane, which makes
it a *validation* of the direction and a *watch item*, not an adoption.

---

## Part 1 — Turnstone deep dive

### What it is
Self-hosted, local-first orchestration for tool-using agents. Apache-2.0 since v1.6
(BSL 1.1 before; CLA required; copyright one individual — relicense risk is real but
backward-irrevocable for the versions we'd borrow from). Python 3.11+, ~141k LOC + ~40k
JS, ~8,400 test functions, mypy --strict, 3-version CI matrix. 740★, 110 releases,
solo-maintainer-plus-six profile, AI-assisted development workflows in its own CI.
Ships: terminal REPL, web UI with parallel "workstreams," cluster console with
rendezvous routing, Discord/Slack gateway, cron scheduler + watch DSL, coordinator
agents that spawn/steer child workstreams, "Personas," typed/scoped BM25 memory, MCP
client with glob tool-policies (allow/deny/ask), two-tier advisory judge + output
guard, RBAC/OIDC/audit/usage tracking, eval harness + self-modifying prompt optimizer.

### Why it fails the adopt test (as a system)

1. **Doctrine inversion (disqualifying).** Its own code comments state the position:
   bash safety is a "soft guardrail… trivially bypassable… The user approval prompt is
   the primary security boundary" (`turnstone/core/safety.py`). The pre-execution judge
   is an **LLM grading tool calls** — advisory, and a model deciding what a model may do
   is precisely what CC3/P5 forbid ("never by trusting the model's self-report"). The
   output guard "annotates but never gates." Approval is enforced **in-process,
   in-memory** (`threading.Event`), recovered after a crash by *stripping the turn* —
   not a durable, out-of-band, first-decision-wins queue (D4). Every enforcement point
   sits on the wrong side of our trust boundary: inside the harness process, client-side.
2. **Identity is cosmetic, not structural.** Personas = base prompt + tool visibility +
   MCP/memory toggles. No per-identity credential custody, no per-identity memory
   stores (one shared DB, scoped rows), no per-identity gateway users, no immutable
   identity↔backend binding. Incompatible with "identity is docs + memories" +
   per-identity Peta users + per-identity Qdrant collections.
3. **Custody:** LLM provider keys stored **plaintext** in `config.toml`/DB column
   (`storage/_schema.py:834`) — fails the vault invariant outright. (Ironically its
   per-user MCP OAuth tokens *are* Fernet-encrypted.)
4. **Audit economics:** 180k LOC, releases near-daily, one primary author. The audit
   burden of adopting it as the trust-bearing harness exceeds building our ~5k-LOC
   control plane many times over. Fails cheaper-to-audit-than-build decisively.
5. Misc: binds `0.0.0.0` by default; no vector memory (BM25 lexical only — our
   ratified memory design is per-identity Qdrant + tiered promotion); no
   OpenAI-compatible *server* surface (its UI is welded to its own engine, so it cannot
   front our Facade — it does not even compete with LibreChat for our chat modality).

### What it validates (independent convergence — worth telling the household)
- **Personas are "resolved once and snapshotted at creation"** — the exact
  identity-fixed-at-session-creation rule we ratified (no mid-session swap).
- Its memory taxonomy (user/project/feedback/reference × scopes) and "metacognitive
  nudge" pattern converge with our memory-tier thinking.
- Its scheduler + watch DSL + idle-nudge is a working Autonomy-Driver/Oscillator shape.
- A fast-moving Apache harness with approvals/policies/audit means the harness-plane
  landscape is compressing. **Watch trigger for the next quarterly re-validation
  (~2026-10):** if Turnstone ships (a) gateway-side durable approval, (b) structural
  per-identity isolation, or (c) vector memory, re-run the adopt test.

### What to borrow (the pattern quarry — all build-side, small, attributed)

| # | Pattern | Lands in | Size |
|---|---|---|---|
| T1 | **Output-guard pattern library** (regex families for injection/override/credential-leak/encoded payloads, arXiv-cited) — as *advisory annotations* on `trusted:false` blocks in our inspector; never a gate (matches both our doctrine and, notably, Turnstone's own annotate-don't-gate stance) | Facade grounding pipeline / C.2 inspector | S |
| T2 | **Watch/condition DSL + idle-nudge** shape for wake-loop triggers | Autonomy Driver (Alden Phase 8 design input) | M (design borrow) |
| T3 | **Coordinator spawn/steer API surface** (`spawn_workstream`, `wait_for`, `close_all_children`) as the vocabulary for future cross-identity orchestration | Bridge/bus design, post-restructure | design-only |
| T4 | **Interrupted-conversation repair** (strip incomplete turn on resume) as the Facade's crash-recovery behavior for in-flight turns | Facade session handling (Decision E work) | S |
| T5 | **Skill security scanner** concept (scan-at-install for prompt bundles) for our identity-package/template pipeline | Registrar (Alden Phase 5) | M |
| T6 | **SSRF guard** shape (DNS re-resolution per redirect hop) for any control-plane web fetcher | obsidian-mcp / future web tools | S |

Attribution note: Apache-2.0 permits copying with NOTICE preservation; T1/T6 involve
actual code lifts — carry the attribution in our NOTICE file.

---

## Part 2 — Bifrost deep dive (brain plane)

### The R18 question, answered with code
Cloud Alden's claim (bus 1087) that Bifrost's governance "IS R18 off the shelf" is
**substantively confirmed, and understated**. Verified in source:

- **Pre-spend enforcement, not post-hoc accounting.** `GovernancePlugin.PreLLMHook`
  short-circuits the request *before the provider call* when a budget/rate-limit/model
  rule fails (`plugins/governance/main.go:1280+`). Our planned Decision-F meter was
  post-hoc (count after spend). For the R18 safety property — "an oscillating identity
  on a metered brain must not run unbounded" — blocking-before-spend is the stronger
  form. Budgets are dollar-based with reset windows (calendar-alignable); **token**
  and request rate-limits exist separately per window — which also serves R6
  (oscillator per-phase budgets) on free local brains where dollars are $0.
- **The ledger is real.** Every request logs provider, model, tokens (incl. cached),
  dollar cost, virtual key, selected provider key, retries/attempt trail, latency,
  status into a queryable store (SQLite/Postgres) with `/api/logs*` + dashboards.
  **One identity = one virtual key** maps exactly onto our identity model (mirror of
  "one identity = one Peta user" on the tool plane).
- **It deletes Facade build items.** Anthropic `/v1/messages` is supported natively
  outbound (the Facade's `"anthropic translation not yet wired"` seam disappears — the
  Facade speaks OpenAI-compat to Bifrost for every brain, incl. `claude-api`);
  retries/key-rotation/provider-fallback come free; local brains are first-class
  (VLLM/Ollama/SGLang provider types, verified `framework/configstore/tables/key.go:69-77`
  — our `.89` llama.cpp and `llm-mini` route through it as OpenAI-compatible endpoints).
- Single static Go binary (Alpine image, ~512MB GOMEMLIMIT guidance), SQLite by
  default, `localhost` bind **by default**, single-node OSS (multi-node is enterprise —
  irrelevant to us).

### The walls, verified implementable

- **Wall 2 (config projection / P4):** Bifrost has a **file-only declarative mode** —
  `config_store.enabled: false` → config loads from `config.json` into memory at
  startup; **UI/API config writes are unavailable**; changes require restart (verified
  `docs/deployment-guides/config-json.mdx:17-23`). This is exactly ADR-0006's shape:
  the Registrar (Phase 3) *generates* `config.json` from the alden-infra Profile
  (brains, VKs per identity, budgets), and Alden-1's boot-verification amendment is
  implementable as a systemd `ExecStartPre` that hashes `config.json` against the
  Profile-recorded hash and **refuses to start on mismatch**. No second writable
  record exists at all in this mode.
- **Non-promotion rule (zero MCP):** configure zero MCP clients — but note the honest
  caveat found in code: **`/mcp` (POST + SSE) and the web UI are registered
  unconditionally; no flag removes them** (`handlers/mcpserver.go:137-138`,
  `server.go`). The wall therefore has three layers: zero MCP clients configured
  (empty registry), `localhost` bind so only the Facade (same host) can reach it, and
  **Caddy path-denies on `/mcp`, `/api/*`, and the UI root** — same pattern as Peta's
  `GET_OWNER` deny (ADR-0003). Each gets a negative test in the skeleton checklist.
- **Wall 4 (credential custody — household question, still open):** facts for the
  consent round: provider keys in Bifrost are `SecretVar`s **encrypted at rest** when
  an `encryption_key` is set (env-supplied master key), or referenced as `env.*` so
  the raw key lives in a root-owned 0600 systemd EnvironmentFile and never in any DB.
  True vault integration is **enterprise-only** — not available to us. **Recommended
  resolution: a bounded, recorded exception** — brain-plane *LLM API keys only* (never
  tool/write credentials) may be custodied as env-refs + encrypted store on the
  control-plane LXC, with compensating controls: encryption key in systemd env, D8
  no-logging discipline, pre-spend budgets capping the blast radius of key misuse, and
  the brain `classification: local|cloud-ok` gate covering the data-egress dimension.
  Rationale: the vault invariant was written for write-capable tool credentials; a
  metered-LLM key's risk profile (spend + egress) is exactly what Bifrost's budgets and
  our classification gate control. Alternatives remain as posted (Peta injects /
  amend invariant).
- **Two walls this eval adds (new — not in the bus round):**
  - **Semantic cache OFF.** Bifrost's semantic-caching plugin returns similar-enough
    cached responses — across virtual keys that is **identity bleed** (one identity
    receiving a response shaped by another's conversation). Must never be enabled for
    the household. (Config: plugin simply not loaded; negative check in the spike.)
  - **Ledger redaction/retention.** Bifrost's log rows carry **full request/response
    payloads by default** (redactable). Our F6(d) rule says the ledger carries counts
    and cost, never content. Configure payload redaction (and retention) at deploy;
    verify a smoke-test log row shows tokens+cost with no prompt text.

### Four-part test (brain plane, with walls)
- *Orthogonal to identity*: ✓ pure substrate transport + accounting; identities appear
  only as VK labels.
- *Fully auditable*: ✓ bounded — we run three OSS plugins (governance, logging,
  telemetry-optional) and the router; MCP/UI surfaces are walled; pin the version and
  re-audit on upgrade exactly as ADR-0003 mandates for Peta. Caveat: upstream releases
  every 2–5 days — we pin and upgrade quarterly, not track head.
- *Firewall-able*: ✓ localhost bind default + Caddy path denies + `enforce_auth_on_inference`
  with per-identity VKs; negative tests in the checklist.
- *Cheaper to audit than build*: ✓ the build alternative (Anthropic translation +
  streaming retry/failover + pre-spend budget engine + ledger + query API, solo, in
  TS) is weeks of new trust-bearing code plus permanent maintenance; the adopt
  alternative is config + walls + a pinned upgrade cadence.

### Division of labor (resolves the flagged Decision E/F frictions)
| Concern | Owner | Why |
|---|---|---|
| Session↔identity↔brain binding, no-mid-session-swap | **Facade** | Ratified; Bifrost has no session concept |
| Single-slot admission, honest queue (C.7), interactive-preempts-background | **Facade** | Bifrost load-balances/fails-over but has no preemption or slot semantics — Decision E stands unchanged, in front of Bifrost |
| Grounding, taint, inspector | **Facade** | The trust boundary; never delegated |
| Provider translation (incl. Anthropic), retries, key rotation, fallbacks | **Bifrost** | Verified native; deletes Facade seams |
| R18 ledger + pre-spend budgets + R6 token windows | **Bifrost** | Verified stronger than the planned meter |
| Brain registry source of truth | **alden-infra (git)** → Registrar generates Bifrost `config.json` (projection, hash-verified at boot) | ADR-0006/Wall 2 |
| Tool calls, write approval, tool credentials | **Peta — unchanged** | Non-promotion rule; Bifrost never touches tools |

---

## Part 3 — The comprehensive harness build-out plan

### Final component map (what the harness is made of, after this eval)

| Plane | Component | Source | Status |
|---|---|---|---|
| Harness UI | LibreChat (chat modality) | ADOPT (ADR-0001) | Decision B spike in skeleton |
| Harness UI | Harness frame + xterm terminal tabs | BUILT | done, live UAT pending |
| Control | Facade (binding, taint, queue, SSE proxy, inspector) | BUILD (ADR-0007 split) | preprocessor built, mounting in skeleton |
| Control | Admin service (config/approvals/terminal) | BUILT | done |
| Control | Registrar (profiles, provisioning, **Bifrost-config generator**) | BUILD | Alden Phase 3/5 |
| **Brain** | **Bifrost (router + R18 ledger + budgets)** | **ADOPT w/ walls — this eval** | household consent → skeleton spike |
| Brains | 122B / 27B / qwen-code / claude-api | existing/hardware-gated | claude-api unblocks after Wall 4 + R18 live |
| Trust core | Peta gateway (tool authz, durable HITL, vault) | ADOPT (ADR-0003) | prod deploy in skeleton |
| Household | Alden Bridge, Qdrant memory + tiers | BUILD/existing | Alden Phases 0/2/6 |
| Substrate | alden-infra (git master), identity packages | BUILD | Alden Phase 1 |
| — | Turnstone patterns T1–T6 | BORROW | backlog, sized above |
| — | Hermes | FROZEN | four-part test required first |

### Proposed ruling to resolve the flagged R18 conflict (for Karl; household consent for the Bifrost half)

**Amend Decision F:** the skeleton does **not** hand-build a cost meter. Instead:
1. **If household consent on Bifrost lands before skeleton execution** (it is already
   mid-decision): the skeleton includes a **Bifrost spike** — deploy v1.6.3-pinned,
   file-only config mode, walls on (zero MCP clients, Caddy path-denies, semantic cache
   off, ledger redaction, localhost bind), routing Facade → Bifrost → 122B. Acceptance:
   the smoke-test conversation appears in Bifrost's ledger attributed to the identity's
   VK with tokens counted and **no payload content stored**; `curl` negative tests on
   `/mcp` + UI from the LAN are denied; kill-Bifrost test → Facade surfaces a labeled
   C.7-style "brain unreachable" error (fail closed, no silent retry storm).
2. **If consent has not landed:** the skeleton proceeds with **no meter at all** — the
   skeleton has zero metered brains, and R18 only gates *metered* use, so nothing is
   lost; the Bifrost spike becomes the first post-skeleton item. Either way, **no
   second accounting authority is ever built** (P4 preserved).

Streaming (Decision F item 1) is unchanged — the Facade still passes SSE through
itself. Machine-auth design (item 3) unchanged. Decision E unchanged (queue is the
Facade's, in front of Bifrost). Charter edits required: replace scope item 6
(cost-meter middleware) with the conditional Bifrost spike; add the negative tests and
the redaction check to the acceptance list; note ADR-0008 (Bifrost adoption) is drafted
from this eval **after** household consent, amending the brain-plane topology.

### Sequencing (respecting the freeze, the remediation, and the household)

1. **Now:** Karl reads this eval → posts Part 2 (incl. the two new walls) to the
   household's open Bifrost decision; rules on the Decision F amendment above.
2. **Unchanged:** Opus 4.8 executes `docs/security-remediation-plan-2026-07-09.md`
   (rotations, eval decommission, push, mirrors). Independent of this plan.
3. **Skeleton executes** per its charter + the amendment (with or without the Bifrost
   spike, per consent timing). Freeze holds for everything else.
4. **Alden Phase 3** (brain registry): Registrar generates Bifrost `config.json` from
   alden-infra (VK per identity, budgets, brain classifications) + records its hash in
   the Profile; boot-verification wired (Wall 2 mechanism → applies to the
   control-plane registry projection too, per Alden-1's strengthening).
5. **claude-api brain + Cloud Alden re-founding (R14)** unblock once Wall 4 is
   consented and the ledger is live — the R18 prerequisite is then satisfied by
   Bifrost, verified, not planned.
6. **Turnstone patterns** enter the backlog (T1/T4/T6 small — natural post-skeleton
   items; T2/T3/T5 are design inputs to Alden Phases 5/8).
7. **Quarterly landscape watch (~2026-10):** Turnstone re-check (triggers above),
   Bifrost upstream re-audit + pin bump, Hermes still frozen unless Karl asks for its
   four-part test.

### Risks & exits

- **Bifrost upstream velocity** (releases every 2–5 days): pin v1.6.3; quarterly
  re-audit + bump; never track head. Watch for OSS→enterprise feature migration
  (vault integration is already enterprise-only) — the walls only depend on OSS
  features verified in this eval.
- **No custom Go plugins.** Bifrost's `.so` plugin path requires same-OS/arch/Go-version
  builds — a treadmill we refuse; all policy stays in the Facade and Caddy. (Design
  rule, record in ADR-0008.)
- **Unremovable `/mcp` + UI routes**: mitigated by three-layer wall + negative tests;
  if a future version widens that surface, the pinned version does not move until
  re-audited.
- **Exit path** (cheap, by design): file-only config means removing Bifrost = point
  the Facade's brain URLs back at the endpoints directly and lose translation/
  budgets/ledger; ledger history exports via `/api/logs` beforehand. No data or
  config is held hostage.
- **VM sizing**: the skeleton VM now hosts LibreChat(+Mongo+Meilisearch), two
  control-plane services, Peta(+Postgres), obsidian-mcp, Caddy, and Bifrost
  (~0.5GB) — provision **16GB RAM** to be comfortable.

---

*Evaluated versions: turnstone main @ 2026-07-09 (v1.7.0rc1 package, v1.7.2 release
same day); bifrost core v1.6.3 / governance plugin per repo @ 2026-07-09. Clones in
session scratchpad; not vendored. Reader-agent maps verified on load-bearing claims by
direct source inspection.*
