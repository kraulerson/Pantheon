# ADR-0006 — Registry data is a projection of `alden-infra`; git is the master record

- **Status:** Accepted
- **Date of decision:** 2026-07-09 (review decision session, Decision D — APPROVAL_LOG ruling)
- **Deciders:** Karl (Orchestrator)

## Context

Two systems can hold the record of identities, brains (backends), and tool grants:

1. The control-plane's SQLite registry (BackendRegistry, and at Alden Phase 3+ the
   brain/profile data), editable from the Configuration page (C.5).
2. The `alden-infra` git repository — per the ratified Alden Future-State Architecture
   (v1.2), the Karl-commit-only control-plane source of truth, hosting the unified
   Profile and Brain Registry. Ratified principle: *"The profile is the single source of
   truth… Two records that can disagree is a bug."* On 2026-07-06 Karl ruled
   `alden-infra` lives on private GitHub (`kraulerson/alden-infra`) with a Gitea
   pull-mirror (APPROVAL_LOG §0.1 ruling).

An admin-page-editable database next to a git master is exactly the second,
independently-writable record the ratified principle forbids. Left unresolved, Alden
build-plan Phase 3 (Brain Registry) and Phase 5 (Profiles/Registrar) would have inherited
a data-ownership conflict plus a migration.

## Decision

**Git (`alden-infra`) is the master for identity, brain, and tool-grant data. The
control-plane's SQLite rows for that data are a read-only projection, synced one-way
git → SQLite.**

- The Configuration page becomes **view + propose-a-change** for this data class:
  a proposed edit is rendered as an `alden-infra` commit for Karl to approve; the page
  never writes these rows directly.
- **Exemption:** DevMachine and ServiceEndpoint rows are harness plumbing (SSH terminal
  targets, infra URLs) with no identity/governance meaning — they remain SQLite-native
  and page-editable exactly as specified in C.5/ADR-0005.
- Sync direction is enforced structurally (the projection tables have no admin write
  path), not by convention.

## Rationale

- Matches the ratified future-state principles P3 ("control plane ≠ data plane ≠ the
  players" — identities and UIs cannot rewrite the rules that govern them) and P4
  (single source of truth) with zero translation work at Alden Phases 3/5.
- The pattern is decided *before* the registry grows: today the affected rows are a
  handful of backends; after Phase 3 they are the Profile/BrainRegistry. Retrofit later
  = data migration + untangling write paths on a live system.
- Git-first gives every definitional change an author, a diff, and a revert for free —
  the same audit properties the ecosystem's witness/audit design assumes.

## Alternatives considered

- **SQLite-primary, exported snapshots to git:** preserves the page's current edit
  convenience but leaves the editable copy as the drifting one — a standing violation of
  the ratified principle, and the export is one more thing to forget.

## Consequences

- Design work (schema of the projection, sync trigger, propose-a-change UX) lands
  **before Alden build-plan Phase 3 starts**; the Configuration page's affected sections
  gain a labeled "mastered in alden-infra — propose a change" state.
- Until `alden-infra` exists with real content (it is stood up in Alden Phase 1), the
  current BackendRegistry rows continue as-is; this ADR fixes the target pattern, not a
  same-day cutover.
- C.5's fail-closed/validation requirements are unchanged; they now apply to proposal
  construction rather than direct row writes for the projected data class.

## Related

- PROJECT_BIBLE §5 DM-4; §3 ADR-0006 pointer
- APPROVAL_LOG — Review Decision Session (2026-07-09), Ruling D; §0.1 ruling (2026-07-06)
- Alden Ecosystem — Future-State Architecture v1.2 (P3/P4, §3 `alden-infra` + Profile)
