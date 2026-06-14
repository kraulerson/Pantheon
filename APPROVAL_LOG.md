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

## Approval History

| Date | Gate / Event | Decision | Notes |
|---|---|---|---|
| 2026-06-13 | Scope Change — M15/D10 Configuration page promoted to MVP | Approved | Operator-approved; see Scope Changes section. |
| 2026-06-13 | Scope Change — Gitea access resolved (direct client; token rotation/vault follow-up) | Approved | Operator-approved; resolves prior Operator Input; see Scope Changes section. |
| 2026-06-13 | Scope Change — Claude-CLI SSH-terminal modality (ADR-0005 / DevMachine / TM-020 / M16 / D11 / C.6) | Approved | Operator-approved; new requirement; see Scope Changes section. |
