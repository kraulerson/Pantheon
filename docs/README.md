# Documentation Map — pantheon-harness

Orientation page for all project documentation. One rule: **governance facts live in
the root canon; design rationale lives in dated docs; anything superseded carries a
status banner or lives in `archive/`.** Updated 2026-07-10.

## Start here (the canon — always current)

| Doc | What it is |
|---|---|
| `../PROJECT_BIBLE.md` | THE architecture record: ADRs, threat model, data model, UI specs, build strategy. Per-section Last-Updated markers. |
| `../PRODUCT_MANIFESTO.md` | Requirements, MVP cutline, resolved decisions D1–D11. |
| `../APPROVAL_LOG.md` | Every ruling, gate, scope change, and consent — the governance ledger. |
| `../CHANGELOG.md` / `../FEATURES.md` / `../BUGS.md` | What changed / what's built / the bug index (H1). |
| `../CLAUDE.md` | Working agreement for AI sessions (Solo Orchestrator framework). |
| `user-guide.html` | **The operator user guide** — every page and field, dev-machine setup, settings reference, and an explicit "not built yet" list. Served live at `/help` (no login required). |

## Build the system (execution order)

1. `walking-skeleton-milestone.md` — the charter: scope, acceptance checklist, exit.
2. `skeleton-steps/` — **the 9 junior-executable step designs** (README has the index).
3. `../deploy/` — compose, Caddyfile, systemd units, env template (its README is the map).
4. `security-remediation-plan-2026-07-09.md` — the Opus 4.8 remediation pass (runs first).

## Design decisions of record (dated; each is the rationale behind APPROVAL_LOG rulings)

| Doc | Decides | Status |
|---|---|---|
| `2026-07-02-landscape-revalidation.md` | Build-vs-adopt reaffirmed; version pins | Active reference |
| `2026-07-09-turnstone-bifrost-eval.md` | Turnstone rejected; Bifrost eval | **Outcome banner at head: Bifrost NOT adopted** |
| `2026-07-09-cli-comms-autonomy-design.md` | Channels/session-waker + loop safety | Active; Q7 superseded-in-part banner |
| `2026-07-09-deployment-topology-container-tmux.md` | VM enclosure (D-ENC), tmux dev plane | Active; D-ENC resolved |
| `2026-07-10-identity-classes-and-channel-lifecycle.md` | Full/lite identities, leases, channel lifecycle + delete taxonomy (RATIFIED) | Active |
| `machine-auth-design.md` | Service-principal tier (built Alden Phase 3) | Active design |
| `2026-07-10-postmortem-design-sprint.md` | Post-mortem of 2026-06-13 → 07-10 | Retrospective |
| `2026-07-10-agent-legibility-remediation-plan.md` | Fix+guard+upstream for the 7 agent-cognition hazards | **OPEN — not yet executed** |

## Reference & phase artifacts

- `ADR documentation/` — standalone ADR files (0004, 0006, 0007; 0001–0003 + 0005 live
  in Bible §3).
- `phase-0/`, `phase-1/` — gate artifacts (FRD, user journey, architecture, threat
  model, data-model/test/UI). Historical inputs to the Bible; the Bible supersedes on
  conflict.
- `integration/alden-bridge.md` — the bridge seam (endpoints, tools, trust rules).
- `security-audits/` — per-feature audit reports + the 2026-07-09 project review.
- `reference/` — Solo Orchestrator framework docs (builders guide, governance,
  security-scan guide, CLI handoff incl. the Peta bootstrap runbook).
- `platform-modules/web.md` — framework platform module.
- `test-results/`, `snapshots/` — archived evidence and phase-gate snapshots.

## Archive

`archive/` — superseded working documents, kept for the record, each with a status
banner: session handoffs that have been fully executed. Nothing in `archive/` is
load-bearing; if something in it contradicts the canon, the canon wins.

## Conventions

- New design docs are dated (`YYYY-MM-DD-topic.md`) and get a row in this map.
- A superseded doc is never silently edited into agreement — it gets a status banner
  pointing at what replaced it ("silent change is evidence destruction").
- Handoffs go to `archive/` once executed, with an EXECUTED banner.
