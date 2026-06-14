# Functional Requirements Document — Pantheon Harness

<!--
  Phase 0 Step 0.1 output. This document captures the full functional requirements
  before they are summarized into the Product Manifesto Section 2.

  Save as: docs/phase-0/frd.md

  This file preserves the detailed logic triggers, failure states, and rationale
  that the Manifesto summary may compress. Reviewers examine this for completeness;
  the Manifesto captures the approved result.
-->

**Date:** 2026-06-13
**Status:** Draft
**Track:** Standard
**Author mode:** Lead PM (Skeptical) — quality over positivity; assumes confused operator and adversarial/tainted inputs.
**Source of truth:** `docs/phase-0/REQUIREMENTS-SOURCE.md` (the 14 requirements, deployment model §2, hard constraints §3, decided architecture §5, MVP cutline §8). Where this FRD and the source disagree, the source wins.

> **Skeptical framing applied throughout.** Every "happy path" below assumes it will be hit by (a) a logged-out or second-device browser, (b) a malicious MCP server, (c) recalled memory carrying an injected instruction, and (d) a colorblind operator who cannot rely on red/green. Failure states are written as *the system's defensive default*, not as an apology.

---

## Must-Have (MVP)

Decomposed from source §8 "Must-have (MVP)". The cutline bundles several requirements per clause; this FRD splits them into independently testable features so each gets its own logic trigger and failure state. Requirement numbers (#n) refer to source §4.

| # | Feature | Logic Trigger | Failure State (error + recovery) | Rationale |
|---|---------|--------------|---------------------------------|-----------|
| M1 | **UI authentication gate (#9)** | If any request for a session, session list, or privileged action arrives without a valid authenticated UI session, the system must reject it and output the login screen (never session content). | **Error:** 401/redirect to login; no session metadata leaked in the response. **Recovery:** operator re-authenticates; on success the originally-requested route is re-resolved. Logged-out or second-untrusted device sees only login. No "remember me" bypass of step-up gates. | Source §8 names #1/#2/#9 as the floor. Without auth there is no trust boundary at all; every other control is moot. |
| M2 | **Internally-hosted web UI on LAN/Tailscale only (#1, §2)** | If a request reaches the UI from any origin not on the LAN or tailnet, the system must drop it and output nothing (no redirect, no banner). | **Error:** connection refused / not routable; no public listener exists. **Recovery:** none by design — public reachability is a defect, not a recoverable state. Verified by config + network test, not app logic alone. | §2 is FIRM. Public exposure would invalidate the "token entropy is the whole of auth" assumption (§6). |
| M3 | **Tabbed multi-session to distinct backends (#2)** | If the operator opens a new tab/session bound to backend B while session A (backend A) is active, the system must maintain both concurrently and output independent, non-cross-contaminating session state per tab. | **Error:** if a backend is unreachable, that tab shows a per-tab connectivity error (icon + text label, e.g. "Backend unreachable", colorblind-safe) without killing other tabs. **Recovery:** operator retries that tab; other tabs unaffected. | Core LibreChat capability; the operator orchestrates several backends at once. Isolation between tabs is a correctness requirement, not cosmetic. |
| M4 | **Peta gateway: single point, hardened (#3, §6)** | If any AI system (UI session or MCP client) attempts to reach a tool/backend other than through the Peta gateway, the system must have no such path and output all tool traffic exclusively through the gateway. | **Error:** direct-to-backend calls are unroutable (gateway is the only registered path). **Recovery:** none — bypassing the gateway is a misconfiguration to be caught in CI/threat model, not handled at runtime. Peta runs non-root, no docker.sock, remote/HTTP downstreams only; `/admin` and `GET_OWNER` never exposed. | §5 + §6: the gateway is where prompt-injection containment and key custody live. A bypass defeats #10, #13, #14. |
| M5 | **Identity = one Peta user; per-tool authz (#10b, #5-ii, #14b)** | If a session invokes a tool, the system must resolve the session's identity to its Peta user and check that user's per-tool authorization at the gateway; if authorized → execute and output result; if not → deny and output an authorization error. | **Error:** unauthorized tool call returns a gateway-side denial (not a model refusal), logged with correlation ID. **Recovery:** operator must reconfigure the identity's authz via the admin API (M12); no in-session escalation. | §5 mapping "one Alden identity = one Peta user." Server-side per-tool authz is the stated prompt-injection containment (#10). |
| M6 | **MCP server registration auth (#10a)** | If a new MCP server attempts to become reachable, the system must require it to register and authenticate at the gateway first; until then it must output "unregistered/unreachable" and route no calls to it. | **Error:** calls to an unregistered server fail closed with a "server not registered" error. **Recovery:** operator registers + authenticates the server via the management interface (M12). | #10(a) — registration auth is half of the two-direction gateway auth. A server that can attach without auth is an injection/exfil vector. |
| M7 | **Write-approval gate (`dangerLevel: 2`) (#5 confirmation, #14c, #8)** | If a session issues a write-scoped tool call (Gitea write, Qdrant write, Obsidian write), the system must hold the call and output an explicit out-of-band human-approval prompt; only on operator approval does the gateway sign and commit. | **Error:** an unapproved or timed-out write is **not** committed; the call is recorded as pending/denied. **Recovery:** operator approves (commit) or rejects (drop). Reads/reasoning are never gated. UI control is shape/label-based (e.g. "Approve write" / "Reject" buttons with distinct icons + text), never color-only. | §8 + #14c: durable human-in-the-loop write gate. Reads frictionless; writes never auto-fire. |
| M8 | **Identity-as-session-profile, EXISTING identities (#5 i/ii/iv)** | If the operator selects an existing identity in the New-Session popup, the system must configure the session at creation from that identity's Gitea repo (persona/system prompt), its tool/MCP authorizations, and its Gitea write scope, then output an opened session bound to those settings. | **Error:** if any source (persona repo, authz config, scope) cannot be loaded, session creation **fails closed** with a specific error ("persona repo unreachable" / "authz unresolved") and **no partially-configured session opens**. **Recovery:** operator retries after the source is reachable; never opens a session with missing authz. | §8 MVP scope. Partial provisioning is the dangerous case — a session with persona but stale authz is an isolation breach. |
| M9 | **Backend binding at creation (#14a)** | If a session requests an identity on any backend other than the one that identity was permanently bound to at creation, the system must reject session creation and output a binding-violation error. | **Error:** creation rejected with "identity X is bound to backend Y, not Z." **Recovery:** operator opens the identity on its bound backend, or creates a *new* identity for the other backend (Should-Have provisioning). No rebinding at runtime. | #14a: identity↔backend binding is one of two orthogonal isolation mechanisms; both required. |
| M10 | **Grounding pipeline: `trusted:false` tagging + taint-by-presence + inspectability (#13, #14c)** | If context is assembled from any non-current-user-typed source (persona, identity Qdrant, mailbox, cross-session search), the system must tag that content `trusted:false` at retrieval, and if ANY `trusted:false` content is present in the session, the system must gate that session's write-scoped calls pending explicit human approval, and must output a fully-inspectable assembled prompt distinguishing `trusted:false` content by label/position/icon (never color). | **Error:** if the taint engine cannot determine provenance for a piece of content, it must **default that content to `trusted:false`** (fail safe), not `trusted:true`. If the inspector cannot render, send is blocked with an error. **Recovery:** operator reviews the inspector and approves/edits; gated writes follow M7. | §8 core. Taint-by-PRESENCE (not judgment): any untrusted content gates writes. This is the heart of the injection defense. |
| M11 | **Cross-session search, unified (#4)** | If the operator searches from any session, the system must search across ALL sessions/identities and output ranked hits; any hit injected into context is tagged `trusted:false` (per M10). | **Error:** if the search index (Meilisearch) is unavailable, search returns a clear "search index unavailable" state (icon + text), not silent empty results that could be mistaken for "no matches." **Recovery:** operator retries when index is back; degraded mode does not block chatting. | §8 + #4. The subtle failure is *silent* empty results; skeptically, an empty result must be distinguishable from an unavailable index. |
| M12 | **Gateway management via admin API (#11 API-level)** | If the operator (under the strongest auth tier) issues an add/remove/edit on an MCP server registration via the admin REST API, the system must apply it at the gateway and output the updated registration state. | **Error:** management calls outside the strongest auth tier are denied; malformed registration is rejected with validation errors and **no partial registration persists**. **Recovery:** operator corrects and resubmits. | §8 implies #11 at the API level (GUI is Should-Have). The Peta Console GUI is closed, so drive the REST API directly. |
| M13 | **Bridge mailbox + group conversation via proxied tools (#6, #7)** | If the operator opens the bridge mailbox or initiates a group conversation, the system must surface the Alden bridge tools (proxied through the gateway) and output mailbox contents (checkable + searchable) / a group session. | **Error:** if the bridge MCP server (`10.100.23.88:8765`) is unreachable, the mailbox/group tab shows a connectivity error (icon + text), not stale-as-live data. **Recovery:** retry; other sessions unaffected. Mailbox content entering any other session's context is `trusted:false` (M10). | §8 + #6/#7. Mailbox messages are external content — they MUST flow through the taint boundary. |
| M14 | **Obsidian/filesystem MCP server, write-gated (#8)** | If a session issues an Obsidian vault write, the system must route it through the Obsidian MCP server registered behind Peta with write tools at `dangerLevel: 2`, gate it (M7), and on approval output a committed write that LiveSync propagates. | **Error:** write rejected/held if unapproved or if the session is tainted (M10); a failed filesystem write returns a specific error and does **not** report success. **Recovery:** operator approves; on filesystem failure, operator retries — LiveSync is downstream and not assumed atomic. | §8 + #8. Direct vault writes are a high-impact write path; must inherit the same gate as Gitea/Qdrant writes. |

---

## Cross-cutting Must-Have constraints (apply to every feature above with UI)

- **CC1 — Colorblind safety (§3).** Every signal/control (approval buttons, trusted/untrusted markers, connectivity states, per-message prompt-master toggle) MUST be distinguishable by **shape, position, text label, or icon — never color alone.** This is a pass/fail acceptance criterion on every UI feature, not a nice-to-have. Failure state: any color-only signal is a SEV-2 defect at the accessibility gate.
- **CC2 — Fail closed.** Every authz, taint, and write decision defaults to deny/untrusted on ambiguity or error (see M5, M7, M8, M10). There is no "fail open for convenience."
- **CC3 — Gateway-enforced, not model-enforced (#10, #13).** Authorization, injection containment, and write gating are decided at the Peta gateway, never by trusting the model's self-report. A model "promising" not to write is not a control.

---

## Should-Have (v1.1)

| # | Feature | Description | Deferred Because |
|---|---------|-------------|-----------------|
| S1 | **New-identity provisioning orchestrator (#5 "new")** | One transaction: pull template from Gitea, create repo/scope, create Qdrant collection, generate HMAC key → gateway custody, set backend binding, mint Peta user + perms; then open the session. | High blast-radius multi-system write; needs the MVP gateway, key custody, and binding registry working and trusted first. MVP supports *existing* identities only (§8). |
| S2 | **Prompt-master isolated rewriter (#12)** | Opt-in, default OFF, per-message toggle (shape/label, colorblind-safe). Pass draft to a rewrite-only service on Alden-1 (no tools, no identity, no session authz); show rewrite beside original with a diff; operator picks which sends; never auto-substitute. | Explicitly v1.1 in §8. Quality-of-life, not a trust-boundary control. Must run isolated to avoid becoming an injection path. |
| S3 | **Gateway management GUI (#11 GUI)** | A UI over the admin REST API for add/remove/edit MCP server registrations, behind the strongest auth tier. | MVP drives #11 via the admin API directly (M12); the Peta Console GUI is closed, so a custom GUI is extra build, not the floor. |
| S4 | **Additional backends: 7900XTX local + cloud (#5 backend options)** | Add the future 7900XTX local backend and cloud backends to the New-Session backend list, each with its own binding. | Hardware/endpoints not yet present; backend list is data-driven so adding later is low-risk. §8 defers. |

---

## Will-Not-Have

| # | Feature | Exclusion Rationale |
|---|---------|-------------------|
| W1 | **Public / multi-tenant exposure** | §2 FIRM + §7: exactly one human operator, LAN/Tailscale only, no external users ever. Multi-tenant would break the single-token-entropy auth model. |
| W2 | **Cloudflare Tunnel / any public ingress** | §2 + §6 explicitly forbid Cloudflared and public `/mcp/public`. Public ingress is an exclusion, not a config option. |
| W3 | **Any color-only UI signal** | §3 + §8: the operator is colorblind. Color-as-sole-channel is a prohibited design, not a deferred feature. |
| W4 | **Runtime identity context-injection** | §8: identity is configured at session CREATION time only. No mid-session identity swap or runtime persona/authz injection — that would bypass backend binding and authz resolution. |
| W5 | **Loading HMAC keys into a session's context** | §8 + #14b: keys live in gateway custody and are used to sign on the session's behalf. A key in context is exfiltrable by a prompt-injected session. |
| W6 | **Trusting the model to self-police writes / taint (implicit exclusion)** | #10/#13 enforce at the gateway. We will NOT implement "ask the model nicely" controls or taint-by-model-judgment; taint is by presence, gating is at the gateway. |

---

## Contradictions, hidden dependencies, and skeptical findings

Surfaced per the Lead PM (Skeptical) mandate. These are ordered by how much they can sink the build if ignored.

1. **Taint-by-presence ⇒ grounding MUST tag provenance BEFORE any write path is reachable (sequencing dependency, not a parallel feature).** #14c gates a session's writes if it contains *any* `trusted:false` content. But the taint can only gate what was tagged. Therefore M10 (retrieval-time tagging + the taint engine) is a hard *prerequisite* of M7/M14 (write gate), not a peer feature to be built in any order. **Implication:** if grounding/tagging ships after the write path, there is a window where untrusted content reaches a write ungated. Build order MUST be: tagging → taint computation → write gate. Recommend an integration test that fails if a write executes from a session with untagged-provenance content present.

2. **Identity = Peta user ⇒ identity creation MUST mint a Peta user + token AT creation, atomically with the other resources (provisioning is a distributed transaction, not a checklist).** §5 maps one identity to one Peta user, and §5 "new identity" lists six creates (Gitea repo, scope, Qdrant collection, HMAC key→custody, backend binding, Peta user+perms). If any step succeeds and a later one fails, you get a **half-provisioned identity** — e.g., a Gitea repo with no Peta user (unusable) or a Peta user with no backend binding (M9 can't enforce). The brief does not specify rollback/idempotency. **Hidden dependency / open question:** S1 (v1.1) needs a defined commit/rollback semantics (saga or compensating actions) so a failed provision leaves no orphan resources. For MVP this is dodged because only *existing* identities are supported (M8) — but M8 itself assumes those resources were created consistently. *Are there already-existing identities provisioned correctly, or does MVP need at least one manual/scripted provision path to have anything to select?* — **OPEN QUESTION for the operator.**

3. **"Reads/reasoning frictionless" (#5) vs. taint-by-presence gating (#14c) — a real tension at the boundary.** #5 promises reads are frictionless and only WRITES hit the gate. #13/#14c say any `trusted:false` content present gates that session's writes. These are consistent ONLY if "frictionless reads" never silently flips to a write. The contradiction bites for tools whose `dangerLevel` is ambiguous (e.g., a "converse" or "send message" bridge tool — is sending a message a write?). **Implication:** the bridge tools (#6/#7) and mailbox need an explicit read-vs-write classification, because a "send" is a write and a tainted session sending a message is exactly the self-injection exfil path #14c exists to stop. **Recommend** an explicit per-tool read/write (dangerLevel) audit as a Phase-1 artifact; do not let it default.

4. **#10 "enforced at the gateway, contains prompt injection" vs. LibreChat per-agent tool authz (#5 maps agents≈identities).** §5 says LibreChat Agents provide per-agent tool authz AND Peta provides server-side per-tool authz. Two authz layers that must agree. If LibreChat permits a tool the gateway denies (or vice versa), behavior is confusing at best and a bypass at worst. **Hidden dependency:** a single source of truth for "which identity may call which tool" — the brief implies Peta is authoritative (#10 "enforced at the gateway, NOT the model"), so LibreChat's agent-tool config must be treated as UI convenience only and the gateway as the enforcer. Needs to be stated explicitly so no one relies on the LibreChat layer for security.

5. **Cross-session search "any session may search ALL sessions" (#4/#13) vs. per-identity isolation (#14).** Search is global, but identities are isolated (private Qdrant collections, separate Gitea scopes). Search results from another identity's session are exactly the `trusted:false` content #13 is built to tag — so this is *consistent by design*, but only if search hits are funneled through the same tagging path (M10) and never treated as the current user's trusted input. **Implication:** there must be no "search result → paste as if I typed it" affordance that launders untrusted content into `trusted:true`. Skeptically, this is an easy product mistake to make in the UI.

6. **Auth "tiers" referenced (#11 "strongest auth tier") but only one auth mechanism specified (#9 login + §6 token entropy).** §8/§11 assume *tiers* (step-up for privileged actions) but §6 says "token entropy is the whole of auth." **Open question:** what constitutes the "strongest auth tier" for gateway management and write approval — is it a second factor, a separate credential, or just the out-of-band approval gate? The brief gestures at step-up ("confirmation/step-up gate" in #5) without defining it. Needs a decision before M7/M12 are buildable.

---

## Recommendations (not in scope unless approved)

These are PM recommendations beyond the brief; do NOT implement without operator approval.

- **R1 — Provisioning saga with compensating actions (relates to finding #2).** When S1 is built, define explicit rollback for partial new-identity provisioning. Recommend recording an ADR.
- **R2 — Per-tool read/write classification artifact (relates to finding #3).** Produce a reviewed table classifying every registered tool's `dangerLevel`, especially bridge "send/converse" tools, before MVP write-gate sign-off.
- **R3 — Authz single-source-of-truth statement (relates to finding #4).** Document that Peta is authoritative for tool authz and LibreChat agent config is non-load-bearing for security.
- **R4 — "Untrusted → trusted" laundering guard (relates to finding #5).** Add a UAT scenario that attempts to promote a search/mailbox hit to trusted input and asserts it stays `trusted:false`.
- **R5 — Define the "strongest auth tier" (relates to finding #6).** Recommend an explicit step-up mechanism decision at the Phase-1 threat model.
- **R6 — Index-unavailable vs. empty-result distinction (relates to M11).** Treat as an explicit acceptance criterion, not an implementation detail.

---

## Review Checklist

- [x] Every Must-Have feature has a logic trigger (If/Then/Output) — M1–M14.
- [x] Every Must-Have feature has a defined failure state (error + recovery) — M1–M14.
- [x] Every feature is categorized (Must / Should / Will-Not).
- [x] At least 3 Will-Not-Have items are listed — 6 (W1–W6).
- [x] No feature is ambiguous enough to be interpreted two ways — contradictions surfaced separately rather than buried in feature text.
- [x] Colorblind constraint applied to every UI-bearing feature (CC1).
- [x] No features added beyond the brief; recommendations isolated in their own section.
