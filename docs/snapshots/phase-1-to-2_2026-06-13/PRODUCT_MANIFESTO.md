# Product Manifesto — Pantheon Harness

<!--
  This document is the foundational artifact produced during Phase 0.
  It defines what the product does, who it serves, and what is in/out of scope.
  It is the north star for all subsequent phases.

  Completion gates entry to Phase 1. All 8 numbered sections must be filled out.
  Appendices are track-conditional — see inline notes.

  Do not alter headings or remove sections. Add content within the placeholders.
-->

**Status:** Approved
**Approved By:** Karl (Orchestrator)
**Approval Date:** 2026-06-13
**Phase Gate:** Phase 0 → Phase 1

> **Manifesto Rules (binding on all later phases):**
> 1. **Architecture that contradicts this Manifesto is rejected.** The Project Bible (Phase 1) may refine *how*, never override *what* this document fixes as intent, scope, or trust model.
> 2. **Features not above the MVP Cutline (§5) are not built in Phase 2.** Moving an item above the line requires explicit Orchestrator approval and a recorded decision in the Approval Log.
> 3. **Every open question is resolved at this gate.** The Phase 0 → Phase 1 gate fails if any question is left unresolved (status open). See §8 — all are Resolved.

---

## 1. Product Intent

Pantheon Harness is a single, internally-hosted web harness that lets one solo senior architect ("Karl") safely orchestrate a distributed homelab AI ecosystem ("Alden") — conversing with multiple AI backends and personas, grounding them on private memory, and writing to scoped systems — **without the harness ever becoming a prompt-injection vector.** The problem it solves: orchestrating many AI identities across LibreChat (UI), a hardened Peta MCP gateway (trust core), and custom control-plane glue, while enforcing — at the gateway, never by trusting the model — a hard trust boundary in which only the operator's typed input is trusted and every recalled/cross-session/non-user fragment is `trusted:false` and gates that session's writes. The outcome: frictionless reads and reasoning, with every write to a scoped system (Gitea, Qdrant, Obsidian, bridge sends) passing an inspectable, out-of-band human-approval gate signed by gateway-custody keys the session never sees. Architecture that contradicts this intent is rejected; features that do not serve it are not built.

---

## 2. Functional Requirements

<!-- Source: Phase 0 Step 0.1 (docs/phase-0/frd.md). Requirement #n refers to REQUIREMENTS-SOURCE.md §4. -->

### Must-Have (MVP)

