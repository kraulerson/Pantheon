# ADR-0007 — Admin surface and Facade run as separate services (amends ADR-0001/0002 deployment shape)

- **Status:** Accepted
- **Date of decision:** 2026-07-09 (review decision session, Decision G — APPROVAL_LOG ruling)
- **Deciders:** Karl (Orchestrator) — chose the stronger option over the reviewer's recommendation

## Context

The control-plane Fastify app has accreted every surface into one process: the operator
admin pages (Configuration/C.5, approvals/C.3, terminal gateway/C.6) and — once the
walking skeleton mounts it — the Facade (the `/v1/chat/completions` grounding/taint
pipeline every conversation flows through). These surfaces have different sensitivity
(privileged operator writes vs. session data path), different auth (operator cookie/D6
step-up vs. per-session + future machine auth), and different failure stakes (an admin
page bug should not kill live conversations — the Alden ecosystem's invariant is that
the household keeps talking).

The ratified Alden Future-State Architecture separates control plane from data plane as
a load-bearing principle. The review offered a lighter option (one process, internally
structured to split later); Karl ruled for the full split now.

## Decision

**The control-plane deploys as two services from one codebase, from the walking
skeleton onward:**

1. **Admin service** — Configuration page, approvals UI, terminal WebSocket gateway,
   registry views. Operator auth (#9 cookie + D6 step-up when built). May restart
   freely; its failure must not interrupt any conversation.
2. **Facade** — the OpenAI-compatible pre-processor (`/v1/chat/completions`): grounding,
   taint, session binding (Session entity), brain-busy queue (C.7), streaming
   pass-through, cost-meter middleware, and (Phase 3) the machine-auth path for the
   Autonomy Driver. Stateless across restarts: session bindings persist in SQLite.

Same repository, same build, two entrypoints/processes (systemd units or compose
services), separate ports, separate auth domains. Caddy fronts both with the §11 header
policy.

## Rationale

- Matches ratified P3 (control plane ≠ data plane) at the process boundary, not just in
  code layout — the failure domains are actually independent.
- Cheapest moment to do it: the Facade is not yet mounted anywhere, so nothing live has
  to be split.
- Two services from one codebase adds no second deploy artifact to maintain; the
  marginal cost is one more systemd unit on a VM that already runs LibreChat, Peta, and
  Postgres.

## Alternatives considered

- **Structured monolith, split later (reviewer's recommendation):** one process with
  separately-mountable apps and distinct auth. Less operational surface today, but the
  split would eventually be surgery on a live data path, and the shared process keeps
  shared-fate failures. Declined by the operator in favor of the ratified separation.
- **Do nothing:** intertwined surfaces, shared fate; rejected.

## Consequences

- `src/server.ts` is replaced by two entrypoints (e.g. `server-admin.ts`,
  `server-facade.ts`) composing disjoint route sets from `buildApp()`-style factories;
  shared modules (registry read paths, custody, logging) stay common.
- `scripts/install-debian.sh` and the skeleton charter provision **two** units.
- The D6 step-up (unbuilt) attaches to the admin service only; machine auth (Decision F,
  designed at skeleton, built at Alden Phase 3) attaches to the Facade only.
- Health checks (`/health`) exist per service; the smoke test verifies an admin-service
  restart does not drop an in-flight Facade conversation.

## Related

- PROJECT_BIBLE §3 (ADR-0007 pointer), §11 topology, §5 DM-4, §9 C.7
- APPROVAL_LOG — Review Decision Session (2026-07-09), Ruling G
- `docs/walking-skeleton-milestone.md` — where the split is first deployed
