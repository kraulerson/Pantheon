# Pantheon Harness — Authoritative Requirements Source

**Status:** Canonical input for all Phase 0/1 artifacts. If a downstream doc contradicts this file, this file wins (until the Project Bible supersedes it at the Phase 1 gate).
**Companion references (siblings of the project dir):** `../ALDEN-HARNESS-CLI-HANDOFF.md` (architecture rationale + validated Peta evaluation, incl. the `RESULTS` section), `../peta-eval/` (reproducible gateway eval).

---

## 1. What this is
A single internally-hosted web harness for a solo operator ("Karl") to interface with a distributed homelab AI ecosystem ("Alden"). The operator **orchestrates AI rather than hand-writing code**. Values: correctness, governance, not reinventing what already ships.

**Ecosystem components (existing):**
- **Cloud Alden** — Claude via Anthropic API / claude.ai.
- **Alden-1** — local Qwen 3.5 122B, OpenAI-compatible, `192.168.1.89:8080`.
- **Claude Code CLI** — execution layer.
- **Alden Bridge** — MCP server `10.100.23.88:8765` (mailbox, memory, gitea, converse tools — tool taxonomy in the handoff doc §7).
- **Gitea** (scoped identity repos), **Qdrant** vector DB (`10.100.23.79:6333`), **Obsidian** vault (LiveSync/CouchDB).
- **pfSense + Tailscale**; **Caddy** reverse proxy.

## 2. Deployment model (FIRM — do not design against)
Single user. No multi-tenant. **No public exposure**; reachable only from inside the LAN or over Tailscale. **NO Cloudflare Tunnel / public ingress.** UI-to-internal traffic is plain LAN.

## 3. Hard constraints
- **Operator is colorblind.** Every UI signal/control must use **shape, position, text labels, or icons — never color alone.**
- Orchestrated via Claude Code → outputs must be precise enough to hand to a coding agent.
- Self-hosted, on-prem; secrets stay on the LAN.