- **UI authentication gate (#9):** If any request for a session, session list, or privileged action arrives without a valid authenticated UI session, the system must reject it and output only the login screen. Failure state: 401/redirect to login, no session metadata leaked; operator re-authenticates and the original route re-resolves. No "remember me" bypass of step-up gates.
- **Internally-hosted web UI, LAN/Tailscale only (#1, §2):** If a request reaches the UI from an origin not on the LAN or tailnet, the system must drop it and output nothing. Failure state: connection refused / not routable — public reachability is a defect, not a recoverable state; verified by config + network test.
- **Tabbed multi-session to distinct backends (#2):** If the operator opens a session bound to backend B while session A is active, the system must maintain both concurrently with non-cross-contaminating per-tab state. Failure state: an unreachable backend shows a per-tab connectivity error (icon + text label, colorblind-safe) without killing other tabs.
- **Peta gateway — single hardened point (#3, §6):** If any AI system attempts to reach a tool/backend other than through Peta, the system must have no such path; all tool traffic flows exclusively through the gateway (non-root, no docker.sock, remote/HTTP downstreams only, `/admin` and `GET_OWNER` never exposed). Failure state: direct-to-backend calls are unroutable — a bypass is a misconfiguration caught in CI/threat model, not handled at runtime.
- **Identity = one Peta user; per-tool authz (#10b, #5-ii, #14b):** If a session invokes a tool, the system must resolve its identity to a Peta user and check per-tool authorization at the gateway; authorized → execute, else → gateway-side denial (not a model refusal), logged with correlation ID. Failure state: no in-session escalation; reconfigure authz via the admin API (M12).
- **MCP server registration auth (#10a):** If a new MCP server attempts to become reachable, the system must require it to register and authenticate at the gateway first; until then it is "unregistered/unreachable" and routes no calls. Failure state: calls to an unregistered server fail closed.
- **Write-approval gate, `dangerLevel: 2` (#5, #14c, #8):** If a session issues a write-scoped tool call (Gitea/Qdrant/Obsidian write, or a send-type bridge tool), the system must hold the call and output an explicit out-of-band human-approval prompt **that displays the proposed write — the tool plus its arguments/diff** — and only on operator approval does the gateway sign and commit. Resolution is **single-decision across devices (first decision wins / lock)**. Failure state: an unapproved or timed-out write is not committed (recorded pending/denied); reads/reasoning are never gated; controls are shape/label-based, never color-only.
- **Identity-as-session-profile, EXISTING identities (#5 i/ii/iv):** If the operator selects an existing identity in the New-Session popup, the system must configure the session at creation from that identity's Gitea persona/system prompt, its tool/MCP authorizations, and its Gitea write scope, then open a session bound to those settings. Failure state: if any source cannot be loaded, creation fails closed with a specific error and **no partially-configured session opens.**
- **Register-an-existing-identity path (MVP enabler — see Resolved Decision D1):** If the operator runs the scripted/CLI register-existing-identity command, the system must record an existing Alden identity (persona repo ref, backend binding, Qdrant collection, Peta user/token, HMAC key handle) into the control-plane registry so that ≥1 identity is selectable in the New-Session popup. Failure state: a registration missing any required field is rejected and no partial registry entry persists. (Full *new-identity provisioning UX* remains Should-Have.)
- **Backend binding at creation (#14a):** If a session requests an identity on a backend other than the one it was permanently bound to at creation, the system must reject creation with a binding-violation error. Failure state: "identity X is bound to backend Y, not Z" — no runtime rebinding.
- **Grounding pipeline — `trusted:false` tagging + taint-by-presence + inspectability (#13, #14c):** If context is assembled from any non-current-user-typed source (persona, identity Qdrant, mailbox, cross-session search), the system must tag that content `trusted:false` at retrieval; if ANY `trusted:false` content is present, it must gate that session's write-scoped calls pending approval; and it must output a fully-inspectable assembled prompt distinguishing untrusted content by label/position/icon (never color). Failure state: indeterminate provenance defaults to `trusted:false` (fail safe); if the inspector cannot render, send is blocked.
- **Cross-session search, unified (#4):** If the operator searches from any session, the system must search across ALL sessions/identities and output ranked hits; any hit injected into context is tagged `trusted:false`. Failure state: if the search index is unavailable, a clear "search index unavailable" state (icon + text) — never silent empty results mistaken for "no matches."
- **Gateway management via admin API (#11 API-level):** If the operator (under the privileged tier) issues an add/remove/edit on an MCP server registration via the admin REST API, the system must apply it and output the updated registration state. Failure state: calls outside the privileged tier are denied; malformed registration is rejected with no partial registration persisting.
- **Bridge mailbox + group conversation via proxied tools (#6, #7):** If the operator opens the mailbox or starts a group conversation, the system must surface the Alden bridge tools (proxied through the gateway) and output mailbox contents (checkable + searchable) / a group session. Failure state: if the bridge MCP server is unreachable, a connectivity error (icon + text), not stale-as-live data. Mailbox/converse content entering any session is `trusted:false`; send-type bridge tools are WRITES (see Resolved Decision D2).
- **Obsidian/filesystem MCP server, write-gated (#8):** If a session issues an Obsidian vault write, the system must route it through the Obsidian MCP server registered behind Peta with write tools at `dangerLevel: 2`, gate it, and on approval output a committed write that LiveSync propagates. Failure state: write rejected/held if unapproved or the session is tainted; a failed filesystem write returns a specific error and never reports false success.

**Cross-cutting MVP constraints (apply to every UI-bearing feature):**
- **CC1 — Colorblind safety (§3):** Every signal/control must be distinguishable by shape, position, text label, or icon — never color alone. Any color-only signal is a SEV-2 accessibility defect.
- **CC2 — Fail closed:** Every authz, taint, and write decision defaults to deny/untrusted on ambiguity or error.
- **CC3 — Gateway-enforced, not model-enforced:** Authorization, injection containment, and write gating are decided at the Peta gateway, never by trusting the model's self-report.

### Should-Have (v1.1)

- **New-identity provisioning orchestrator (#5 "new"):** One transaction — pull Gitea template, create repo/scope, create Qdrant collection, generate HMAC key → gateway custody, set backend binding, mint Peta user + perms, then open the session. Deferred: high-blast-radius multi-system write; needs MVP gateway, key custody, and binding registry trusted first, plus defined rollback/saga semantics.
- **Prompt-master isolated rewriter (#12):** Opt-in, default OFF, per-message toggle (shape/label, colorblind-safe); draft → rewrite-only service on Alden-1 (no tools, no identity, no session authz); rewrite shown beside original with a diff; operator picks which sends; never auto-substitute.
- **Gateway management GUI (#11 GUI):** A UI over the admin REST API for MCP server registration, behind the privileged tier. MVP drives #11 via the admin API directly.
- **Additional backends — 7900XTX local + cloud (#5):** Add to the data-driven backend list, each with its own binding. Hardware/endpoints not yet present.

### Will-Not-Have

- **Public / multi-tenant exposure:** §2 FIRM + §7 — exactly one operator, LAN/Tailscale only, no external users ever; multi-tenant would break the single-token-entropy auth model.
- **Cloudflare Tunnel / any public ingress:** §2 + §6 forbid Cloudflared and public `/mcp/public`; an exclusion, not a config option.
- **Any color-only UI signal:** §3 — the operator is colorblind; color-as-sole-channel is a prohibited design.
- **Runtime identity context-injection:** §8 — identity is configured at session creation time only; no mid-session identity swap or runtime persona/authz injection.
- **Loading HMAC keys into a session's context:** §8 + #14b — keys live in gateway custody and sign on the session's behalf; a key in context is exfiltrable by a prompt-injected session.
- **Trusting the model to self-police writes/taint:** #10/#13 — no "ask the model nicely" controls and no taint-by-model-judgment; taint is by presence, gating is at the gateway.

---

## 3. User Journeys

<!-- Source: Phase 0 Step 0.2 (docs/phase-0/user-journey.md). -->

### Persona

- **Who:** Karl — solo senior architect; sole human operator of the Alden homelab ecosystem; orchestrates AI rather than hand-writing code.
- **Skill Level:** High (architect-level). **Colorblind** — every UI cue must be shape, position, text label, or icon, never color alone.
- **Goal:** Drive distributed AI identities safely from one harness — converse, ground on private memory, write to scoped systems — without the harness becoming an injection vector.
- **Emotional State on Arrival:** Focused but frequently context-switching across concurrent sessions; may be tired/distracted; is also his own adversary for threat-modeling. The UI must assume a confused or fatigued operator and fail safe.

### Success Path

1. **Authenticate (#9):** User sees the LibreChat login if logged-out (no session list, no identity names leaked). User enters credentials. System blocks all session/privileged surfaces until auth succeeds, then lands in the harness shell (session list / tab bar), with a per-device signed-in indicator (text/icon).
2. **Open New Session (#5):** User sees the New-Session popup and selects AI SYSTEM × IDENTITY (existing / none / new), then confirms. System resolves the identity→backend binding (#14a), loads persona/authz/Qdrant collection/Gitea scope from the identity, mints a per-identity Peta token, and opens a tab labeled with identity + backend (text, not color), verifiable in a session-info panel.
3. **Converse with grounding ON + inspect prompt (#13):** User sees the message box (grounding default-ON) and opens "Inspect assembled prompt" before sending. System assembles the prompt, tags every non-user source `trusted:false`, and renders the full prompt with untrusted blocks distinguished by label + icon + position (never color); each source is individually toggleable. User sends only after reviewing.
4. **Approve or deny a write from a tainted session (#13/#14c):** User sees an out-of-band approval gate when a reply proposes a write while the session holds any `trusted:false` content. System shows **what will be written, the tool + arguments/diff, the target scope, and the signing identity**; user clicks Approve or Deny (distinct shaped/labeled buttons + position). On Approve the gateway signs (key never enters session context) and commits with a receipt; on Deny no write occurs and state is unchanged. The decision is single-resolution across devices and is logged.
5. **Recall: search, mailbox, group (#4/#6/#7):** User sees cross-session search results spanning all identities, a checkable/searchable mailbox, and ad-hoc group conversations via proxied bridge tools. System returns reads frictionlessly; any recalled or non-user content entering a session is `trusted:false` (feeding steps 3/4). Send-type bridge actions are writes and follow step 4.

### Failure Recovery

- **Step 1:** Stale/expired session or a logged-out second device → re-authenticate; logged-out devices stay blocked from all session/privileged surfaces ("Session expired — sign in again").
- **Step 2:** Identity requested on a backend it is not bound to (#14a) → creation rejected at the popup, offered the correct bound backend or a "no identity" bare session. Bound backend offline / token mint fails → retry, or open a bare session to keep working.
- **Step 3:** A grounding source is down or empty → per-source toggle lets the operator proceed without it; inspector lists omitted sources. Operator distracted and sends without inspecting → the assembled prompt is retained, so Inspect is available after send and trust tags persist in the transcript.
- **Step 4:** Approval gate times out or the raising device goes offline → the gate is durable (Peta); resolve from any tailnet device; unresolved defaults to deny (no write). Approving a write in error → decision logged; revert is manual via Gitea/Obsidian history (no built-in post-commit undo in MVP — accepted, see §8 D-fatigue note).
- **Step 5:** Search index unavailable → explicit "search index unavailable" state (not silent empty). Bridge unreachable → connectivity error, not stale-as-live data; other sessions unaffected.

### Exit Points

- **Per-session:** closing a tab preserves the conversation (searchable later via #4); re-opening resumes context and grounding re-assembles fresh.
- **Logout / device close:** auth state cleared on that device only; other devices unaffected; pending out-of-band approvals survive (durable in Peta) and resolve elsewhere.
- **Abandonment mid-write:** an unresolved approval defaults to deny (no write) — fail-safe, not fail-open.
- **Tainted session, want a clean context:** taint is sticky per session (see Resolved Decision D5) — the operator opens a fresh session rather than detainting in place.

---

## 4. Data Contracts

<!-- Source: Phase 0 Step 0.3 (docs/phase-0/data-contract.md). -->

### Inputs

- **Operator message (this session):** Type: UTF-8 text. Validation: required, length-bounded; provenance `trusted:true` (the only trusted input). Sensitivity: Internal (may carry typed PII/secrets).
- **UI auth credential / session token:** Type: token/cookie. Validation: required before any session opens; valid, unexpired, tailnet-reachable only. Sensitivity: Sensitive.
- **Identity selection (AI system × identity):** Type: enum + identity ref. Validation: system ∈ registered backends; identity ∈ {existing, new, none}; existing identity must be bound to the chosen backend else reject (#14a). Sensitivity: Internal.
- **Recalled content — persona, Qdrant hits, mailbox, cross-session search, model/tool output:** Type: text/structured. Validation: tagged `trusted:false` at retrieval; taints session by presence. Sensitivity: Internal (may carry PII).
- **Write-approval decision (out-of-band):** Type: approve/deny + call ref. Validation: required to release any gated write; tied to a specific pending call; single-resolution. Sensitivity: Internal.
- **MCP server registration:** Type: server descriptor + creds. Validation: must register + authenticate before reachable; privileged tier only. Sensitivity: Sensitive.
- **Per-identity HMAC signing key / Peta access token:** Type: key handle / bearer token. Validation: gateway/vault custody only; NEVER loaded into session context, prompts, transcripts, or logs. Sensitivity: **Highest.**

### Transformations

- **Step 1 — Grounding assembly:** enabled sources → tag every recalled item `trusted:false` → assemble one inspectable grounded prompt with untrusted content visibly distinguished (label/position/icon, never color). Unavailable source → omit + non-color indicator; never upgrade trust.
- **Step 2 — Taint-by-presence:** any `trusted:false` content present → mark session tainted. Presence-based, not judgment-based. Indeterminate → tainted (fail closed).
- **Step 3 — Write-approval gating:** write-scoped tools are `dangerLevel:2`; writes held whenever the session is tainted; released only on explicit out-of-band approval that displays the proposed write. No approval → blocked and held durably; never auto-commit.
- **Step 4 — HMAC sign-on-behalf at gateway:** gateway signs the approved write with the identity's own key; A's key cannot sign B's repo/memory. Signing failure → reject + audit; key never leaves vault.
- **Step 5 — Identity provisioning / binding:** existing → load persona + authz + collection + scope (MVP: via the register-existing path/admin wiring); new → full provision (Should-Have); none → bare session, minimal authz, no write scope. Wrong-backend → reject at creation.
- **Step 6 — UI auth gate:** authenticate before any session/privileged action; multi-device on tailnet; logged-out reaches nothing.

### Outputs

- **Assembled grounded prompt (inspectable):** Format: structured text with trust labels. Latency: near-interactive (assemble + render before send). Retention: ephemeral + short TTL (see Resolved Decision D8).
- **Model responses / tool-call results:** Format: text/structured. Latency: backend-dependent. Tool results are `trusted:false`. Retention: persistent transcript.
- **Signed writes — Gitea / Qdrant / Obsidian:** Format: HMAC-signed commit/blob, signed vector+payload, Markdown via Obsidian MCP. Latency: post-approval. Retention: persistent.
- **Gateway audit log / approval records:** Format: append-only decision + call ref + timestamp. Latency: write-through. Retention: persistent; **contains NO raw keys/tokens/secrets** (see D8).

### Third-Party Data

- **Qdrant (per-identity collections, `10.100.23.79:6333`):** Used for: identity memory recall + signed writes. Fallback: recall omitted (non-color indicator); writes blocked. Caching: none beyond the live session.
- **Gitea (per-identity repos):** Used for: persona reads + signed writes. Fallback: persona load fails → block identity session start; writes held. Caching: read-only for the session lifetime.
- **Alden Bridge MCP (`10.100.23.88:8765`):** Used for: mailbox/memory/converse. Fallback: degrade with a visible indicator; session continues; no stale-cache writes. Caching: none.
- **Obsidian vault (LiveSync/CouchDB):** Used for: signed Markdown writes. Fallback: writes held in approval/queue, never silently dropped; LiveSync resync on reconnect. Caching: none.
- **Backends — Alden-1 (`192.168.1.89:8080`) / Claude (Anthropic API):** Used for: completions. Fallback: backend-down indicator (non-color); no failover that crosses identity backend binding. Caching: none.
- **Peta MCP gateway (`dunialabs/peta-core`):** Used for: all tool calls, authz decisions, signing. Fallback: gateway down → ALL tool calls/writes fail closed (no direct-to-backend bypass). Caching: none.

### State

- **Identities + backend binding, Peta users/perms, Qdrant collections, sessions+transcripts, taint flags, approval records:** Persists — disk (permanent / Peta / Qdrant / transcript + Meilisearch / gateway stores). Retention: until deprovision; backup required.
- **HMAC key handles + Peta tokens:** Persists — disk (gateway vault, encrypted), never in session memory. Backup required (escrow — see D9).
- **Assembled grounded context, in-flight tool calls:** Ephemeral — memory; destroyed on session close (assembled prompt retained for the session + a short TTL per D8).
- **UI auth session token:** Ephemeral — memory / short-lived store.

---

## 5. MVP Cutline

<!--
  This is a hard line. Features listed above this line ship first.
  Everything below this line goes to the Post-MVP Backlog.
  This cutline governs Phase 2 — features not above this line are not built.
  Do not move items above the line without Orchestrator approval and a recorded decision.
-->

**Above the line (MVP — ships first):**
- UI authentication gate (#9)
- Internally-hosted web UI, LAN/Tailscale only (#1, §2)
- Tabbed multi-session to distinct backends (#2)
- Peta gateway — single hardened point (#3, §6)
- Identity = one Peta user; per-tool authz (#10b, #5-ii, #14b)
- MCP server registration auth (#10a)
- Write-approval gate, `dangerLevel: 2`, with proposed-write display + single-resolution (#5, #14c, #8)
- Identity-as-session-profile for EXISTING identities (#5 i/ii/iv)
- **Scripted/CLI register-an-existing-identity path** (MVP enabler — Resolved Decision D1)
- Backend binding at creation (#14a)
- Grounding pipeline — `trusted:false` tagging + taint-by-presence + inspectability (#13, #14c)
- Cross-session search, unified (#4)
- Gateway management via admin API (#11 API-level)
- Bridge mailbox + group conversation via proxied tools, send-type tools classified as writes (#6, #7)
- Obsidian/filesystem MCP server, write-gated (#8)
- Cross-cutting CC1 (colorblind safety), CC2 (fail closed), CC3 (gateway-enforced)

---

**CUTLINE — nothing below this line is built in Phase 2 without Orchestrator approval**

---

**Below the line (Post-MVP — see Section 6):**
- New-identity provisioning orchestrator (#5 "new")
- Prompt-master isolated rewriter (#12)
- Gateway management GUI beyond the admin API (#11 GUI)
- Additional backends — 7900XTX local + cloud (#5)

### Resolved Decisions

Each decision below resolves an open question or ambiguity surfaced in the Phase 0 artifacts. These are binding on Phase 1+.

- **D1 — MVP cutline = brief §8 Must-Haves PLUS a minimal scripted/CLI "register an EXISTING identity" path.** Rationale: a session must have ≥1 identity to select; without a registration path the existing-identity flow has nothing to choose. Full new-identity provisioning UX stays Should-Have.
- **D2 — Every bridge/Obsidian/MCP tool gets an explicit read-vs-write classification.** Send-type tools (converse, mailbox_write, queue_message, share_write, gitea_file_write, memory_store, obsidian write) are WRITES → `dangerLevel:2` (Approval) and gated; reads are frictionless. Rationale: a "send" from a tainted session is exactly the self-injection exfil path #14c exists to stop; classification must not default. MVP.
- **D3 — Build/sequencing rule (enshrined): tag → taint → gate.** Grounding provenance-tagging (`trusted:false`) is a hard prerequisite of taint tracking, which is a hard prerequisite of the write-approval gate. Rationale: taint can only gate what was tagged; building the write path first opens a window where untrusted content writes ungated.
- **D4 — The write-approval gate must display the proposed write (tool + arguments/diff) — no blind approval — and resolution is single-decision across devices (first decision wins / lock).** Rationale: prevents reflexive approval of an unseen write and prevents a multi-device approval race. MVP.
- **D5 — Taint is sticky per session in MVP.** No in-place "detaint"; the operator opens a fresh session for a clean context. Rationale: a defined, simple, fail-safe semantics beats an unspecified in-place detaint that could launder untrusted content.
- **D6 — Privileged tier (write approvals + gateway management) uses a strong step-up credential (passkey/WebAuthn or equivalent re-auth).** Gateway management is reachable ONLY via a separate authenticated admin surface, never via any tool exposed to a session; session call-auth is automatic (per-identity token). These three share one root credential but differ in ceremony. Rationale: resolves the "strongest auth tier" ambiguity and keeps management off the session tool surface.
- **D7 — `trusted:false` → typed-input "laundering" is an ACCEPTED residual risk for a single trusted operator.** Mitigation: the inspector visibly marks `trusted:false` and the system never auto-promotes recalled content to trusted. Rationale: with exactly one trusted human, paste-into-own-input is operator-self-trust, not a third-party bypass; the control is visibility, not prevention.
- **D8 — Audit log discipline:** HMAC keys + Peta tokens are NEVER logged; recalled PII is redacted or stored by reference; the inspectable assembled prompt is retained for the session + a short TTL. Rationale: prove what was sent without persisting secrets in cleartext, resolving the data-contract open question.
- **D9 — Ops defaults (homelab, 1 user):** single environment; nightly backup; HMAC-key recovery via encrypted escrow backup; CI via self-hosted runner OR local pre-commit + manual gate (no public GitHub); monitoring optional at 1 user. Rationale: right-sized operations for a one-operator on-prem deployment without inventing scale machinery that does not apply.

---

## 6. Post-MVP Backlog

<!--
  Items here are candidates, not commitments.
  Prioritized by user feedback after launch, not by this document.
-->

- **New-identity provisioning orchestrator (#5 "new").** A single transaction creating Gitea repo/scope, Qdrant collection, HMAC key → custody, backend binding, and Peta user+perms, then opening the session. Justified when: the operator needs to create identities beyond those registered via the D1 path, and the MVP gateway/custody/binding registry are proven. Requires defined saga/compensating-action rollback (no orphaned half-provisioned identities).
- **Prompt-master isolated rewriter (#12).** Opt-in per-message rewrite on Alden-1, shown beside the original with a diff, never auto-substituted. Justified when: the operator repeatedly wants drafting assistance and the isolation guarantees (no tools/identity/authz) are verified.
- **Gateway management GUI (#11 GUI).** A custom UI over the admin REST API. Justified when: driving registrations via the API directly becomes a friction point at the operator's actual usage volume.
- **Additional backends — 7900XTX local + cloud (#5).** Add to the data-driven backend list with per-backend binding. Justified when: the hardware/endpoints exist.

---

## 7. Will-Not-Have List

<!-- Source: Phase 0 Step 0.1. Product-wide scope boundaries, not deferred features. -->

- **Public / multi-tenant exposure:** §2 FIRM + §7 — exactly one operator, ever; multi-tenant breaks the single-token-entropy auth model and is out of domain.
- **Cloudflare Tunnel / any public ingress:** §2 + §6 forbid it explicitly; public reachability would invalidate the "token entropy is the whole of auth" assumption.
- **Any color-only UI signal:** §3 — the operator is colorblind; color-as-sole-channel is a prohibited design across the whole product.
- **Runtime identity context-injection:** §8 — identity is creation-time only; runtime persona/authz injection would bypass backend binding and authz resolution.
- **Loading HMAC keys into a session's context:** §8 + #14b — keys are exfiltrable from session context; signing happens at the gateway on the session's behalf.
- **Model-self-policed writes/taint:** #10/#13 — enforcement is at the gateway, never "ask the model nicely"; taint is by presence, not by model judgment.

---

## 8. Open Questions

<!-- Source: Phase 0 Steps 0.1–0.3. Every question must be resolved before the Phase 0 → Phase 1 gate. -->

All Phase 0 open questions are resolved as recorded decisions in §5 "Resolved Decisions." None remain unresolved. The Phase 0 → Phase 1 gate requires zero unresolved (open-status) lines; the table below confirms every question is Resolved.

**Q1: Does MVP need a manual/scripted path to have any identity to select? (FRD finding #2)**
- Context: existing-identity flow needs ≥1 consistently-provisioned identity to choose.
- Decision needed by: Phase 0 gate
- Status: Resolved — D1: a minimal scripted/CLI register-existing-identity path is in the MVP cutline.

**Q2: Are bridge "send/converse" and similar tools reads or writes? (FRD finding #3)**
- Context: "frictionless reads" must never silently flip to an ungated write; a tainted send is the exfil path #14c exists to stop.
- Decision needed by: Phase 0 gate
- Status: Resolved — D2: explicit per-tool read/write classification; send-type tools are `dangerLevel:2` writes and gated.

**Q3: What is the correct build order for tagging, taint, and the write gate? (FRD finding #1)**
- Context: taint can only gate what was tagged; ordering errors open an ungated-write window.
- Decision needed by: Phase 0 gate
- Status: Resolved — D3: enshrined order tag → taint → gate, with an integration test that fails if a write executes from a session holding untagged-provenance content.

**Q4: How is approval-fatigue / blind approval and the multi-device approval race handled? (Journey gaps #1, #6)**
- Context: taint-by-presence gates every write; reflexive approval and concurrent multi-device resolution are real risks.
- Decision needed by: Phase 0 gate
- Status: Resolved — D4: the gate displays the proposed write (tool + arguments/diff) and resolution is single-decision across devices (first wins / lock). Post-commit undo is out of MVP; manual revert via Gitea/Obsidian history is the accepted recovery.

**Q5: Is there an in-place "session detaint" path? (Journey gap #5)**
- Context: whether the operator can clear taint in-session after removing untrusted sources.
- Decision needed by: Phase 0 gate
- Status: Resolved — D5: taint is sticky per session in MVP; open a fresh session for a clean context.

**Q6: What constitutes the "strongest auth tier" for write approval and gateway management? (FRD finding #6)**
- Context: the brief references tiers/step-up but specifies only login + token entropy.
- Decision needed by: Phase 0 gate
- Status: Resolved — D6: a strong step-up credential (passkey/WebAuthn or equivalent re-auth); gateway management only via a separate authenticated admin surface, never via a session tool; session call-auth automatic per-identity token.

**Q7: Can recalled `trusted:false` content be laundered into trusted input via paste? (FRD finding #5)**
- Context: a "search result → paste as if I typed it" affordance could promote untrusted content.
- Decision needed by: Phase 0 gate
- Status: Resolved — D7: accepted residual risk for a single trusted operator; mitigation is visible `trusted:false` marking and no auto-promotion; never build an affordance that auto-trusts recalled content.

**Q8: What does the audit log record, and how long is the assembled prompt retained, given secret-redaction requirements? (Data Contract open question)**
- Context: prove what was sent without persisting keys/tokens/PII in cleartext.
- Decision needed by: Phase 0 gate
- Status: Resolved — D8: keys/tokens never logged; recalled PII redacted or stored by reference; inspectable assembled prompt retained for the session + a short TTL.

**Q9: What are the operational defaults (environments, backup, key recovery, CI, monitoring) for a 1-user homelab?**
- Context: standard-track ops machinery must be right-sized for a single on-prem operator.
- Decision needed by: Phase 0 gate
- Status: Resolved — D9: single environment; nightly backup; HMAC-key recovery via encrypted escrow backup; CI via self-hosted runner OR local pre-commit + manual gate; monitoring optional at 1 user.

---

## Operator Inputs Needed for Phase 2 (non-blocking)

These are external inputs the Orchestrator supplies before/during Phase 2 implementation. They are **not unresolved product questions** and do not gate the Phase 0 → Phase 1 transition.

- **Gitea base URL + repo-layout convention:** the exact base URL and the per-identity repo/scope naming/layout the control-plane should read personas from and write to.
- **Importability of existing identities:** confirmation that the existing "Alden" / "Alden-1" identities already in Gitea are importable in the expected persona format (so the D1 register-existing path can ingest them as-is, or whether a one-time normalization is needed).
- **Passkey mechanism confirmation:** confirm the concrete step-up mechanism for the privileged tier (WebAuthn/passkey vs. an equivalent re-auth that works across the operator's tailnet devices).
- **MVP target date:** the date against which Phase 2 sequencing (tag → taint → gate per D3) is planned.

---

## Bug Severity Reference

(Per the framework testing workflow; reproduced here for the Manifesto's scope.)

| Severity | Definition | Phase 2 Handling |
|---|---|---|
| **SEV-1** | Trust-boundary or auth breach; ungated write; key/token exposure; data loss; gateway bypass. | Cannot be deferred. Stop-the-line; fix test-first before any further feature work. |
| **SEV-2** | Significant correctness/security gap with a workaround; **any color-only UI signal (CC1 violation)**; fail-open behavior on a non-critical path. | May be deferred during Phase 2 but must be resolved (or the feature removed) at the Phase 2 → 3 gate. |
| **SEV-3** | Minor functional/usability defect; cosmetic non-color issue; degraded but safe behavior. | Triaged into the backlog; fix as capacity allows. |

---

## Appendix A: Revenue Model & Unit Economics

**SKIPPED — internal tool.** Pantheon Harness is a single-operator, on-prem internal tool with no users, pricing, or revenue. There are no per-user costs or break-even economics to model. (Standard-track appendix retained as a heading per the template; not applicable.)

---

## Appendix B: Orchestrator Competency Matrix

Self-assessment of the Orchestrator's ability to validate AI-generated output in each domain. Where validation is partial or absent, an automated tool is mandated as the control. For security, automated tooling is **mandatory** regardless of self-assessed competence (priority-1 hierarchy).

| Domain | Can I Validate? | If No/Partial: Automated Tool |
|---|---|---|
| Product / UX Logic | Yes | — |
| Frontend / UI | Partially | Playwright (flows) + axe-core (a11y); manual colorblind review against CC1 |
| Backend / API | Yes (strong) | Contract tests + integration tests on the control-plane and gateway authz/taint/gate paths |
| Database | Partially | Migration dry-run + schema diff; per-identity isolation tests on Qdrant collections/Gitea scopes |
| Security | Yes (strong) — **mandatory automated tooling regardless** | Semgrep (SAST), gitleaks (secrets), Snyk/`npm audit` (deps), plus STRIDE threat model and gateway-bypass tests |
| Build & Packaging | Yes | CI pipeline (self-hosted runner or local pre-commit + manual gate per D9); release smoke test |
| Accessibility | Partially | axe-core automated checks + manual keyboard-only and colorblind passes on adopted (LibreChat/Peta) and custom surfaces (CC1) |
| Performance | Partially | Lighthouse for the UI; targeted latency checks on grounding assembly and gateway round-trips (single-user scale) |
| Platform-Specific (web) | Yes | Reverse-proxy/config + network test confirming LAN/Tailscale-only, no public listener (M2) |

Known gaps accepted: Frontend/UI, Database, Accessibility, and Performance are **Partially** validatable by the Orchestrator; the tools above are the controls and must be in place before Phase 2 work in those domains. Security review is strong AND backed by mandatory automated tooling — no security domain relies on human review alone.

---

## Appendix C: Trademark & Legal Pre-Check

**SKIPPED — internal tool.** No public distribution, no external users, no commercial name in market — there is no trademark exposure to clear and no app-store/distribution channel to satisfy. Data privacy: GDPR/CCPA do not apply (single private operator, no third-party personal data subjects; on-prem, LAN/Tailscale-only). The relevant data-handling controls (secret custody, PII redaction in logs, trust boundary) are specified in §4 and the Resolved Decisions, not in this appendix. (Standard-track appendix retained as a heading per the template; not applicable.)
