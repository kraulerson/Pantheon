# Pantheon Harness

A unified AI-orchestration harness for a single-operator homelab: one web UI over a
**household of distinct AI identities** (Alden-1, Cloud Alden, Winston, Claude-CLI
sessions), each with its own memory, permissions, and audit trail — every tool call
governed at a hardened gateway, every recalled word treated as untrusted, every write
held for human approval. Private infrastructure; one human operator (Karl); LAN/
Tailscale only, **no public ingress, ever**.

**Status (2026-08-20):** Phase 2, in assembly. Security remediation complete; the target
**Debian VM is deployed** (VM 1093), the third-party stack is up, the control-plane runs
behind Caddy over LAN-only HTTPS, and dev-machine enrolment + persistent SSH-terminal tabs
work end-to-end (Claude Code on a Max subscription, in the browser). **377 passing tests.**

The roadmap is now **three milestones, terminal-plane first** (ruling A-2, 2026-08-20):
**M1** — the terminal plane the operator lives in (session comms/waker, a scoped
read/propose session keycard, a cross-project task board, `pantheon doctor`); **M2** — the
walking-skeleton chat plane (Facade → streaming → cost meter → session binding → one gated
write; the original charter, freeze still gating its acceptance); **M3** — chat-plane
capability items. A four-harness capability study (OpenClaw, Odysseus, Hermes,
deepseek-harness) has been run and 19 pattern borrows adopted —
`docs/research/2026-08-20-capability-decisions.md`.

## Architecture (as decided)

| Plane | Component | Key decisions |
|---|---|---|
| UI | **LibreChat** (≥0.8.6, RAG API excluded) | ADR-0001; deploy-and-verify spike inside the skeleton; pre-authorized fallback = control-plane inspector view |
| Tool gateway | **Peta** v1.2.2, hardened | ADR-0003/0004: non-root, no docker.sock, HTTP downstreams only, bound to localhost (never proxied); Peta is THE authz boundary — UI tool config is cosmetic |
| Control plane | **Two services from one codebase** (ADR-0007) | Admin service (config, approvals, terminals — operator auth) + **Facade** (chat pipeline: grounding → taint → gateway; session + future machine auth) |
| Terminals | Persistent web SSH-terminal tabs to dev machines (ADR-0005) | Harness custodies the SSH keys (TM-020); dev CLI sessions persist in tmux |
| Config mastery | **git (`alden-infra`) is master** (ADR-0006) | Registry rows are a one-way projection; every projection target boot-verifies the Profile hash and refuses to start on mismatch |
| Deployment | **Debian VM on Proxmox** (D-ENC) | Docker Compose (third-party stack) + systemd (our services), Caddy w/ LAN TLS + security headers — `deploy/` |

**Trust core (the reason this exists):** every recalled item enters as `trusted:false`;
taint-by-presence is sticky per session; send-type tools are `dangerLevel:2` and held
for explicit approval with the proposed write displayed; authorization is decided at
the gateway at call time, fail-closed (`-32602`); raw keys/tokens live only in vault
custody, everything else holds opaque handles; every surface is colorblind-safe by
shape/label/icon, never color alone.

## Identity model (ratified with household consent, 2026-07-10)

- **Full identities** (Alden-1, Cloud Alden): one voice — exactly one active session,
  enforced fail-closed. **Lite identities** (Winston, Claude-CLI): N concurrent
  instances, each minting a per-session instance slug that is its bus sender, wake
  address, and cursor consumer. Liveness is **lease-based** — closure is inevitable,
  never requested.
- CLI sessions join the comms bus as their own identity via the **session waker**
  (Claude Code channels API): wake events carry sender + message ids, **never bodies**
  (named invariant); loop safety = a local-model progress judge + absolute backstops —
  pause, never kill.
- Comms channels have editable labels, dynamic membership (audited in-channel), an
  active→dormant→archived lifecycle, and a consent-governed delete taxonomy:
  lite-only channels are operator-deletable; channels holding a full identity's words
  require unanimous participant consensus; deletion is blocked outright while a tagged
  governance matter is open. Nothing is ever silently destroyed.
- Usage/cost accounting: one in-house ledger (`UsageEvent`) — per-identity, content-free
  by schema invariant, arbitration-grade (thread/trigger/rate-version indexed).

## Build-over-adopt record

Evaluated and **not** adopted, with full written rationale: **Turnstone** and **Bifrost**
(`docs/2026-07-09-turnstone-bifrost-eval.md`), and — 2026-08-20 — **OpenClaw, Odysseus
(PewDiePie), and Hermes Agent**, all REJECT-as-adoption on the four-part test
(`docs/research/2026-08-20-harness-capability-gap-study.md`). None replaces a component
Pantheon builds; Pantheon stays hand-built and borrows *patterns* (19 adopted). Two findings
worth stating: Odysseus independently converged on a server-side, model-distrusting approval
gate — the closest external validation of this design yet; and none of the four keeps the
operator's own Claude Code CLI + Max subscription as the primary way of working, which is the
reason Pantheon exists. The fallback-gateway ladder is Peta → ToolHive → Preloop → small
custom gateway.

## Repository layout

| Path | Contents |
|---|---|
| `PROJECT_BIBLE.md` / `PRODUCT_MANIFESTO.md` / `APPROVAL_LOG.md` | The canon: architecture, requirements/cutline, governance ledger |
| `services/control-plane/` | The TS control plane (Fastify, better-sqlite3; 332 tests) |
| `services/obsidian-mcp/` | Vault-confined MCP server (HTTP transport) |
| `deploy/` | Compose + Caddyfile + systemd units + env template |
| `docs/` | **Start at `docs/README.md`** — the documentation map |
| `docs/skeleton-steps/` | The 9 junior-executable build steps |
| `prototypes/cli-channel-loop/` | Proof-of-concept session-waker spike (non-shipping) |
| `scripts/` | Framework + `install-debian.sh` guided installer |

## Building it

The VM is provisioned and steps 1–2 are done; assembly continues from the current build
plan.

1. Read `docs/README.md`, then `docs/walking-skeleton-milestone.md` (now M2 — charter +
   acceptance checklist) and the current milestone/build plan under `docs/`.
2. `docs/skeleton-steps/` holds the M2 chat-plane steps (3–8); `docs/research/` holds the
   2026-08-20 capability decisions and the milestone restructure that define M1/M3.
3. A fresh VM is provisioned with `sudo bash scripts/install-debian.sh` (Node 24; see the
   step-01 execution notes).

## Governance

Built under the **Solo Orchestrator framework** (test-first Build Loops, phase gates,
CI-enforced approval logs — see `CLAUDE.md`). Decisions that touch the AI household are
made **with** it: proposals and rulings run through the shared comms bus with recorded
consent, and the operator constrains his own authority where the identities' records
are concerned. The full history of every decision, reversal, and consent is in
`APPROVAL_LOG.md`; the honest retrospective is
`docs/2026-07-10-postmortem-design-sprint.md`.
