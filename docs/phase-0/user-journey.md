# User Journey Map — Pantheon Harness

<!--
  Phase 0 Step 0.2 output. Captures the full user journey analysis
  before it is summarized into the Product Manifesto Section 3.

  Agent persona for this step: Skeptical Product Manager.
  Challenge every success path. What if the user is tired? Distracted? Adversarial?
-->

**Date:** 2026-06-13
**Status:** Draft

---

## Primary Persona

| Field | Value |
|-------|-------|
| **Name** | Karl |
| **Role** | Solo senior architect who orchestrates AI rather than hand-writing code; sole human operator of the Alden homelab ecosystem. |
| **Goal** | Drive distributed AI identities (personas) safely from one harness — converse, ground on private memory, write to scoped systems — without the harness becoming an injection vector. |
| **Context** | Works from multiple devices (desktop, laptop, tablet) on a Tailscale tailnet. No public exposure. Frequently context-switches between concurrent sessions. May be tired/distracted; is also his own adversary for threat-modeling purposes. |
| **Technical Skill** | High (architect-level), but **colorblind** — every UI cue must be shape, position, text label, or icon, **never color alone**. |

**Cross-cutting accessibility invariant (applies to EVERY step below):** No state, status, trust tag, toggle, or alert may be communicated by color alone. Each must carry a redundant shape/icon/text/position cue. This is treated as a success criterion on every step, not a one-time check.

---

## Journey: Orchestrate an Identity Session End-to-End (Primary Flow)

### Entry Point
Karl opens a browser on a tailnet device and navigates to the harness URL (Caddy → LibreChat, LAN/Tailscale only). He may arrive logged-out, with a stale session, or on a brand-new device. He is never on the public internet — there is no public ingress to reach.

### Success Path

