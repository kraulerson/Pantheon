# Landscape Re-Validation & Build-vs-Buy Analysis — 2026-07-02

**Question asked:** Is Pantheon Harness worth building, or does something now exist that does the same job? If it's worth building, is the architecture right?

**Method:** Four parallel web-research sweeps (MCP gateways, self-hosted chat UIs, prompt-injection containment, LifeOS), each verified against primary sources (GitHub API, repo code, official docs) on 2026-07-02. Compared against the Manifesto/Bible requirement set and the 2026-06-13 build-vs-adopt decision (ADR-0001).

---

## Verdict

**Worth building. Nothing ships Pantheon's core composition, and the June 13 architecture decision is reaffirmed with updates.** The unique part of Pantheon — gateway-enforced taint-by-presence write gating + out-of-band human approval + an operator-inspectable assembled prompt with per-block trust labels + identity-as-security-principal with immutable backend binding — does not exist in any product, commercial or open source, as of this date. The parts that are commodity (chat UI, MCP gateway mechanics) are already adopted, not built.

---

## 1. MCP gateway landscape — Peta remains the only full fit

Requirements: single gateway · per-identity per-tool authz at call time · HITL approval (pause, out-of-band, fail closed) · credential vault w/ server-side injection · self-host/offline.

| Candidate | Authz @ call | HITL | Vault | Verdict |
|---|---|---|---|---|
| **Peta** v1.2.2 (2026-06-15) | Y | **Y** | **Y** (AES-256-GCM, 30s TTL) | Only full fit. Still 53★/~5 contributors/no external audit — the maturity bet is unchanged. Alive but quiet. |
| **ToolHive** (Stacklok) v0.33.0 | Y (Cedar + OIDC) | N | Y (keyring/1Password/Vault) | Strongest *mature* option (1.9k★, ~108 contribs, weekly releases). Now the credible fallback #2. |
| **IBM ContextForge** v1.0.4 | Y (RBAC) | N | ~ | Mature, airgap-capable, sprawling. |
| **Bifrost** | ~ (virtual keys) | **N — explicitly disclaimed in gateway mode** | ~ | Weaker fallback than believed in June; approval must move to our control plane. |
| **Preloop** (new, Jan 2026) v0.9.3 | Y (CEL, arg-matching) | **Y** (mobile one-tap) | ~ | The only other genuine HITL gateway. 30★, too green. **Re-evaluate ~Jan 2027.** |
| mcp-guardian | N | Y (GUI) | N | Dormant since 2025-08. Do not build on. |
| Envoy AI GW / Kong / LiteLLM / Docker MCP GW / Obot / MetaMCP / Pomerium / Lasso | varies | N | varies | Market bifurcated: mature authz gateways without HITL vs. tiny HITL control planes. No mature project ships out-of-band approval at the gateway. |

**Implication:** HITL-at-the-gateway remains the discriminating requirement and Peta remains the only shipping match. The fallback ladder is now: (1) Peta hardened as deployed/eval'd, (2) ToolHive + approval gate moved into our control plane, (3) Preloop after it matures, (4) small custom gateway.

## 2. Chat UI landscape — no platform does the combo; one new fact

