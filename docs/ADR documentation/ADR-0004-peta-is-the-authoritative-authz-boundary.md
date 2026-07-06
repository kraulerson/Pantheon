# ADR-0004 — Peta is the authoritative authorization boundary; LibreChat Agent config is cosmetic

- **Status:** Accepted (reconstructed 2026-07-05 — see Provenance)
- **Date of decision:** 2026-06-13 (Phase 1, Investigation B)
- **Deciders:** Karl (operator), Solo Orchestrator Phase 1 review

## Provenance

`docs/phase-1/architecture.md` cites "ADR-0004" four times (lines ~54, 66, 145, 163),
but no ADR-0004 section was ever written — `PROJECT_BIBLE.md` §3 jumps from ADR-0003 to
ADR-0005. The decision itself **was** made and ratified as Phase 1
**Investigation B — "Dual-authz single source of truth"** (`docs/phase-1/architecture.md`
§ Investigation B). This document reconstructs that decision in ADR form so the citation
resolves. No new decision is introduced here; the normative text is Investigation B's.

## Context

Two places *could* express what tools an identity may use:

1. **LibreChat Agent configuration** — each LibreChat "Agent" maps roughly 1:1 to an
   Alden identity and can list tools in its config.
2. **Peta gateway policy** — per-identity tokens whose per-tool grants are enforced
   server-side at call time.

If both are treated as authoritative, they can disagree, and the weaker one (client-side
Agent config, which lives in the model's context and can be coaxed around by injected
content) becomes the effective boundary.

## Decision

**The Peta gateway is the authoritative security enforcement point. LibreChat Agent tool
configuration is UX/convenience only and is NEVER the trust boundary.**

Concretely:

- The control-plane mints exactly **one per-identity Peta token** with the correct
  per-tool grants and `dangerLevel:2` write flags; **that token's grants are the only
  thing that authorizes a call.**
- If LibreChat's Agent config and Peta's policy ever disagree, **Peta wins** and
  LibreChat's view is cosmetic.
- Gateway management (#11) is reachable only via the separate authenticated admin
  surface (D6), never via any tool exposed to a session.

## Rationale

The live eval proved Peta enforces per-tool authz **server-side, at call time**, denying
a tool the identity was not granted *regardless of what the caller/model requests*
(scenarios A2/R1 — the injection-containment property). Anything expressed in LibreChat's
Agent config is client-side configuration. Manifesto CC3: authorization, injection
containment, and write gating are decided **at the Peta gateway, never by trusting the
model's self-report.**

## Consequences

- Agent/identity tool lists shown in any UI are a *projection* of Peta policy, never an
  input to it. Divergence is a display bug, not a security event.
- Alden future-state alignment: this is the same rule as future-state principle P5
  ("Permission at the gateway, never at the model") — no rework needed when the Facade
  replaces/absorbs the pre-processor.
- Tool-grant changes are made against Peta (via the admin surface), after which UI
  configs may need refreshing to match.

## Related

- ADR-0001 (three-layer architecture), ADR-0003 (hardened Peta deployment)
- `docs/phase-1/architecture.md` — Investigation B (normative source)
- Alden Future-State Architecture §3.4 (Trust Core), principle P5