## 4. The 14 requirements (the feature set)
1. **One internally-hosted web UI** (LAN/Tailscale only).
2. **Tabbed multi-session:** many concurrent sessions to different backends.
3. **A locally-hosted MCP gateway** — all AI systems talk through one point.
4. **Per-session search over previous sessions** (like Claude Desktop), unified across all sessions/identities.
5. **IDENTITY AS A SESSION-CREATION PROFILE.** New Session → popup chooses AI SYSTEM (Local Corsair/Alden-1 | future 7900XTX | Claude CLI | future cloud) × IDENTITY (existing | new | none). Selecting an existing identity configures at creation: (i) persona/system prompt from that identity's Gitea repo; (ii) that identity's tool/MCP authorizations; (iii) that identity's private Qdrant collection; (iv) that identity's Gitea write scope. "No identity" = bare session, minimal authz, no write scope. "New identity" = pull template from Gitea, create repo/scope/Qdrant collection/HMAC key, provision across systems, then open. Reads/reasoning frictionless; only WRITES to scoped systems hit a confirmation/step-up gate.
6. **Alden comms bridge integrated** for ad-hoc group conversations.
7. **Mailbox access** — always checkable and searchable for old messages.
8. **Direct writes into the Obsidian vault** (LiveSync propagates).
9. **AUTH ON THE UI** — authentication required before any session opens; multi-device on the tailnet; a logged-out browser/another device must not reach sessions or privileged actions.
10. **MCP GATEWAY AUTH — two directions:** (a) registration/server auth — any new MCP server must register + authenticate before reachable; (b) client/call auth — which sessions may invoke which servers' tools, **enforced at the gateway**, containing prompt injection.
11. **Gateway management interface** — add/remove/edit MCP server registrations (co-located + remote); privileged, behind the strongest auth tier.
12. **OPTIONAL PROMPT REWRITE ("prompt-master")** — opt-in, default OFF; per-message toggle (shape/label, colorblind-safe). Before send, pass drafted text to a rewrite-only service; present rewrite beside the original; operator picks which sends; never auto-substitute. Rewriter runs isolated: no tools, no loaded identity, no session authz. Recommend it run on local Alden-1 (drafts stay on LAN). Show diff vs original.
13. **GROUNDING / CONTEXT-INJECTION PIPELINE** — explicit, inspectable stage. Sources: loaded persona, identity Qdrant collection, mailbox hits, cross-session search (any session may search ALL sessions). **TRUST BOUNDARY (hard):** all cross-session/recalled/Qdrant/mailbox/non-user content enters context tagged `trusted:false`; only the current user's typed input in THIS session is trusted. **Three-layer enforcement:** (1) retrieval tags recalled content `trusted:false`; (2) the gateway blocks write-scoped calls traceable to `trusted:false` origin pending confirmation (enforcement at the gateway, NOT the model); (3) privileged writes require explicit out-of-band confirmation. **Inspectability:** operator can view the fully-assembled grounded prompt before/after send, with `trusted:false` content visibly distinguished (label/position/icon — never color). Grounding default-ON for identity sessions; every source individually toggleable per session.
14. **PER-IDENTITY ISOLATION + WRITE INTEGRITY — two orthogonal mechanisms, both required:** (a) **identity↔backend binding** — each identity is permanently bound at creation to the backend it was created on; a session requesting an identity on any other backend is rejected at creation. (b) **cross-identity isolation via per-identity HMAC** — each identity has its own Gitea repo, Qdrant tag/collection, and HMAC key; A's key cannot sign a write to B's repo/memory. **Key custody:** HMAC keys are held by the GATEWAY and used to sign writes on a session's behalf; keys are NEVER loaded into a session's context. (c) **self-injection boundary:** any memory/identity write proposed by a session that has ANY `trusted:false` content in its context requires explicit human approval before the gateway signs/commits — implemented as **taint-by-PRESENCE** (any untrusted content gates that session's writes), NOT taint-by-judgment.

## 5. Decided architecture (settled — see handoff doc for full rationale)
Three layers:
- **UI plane — ADOPT LibreChat.** Provides #1, #2, #4 (Meilisearch conversation search), #9 (built-in auth), and **Agents ≈ identities** (persona + one endpoint = backend binding + per-agent tool authz). Surfaces #6/#7 via proxied bridge tools.
- **Trust core / MCP gateway — ADOPT Peta** (`dunialabs/peta-core`, ELv2). **Validated this project** (see handoff `RESULTS`): single gateway (#3), server-side per-**tool** authz that contains prompt injection (#10), credential custody/vault (#14b key-custody role), durable human-in-the-loop write-approval gate (#14c), admin REST API (#11 — drive directly; the Console GUI is closed). **Mapping: one Alden identity = one Peta user;** reads frictionless; write-scoped tools marked `dangerLevel: 2` (Approval).
- **Custom control-plane "glue" — BUILD (this project's code).** The novel parts nobody ships:
  - Identity-creation popup + **provisioning orchestrator** (#5 "new identity": Gitea repo from template, Qdrant collection, HMAC key gen→gateway custody, backend binding, Peta user+perms).
  - **Inspectable grounding pipeline + `trusted:false` taint-by-presence** engine (#13) — pure logic, fully unit-testable. NOTE: Peta's approval trigger is static per-tool `dangerLevel`, so "gate all writes" is native; taint-by-presence refinement lives HERE (compute taint per session; keep writes gated or toggle danger level per call).
  - **Prompt-master** isolated rewriter on Alden-1 (#12).
  - **Obsidian/filesystem MCP server** (#8) — registered behind Peta, write tools `dangerLevel: 2`.
  - **Per-session-identity wiring** LibreChat → control-plane → Peta (mint per-identity Peta tokens at session creation), and the **backend-binding registry** (#14a).

## 6. Peta hardening carried in (from the validated eval — non-negotiable)
- Run peta-core **non-root, no docker.sock**, remote/HTTP downstreams only (no `CustomStdio`).
- `npm audit fix` / pin patched image; re-audit per upgrade.
- LAN/Tailscale-only; never expose `/admin` or `GET_OWNER`; no Cloudflared, no anonymous `/mcp/public`.
- Strong unique Peta access token per identity (token entropy is the whole of auth).

## 7. Users
Exactly one human operator (multi-device on the tailnet). No external users, ever. "Identities" are AI personas the operator orchestrates — not human users.

## 8. MVP cutline guidance (for the Manifesto — operator confirms)
**Must-have (MVP):** auth'd LibreChat UI on LAN/Tailscale (#1,#2,#9); Peta gateway hardened with identity=user + per-tool authz + write-approval (#3,#10,#14b/c); identity-as-session-profile for EXISTING identities (#5 i/ii/iv via agents + control-plane wiring; backend binding #14a); grounding pipeline with `trusted:false` tagging + taint-by-presence + inspectability (#13); cross-session search (#4); bridge mailbox + group convo via proxied tools (#6,#7); Obsidian MCP writes gated (#8).
**Should-have (v1.1):** New-identity provisioning orchestrator (#5 "new"); prompt-master (#12); gateway management UI beyond the admin API (#11 GUI); 7900XTX + cloud backends.
**Will-not-have:** public/multi-tenant; Cloudflare tunnel; any color-only UI signal; runtime identity context-injection (identity is creation-time only); loading HMAC keys into session context.

## 9. Track & platform
Standard track. Platform: web (TS control-plane service + LibreChat UI), with MCP-server sub-components (Obsidian MCP). Security rigor: STRIDE threat model, security tooling in CI, TDD, formal-ish UAT (single operator).
