# Solo Orchestrator — Project Intake Template

## Version 1.0

---

## Document Control

| Field | Value |
|---|---|
| **Document ID** | SOI-004-INTAKE |
| **Version** | 1.0 |
| **Classification** | Project Initialization Template |
| **Date** | 2026-06-13 |
| **Companion Documents** | SOI-002-BUILD v1.0 (Builder's Guide), SOI-003-GOV v1.0 (Enterprise Governance Framework) |

---

## Purpose

This template collects every decision, constraint, and context variable that the AI agent needs to execute the Solo Orchestrator methodology with maximum autonomy. Fill it out completely before starting Phase 0. Incomplete sections will force the agent to stop and ask — every blank field is a round-trip.

### How This Document Flows Into the Process

The Intake is the primary input to the Builder's Guide. Here's where each section goes:

| Intake Section | Consumed By | Purpose |
|---|---|---|
| **1. Project Identity** | Phase 0 initialization, Platform Module selection | Names the project, sets the track, identifies which Platform Module the agent loads |
| **2. Business Context** | Phase 0 Steps 0.1-0.2 | The agent validates and expands this into the FRD and User Journey — it doesn't re-discover it |
| **3. Constraints** | Phase 0 and Phase 1 | Timeline, budget, and user targets constrain architecture and scope |
| **4. Features & Requirements** | Phase 0 Steps 0.1, 0.4 | The agent expands logic triggers and failure states, flags gaps, produces the Manifesto |
| **5. Data & Integrations** | Phase 0 Step 0.3, Phase 1 Step 1.4 | Drives the Data Contract, data model design, and third-party integration architecture |
| **6. Technical Preferences** | Phase 1 Steps 1.2-1.6 | Hard constraints and preferences feed directly into architecture proposals; Competency Matrix determines where automated tooling is mandatory |
| **7. Revenue Model** | Phase 0 Step 0.5, Phase 1 Step 1.2 | Hosting/distribution cost ceiling constrains architecture; pricing model shapes feature decisions |
| **8. Governance Pre-Flight** | Enterprise Governance Framework pre-conditions | Maps directly to the organizational approvals required before Phase 0 can begin |
| **9. Accessibility & UX** | Phase 1 Step 1.5, Phase 3 Step 3.4 | Architectural constraints from Day 1, not Phase 3 afterthoughts |
| **10. Distribution & Operations** | Phase 4, Platform Module | Distribution channels, monitoring, update strategy — platform-dependent |
| **11. Known Risks** | Phase 1 Step 1.3 | Additional inputs for the Iron Logic Stress Test |

The more complete the Intake, the more autonomously the agent can work. Where the Intake is vague or incomplete, the Builder's Guide prompts shift from validation to discovery — the agent will ask targeted questions instead of proposing options it doesn't have enough context to evaluate.

### How to Use This Document

You can fill this out using the **intake wizard** (`bash scripts/intake-wizard.sh`) or by **editing this file directly**. The wizard offers an interactive walkthrough and tracks your progress. Either approach works, but be aware of the difference:

1. Fill out every section. Mark fields N/A where they genuinely don't apply — don't leave blanks.
2. For organizational deployments, complete the Governance Pre-Flight (Section 8) before starting. This section maps to the Enterprise Governance Framework pre-conditions.
3. Once complete, provide this document to the AI agent at the start of Phase 0 with the instruction: "This is the Project Intake. Use it as the primary constraint for all phases. Do not suggest features, architectures, or tooling that contradict it."
4. The agent will use this to generate the Product Manifesto (Phase 0) and Project Bible (Phase 1) without stopping to ask for information that should already be decided.

> **If editing manually:** Section 1 fields (project name, platform, language, track) and Section 8 (governance mode) were used during init to generate your CI pipeline, release pipeline, platform module, and phase gate rules. If you change these fields here, you must also run the reconfigure script to update the generated files:
>
> ```bash
> bash scripts/reconfigure-project.sh --field <field> --old <old_value> --new <new_value>
> ```
>
> Supported fields: `name`, `platform`, `language`, `track`, `deployment`. The intake wizard handles this automatically — manual editing does not.

---

## 1. Project Identity

| Field | Value |
|---|---|
| **Project name** | pantheon-harness |
| **Project codename** (if different from public name) | Pantheon Harness |
| **One-sentence description** | Pantheon Harness: unified AI-orchestration harness for a single-operator homelab — LibreChat UI + Peta MCP gateway + custom control-plane (identity-as-session-profile, grounding/trusted:false pipeline, prompt-master, Obsidian MCP). |
| **Project track** | Standard |
| **Platform type** | web |
| **Platform Module** | SOI-PM-WEB |

> **Mobile (SOI-PM-MOBILE v1.0)** — The mobile Platform Module covers React Native (Expo), Flutter, Swift (iOS), and Kotlin (Android) with architecture patterns, offline-first guidance, code signing, app store submission, and testing.
| **Target platforms** | Web (modern desktop browsers — Chrome/Firefox/Safari), reached only from inside the LAN or over Tailscale. No public exposure. |
| **Is this a personal project or organizational deployment?** | Personal |
| **Repository URL** (if already created) | Self-hosted Gitea (LAN) — URL TBD by operator |
| **Git host** | Gitea (self-hosted, on-prem) |
| **Repository visibility** | Private (self-hosted, single operator) |

---

## 2. Business Context

### 2.1 The Problem

_What specific problem does this solve? Be concrete — not "improve efficiency" but "the finance team spends 6 hours/week manually reconciling invoices from 3 systems into a single spreadsheet."_

```
A single solo operator ("Karl") runs a distributed homelab AI ecosystem ("Alden")
spread across multiple backends and services: Cloud Alden (Claude via Anthropic
API / claude.ai), Alden-1 (local Qwen 3.5 122B, OpenAI-compatible at
192.168.1.89:8080), the Claude Code CLI, an Alden Bridge MCP server (mailbox,
memory, gitea, converse tools), Gitea (scoped identity repos), a Qdrant vector
DB, and an Obsidian vault (LiveSync/CouchDB). Today there is no single, authed
interface to drive all of these. The operator must juggle separate tools,
manually manage which AI persona ("identity") talks to which backend with which
tool authorizations and memory scope, and has no enforced trust boundary between
AI-recalled content and the operator's own typed input — so prompt-injection and
cross-identity write contamination are unmitigated. The harness gives the
operator ONE internally-hosted, authenticated web UI to orchestrate the whole
ecosystem, with a single MCP gateway enforcing per-identity isolation, write
integrity, and an inspectable grounding/trust pipeline. The operator orchestrates
AI rather than hand-writing code; harness outputs must be precise enough to hand
to a coding agent (Claude Code).
```

### 2.2 Who Has This Problem

| Field | Value |
|---|---|
| **Primary user persona** | Solo operator "Karl" — senior software/security architect who orchestrates AI rather than hand-writing code. High technical skill. Multi-device on the tailnet. Colorblind (see §9). |
| **Secondary personas** (if any) | None human. "Identities" are AI personas the operator orchestrates (not human users). No external users, ever. |
| **How do they solve this problem today?** | Separate, disconnected tools per backend; manual management of persona/tool-auth/memory scope; no enforced trust boundary between recalled content and operator input. |
| **What's wrong with the current solution?** | No single authed entry point; no central MCP gateway enforcing per-tool authz; prompt injection and cross-identity write contamination unmitigated; no inspectable grounding/trust pipeline. |

### 2.3 Success Criteria

_How will you know this project succeeded? Define measurable outcomes, not feelings._

| Metric | Target | How Measured |
|---|---|---|
| Single authed entry point to all backends | One LibreChat UI on LAN/Tailscale fronts every backend; no logged-out access to sessions | Operator verification; logged-out browser/second device cannot reach sessions or privileged actions |
| Gateway-enforced per-tool authz containing prompt injection | All AI traffic flows through one Peta gateway; write-scoped tools require approval | Peta config review; injection test cannot trigger an unconfirmed write |
| Per-identity isolation + write integrity | Identity A's HMAC key cannot sign a write to B's repo/memory; identity bound to one backend | Isolation test (cross-identity write rejected) + backend-binding rejection at session creation |
| Inspectable trust boundary | Operator can view fully-assembled grounded prompt with trusted:false content visibly distinguished (never color) | Manual inspection of grounding pipeline before/after send |

### 2.4 What This Is NOT

_List 3-5 things that sound related but are explicitly out of scope. This prevents the agent from scope-creeping into adjacent problems._

1. Not a public or multi-tenant service — single operator, no external users, ever.
2. Not internet-exposed — no Cloudflare Tunnel / public ingress; LAN/Tailscale only.
3. Not a runtime identity context-injection system — identity is configured at session creation only, never re-injected at runtime.
4. Not a from-scratch chat UI or MCP gateway — adopts LibreChat (UI) and Peta (gateway); only the novel control-plane glue is built.
5. Not a tool that loads HMAC keys into a session's context — keys are custodied by the gateway and used to sign on the session's behalf.

---

## 3. Constraints

### 3.1 Timeline

| Field | Value |
|---|---|
| **Target MVP date** | Not specified in brief — operator to set (see Open Questions). |
| **Hard deadline?** | No (not stated in brief). Personal internal tool; correctness and governance prioritized over schedule. |
| **Orchestrator availability** | Not specified in brief (see Open Questions). Operator is a senior architect orchestrating AI. |
| **Blocked time or interleaved?** | Not specified in brief (see Open Questions). |

### 3.2 Budget

| Field | Value |
|---|---|
| **Monthly infrastructure ceiling** | Effectively ~$0 incremental — self-hosted on existing on-prem homelab hardware. Only existing Anthropic API/claude.ai usage applies (already provisioned). |
| **One-time budget** (if any) | None stated. No domain, no public cert (LAN/Tailscale, internal certs via Caddy). |
| **AI subscription** | Already have — Anthropic API / claude.ai (Cloud Alden) plus local Alden-1 (Qwen 3.5 122B). Commercial/self-hosted mix. |
| **Who approves spending?** | Self (operator "Karl"). |

### 3.3 Users

| Field | Value |
|---|---|
| **Users at launch** | 1 (operator "Karl", multi-device on the tailnet). |
| **Users at 6 months** | 1. |
| **Users at 12 months** | 1. No external users, ever. ("Identities" are AI personas, not human users.) |
| **Internal only or external?** | Internal only. |
| **Geographic distribution** | Single operator, on-prem homelab; reachable over Tailscale from operator's own devices. No data sovereignty concerns — secrets stay on the LAN. |

---

## 4. Features & Requirements

### 4.1 Must-Have Features (MVP)

_For each feature, define the business logic trigger and the failure state. If you can't articulate "If [condition], the system must [action]" — the feature isn't defined well enough to build._

_The MVP set below is the brief's "Must-have" cutline (§8). It maps requirements #1, #2, #4, #6, #7, #8, #9, #10, #13, #14, plus #5 for EXISTING identities only and #3 (the gateway). New-identity provisioning (#5 "new"), prompt-master (#12), and gateway-management GUI beyond the admin API (#11) are Should-Have v1.1 (§4.2)._

| # | Feature | Business Logic Trigger | Failure State |
|---|---|---|---|
| 1 | **One internally-hosted web UI (#1)** (LAN/Tailscale only) — ADOPT LibreChat | If a request arrives from inside the LAN or over Tailscale AND is authenticated, the system must serve the UI/session. | Request from outside the tailnet, or unauthenticated → no UI, no session; deny. No public ingress path exists. |
| 2 | **Tabbed multi-session (#2)** — many concurrent sessions to different backends | If the operator opens a new tab/session, the system must allow an independent concurrent session bound to a chosen backend. | Backend unreachable → session shows clear non-color error state; other sessions unaffected. |
| 3 | **Local MCP gateway (#3)** — all AI systems talk through one point — ADOPT Peta | If any AI system needs a tool/backend, the call must route through the single Peta gateway. | Direct (non-gateway) tool path attempted → not available; gateway down → tool calls fail closed with explicit error. |
| 4 | **Per-session search over previous sessions (#4)** — unified across all sessions/identities (LibreChat Meilisearch) | If the operator searches within a session, the system must return matches across ALL prior sessions/identities. | No matches → explicit empty-state (text/icon). Index unavailable → degraded notice, sessions still usable. |
| 5 | **Identity as session-creation profile — EXISTING identities (#5 i/ii/iv)** | If "New Session" → operator picks AI SYSTEM × an EXISTING IDENTITY, the system must configure at creation: persona/system prompt from that identity's Gitea repo, that identity's tool/MCP authz, its Qdrant collection, and its Gitea write scope; "no identity" = bare session, minimal authz, no write scope. Reads/reasoning frictionless; only WRITES to scoped systems hit a confirmation/step-up gate. | Identity repo/collection unreadable → block session creation with explicit error; never open a mis-scoped session. Identity requested on a non-bound backend → reject at creation (#14a). |
| 6 | **Alden comms bridge integrated (#6)** — ad-hoc group conversations (proxied bridge tools via Peta) | If the operator initiates a group conversation, the system must surface bridge converse tools proxied through the gateway. | Bridge unreachable → explicit non-color error; no silent partial sends. |
| 7 | **Mailbox access (#7)** — always checkable and searchable for old messages (proxied bridge tools) | If the operator opens/searches the mailbox, the system must list and search messages including old ones. | Mailbox service down → read-only degraded state with explicit notice. |
| 8 | **Direct writes into the Obsidian vault (#8)** — BUILD Obsidian/filesystem MCP server, write tools dangerLevel 2 (gated) | If the operator/identity issues a vault write, the gateway must require approval before committing; LiveSync then propagates. | Write blocked pending approval; if denied → no write. Vault/MCP down → write fails closed with explicit error. |
| 9 | **Auth on the UI (#9)** — authentication required before any session opens; multi-device on tailnet (LibreChat built-in auth) | If a session or privileged action is requested, the system must require successful authentication first. | Logged-out browser / another device → cannot reach sessions or privileged actions; redirect to auth. |
| 10 | **MCP gateway auth, two directions (#10)** — (a) server registration/auth before reachable; (b) client/call authz enforced at the gateway | If a new MCP server is added, it must register + authenticate before reachable; if a session invokes a tool, the gateway must verify that session may invoke that server's tool. | Unregistered/unauthenticated server → unreachable. Unauthorized tool call → denied at gateway (contains prompt injection). |
| 11 | **Grounding / context-injection pipeline (#13)** — explicit, inspectable stage with hard trust boundary + taint-by-presence | If context is assembled, all cross-session/recalled/Qdrant/mailbox/non-user content must be tagged `trusted:false`; only the current user's typed input in THIS session is trusted. Three-layer enforcement: (1) retrieval tags recalled content; (2) gateway blocks write-scoped calls traceable to `trusted:false` origin pending confirmation; (3) privileged writes require explicit out-of-band confirmation. Operator can inspect the fully-assembled prompt before/after send with `trusted:false` visibly distinguished (label/position/icon, never color). Grounding default-ON for identity sessions; every source individually toggleable per session. | Any untrusted-origin write attempt → gated pending explicit confirmation. Source unavailable → that source omitted with explicit notice; pipeline still inspectable. |
| 12 | **Per-identity isolation + write integrity (#14)** — two orthogonal mechanisms, both required | (a) identity↔backend binding: a session requesting an identity on any other backend than its creation backend must be rejected at creation. (b) per-identity HMAC: each identity has its own Gitea repo, Qdrant tag/collection, HMAC key; A's key cannot sign a write to B's repo/memory. Key custody: HMAC keys held by the GATEWAY, used to sign on a session's behalf, NEVER loaded into session context. (c) self-injection boundary: any memory/identity write proposed by a session with ANY `trusted:false` content in context requires explicit human approval before the gateway signs/commits — taint-by-PRESENCE, not taint-by-judgment. | Cross-identity write → rejected (key cannot sign). Wrong-backend identity request → rejected at creation. Tainted-context write → blocked pending human approval. |

### 4.2 Should-Have Features (Post-MVP v1.1)

_Features that enhance the MVP but are not required for first usable release. (Brief §8 "Should-have".)_

1. **New-identity provisioning orchestrator (#5 "new")** — pull template from Gitea, create repo/scope/Qdrant collection/HMAC key, provision across systems (Peta user + perms, backend binding), then open the session.
2. **Optional prompt rewrite "prompt-master" (#12)** — opt-in, default OFF; per-message toggle (shape/label, colorblind-safe); rewrite-only service runs isolated (no tools, no loaded identity, no session authz), recommended on local Alden-1 (drafts stay on LAN); present rewrite beside original with diff; operator picks; never auto-substitute.
3. **Gateway management UI beyond the admin API (#11)** — GUI to add/remove/edit MCP server registrations (co-located + remote); privileged, behind the strongest auth tier. (MVP drives Peta's admin REST API directly; the Peta Console GUI is closed.)
4. **Additional backends** — future 7900XTX local backend and future cloud backends in the AI-SYSTEM picker.

### 4.3 Will-Not-Have Features (Explicit Exclusions)

_Things that sound related but the agent must NOT build or suggest. (Brief §8 "Will-not-have".)_

1. Public / multi-tenant access; Cloudflare Tunnel or any public ingress.
2. Any color-only UI signal (operator is colorblind — see §9).
3. Runtime identity context-injection (identity is creation-time only) and loading HMAC keys into session context.

---

## 5. Data & Integrations

### 5.1 Data Inputs

_What data does the user provide or the system ingest?_

| Input | Data Type | Validation Rules | Sensitivity | Required? |
|---|---|---|---|---|
| Operator message / typed prompt (this session) | Text | Non-empty; this is the ONLY `trusted:true` content | Confidential | Yes |
| Session-creation selection (AI system × identity) | Enum/choice | AI system ∈ {Alden-1/Local Corsair, future 7900XTX, Claude CLI, future cloud}; identity ∈ {existing, new, none}; identity must be bound to chosen backend (#14a) | Internal | Yes |
| Per-message prompt-master toggle (v1.1) | Boolean | Default OFF; colorblind-safe control | Internal | No |
| Per-session grounding-source toggles | Booleans | Default-ON for identity sessions; each source individually toggleable | Internal | No |
| Recalled / cross-session / Qdrant / mailbox / non-user content | Text/structured | Always tagged `trusted:false` on entry to context | Confidential | N/A (system-ingested) |
| Auth credential (UI login) | Secret | Required before any session opens; entropy of per-identity Peta token is the whole of gateway auth | Confidential | Yes |
| New-identity template (v1.1) | Structured (Gitea template) | Valid template; drives repo/scope/Qdrant/HMAC provisioning | Confidential | No (v1.1) |

**Sensitivity classifications:** Public, Internal, Confidential, PII, Financial, Health/Medical, Regulated

> Trust boundary (hard, #13): only the operator's typed input in the CURRENT session is `trusted:true`. All recalled/cross-session/Qdrant/mailbox/non-user content is `trusted:false`. HMAC keys and secrets stay on the LAN and are never loaded into session context.

### 5.2 Data Outputs

_What does the user receive from the system?_

| Output | Format | Latency Expectation |
|---|---|---|
| AI session responses (per backend) | Streamed chat text in LibreChat UI | Interactive (streamed) |
| Inspectable assembled grounded prompt (before/after send) | Rendered view with `trusted:false` content visibly distinguished (label/position/icon — never color) | On demand, near-instant |
| Cross-session search results | Ranked list with explicit empty-state | <1-2s typical (Meilisearch) |
| Write-approval prompts (gated writes to scoped systems / vault) | Explicit out-of-band confirmation UI (shape/text/icon) | Interactive; blocks until decided |
| Prompt-master rewrite (v1.1) | Rewrite shown beside original with diff | Interactive (local Alden-1) |

### 5.3 Third-Party Integrations

_Every external API or data source the application needs to connect to._

| Service | What Data We Send/Receive | Auth Method | Fallback if Unavailable | Existing Account? |
|---|---|---|---|---|
| Cloud Alden (Anthropic API / claude.ai) | Prompts / completions | API key (commercial) | Fail closed; other backends usable | Yes |
| Alden-1 (local Qwen 3.5 122B, `192.168.1.89:8080`) | Prompts / completions (OpenAI-compatible) | LAN; per-identity Peta token at gateway | Fail closed; explicit error | Yes (self-hosted) |
| Claude Code CLI | Execution-layer orchestration | Local | Manual fallback | Yes |
| Alden Bridge MCP (`10.100.23.88:8765`) | mailbox / memory / gitea / converse tools | Gateway-enforced per-tool authz (Peta) | Read-only/degraded with notice | Yes (self-hosted) |
| Qdrant (`10.100.23.79:6333`) | Per-identity vector collections (recall, tagged `trusted:false`) | LAN; per-identity collection/tag | Source omitted with notice | Yes (self-hosted) |
| Gitea (self-hosted) | Per-identity persona repos + write scope | Per-identity scope; writes gated/HMAC-signed by gateway | Block writes; reads degraded | Yes (self-hosted) |
| Obsidian vault / CouchDB LiveSync | Direct vault writes (via BUILT Obsidian MCP, dangerLevel 2) | Gateway-gated write approval | Write fails closed | Yes (self-hosted) |
| Peta gateway (`dunialabs/peta-core`, ELv2) | All tool/backend calls; HMAC key custody; write-approval gate | Per-identity access token (token entropy is auth) | Fail closed — no direct bypass path | Yes (adopted, validated) |

### 5.4 Data Persistence

| Question | Answer |
|---|---|
| **What data must persist across sessions?** | Conversation history + search index (LibreChat/Meilisearch); per-identity personas (Gitea repos), memory (Qdrant collections), backend-binding registry, HMAC keys (gateway custody); MCP server registrations + per-identity Peta tokens/perms; Obsidian vault content. |
| **What data can be ephemeral (browser/device only)?** | UI/tab state, transient grounding-source toggles, prompt-master draft rewrites (before the operator chooses). |
| **Expected data volume at 12 months** | Small — single operator. Bounded by personal conversation volume + vault size. |
| **Data retention requirements** | Keep (no regulatory requirement; internal personal tool). Operator-managed. |
| **Backup requirements** | Existing homelab posture: Gitea repos and Obsidian/CouchDB LiveSync provide versioning/replication; Qdrant + LibreChat data covered by whatever the homelab backup default is. (Specifics TBD by operator — see Open Questions.) |

---

## 6. Technical Preferences

### 6.1 Orchestrator Technical Profile

| Field | Value |
|---|---|
| **Languages you know well** | TypeScript/JavaScript (project primary language); senior architect-level general fluency. |
| **Frameworks you've used** | Node/Express-class backends; React-based UIs (LibreChat is the adopted UI). |
| **Languages/frameworks you're willing to learn** | As needed — operator orchestrates AI rather than hand-writing code. |
| **Languages/frameworks you refuse to use** | None stated. (Constraint is architectural, not language: adopt LibreChat + Peta, build TS glue.) |
| **Database experience** | Comfortable with vector DB (Qdrant) and self-hosted data stores; whatever LibreChat/Peta require. |
| **DevOps experience level** | Advanced — runs a distributed homelab (pfSense+Tailscale, Caddy, Gitea, Qdrant, CouchDB, Docker/Colima). |
| **Mobile development experience** | N/A — web-only, desktop browsers. |

### 6.2 Competency Matrix

_For each domain, answer honestly: "Can I look at the AI's output and reliably determine if it's correct?"_

| Domain | Self-Assessment | Automated Tooling Required? |
|---|---|---|
| Product/UX Logic | Yes | Recommended (operator validates; this is a personal tool) |
| Frontend Code (HTML/CSS/JS) | Partially | Yes — Lighthouse + tests; most UI is adopted LibreChat, limited custom surface |
| Backend / API Design | Yes | Yes (mandatory regardless — security-sensitive project): tests + SAST |
| Database Design & Queries | Partially | Yes — automated tests; schema/migration review |
| Security (Auth, Injection, IDOR) | Yes (senior security-review competency) | **Yes — MANDATORY regardless.** Security-sensitive project: Semgrep (SAST), gitleaks (secrets), Snyk (deps) in CI; STRIDE threat model; injection/isolation tests are non-negotiable |
| DevOps / Infrastructure | Yes (advanced homelab operator) | Recommended (IaC/config review; Peta hardening checklist enforced) |
| Accessibility (WCAG) | Partially | **Yes — colorblind operator (see §9).** Automated + manual: every signal must use shape/position/text/icon, never color alone |
| Performance Optimization | Partially | Recommended — single-user load is light; Lighthouse available |
| Mobile (iOS/Android) | N/A | N/A — web-only |

_Every "Partially" or "No" means automated tooling is mandatory in Phase 3. The agent will factor this into architecture selection and testing strategy._

> **Operator profile:** senior architect who orchestrates AI; strong on architecture, backend, and security review. Automated tooling (SAST, dependency scan, tests, accessibility checks) is relied on to cover the "Partially" domains. Because this is a security-sensitive project, the security tooling chain (Semgrep, gitleaks, Snyk, STRIDE threat model, injection/isolation tests) is **mandatory regardless of self-assessment**.

### 6.3 Development Environment

| Field | Value |
|---|---|
| **Primary development machine** | macOS (Darwin 25.4.0). |
| **Secondary machines** (if any) | Multi-device on the tailnet; on-prem homelab hosts (Alden-1, gateway, Gitea, Qdrant, CouchDB). |
| **IDE/Editor** | Claude Code CLI (execution layer); editor per operator preference. |
| **Docker available?** | Yes (Docker 29.3.1 + Colima 0.10.1). Note Peta hardening: run peta-core non-root, no docker.sock, remote/HTTP downstreams only. |
| **Node.js version** | 25.9.0. |
| **Python version** (if applicable) | N/A — TypeScript project. |
| **Claude Code installed?** | Yes (2.1.177). |
| **AI subscription tier** | Anthropic API / claude.ai (Cloud Alden) + self-hosted Alden-1. |

### 6.4 Architecture Preferences & Constraints

_These are preferences, not mandates. The agent will respect hard constraints but may recommend against soft preferences with justification. Fields vary by platform — fill in what applies to your project type._

**All Platforms:**

| Field | Value | Hard Constraint or Preference? |
|---|---|---|
| **Primary language** | TypeScript (control-plane glue + Obsidian MCP server) | Hard constraint |
| **Data storage** | LibreChat's own store + Meilisearch (search); Qdrant (per-identity vectors); Gitea (personas/scope); CouchDB (Obsidian LiveSync); gateway-custodied HMAC keys | Hard constraint (adopted components) |
| **Authentication** | LibreChat built-in auth on the UI (#9); per-identity Peta access tokens at the gateway (#10). Local-only / tailnet. No external SSO. | Hard constraint |

**Web Applications:**

| Field | Value | Hard Constraint or Preference? |
|---|---|---|
| **Frontend framework** | LibreChat (React-based) — ADOPTED. Custom surfaces (identity-creation popup, grounding inspector) integrate with it. | Hard constraint (adopt LibreChat) |
| **Backend framework** | Node/TypeScript control-plane service ("glue"); Express-class or no-preference within TS. Peta gateway adopted as the trust core. | Preference (TS); adopting Peta is a hard constraint |
| **Hosting** | Self-hosted on-prem homelab; Caddy reverse proxy; LAN/Tailscale only; NO public ingress / no Cloudflare Tunnel. | Hard constraint |

**Desktop Applications:**

| Field | Value | Hard Constraint or Preference? |
|---|---|---|
| **UI framework** | N/A — web only | N/A |
| **Packaging format** | N/A | N/A |
| **Auto-update strategy** | N/A | N/A |
| **Offline requirement** | N/A — requires LAN/Tailscale network to reach backends | N/A |

**Mobile Applications:**

| Field | Value | Hard Constraint or Preference? |
|---|---|---|
| **Framework** | N/A — web only | N/A |
| **Minimum OS version** | N/A | N/A |
| **App store distribution** | N/A | N/A |
| **Offline requirement** | N/A | N/A |
| **Device API requirements** | N/A | N/A |
| **Biometric authentication** | N/A | N/A |

**Cross-Cutting:**

| Field | Value | Hard Constraint or Preference? |
|---|---|---|
| **Monorepo or separate repos?** | Not decided in brief — likely single repo for the custom control-plane glue + Obsidian MCP; adopted LibreChat/Peta are external components. (See Open Questions.) | Preference |
| **Web + Desktop, Web + Mobile, or single platform?** | Single platform — web only (desktop browsers on LAN/Tailscale). | Hard constraint |

### 6.5 Existing Infrastructure to Integrate With

_Anything the application must connect to or comply with._

| System | Details | Integration Required? |
|---|---|---|
| **SSO / Identity Provider** | None — LibreChat built-in auth + per-identity Peta tokens; local/tailnet only | N/A |
| **Logging / SIEM** | None enterprise; structured logging per CLAUDE.md (timestamp/severity/correlation ID) | No |
| **Monitoring** | Homelab-native; no Datadog/New Relic. Grafana optional (operator's discretion) | No |
| **Data Warehouse** | None | N/A |
| **Backup Infrastructure** | Existing homelab posture (Gitea versioning, Obsidian/CouchDB LiveSync replication) | Yes (rely on existing) |
| **CI/CD Platform** | Local CI chain per framework (Semgrep, gitleaks, Snyk, tests, Lighthouse); runner host TBD by operator | Yes |
| **Repository Platform** | Gitea (self-hosted) — also stores per-identity persona repos and write scopes | Yes |
| **Other (homelab ecosystem — adopted/integrated)** | **Alden-1** local LLM (`192.168.1.89:8080`); **Alden Bridge MCP** (`10.100.23.88:8765` — mailbox/memory/gitea/converse); **Qdrant** (`10.100.23.79:6333`); **Obsidian/CouchDB LiveSync**; **Caddy** reverse proxy; **pfSense + Tailscale**; **Peta** gateway (`dunialabs/peta-core`, ELv2 — validated/adopted) + **LibreChat** UI (adopted) | Yes |

---

## 7. Revenue Model (Standard+ Track — skip for internal tools)

**SKIPPED — internal tool, no revenue model.** (Standard track allows skipping Revenue Model for internal tools. Single operator, no external users, no pricing.)

| Field | Value |
|---|---|
| **Pricing model** | SKIPPED — internal tool, no revenue model |
| **Target price point** | SKIPPED — internal tool, no revenue model |
| **Competitive price range** | SKIPPED — internal tool, no revenue model |
| **Per-user cost estimate** (hosting, API calls, storage) | SKIPPED — internal tool, no revenue model |
| **Break-even user count** | SKIPPED — internal tool, no revenue model |
| **Hosting cost ceiling at launch** | SKIPPED — internal tool, no revenue model |
| **Hosting cost ceiling at 1,000 users** | SKIPPED — internal tool, no revenue model |
| **Hosting cost ceiling at 10,000 users** | SKIPPED — internal tool, no revenue model |

---

## 8. Governance Pre-Flight (Organizational Deployments Only)

**N/A — personal deployment.** This entire section (8.1 Pre-Conditions, 8.2 Approval Authorities, 8.3 Escalation Chain, 8.4 Compliance Screening, 8.5 Exit Criteria) is N/A for a personal, single-operator, internal deployment. No organizational sponsor, no insurance/liability entity, no ITSM, no compliance screening. The operator is the sole approver at every gate.

_Skip this section for personal projects. For organizational deployments, every field must be completed or marked "In Progress" with an expected completion date. Phase 0 cannot begin until all "Blocking" items are resolved._

**Governance Mode:** N/A — personal deployment

> **If POC mode:** This project operates under POC constraints — no production deployment, no real user data, no external users. Deferred pre-conditions must be resolved before production. Upgrade with: `scripts/upgrade-project.sh --to-production`

### 8.1 Pre-Conditions

| Pre-Condition | Status | Details | Blocking? |
|---|---|---|---|
| **AI deployment path approved by IT Security** | Not Started / In Progress / Complete | _Commercial API, Enterprise agreement, ZDR, self-hosted?_ | Yes |
| **Insurance confirmation obtained** | Not Started / In Progress / Complete | _Cyber liability, E&O, D&O cover AI-generated code?_ | Yes |
| **Liability entity designated** | Not Started / In Progress / Complete | _Which entity bears liability — subsidiary or parent?_ | Yes |
| **Project sponsor assigned** | Not Started / In Progress / Complete | _Name:_ | Yes |
| **Backup maintainer designated** | Not Started / In Progress / Complete | _Name:_ | Yes |
| **ITSM ticket filed / portfolio registered** | Not Started / In Progress / Complete | _Ticket #:_ | Yes |
| **Exit criteria defined** | Not Started / In Progress / Complete | | Yes |
| **Orchestrator time allocation approved** | Not Started / In Progress / Complete | _Hours/week, blocked or interleaved_ | Yes |

### 8.2 Approval Authorities

| Gate | Approver Name | Approver Role |
|---|---|---|
| **Phase 0 → Phase 1** (business justification) | | |
| **Phase 1 → Phase 2** (architecture approval) | | |
| **Phase 3 → Phase 4** (go-live approval) | | |

### 8.3 Escalation Chain

| Level | Name | Role | Contact |
|---|---|---|---|
| 1 (first escalation) | | | |
| 2 | | | |
| 3 (final authority) | | | |

### 8.4 Compliance Screening

_Complete this screening with the project sponsor. Mark each question Yes/No and complete the action if Yes._

| Question | Yes/No | Required Action | Status |
|---|---|---|---|
| Does this application process data used in financial reporting? | | Route through SOX IT general controls | |
| Does this application handle payment card data (even masked)? | | PCI scoping assessment required | |
| Does this application collect personal data from users in multiple states or internationally? | | Legal review for applicable privacy laws | |
| Are any users or subsidiaries in the EU? | | EU AI Act classification + data sovereignty assessment | |
| Does any subsidiary operate in a sanctioned jurisdiction? | | OFAC screening | |
| Is data subject to records retention requirements? | | Define retention periods and deletion procedures | |
| Will the deployed application include AI-powered features for end users? | | EU AI Act classification for deployed product | |
| Does your organization require penetration testing for all production applications? | | Schedule pen test for Phase 3 | |

### 8.5 Exit Criteria

| Outcome | Definition | Decision Maker |
|---|---|---|
| **Success** (proceed to scale) | _e.g., "MVP deployed, handoff test passed, actual hours within 20% of estimate"_ | |
| **Conditional** (proceed with modifications) | _e.g., "MVP works but took 2x projected hours — evaluate methodology adjustments"_ | |
| **Failure** (stop) | _e.g., "Quality unacceptable, security findings unresolvable, or Orchestrator unable to evaluate AI output"_ | |

---

## 9. Accessibility & UX Constraints

> ## ⚠️ CRITICAL ACCESSIBILITY CONSTRAINT — THE OPERATOR IS COLORBLIND
> **Every UI signal, status indicator, control, and distinction MUST be conveyed by shape, position, text label, or icon — NEVER by color alone.** This is a HARD constraint from Day 1, not a Phase 3 afterthought. It applies to all custom surfaces and to any LibreChat theming. Specifically: the `trusted:false` vs `trusted:true` distinction in the grounding inspector (#13), the prompt-master per-message toggle (#12), write-approval/step-up gates, session/backend status, and error states must all be distinguishable WITHOUT relying on color. Color may be used as a redundant secondary cue only.

| Field | Value |
|---|---|
| **Accessibility requirements** | Colorblind-safe is the governing requirement (never color alone). Target WCAG AA where applicable; automated + manual accessibility checks mandatory (operator self-assessed "Partially" on WCAG). |
| **Color vision deficiency considerations** | **YES — operator is colorblind.** Never rely on color alone for meaning. Use shape, position, text labels, patterns, or icons. Color only as a redundant secondary cue. |
| **Supported browsers** | Modern desktop browsers (Chrome / Firefox / Safari — internal tool, latest versions). |
| **Mobile responsive required?** | No — desktop browsers only. |
| **Supported devices** | Desktop only (multi-device on the tailnet, but desktop-class browsers). |
| **Branding / style guide** | None — agent's discretion, subject to the colorblind-safe constraint above; defaults to LibreChat's UI. |
| **Dark mode required?** | Nice-to-have (LibreChat default). Must remain colorblind-safe in any theme. |

---

## 10. Distribution & Operations Preferences

**All Platforms:**

| Field | Value |
|---|---|
| **Notification preferences for alerts** | Operator-direct (e.g., via Alden Bridge mailbox / homelab notifications). No PagerDuty/Slack enterprise. Not specified in brief — operator's discretion. |
| **Uptime expectation** | Best effort — single operator, internal tool. |
| **Environment strategy** | Not specified in brief. Likely dev + production on the homelab (operator's discretion — see Open Questions). |

**Web Applications:**

| Field | Value |
|---|---|
| **Domain name** (if already acquired) | None public. Internal hostname via Caddy on LAN/Tailscale. |
| **SSL certificate** | Internal — Caddy-managed (no public CA needed; LAN/Tailscale only). |
| **Maintenance window preferences** | None — single operator; deploy at will. |

**Desktop Applications:**

| Field | Value |
|---|---|
| **Distribution channels** | N/A — web only (self-hosted) |
| **Code signing** | N/A — web only |
| **Code signing certificates** (if required) | N/A |
| **Auto-update mechanism** | N/A — self-hosted redeploy |
| **Minimum supported OS versions** | N/A |
| **Installer format preferences** | N/A |

**Mobile Applications:**

| Field | Value |
|---|---|
| **Distribution** | N/A — web only |
| **Developer accounts** | N/A |
| **Beta testing** | N/A |

---

## 11. Known Risks & Concerns

_Anything the agent should know that doesn't fit elsewhere. Technical debt you're aware of going in, political sensitivities, dependencies on other projects, timing constraints, previous failed attempts at solving this problem, etc._

```
SECURITY-SENSITIVE PROJECT. The whole value proposition is a defensible trust
boundary and per-identity isolation; security findings gate everything.

Key risks / known constraints carried in from the brief:
- Prompt injection is the primary threat. Trust enforcement MUST live at the
  GATEWAY, not the model (#10, #13). Taint is by PRESENCE (any trusted:false
  content in a session's context gates that session's writes) — NOT by judgment.
- Peta's native approval trigger is static per-tool dangerLevel ("gate all
  writes" is native; mark write-scoped tools dangerLevel: 2). The
  taint-by-presence refinement is BUILT here (compute taint per session; keep
  writes gated or toggle danger per call). This is the riskiest custom logic —
  pure, fully unit-testable; cover it heavily.
- Peta hardening is NON-NEGOTIABLE (brief §6): run peta-core non-root, no
  docker.sock, remote/HTTP downstreams only (no CustomStdio); npm audit fix /
  pin patched image and re-audit per upgrade; LAN/Tailscale only; never expose
  /admin or GET_OWNER; no Cloudflared; no anonymous /mcp/public. Token entropy
  per identity is the WHOLE of gateway auth — strong unique tokens.
- HMAC keys are gateway-custodied and signed on the session's behalf; NEVER
  loaded into session context.
- Identity is bound to its creation backend permanently (#14a); reject
  cross-backend identity requests at session creation.
- Peta Console GUI is closed — MVP drives the admin REST API directly (#11).
- Adopted-component dependency: project rides on LibreChat (Agents ≈ identities,
  Meilisearch search, built-in auth) and Peta (ELv2). Track upstream changes.
- Operator orchestrates AI rather than hand-writing code — artifacts/outputs
  must be precise enough to hand to Claude Code.
- The colorblind constraint (§9) is a hard, day-one architectural constraint.

Authoritative source: docs/phase-0/REQUIREMENTS-SOURCE.md (this file wins until
the Project Bible supersedes it at the Phase 1 gate). Companion references:
../ALDEN-HARNESS-CLI-HANDOFF.md (architecture rationale + validated Peta eval,
incl. RESULTS), ../peta-eval/ (reproducible gateway eval).
```

---

## 11.5. Testing & Bug Tracking

| Field | Value |
|---|---|
| **Testing interval** | Every 2 features (default). |
| **Bug tracking tool** | BUGS.md (single operator; self-hosted Gitea Issues optional). |
| **Human tester count** | 1 (the operator). |
| **Beta tester coordination** (if >1 tester) | N/A — single operator. |
| **Bug severity SLAs** (Full UAT level only) | Defaults: SEV-1 24h / SEV-2 7d / SEV-3 best effort. SEV-1 cannot be deferred; given the security focus, any SEV-1/SEV-2 affecting the trust boundary, isolation, or auth must be resolved before the relevant phase gate. |

> **How this is used:** The agent pauses construction every N features to run a UAT testing session. Agent testers run automated, exploratory, and cross-platform tests in parallel while you test manually. Bugs are compiled, triaged, and fixed before construction resumes. See Steps 2.7-2.9 in the Builder's Guide.

---

## 12. Tooling Configuration

> This section is auto-populated by `init.sh` based on the tool installation matrix. It records what was installed, what needs manual setup, and what is deferred to later phases. Claude reads this to understand the available tooling environment.
>
> If this section is empty, run `init.sh` or manually populate `.claude/tool-preferences.json`.

<!-- AUTO-GENERATED BY INIT.SH — do not edit above this line -->

---

## 13. Agent Initialization Prompt

_Once this template is complete, provide it to the AI agent at the start of Phase 0 along with the Builder's Guide. Copy and customize the bracketed sections._

_The Builder's Guide contains dual-path prompts for Phase 0 and Phase 1 — one for Intake-first (validation and expansion) and one for conversational discovery (without Intake). By providing this Intake, you are activating the Intake-first path. The agent will validate, expand, and challenge your inputs rather than discovering them from scratch._

```
You are the AI execution layer for a Solo Orchestrator project. I am the
Orchestrator. I define intent, constraints, and validation. You provide
architecture, code, and documentation within the constraints I set.

ATTACHED:
1. Project Intake Template (this document) — your primary constraint
2. Solo Orchestrator Builder's Guide v1.0 — your process reference
3. Platform Module: [WEB / DESKTOP / MOBILE] — your platform-specific
   reference for architecture, tooling, testing, and distribution

DOCUMENT RELATIONSHIP:
- The Intake is the DATA SOURCE. It contains my decisions, constraints,
  requirements, technical profile, and (if organizational) governance
  pre-conditions.
- The Builder's Guide is the PROCESS. It defines the phases, steps,
  quality gates, and remediation procedures you follow.
- The Platform Module is the PLATFORM IMPLEMENTATION GUIDE. When the
  Builder's Guide shows a ⟁ PLATFORM MODULE callout, reference the
  attached Platform Module for platform-specific instructions.
- Where the Builder's Guide shows "With Intake" prompts, use those.
  They direct you to validate and expand my Intake data rather than
  re-discovering it.

RULES:
- The Project Intake is the governing constraint. Do not suggest features,
  architectures, or tooling that contradict it.
- The Builder's Guide defines the phase-by-phase process. Follow it.
- The Platform Module defines platform-specific implementation. Follow it
  at every ⟁ callout point.
- If the Intake specifies a hard constraint, respect it absolutely.
- If the Intake specifies a preference, you may recommend against it with
  justification, but defer to my decision.
- If the Intake leaves a field as "no preference," make a recommendation
  based on the constraints and explain your reasoning.
- If the Intake leaves a field blank or incomplete, flag it immediately
  and ask for the specific missing information before proceeding past
  the step that requires it.
- For any domain where my Competency Matrix (Section 6.2) says "Partially"
  or "No," default to the most conservative, well-documented option and
  ensure automated validation tooling covers that domain.
- Do not add features not in the MVP Cutline (Section 4.1).
- Do not suggest dependencies without justification.
- Every feature must have tests before implementation.
- Flag any conflict between the Intake constraints and technical feasibility
  immediately — do not silently work around it.

ACCESSIBILITY (from Section 9):
[Copy any specific requirements here, e.g., "Color vision deficiency:
never rely on color alone for meaning. Use shape, position, text labels,
patterns, or icons."]

PROJECT TRACK: [Light / Standard / Full]
PLATFORM: [Web / Desktop / Mobile / Other]
TARGET PLATFORMS: [e.g., Windows 10+, macOS 12+, Ubuntu 22.04+]

BEGIN: Execute Phase 0, Step 0.1 using the "With Intake — Validation
Prompt" path from the Builder's Guide. Use Sections 2 and 4 of the
Intake as the primary data source. Generate the Functional Requirements
Document by expanding my business logic triggers and failure states.
Where I've been vague, make it specific and flag for my review. Where
I've been contradictory, identify the contradiction and ask me to resolve
it. Where I've omitted an implicit dependency (e.g., features that
require authentication but I didn't list authentication), flag it as a
recommended addition.
```

---

## Checklist Before Starting

- [ ] Every field is filled in or explicitly marked N/A
- [ ] Must-Have features all have business logic triggers (If X, then Y)
- [ ] Must-Have features all have failure states defined
- [ ] Will-Not-Have list has at least 3 items
- [ ] Data sensitivity classifications are assigned to all inputs
- [ ] Competency Matrix is completed honestly
- [ ] Budget constraints are realistic (not aspirational)
- [ ] Timeline includes Orchestrator availability, not just calendar dates
- [ ] For organizational deployments: all Section 8 "Blocking" items are Complete
- [ ] Success/failure exit criteria are defined and a decision-maker is named
- [ ] This document has been saved as `PROJECT_INTAKE.md` in the project repository

---

## Open Questions for Operator

_Items the brief (`docs/phase-0/REQUIREMENTS-SOURCE.md`) leaves genuinely undecided. These do not block Phase 0 discovery but should be resolved before they gate downstream work. Nothing here invents requirements — each is a blank the brief did not fill._

1. **Timeline / availability (§3.1):** The brief sets no MVP date, no deadline, and no orchestrator hours-per-week or blocked-vs-interleaved schedule. Provide these (or confirm "as time allows, no deadline").
2. **Repository layout (§6.4 Cross-Cutting):** Single repo for the custom control-plane glue + Obsidian MCP, or separate repos? (Adopted LibreChat/Peta are external.) Confirm the Gitea repo URL for this project.
3. **CI runner host (§6.5):** Where does the local CI chain (Semgrep/gitleaks/Snyk/tests/Lighthouse) run — a homelab host, the dev Mac, or self-hosted Gitea Actions? Confirm.
4. **Backup specifics (§5.4):** Brief states the existing homelab posture (Gitea versioning, Obsidian/CouchDB LiveSync) but does not specify backup cadence/coverage for LibreChat conversation store, Meilisearch index, Qdrant collections, and the gateway's HMAC key custody store. Confirm a concrete backup + key-recovery plan (HMAC key loss = identity write-integrity loss).
5. **Environment strategy (§10):** Production-only on the homelab, or dev + production? Confirm.
6. **Alerting (§10):** Preferred channel for operational alerts (mailbox, homelab notification, other)?
7. **Auth tiering (#9/#11):** Brief calls for "strongest auth tier" on the gateway-management interface but does not define the concrete tiers/mechanism (e.g., step-up factor) for that privileged surface vs ordinary session auth. Confirm the intended step-up mechanism.

---

## Document Revision History

| Version | Date | Changes |
|---|---|---|
| 1.0 | 2026-04-02 | Initial release. |
| 1.0-filled | 2026-06-13 | Intake populated from `docs/phase-0/REQUIREMENTS-SOURCE.md` (Pantheon Harness, Standard track, personal/web). Revenue Model skipped (internal tool); Governance N/A (personal). Open Questions for Operator block added. |

---

## Tooling Configuration

> Auto-generated by init.sh. Full machine-readable config: `.claude/tool-preferences.json`

**Resolved for:** Darwin / web / typescript / standard track

### Installed
| Tool | Category | Version |
|---|---|---|
| Git | version_control | 2.50.1 |
| jq | json_processor | jq-1.7.1-apple |
| Node.js | runtime | 25.9.0 |
| Docker | containerization | 29.3.1 |
| Colima | containerization | 0.10.1 |
| GPG | commit_signing | 2.5.18 |
| Semgrep | SAST Scanner | 1.157.0 |
| gitleaks | Secret Detection | 8.30.1 |
| Snyk CLI | Dependency Scanner | 1.1304.1 |
| Claude Code | ai_agent | 2.1.177 (Claude Code) |
| Development Guardrails for Claude Code | dev_framework | 05eccc2 |
| Superpowers | claude_plugin | installed |
| Context7 MCP | mcp_server | configured |
| Qdrant MCP | mcp_server | configured |
| Lighthouse | Performance Auditing | 13.1.0 |

### Deferred (Phase 3+)
| Tool | Phase | Category |
|---|---|---|
| OWASP ZAP | 3 | DAST Scanner |
| license-checker | 3 | License Compliance |
| Playwright | 3 | E2E Testing |

