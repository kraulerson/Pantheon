# Data Contract — Pantheon Harness

<!--
  Phase 0 Step 0.3 output. This document captures the full data input/output
  specification before it is summarized into the Product Manifesto Section 4.

  Save as: docs/phase-0/data-contract.md

  This defines WHAT data flows through the system, not HOW (architecture is Phase 1).
-->

**Date:** 2026-06-13
**Status:** Draft

---

## Data Inputs

Trust/provenance is a first-class attribute of every input. The hard rule (Req. #13): **only the operator's text typed in THIS session is `trusted:true`. Everything recalled, cross-session, or non-user — Qdrant, mailbox, persona, prior sessions, model/tool output — enters tagged `trusted:false`.** HMAC signing keys and per-identity Peta access tokens are the highest sensitivity: gateway-custody only, never present in any session context.

| # | Input | Source | Format | Validation Rules | Sensitivity |
|---|-------|--------|--------|-----------------|-------------|
| 1 | Operator message (current session) | User (typed, this session) | UTF-8 text | Required; length-bounded; **provenance = `trusted:true`** (only input that is) | Internal (may contain PII/secrets the operator types) |
| 2 | UI auth credential / session token | User → LibreChat auth | Token/cookie | Required before any session opens; valid + unexpired; tailnet-reachable only | Sensitive |
| 3 | Identity selection (AI system × identity) | User (New-Session popup) | Enum + identity ref | AI system ∈ registered backends; identity ∈ {existing, new, none}; existing identity must be bound to the chosen backend (else reject at creation, #14a) | Internal |
| 4 | New-identity template request | User → glue → Gitea template | Template ref + name | Name unique; template resolvable; triggers provisioning (repo, Qdrant collection, HMAC key, Peta user) | Internal |
| 5 | Per-session source toggles + grounding/prompt-master toggles | User (per session) | Booleans | Grounding default-ON for identity sessions; prompt-master default-OFF; each source individually toggleable | Internal |
| 6 | Loaded persona / system prompt | Identity Gitea repo (recalled) | Markdown/text | Bound to selected identity at creation only (never runtime-injected); **`trusted:false`** | Internal |
| 7 | Qdrant recall hits | Identity's private Qdrant collection | Vector hits → text | Scoped to identity's collection; **`trusted:false`**; taints session by presence | Internal (content may carry PII) |
| 8 | Mailbox messages / search hits | Alden Bridge mailbox | Message records | Read/search; **`trusted:false`**; taints session by presence | Internal |
| 9 | Cross-session search hits | Unified store across ALL sessions/identities (Meilisearch + transcripts) | Text snippets | Any session may search all; recalled content **`trusted:false`**; taints by presence | Internal |
| 10 | Model responses / tool-call results | Backend (Alden-1, Claude) / MCP tools | Text / structured | Non-user origin → **`trusted:false`**; taints by presence | Internal |
| 11 | Write-approval decision (out-of-band) | User (explicit confirmation) | Approve/deny + ref | Required to release any gateway-gated write; tied to a specific pending call | Internal |
| 12 | Prompt-master draft (in) | User draft text only | Text | Text-in only; **no identity, no tools, no session authz** reach the rewriter | Internal |
| 13 | MCP server registration | User (admin, gateway mgmt) | Server descriptor + creds | Server must register + authenticate before reachable (#10a); behind strongest auth tier | Sensitive |
| 14 | Per-identity HMAC signing key | Generated at provisioning → gateway vault | Key handle (in session); raw key (vault only) | **Gateway custody only; NEVER loaded into session context, prompts, or logs** | **Highest** |
| 15 | Per-identity Peta access token | Minted by glue at session creation | Bearer token | One identity = one Peta user; strong unique entropy (token entropy IS the auth); **never echoed to client/session/logs** | **Highest** |

---

## Data Transformations

Discrete pipeline steps. The trust model is enforced at the gateway, **not** by the model (#13 three-layer enforcement).

| # | Input(s) | Transformation | Output | Error Behavior |
|---|----------|---------------|--------|----------------|
| 1 | #6,#7,#8,#9 + #1 | **Grounding assembly:** retrieve from enabled sources → tag every recalled item `trusted:false` → assemble a single inspectable grounded prompt with untrusted content visibly distinguished (label/position/icon, never color) | Assembled grounded prompt (ephemeral, inspectable pre/post-send) | If a source is unavailable: omit it, surface a non-color indicator; never silently substitute or upgrade trust |
| 2 | #1,#6–#10 | **Taint-by-presence tracking:** if ANY `trusted:false` content is present in the session context, mark the session tainted. Presence-based, NOT judgment-based (#14c) | Per-session taint flag | Fail closed: if taint state is indeterminate, treat as tainted |
| 3 | Proposed write + taint flag (#2) | **Write-approval gating:** write-scoped tools are `dangerLevel:2` at Peta (gate all writes natively). Glue keeps writes gated whenever session is tainted; releases only on explicit out-of-band approval (#11) | Approved or held write request | No approval → write blocked and held durably; never auto-commit |
| 4 | Approved write + #14 | **HMAC sign-on-behalf at gateway:** gateway signs the write with the identity's own HMAC key. A's key cannot sign B's repo/memory (#14b) | Signed write to scoped target | Signing failure → reject write, audit; key never leaves vault |
| 5 | #12 | **Prompt-master isolated rewrite:** text-in → rewrite-only service on Alden-1 (no identity, no tools, no authz) → text-out; present beside original with diff; operator picks which sends; never auto-substitute (#12) | Rewritten draft (operator-selectable) | Rewriter down → fall back to original draft; toggle is colorblind-safe shape/label |
| 6 | #3,#4 | **Identity provisioning / binding:** existing → load persona + tool authz + Qdrant collection + Gitea scope; new → create repo/scope/collection, gen HMAC key→vault, bind backend, create Peta user+perms; none → bare session, minimal authz, no write scope | Configured session + backend binding registry entry (#14a) | Identity-on-wrong-backend → reject at creation |
| 7 | #2 | **UI auth gate:** authenticate before any session or privileged action; multi-device on tailnet; logged-out device reaches nothing | Authenticated UI session | Unauthenticated → no session, no privileged action |

---

## Data Outputs

| # | Output | Destination | Format | Retention | Sensitivity |
|---|--------|-------------|--------|-----------|-------------|
| 1 | Assembled grounded prompt (inspectable) | Screen (operator) + backend on send | Structured text w/ trust labels | Ephemeral (session memory) | Internal |
| 2 | Model responses | Screen + session transcript | Text | Persistent (transcript store) | Internal |
| 3 | Tool-call results | Session context + transcript | Structured / text | Persistent (transcript), `trusted:false` | Internal |
| 4 | Gateway audit log | Gateway durable store | Append-only log | Persistent (long-lived) | Sensitive — **must contain NO raw keys/tokens/secrets** |
| 5 | Signed write — Gitea | Identity's scoped Gitea repo | Commit/blob, HMAC-signed | Persistent | Internal |
| 6 | Signed write — Qdrant | Identity's Qdrant collection | Vector + payload, signed | Persistent | Internal |
| 7 | Signed write — Obsidian | Vault (LiveSync → CouchDB propagates) | Markdown via Obsidian MCP | Persistent | Internal |
| 8 | Approval records | Gateway durable store | Decision + call ref + timestamp | Persistent | Sensitive |

---

## Third-Party Integrations

| # | Service | Data Sent | Data Received | Fallback if Unavailable |
|---|---------|-----------|---------------|------------------------|
| 1 | Qdrant (per-identity collections, `10.100.23.79:6333`) | Query vectors, signed payload writes | Recall hits (`trusted:false`) | Recall sources omitted (non-color indicator); session proceeds without memory; writes blocked. No client-side caching of recall content beyond the live session |
| 2 | Gitea (per-identity repos) | Persona reads; signed writes | Persona/template text; commit refs | Persona load fails → block identity session start; writes held; provisioning aborts cleanly. Persona may be cached read-only for the session lifetime only |
| 3 | Alden Bridge MCP (`10.100.23.88:8765` — mailbox/memory/converse) | Mailbox queries, converse messages | Messages, memory (`trusted:false`) | Mailbox/group features degrade with a visible indicator; session continues; no stale-cache writes |
| 4 | Obsidian vault (LiveSync/CouchDB) | Signed Markdown writes (via MCP) | Write ack | Writes held in approval/queue; never silently dropped; LiveSync resync on reconnect |
| 5 | Backend — Alden-1 (Qwen, `192.168.1.89:8080`, OpenAI-compat) | Assembled prompt; prompt-master drafts | Completions | Session shows backend-down (non-color); no failover that crosses identity backend binding |
| 6 | Backend — Claude (Anthropic API / claude.ai) | Assembled prompt | Completions | Same as #5; binding preserved |
| 7 | Peta MCP gateway (`dunialabs/peta-core`) | Per-identity token, tool calls, signing requests | Tool results, authz decisions, signed writes | If gateway down: ALL tool calls and writes fail closed (no direct-to-backend bypass). Hardening: non-root, no docker.sock, LAN/Tailscale-only, no `/admin` or `GET_OWNER` exposure |

---

## State Boundaries

The boundary: **the permanent store holds identity definitions, authz, memory, transcripts, and security artifacts; session memory holds only the live assembly and in-flight calls and is lost on close.** HMAC keys and Peta tokens live in gateway custody — in the permanent store as protected secrets, never copied into session memory.

| Data | Lifecycle | Persistence | Backup Required |
|------|-----------|-------------|-----------------|
| Identities + backend binding (#14a registry) | Created at provisioning → removed on deprovision | Disk (permanent store) | Yes |
| Peta users / permissions | Created at provisioning → edited via admin API | Disk (Peta store) | Yes |
| Qdrant collections (per identity) | Created at provisioning → persists | Disk (Qdrant) | Yes |
| Sessions + transcripts | Created at New Session → persists for cross-session search | Disk (transcript + Meilisearch index) | Yes |
| Taint flags | Computed at message time → persists with session record | Disk (session record) | Yes |
| Approval records | Created on gate decision → persists | Disk (gateway store) | Yes |
| HMAC key handles + Peta tokens | Generated at provisioning/session creation → held by gateway | Disk (gateway vault, encrypted) — **never in session memory** | Yes |
| Assembled grounded context | Built per message → destroyed on session close | Memory (ephemeral) | No |
| In-flight tool calls | Created on call → resolved/dropped on completion | Memory (ephemeral) | No |
| UI auth session token | Login → logout/expiry | Memory / short-lived store | No |

---

## Sensitivity Classification Summary

PII/secrets enumeration and where each must **NEVER** appear:

| Classification | Data Items | Handling Requirements |
|---------------|------------|----------------------|
| **PII / Secrets — Highest** | Per-identity HMAC signing keys; per-identity Peta access tokens | Gateway/vault custody only. **MUST NEVER appear in:** session context, assembled prompts, model inputs, client UI, audit logs, transcripts, or error messages. Encrypted at rest; signing happens at the gateway on the session's behalf |
| **Sensitive** | UI auth credentials/tokens; MCP server registration creds; gateway audit log; approval records | Strongest auth tier for gateway mgmt; access-controlled; audit log records actions but redacts all secrets; LAN/Tailscale-only, no public ingress |
| **Internal (may carry PII in content)** | Operator messages; persona/system prompts; Qdrant recall; mailbox; cross-session transcripts; model/tool outputs; grounded prompt | On-prem only; secrets never leave the LAN. Operator-typed content may contain PII/secrets — keep within LAN trust zone; never log full prompt bodies containing recalled secrets verbatim to shared logs |
| **Public** | None | — |

**NEVER-appear rule (explicit):** HMAC keys and Peta tokens must never be present in (1) logs/audit entries, (2) client or session context, (3) prompts sent to any model, (4) transcripts, or (5) error output. Operator-typed secrets and recalled PII must never be written to the gateway audit log in cleartext.

---

## Review Checklist

- [x] Every input has a defined source and validation rules
- [x] Every transformation has an error/fallback behavior
- [x] Every output has a defined destination and retention policy
- [x] PII is identified and handling requirements are specified
- [x] Third-party integrations have fallback behavior defined
- [x] State boundaries are clear (ephemeral vs. persistent)

---

## Open Question

- **Audit-log scope vs. secret-redaction:** Req. #13 requires the assembled grounded prompt to be fully inspectable (including `trusted:false` content), but recalled content and operator-typed input may contain PII/secrets. The gateway audit log must prove what was sent without persisting those secrets in cleartext. Needs a Phase 1 decision on what the audit log records (hashes/refs vs. redacted bodies) and how long inspectable assembled prompts are retained beyond the live session.