| Step | User Action | System Response | Success Criteria |
|------|------------|-----------------|-----------------|
| 1. Authenticate (#9) | Navigates to harness; if logged-out, is presented LibreChat login. Enters credentials. | UI blocks all session/privileged surfaces until auth succeeds; on success, lands in the harness shell (session list/tab bar). | Logged-out device sees **only** the login screen — no session list, no tool actions, no leaked identity names. Auth state is per-device. |
| 2. Open New Session (#5) | Clicks "New Session"; a popup appears. Selects **AI SYSTEM** (e.g., Local Corsair/Alden-1) × **IDENTITY** (existing / none / new). Confirms. | Control-plane resolves the identity→backend binding (#14a), pulls persona/system prompt from the identity's Gitea repo, applies that identity's tool/MCP authz, attaches its private Qdrant collection and Gitea write scope, and mints a per-identity Peta token. Session opens on the **bound** backend, pre-configured. | Session tab opens labeled with identity + backend (text, not color). Persona, authz, Qdrant collection, and Gitea scope are all the **selected** identity's — verifiable in a session-info panel. |
| 3. Converse with grounding ON + inspect prompt (#13) | Types a message in an identity session (grounding default-ON). Before sending, opens the **"Inspect assembled prompt"** view. | Grounding pipeline assembles the prompt from sources (persona, identity Qdrant hits, mailbox hits, cross-session search). Each non-user source is tagged `trusted:false`. Inspector renders the full assembled prompt with `trusted:false` blocks visibly distinguished by **label + icon + position/section** (e.g., a "UNTRUSTED — recalled" banner row), never color. | Karl can read exactly what will be sent. Every recalled/Qdrant/mailbox block is unambiguously marked untrusted by non-color means. Each source is individually toggleable for this session. He sends only after reviewing. |
| 4. Reply attempts a WRITE from a tainted session (#13/#14c) | The model reply proposes a WRITE to a scoped system (e.g., Gitea repo or Obsidian vault) while the session holds any `trusted:false` content. Karl is prompted to approve. | **Taint-by-presence**: because the session context contains any untrusted content, the control-plane keeps the write gated. The Peta gateway (write tool `dangerLevel: 2`) fires an **out-of-band approval gate**. Karl is shown what will be written, to which scope, signed by which identity's gateway-held HMAC key. He **Approves** or **Denies** (distinct shaped/labeled buttons + position). | On Approve: gateway signs (key never enters session context) and the write commits; UI shows a confirmed-write receipt. On **Deny: no write occurs**, the model is told the write was rejected, and state is unchanged. Decision is logged. |
| 5a. Cross-session / cross-identity search (#4) | Invokes search across all sessions and identities. | Meilisearch (LibreChat) returns hits spanning every session/identity; results are read-only recall. | Results from other identities appear and are usable; if pulled into a session as context they enter as `trusted:false` (feeding step 3/4 invariants). |
| 5b. Mailbox check/search (#7) | Opens mailbox view; checks new messages and searches old ones via proxied bridge tools. | Bridge mailbox tools (read) return messages frictionlessly; searchable archive. | Mailbox always reachable and searchable; reads are frictionless (no gate). |
| 5c. Ad-hoc group conversation (#6) | Starts a group conversation through the Alden Bridge `converse` tool. | Bridge brokers an ad-hoc multi-party conversation; messages from other parties enter as `trusted:false`. | Group convo works; non-user participants' content is trust-tagged and inspectable. |
| 6. Prompt-master toggle (#12, should-have) | Per-message toggle (default **OFF**; a shaped/labeled control, not a colored one). Drafts text, toggles ON, requests rewrite. | Drafted text is sent to the isolated rewrite-only service (recommended on Alden-1; drafts stay on LAN; rewriter has no tools, no identity, no session authz). The rewrite is presented **beside the original with a diff**. | Karl sees original vs rewrite + diff; he **picks** which one sends. **Never auto-substituted.** Toggle state is readable without color. |
| 7. New-identity provisioning (#5 "new", should-have) | In New Session popup chooses "New identity"; supplies name/template choice; confirms each provisioning step. | Provisioning orchestrator: pulls template from Gitea → creates repo/write scope → creates Qdrant collection → generates HMAC key into **gateway custody** → registers backend binding (#14a) → creates Peta user + perms → opens the session. Each step reports progress and a final summary. | Karl gets explicit confirmation of every artifact created (repo, scope, collection, key custody location, binding, Peta user). Session opens pre-configured exactly like an existing identity. Failure mid-provision is recoverable (see below). |

### The Four States (where applicable)

| Step | Empty | Loading | Error | Success |
|------|-------|---------|-------|---------|
| Auth (1) | Login form, no session data | "Signing in…" spinner with text | "Sign-in failed — credentials rejected" (text + icon); lockout messaging | Harness shell with session list |
| New Session (2) | Popup with no identities yet → "No identities provisioned" + link to create | "Configuring session on <backend>…" with per-step text | "Identity not bound to this backend — rejected" (#14a) / "Backend unreachable" | Pre-configured session tab |
| Inspect prompt (3) | "No grounding sources active for this session" | "Assembling grounded prompt…" | "Grounding source <X> unavailable — sent without it?" (explicit, per-source) | Full prompt rendered with trust tags |
| Write approval (4) | n/a (gate only fires on a write) | "Awaiting your approval…" (persists out-of-band) | "Write failed after approval — HMAC/scope error, nothing committed" | "Write committed to <scope>" receipt |
| Search/Mailbox (5) | "No results" / "Mailbox empty" | "Searching…" | "Search index unavailable" / "Bridge unreachable" | Results list / messages |
| Prompt-master (6) | Toggle OFF, no rewrite shown | "Rewriting on Alden-1…" | "Rewriter unavailable — your original is unchanged; send as-is?" | Original + rewrite + diff, pick-to-send |
| Provisioning (7) | n/a | Per-step progress checklist | "Step <N> failed — see rollback options" | Artifact summary + open session |

---

## Failure Recovery

| Failure Point | What Goes Wrong | Recovery Path | User Sees |
|--------------|----------------|---------------|-----------|
| Step 1 | Stale/expired session on a returning device; or a second device is logged-out. | Re-authenticate; logged-out device stays blocked from all session/privileged surfaces. | "Session expired — sign in again." Logged-out device sees only login. |
| Step 2 | Identity requested on a backend it is NOT bound to (#14a). | Creation **rejected** at the popup; offered the correct bound backend or "no identity" bare session. | "Identity <X> is bound to <backend Y>; cannot open on <Z>." (text) |
| Step 2 | Bound backend offline / Peta token mint fails. | Retry; or open a "no identity" bare session (minimal authz, no write scope) to keep working. | "Backend <Y> unreachable — retry or open a bare session." |
| Step 3 | A grounding source (Qdrant/mailbox/search) is down or returns nothing. | Per-source toggle lets Karl proceed without it; inspector shows which sources were omitted. | "Source <X> unavailable — excluded from prompt." |
| Step 3 | Karl distracted, sends without inspecting. | Inspect is available **after** send too (assembled prompt is retained); trust tags persist in transcript. | Sent message still shows its trust-tagged grounding in the transcript. |
| Step 4 | Karl approves a write he shouldn't have (fatigue/click-through). | **GAP** — see gaps below. Currently: decision is logged; no built-in undo/revert of a committed write. | Write receipt; revert is manual via Gitea/Obsidian history. |
| Step 4 | Approval gate times out or the device that raised it goes offline. | Out-of-band gate is durable (Peta); approve from any tailnet device; default-deny on unresolved. | Pending-approval item resolvable from another device. |
| Step 5 | Cross-session search returns content from an identity Karl forgot is sensitive. | Content enters as `trusted:false`; cannot drive a write without the step-4 gate. | Untrusted-tagged results; writes still gated. |
| Step 6 | Rewriter (Alden-1) down, or returns a degraded rewrite. | Original is always preserved and is the default; Karl sends original. No auto-substitution ever. | "Rewriter unavailable — sending your original." |
| Step 7 | Provisioning fails partway (e.g., Qdrant collection created but HMAC custody step fails). | **GAP** — needs transactional/rollback semantics so no orphaned half-provisioned identity exists. | "Step <N> failed" + (ideally) rollback of prior steps. |

### Feedback Loops
- **Auth:** explicit signed-in indicator (text/icon) per device; logged-out devices show only login.
- **Session config:** a session-info panel lists the live persona, backend binding, authorized tools, Qdrant collection, and Gitea scope so Karl can verify what he's actually driving.
- **Grounding:** the assembled-prompt inspector is the primary feedback surface — before AND after send, with persistent trust tags.
- **Writes:** approval prompt names target scope + signing identity; post-write receipt confirms commit; deny confirms no-op.
- **Prompt-master:** side-by-side + diff; the chosen text is what appears in the transcript.

### Exit Points
- **Per-session:** closing a tab preserves the conversation (searchable later via #4). Re-opening resumes context; grounding re-assembles fresh.
- **Logout / device close:** auth state cleared on that device; other devices unaffected; pending out-of-band approvals survive (durable in Peta) and can be resolved elsewhere.
- **Abandonment mid-write:** an unresolved approval defaults to **deny** (no write) — fail-safe, not fail-open.
- **Abandonment mid-provision (#7):** the dangerous exit — see gap on rollback.

---

## Feature Gaps & Failure-Recovery Holes (Skeptical PM findings)

1. **Approval-fatigue / click-through on writes (Step 4).** Taint-by-presence means *every* identity session with any recalled content gates *every* write. A busy operator will approve reflexively. The brief specifies the gate but no friction-calibration (e.g., write preview diff, "what changed", per-scope summaries) and **no post-commit undo**. Recommend: rich write-preview in the gate + leverage Gitea/Obsidian history as an explicit revert path. *(Reveals a UX gap, not an architecture gap.)*

2. **New-identity provisioning is not transactional (Step 7).** Seven cross-system steps (Gitea repo, scope, Qdrant collection, HMAC key→custody, binding, Peta user, perms) with no stated rollback. A mid-sequence failure can orphan artifacts or, worse, leave a key/binding mismatch. Recommend defining compensating/rollback actions and an idempotent re-run. *(Should-have, but the hole is real.)*

3. **Colorblind enforcement has no acceptance test surface.** LibreChat and Peta admin surfaces are third-party; the brief mandates non-color cues but the harness inherits upstream UI we don't fully control. Need an explicit a11y checklist/automated check on every adopted surface (especially LibreChat's built-in status indicators and Peta approval UI), not just custom glue. *(Gap in validation coverage.)*

4. **Inspectability scope on adopted UI.** "View the fully-assembled grounded prompt before send" is custom-glue functionality, but LibreChat's native send path may not expose a pre-send interception point cleanly. Confirm LibreChat offers a pre-send hook/middleware or the inspector must intercept upstream. *(Possible integration gap — verify against LibreChat.)*

5. **Taint provenance granularity.** Taint-by-presence is binary per session. If Karl wants to clear taint (e.g., start fresh in the same session after removing untrusted sources), is there a defined "session detaint" path, or must he open a new session? Unspecified. *(Minor — likely "open new session," but should be stated.)*

6. **Multi-device approval race.** Out-of-band gate resolvable from any device — what if two devices act on the same pending approval simultaneously? Need single-resolution guarantee (first-write-wins / locked). *(Concurrency hole.)*

---

## Secondary Personas
Single-persona product by hard constraint (#7: exactly one human operator, ever). No secondary journeys.

---

## Review Checklist

- [x] Primary persona is specific (not "users") — solo operator "Karl," colorblind, multi-device tailnet
- [x] Success path covers the complete flow (entry/auth to exit) across all 7 core journeys
- [x] At least 3 failure points identified with recovery paths (11 listed)
- [x] Feedback loops defined (per-step + dedicated section)
- [x] Exit points preserve user state (sessions searchable; fail-safe deny on abandonment)
- [x] Journey reviewed with Skeptical PM mindset (6 gaps flagged)
- [x] Colorblind invariant applied as a success criterion on every step
