# Pantheon Harness

A unified AI-orchestration harness for a single-operator homelab: one web UI over a
**household of distinct AI identities** (Alden-1, Cloud Alden, Winston, Claude-CLI
sessions), each with its own memory, permissions, and audit trail — every tool call
governed at a hardened gateway, every recalled word treated as untrusted, every write
held for human approval. Private infrastructure; one human operator (Karl); LAN/
Tailscale only, **no public ingress, ever**.

**Status (2026-07-10):** Phase 2 under the walking-skeleton freeze. Design complete and
validated — every architecture decision resolved and recorded; ~330 passing tests; a
junior-executable build path exists. Next: the security remediation pass, then skeleton
assembly per `docs/skeleton-steps/`.

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

Evaluated and **not** adopted, with full written rationale: **Turnstone** (doctrine
inversion; six patterns borrowed with attribution) and **Bifrost** (real capabilities,
wrong footprint — needing four walls to make a platform safe was itself the signal).
The fallback-gateway ladder is Peta → ToolHive → Preloop → small custom gateway.
Details: `docs/2026-07-09-turnstone-bifrost-eval.md`.

## Repository layout

| Path | Contents |
|---|---|
| `PROJECT_BIBLE.md` / `PRODUCT_MANIFESTO.md` / `APPROVAL_LOG.md` | The canon: architecture, requirements/cutline, governance ledger |
| `services/control-plane/` | The TS control plane (Fastify, better-sqlite3; ~309 tests) |
| `services/obsidian-mcp/` | Vault-confined MCP server (HTTP transport) |
| `deploy/` | Compose + Caddyfile + systemd units + env template |
| `docs/` | **Start at `docs/README.md`** — the documentation map |
| `docs/skeleton-steps/` | The 9 junior-executable build steps |
| `prototypes/cli-channel-loop/` | Proof-of-concept session-waker spike (non-shipping) |
| `scripts/` | Framework + `install-debian.sh` guided installer |

## Building it

1. Read `docs/README.md`, then `docs/walking-skeleton-milestone.md` (charter +
   acceptance checklist).
2. Run the security remediation pass first
   (`docs/security-remediation-plan-2026-07-09.md`).
3. Execute `docs/skeleton-steps/` steps 1–8 in order. Step 1 provisions the VM and runs
   `sudo bash scripts/install-debian.sh`.

## Governance

Built under the **Solo Orchestrator framework** (test-first Build Loops, phase gates,
CI-enforced approval logs — see `CLAUDE.md`). Decisions that touch the AI household are
made **with** it: proposals and rulings run through the shared comms bus with recorded
consent, and the operator constrains his own authority where the identities' records
are concerned. The full history of every decision, reversal, and consent is in
`APPROVAL_LOG.md`; the honest retrospective is
`docs/2026-07-10-postmortem-design-sprint.md`.