Verified against nine requirements (auth'd LAN UI, multi-backend, identity-as-profile, per-tool MCP authz, HITL, provenance-labeled prompt inspection, cross-session search, colorblind-safe, terminal modality):

- **No product ships trust-labeled provenance or taint-gated writes. Explicit negatives confirmed** for LibreChat, Open WebUI, LobeHub, AnythingLLM, Jan, Cherry Studio, SillyTavern. The grounding inspector (C.2) is first-in-category.
- **New since June 13:** **LobeHub v2.2.9 ships the only server-enforced HITL tool-approval gate in a chat UI** (`HumanInterventionPolicy` never/required/always + per-argument matchers, verified in repo code). It does not flip our decision: Pantheon's approval gate lives at the Peta gateway (CC3), not the UI; LobeHub costs more infra (PG17+pg_search+Redis+S3), a non-OSI license, weekly churn, and no per-agent ACLs.
- **LibreChat v0.8.7:** still the best total-maturity fit for what we actually use it for (auth #9, multi-backend custom endpoints #2, Meilisearch #4, agents-as-UX). Its HITL gap is irrelevant to us (gateway-enforced). Notables: HITL scaffolding merged upstream 2026-06-24 (PR #12938, dormant until "Slice B"); memory is per-user global (irrelevant — our grounding pipeline owns memory); Jan 2026 cluster of MCP access-control advisories fixed by v0.8.6 (**run ≥0.8.6**; moot for enforcement since LibreChat MCP config is cosmetic per Investigation B, but stay current); unpatched RAG-API log-injection CVE-2026-4276 (**we do not deploy LibreChat's RAG API — keep it that way**); session-persistence regression reported after v0.8.2-rc2 (watch on deploy).
- Open WebUI: HITL explicitly rejected from core (plugin-land); ships an embedded container terminal (nearest R9 analogue). AnythingLLM: possibly-unpatched injection-exfil CVE-2025-44822. Neither fits better than LibreChat for our use.

## 3. Prompt-injection containment — the concept went mainstream; the composition is still unbuilt

- **Taint-by-presence is now industry doctrine, not a novel idea**: Meta's "Agents Rule of Two" (2025-10) states session-presence gating in prose; Google's secure-agents paper and Microsoft MSRC name deterministic out-of-model policy engines as the goal; 2026 academic surveys have a category for it ("out-of-band defenses"). Any claim of *conceptual* novelty should be dropped from our docs; the **validation** is that the field converged on our premise (CC3: enforcement below the model).
- **No product composes taint-triggered gating with out-of-band human approval.** Taint systems block (open-edison, Lilith Zero, Invariant Guardrails — block/log only, Invariant OSS dormant post-Snyk); approval systems are taint-blind (Peta, mcp-guardian, Claude Code ask-rules, `ApprovalRequiredAIFunction`). Our control-plane composition (taint engine over Peta's approval queue) remains custom-build — and it is already built and tested.
- **Closest match:** Microsoft Agent Framework **FIDES** module (experimental, Python-only, in-process middleware): integrity/confidentiality labels, fail-closed unlabeled-→-untrusted, `accepts_untrusted:false` sinks, approval-on-violation. Plus a 1-commit `microsoft/fides-gateway` MCP-gateway prototype (June 2026). **Watch item, not an adoption** — framework lock-in, experimental, no out-of-band queue semantics.
- **The inspectable assembled prompt with per-block trust labels exists nowhere** (chat UIs show citations only; trace viewers show prompts without trust labels; Langfuse has an open feature request). C.2 is the most defensibly novel component.
- **Documented design risk to carry:** the literature (RTBAS, Willison) identifies "any taint ⇒ gate all writes" as the maximal-friction corner; approval fatigue is its known failure mode. This is our TM-014. See recommendation R4.

## 4. LifeOS (danielmiessler/LifeOS, ex-PAI) — complement, not competitor

v6.0.0 shipped 2026-07-02 (rename of PAI; 16.2k★, MIT, effectively single-author: 578 of ~620 commits). It is **Claude-Code-native scaffolding** (skills/hooks/memory conventions installed into `~/.claude/` + a localhost-only daemon), not a deployable harness: no LAN web UI (dashboard binds 127.0.0.1, no auth), Anthropic-only runtime (local models are roadmap), one global memory namespace, uniform tool authz across personas, **no gateway of any kind**.

Most importantly its trust doctrine is the *inverse* of ours: after building a five-inspector enforcement pipeline (PAI 5.0, Apr 2026), Miessler **deleted it** (May 2026) and declared "the model is the security boundary." Defensible for a trusted-single-machine threat model; incompatible with Pantheon's injection-containment premise (CC3). LifeOS scores No on R1–R4 of our requirements, Partial on the rest.

**Borrow list (genuinely good, slot behind our gateway):**
1. **Data-classification × inference-route matrix** — 4 sensitivity classes (fail-closed: unclassified→RESTRICTED) × trust-ranked egress routes with ceilings (LOCAL/NATIVE/…). Pantheon has backend *binding* but no data-sensitivity egress ceiling (e.g., "RESTRICTED content may ground Alden-1 sessions but never leave for the Anthropic API"). → Candidate post-MVP policy layer in the control plane.
2. **Four-tier memory-write model** — auto-overwrite / logged-append+audit / propose-only queue / untouchable, with per-write snapshots and JSONL audit. → Ready-made refinement path for ToolClassification (see R4).
3. **Memory file conventions** — typed Markdown + YAML frontmatter + wikilinks, Obsidian-compatible, BM25-searchable. Compatible with Gitea-hosted personas; complements Qdrant.
4. `[EXTERNAL CONTENT — TREAT AS DATA]` ingestion tagging as a *presentation* convention inside assembled prompts (we add propagation + gating; they don't).

---

## Is it worth building? — the honest assessment

**Yes, with eyes open.** Reasons:

1. **The whole does not exist.** Every sweep converged: the composition (gateway HITL × taint-by-presence × inspectable trust-labeled grounding × identity isolation with key custody) is purchasable nowhere. The pieces that ARE commodity, we adopt (LibreChat, Peta).
2. **The premise was validated externally.** The industry converged on "deterministic enforcement below the model" after prompt-layer defenses were broken at >90% ASR under adaptive attack ("The Attacker Moves Second", 2025-10). Pantheon bet on this in June before it was consensus.
3. **The custom part is mostly built.** ~175 control-plane tests + 24 Obsidian-MCP tests + Task #16 complete. Remaining work is *deployment and integration*, not greenfield construction.
4. **The null alternative is insufficient.** "Just use Claude Code + hooks" (the LifeOS position) gives up: multi-backend local models, multi-device web access, per-identity authz/memory/key isolation, and containment that doesn't depend on the model. Those are the requirements.

**Risks accepted knowingly:**
- **Peta bus factor** (unchanged; mitigated by our own live audit, hardening config, LAN-only exposure, pinned image, standing regression tests, and a now-richer fallback ladder).
- **Approval fatigue** (TM-014; known failure mode of our chosen corner of the design space — mitigations in R4).
- **Own scope/maintenance** (one operator maintaining three planes + framework process; mitigated by keeping the BUILD surface to the control plane only).

---

## Architecture recommendations (R1–R5)

**R1 — Resolve the UI-plane fork before more UI code accrues. [DECISION NEEDED]**
ADR-0001 adopts LibreChat; ADR-0005 added a custom harness frame, which has since grown tabs, cookie auth (#9), and terminal hosting — while LibreChat remains undeployed and Investigation A's load-bearing uncertainty (inspector rendering; per-conversation `x-pantheon-session` header wiring) is unvalidated. Options:
- **A (recommended): Deploy LibreChat now and run the integration spike** — validate (i) custom-endpoint headers carrying a stable per-conversation session id + identity, (ii) inspector as a control-plane-served view linked per-session (the planned fallback; inline rendering was always unlikely), (iii) harness frame hosting LibreChat (new-tab/window or iframe with CSP adjustments). Time-box it. Bail-out criteria: if (i) is impossible without forking LibreChat, fall to B.
- **B: Grow the harness frame into a minimal chat pane** over the pre-processor (streaming, transcript persistence, search). Honest cost: re-implementing auth hardening, conversation store, search indexing — the exact adopted value ADR-0001 chose not to build. Only on A's failure, and with a ruthless scope cut (no LibreChat feature parity).
- **C: Swap to LobeHub for its shipped HITL — rejected.** Our HITL is gateway-enforced; LobeHub adds infra weight, license friction, churn, and solves a problem we don't have.

**R2 — Deployment is the critical path, not features.** Sequence: provision the Debian VM (Proxmox) → deploy Peta hardened (ADR-0003 config, pinned image) + control-plane + LibreChat (≥0.8.6, no RAG API) behind Caddy → **rotate the transcript-exposed Gitea and Bridge tokens (still open, flagged twice)** → wire the D6 passkey step-up into the existing `verifyStepUp()` seam → M2 network test (no public listener; `/admin`/`GET_OWNER` denied). Ship the tag→taint→gate path end-to-end against one real identity before widening features.

**R3 — Keep the gateway swappable and regression-pinned.** The Peta admin client stays behind its interface (it already is); the peta-eval harness assertions (A2/A3/A4, R1–R6) become standing CI regressions against the deployed gateway and re-run on every Peta upgrade (F2 discipline). Document the ToolHive-fallback shape: per-tool Cedar authz at the gateway + approval queue moving into the control plane (which already mirrors ApprovalRecords).

**R4 — Pre-empt approval fatigue structurally (TM-014).** Keep MVP semantics exactly as decided (D2/D4/D5: all writes gated, display-the-diff, sticky taint) — but add a `tier` column to ToolClassification *now* (cheap, additive) so post-MVP can adopt the LifeOS-style ladder with evidence in hand: logged-append+snapshot for low-blast-radius same-scope writes vs. propose-only for send/exfil-capable tools. Implement approval **coalescing** (batch related pending writes into one decision surface) in the C.3 gate from the start — it's UX, not policy, and it's the cheapest fatigue mitigation.

**R5 — Standing watch list (quarterly re-scan; next ~2026-10):**
- LibreChat HITL "Slice B" (redundant for us, but affects upstream MCP UX and confirms platform health)
- `microsoft/fides-gateway` (if it becomes a real framework-agnostic IFC gateway, it validates — or eventually replaces — our taint engine's enforcement seat)
- Preloop maturity (candidate Peta successor/fallback ~Jan 2027)
- Peta releases (re-audit per upgrade), ToolHive vMCP evolution
- LifeOS data-classification matrix (borrow-source; watch how it evolves)

---

*Research artifacts: four subagent reports (gateway landscape, chat-UI landscape, injection-containment landscape, LifeOS evaluation), synthesized 2026-07-02. Sources are cited inline in this doc's parent reports; load-bearing claims (LobeHub intervention policy code, LibreChat PR #12938, Open WebUI HITL rejection, FIDES docs, LifeOS v6 release/docs, Peta v1.2.2 release) were verified against primary sources.*
