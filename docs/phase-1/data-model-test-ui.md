# Project Bible — Data Model, Test Strategy & UI Component Specs

<!--
  Phase 1 artifact for Pantheon Harness.
  Source-of-truth precedence: PRODUCT_MANIFESTO.md (intent/scope/trust model) > this document (how).
  Inputs: docs/phase-0/REQUIREMENTS-SOURCE.md, PRODUCT_MANIFESTO.md, docs/phase-0/data-contract.md,
          docs/phase-0/user-journey.md, ../ALDEN-HARNESS-CLI-HANDOFF.md (+ RESULTS), ../peta-eval/harness.
  This document covers three sections of the Bible: (A) Data Model, (B) Test Strategy, (C) UI Component Specs.
  Architecture decisions elsewhere in the Bible are not restated here except where load-bearing.
-->

**Date:** 2026-06-13
**Status:** Draft (Phase 1)
**Track:** Standard
**Binding context:** Manifesto §5 Resolved Decisions D1–D9; REQUIREMENTS-SOURCE §4 (#1–#14), §5–§6.

---

## A. Data Model

### A.0 Principles (binding on every entity)

1. **Custody invariant (highest priority — Manifesto §4, #14b, D8).** Raw HMAC signing keys and raw Peta access tokens live **only in gateway custody** (Peta encrypted vault / encrypted at rest). They MUST NEVER be stored, mirrored, or referenced-by-value in the control-plane DB, session memory, transcripts, prompts, model inputs, audit entries, UI, or error output. The control-plane stores only an **opaque handle** (a custody reference: which vault record, never the secret).
2. **Provenance is a first-class column (#13).** Any entity that can carry recalled/non-user content records a `trusted` boolean. Default and indeterminate value is `false` (fail closed, CC2).
3. **Versioned & reversible.** Every persistent entity is created and mutated only through **versioned, reversible migrations** (CLAUDE.md construction rules). Mutable entities carry `version` (optimistic-concurrency / audit), `createdAt`, `updatedAt`. Deprovision is a state transition (`status`), never a hard delete of audit-relevant rows; AuditEntry and ApprovalRecord are append-only.
4. **Backend binding is permanent (#14a).** `Identity.backendId` is set once at creation and is immutable. No migration may rebind an identity; rebinding requires deprovision + re-provision under a new id.
5. **Access control = enforced at the gateway, not the model (#10, CC3).** The data model records authorization *intent* (which identity may call which tool); the *decision* is made by Peta at call time. The control-plane never grants itself a path around the gateway.

### A.1 Stores (where each entity physically lives)

| Store | Holds | Notes |
|---|---|---|
| **Control-plane DB** (this project's relational store; TS service) | Identity (definition + custody *handles*), BackendRegistry, Session, ToolClassification, GroundingSourceState, AuditEntry (control-plane scope) | Source of truth for orchestration glue. Backed up nightly (D9). Contains **no raw secrets**. |
| **Peta** (gateway store + encrypted vault) | Peta user record (1:1 with Identity), per-user×per-tool permissions, **raw Peta token (encrypted)**, **raw HMAC key material (encrypted `launchConfig`/vault)**, ApprovalRecord (durable PENDING/APPROVED/REJECTED queue), gateway audit log | Custody boundary. `userId = SHA-256(token)[:32]` (per RESULTS A2/R4). `/admin` + `GET_OWNER` never exposed (§6). |
| **Qdrant** (`10.100.23.79:6333`) | Per-identity vector collection (memory) + signed payloads | One collection per Identity (`qdrantCollection`). Cross-collection access denied by per-identity scope. |
| **Gitea** (per-identity repos) | Persona/system prompt, identity template, signed file writes | One repo/scope per Identity (`giteaRepo`). |
| **Transcript + Meilisearch** (LibreChat side) | Session transcripts, cross-session search index | Searched by #4; every recalled hit re-enters as `trusted:false`. |

> **Rule restated for emphasis:** `Identity.hmacKeyHandle` and the Peta token are **references into the Peta vault**, never the key/token. Resolving a handle to a secret happens *inside Peta at signing time only*. The control-plane cannot dereference it.

### A.2 Entities

Notation: `PK` primary key, `FK` foreign key, `→` reference, `[imm]` immutable after create, `[custody-ref]` opaque handle to a gateway-held secret (never the secret).

**Identity** — an AI persona-as-session-profile (#5). Maps 1:1 to a Peta user (RESULTS Q3).
- `id` PK [imm]
- `displayName` — human label shown in UI (text)
- `backendId` FK → BackendRegistry [imm] — **permanent backend binding (#14a)**
- `giteaRepo` — repo/scope ref for persona reads + signed writes
- `qdrantCollection` — this identity's private collection name
- `hmacKeyHandle` [custody-ref] — **handle to the gateway-custody HMAC key; NEVER the key (#14b)**
- `petaUserId` — the Peta user id (`SHA-256(token)[:32]`); the raw token is **not** stored here (custody)
- `personaSourceRef` — pointer to persona/system-prompt location in `giteaRepo` (loaded at creation only; never runtime-injected)
- `status` — `provisioning | active | failed | deprovisioned`
- `version`, `createdAt`, `updatedAt`
- *Reversibility:* full deprovision = transition `status` + revoke Peta user/token + (escrow-backed) key destruction; never a silent row delete.

**BackendRegistry** — the data-driven set of AI systems (#2, #5; extensible for 7900XTX/cloud).
- `id` PK [imm]
- `kind` — enum `local_alden1 | claude_cli | future_local_7900xtx | future_cloud`
- `endpoint` — e.g. `192.168.1.89:8080` (Alden-1)
- `displayName`, `enabled`, `version`, `createdAt`, `updatedAt`

**Session** — one tab/conversation bound to (identity?, backend) at creation (#2, #5).
- `id` PK [imm]
- `identityId` FK → Identity (nullable — "no identity" bare session)
- `backendId` FK → BackendRegistry [imm] — must equal `Identity.backendId` when identity present, else creation rejected (#14a)
- `taintFlag` boolean — **taint-by-presence (#14c, D5: sticky, no in-place detaint)**; default `false`, set `true` (and never back) the moment any `trusted:false` content enters context
- `petaTokenHandle` [custody-ref] — handle to the per-session-minted identity Peta token (custody; never the token)
- `createdAt`, `closedAt` (nullable)
- *Reversibility:* close = set `closedAt`; transcript persists for #4. Taint never reverts within a session (D5).

**ToolClassification** — explicit read-vs-write + danger mapping per (server, tool) (#10, D2).
- `id` PK [imm]
- `server` — registered MCP server id (e.g. Alden Bridge, Obsidian-MCP)
- `tool` — tool name (e.g. `gitea_file_write`, `alden_mailbox_read`)
- `dangerLevel` — `0 | 1 | 2` (Peta semantics; `2` = Approval)
- `isWrite` boolean — explicit classification; **must not default** (D2). Every send-type tool (`converse`, `alden_mailbox_write`, `alden_queue_message`, `alden_share_write`, `gitea_file_write`, `alden_memory_store`, Obsidian write) is `isWrite=true` ⇒ `dangerLevel=2`.
- `version`, `createdAt`, `updatedAt`
- *Note:* Peta's `dangerLevel` is **static per tool** (RESULTS Q2). Taint-by-presence is layered in the control-plane: writes stay gated whenever `Session.taintFlag` is true.

**ApprovalRecord** — the durable HITL write gate (#14c, D4). Authoritative copy is Peta's durable queue; control-plane mirrors decision metadata for audit/UI.
- `id` PK [imm]
- `sessionId` FK → Session
- `identityId` FK → Identity (signing identity)
- `tool` — the proposed write tool
- `argsDigest` — hash/ref of the proposed arguments/diff (**not** raw secret-bearing args in cleartext; D8)
- `argsPreviewRef` — pointer to the human-readable proposed-write preview shown in the gate (short-TTL store; D8)
- `status` — `pending | approved | rejected | expired`
- `decidedBy` — operator/device ref of the **single** resolver (D4 first-wins lock)
- `decidedAt` (nullable), `expiresAt` — gate is durable; **timeout ⇒ no execution (fail closed, R2)**
- `resumeToken` — Peta resume handle
- `createdAt`
- *Reversibility:* append-only. No post-commit undo in MVP (D4); revert is manual via Gitea/Obsidian history.

**GroundingSourceState** — per-session toggle state for each grounding source (#13).
- `id` PK [imm]
- `sessionId` FK → Session
- `source` — enum `persona | identity_qdrant | mailbox | cross_session_search`
- `enabled` boolean — grounding default-ON for identity sessions; each source individually toggleable
- `lastStatus` — `ok | unavailable | empty` (drives the inspector's omitted-source indicator)
- `version`, `updatedAt`

**AuditEntry** — append-only record of security-relevant actions (D8).
- `id` PK [imm]
- `at` timestamp, `correlationId` (ties UI ↔ control-plane ↔ gateway)
- `actor` — operator/device or `gateway`
- `action` — `auth | session_create | binding_reject | tool_call | authz_deny | approval_decision | sign | provisioning_step | server_registration`
- `subjectRef` — identity/session/tool/server ref
- `outcome` — `allow | deny | pending | error`
- `redactedDetail` — **redacted/by-reference only; MUST contain NO raw keys, tokens, or recalled-PII cleartext (D8, data-contract NEVER-appear rule)**
- *Reversibility:* append-only; never mutated or deleted.

> Entity count: **8** (Identity, BackendRegistry, Session, ToolClassification, ApprovalRecord, GroundingSourceState, AuditEntry, plus the **Peta user record** which is the gateway-side projection of Identity — counted here because it is a distinct durable record in a distinct store with its own lifecycle/secrets).

### A.3 Relationships

```
BackendRegistry 1 ──< Identity        (Identity.backendId, immutable binding #14a)
BackendRegistry 1 ──< Session         (Session.backendId, immutable)
Identity 1 ────────< Session          (Session.identityId, nullable for bare sessions)
Identity 1 ──1 PetaUser               (Identity.petaUserId; raw token in Peta custody only)
Identity 1 ──1 Qdrant collection      (Identity.qdrantCollection; per-identity isolation)
Identity 1 ──1 Gitea repo/scope       (Identity.giteaRepo; per-identity isolation)
Session 1 ─────< GroundingSourceState (one row per source per session)
Session 1 ─────< ApprovalRecord       (gate fires per write call)
Session/Identity/Tool/Server ──< AuditEntry (by correlationId, append-only)
ToolClassification (server,tool) → governs which calls are writes/gated
```

**Cross-identity isolation (#14, R4):** there is no relationship that lets Identity A reach Identity B's Qdrant collection, Gitea repo, Peta token, or HMAC key. Isolation is enforced by per-user Peta policy (authorization, not crypto) plus per-identity HMAC custody — A's key cannot sign B's repo/memory.

### A.4 Access Control

- **Authorization intent** lives in Peta per-user × per-tool permissions (mirrored as `ToolClassification` + the Identity↔PetaUser mapping). **Decision is at the gateway, at call time, fail-closed** (CC3, RESULTS A2: `-32602 Permission denied`).
- **Privileged tier (D6):** gateway management (server registration add/remove/edit, #11) and write-approval resolution require a strong step-up credential (WebAuthn/passkey or equivalent re-auth). The admin surface is **separate** and never reachable from any session tool (R6). Session call-auth is automatic via the per-identity Peta token.
- **UI auth gate (#9):** no Session, session list, or privileged action resolves without an authenticated UI session; logged-out = login screen only, no metadata leak.
- **Custody access:** only Peta dereferences `hmacKeyHandle`/token handles, only at signing time. No control-plane code path, log, or UI may resolve a custody-ref to a secret.

### A.5 Data-model decisions made here (load-bearing)

- **DM-1 — `argsDigest` + `argsPreviewRef` split on ApprovalRecord.** D4 demands the gate *display the proposed write*, but D8 forbids persisting recalled-PII/secret-bearing args in cleartext in the durable audit. Decision: the durable audit holds a **digest/ref**; the human-readable preview lives in a **short-TTL** store (session + small TTL, like the assembled prompt). Resolves the data-contract Open Question.
- **DM-2 — Peta user counted as an 8th entity.** It is the gateway-side projection of Identity but is a distinct durable record, in a distinct store, holding the raw (encrypted) token and key material the control-plane must never hold. Modeling it explicitly keeps the custody boundary auditable rather than implicit.
- **DM-3 — `taintFlag` is monotonic per session.** Implements D5 (sticky taint) directly in the schema: once `true`, no transition back to `false`; a clean context = a new Session row.

---

## B. Test Strategy (Standard track)

**Tooling baseline:** TypeScript + **Vitest/Jest** (unit/integration), **Playwright** (UI flows) + **axe-core** (a11y), **Semgrep** (SAST), **gitleaks** (secrets), **Snyk/`npm audit`** (deps). Harness pattern reused from `../peta-eval/harness` (`peta.mjs` admin-API driver + `mock-server.mjs` write-evidence pattern: a real write appends to `writes.log`, so *deny == zero appends* is provable, not asserted by trust). Results archived to `docs/test-results/` (naming `[date]_[scan-type]_[pass|fail].[ext]`).

**Sequencing rule (D3, enshrined): tag → taint → gate.** Tests are written and ordered so that a write executing from a session holding *untagged-provenance* content is a failing test; the write path is never built or tested before tagging+taint.

### B.1 Unit (TDD — highest coverage on pure logic)

The grounding/taint engine is **pure logic** (no I/O) and is the high-coverage core (Manifesto §2 architecture note; CLAUDE.md TDD).

- **Grounding assembly:** every recalled item is tagged `trusted:false`; only this-session typed input is `trusted:true`; indeterminate provenance ⇒ `trusted:false` (fail closed).
- **Taint-by-presence:** ANY `trusted:false` present ⇒ session tainted; presence-based not judgment-based; monotonic (DM-3) — cannot detaint.
- **tag→taint→gate ordering:** a unit test asserts the gate *cannot* be reached for content that was not first run through tagging; reordering breaks the test (D3).
- **ToolClassification:** send-type tools resolve `isWrite=true ⇒ dangerLevel=2`; classification never defaults (D2).
- **Custody guards:** serializers/loggers reject any object graph containing a raw key/token (NEVER-appear rule); custody-ref cannot be dereferenced outside the Peta client.
- **Coverage target:** **≥90% line/branch on the grounding/taint/classification engine**; ≥80% on the rest of the control-plane glue.

### B.2 Integration

- **Control-plane ↔ Peta admin API:** provision identity = create Peta user, set per-tool perms, mint per-identity token, register backend binding — driven through the admin-API pattern from `peta.mjs` (actions 1010/1002/2010/2001). Assert: token never returned to client/logs; `userId = SHA-256(token)[:32]`.
- **MCP client ↔ gateway (reuse peta-eval harness):** stand up `mock-server.mjs` behind Peta; drive calls as a per-identity token via `StreamableHTTPClientTransport`. Assert read frictionless, write gated.
- **Grounding → taint → gate end-to-end (D3 integration test):** assemble a prompt with a recalled (`trusted:false`) item; issue a write; assert the gate fires and the write does not execute until approved. The test **fails if a write executes from a session holding untagged-provenance content**.
- **Backend-binding registry:** request identity on wrong backend ⇒ creation rejected (#14a) with the specific binding-violation error; no partial session row persists.
- **Coverage target:** every MVP data-flow transformation (data-contract Transformations #1–#7) has ≥1 integration test; both happy + fail-closed path.

### B.3 Security (map each threat-model TM-ID to a test; A2/A3/A4 + R1–R6 as regression)

The validated peta-eval assertions become **standing regression tests** (run in CI). Mapping (threat-model TM-IDs to be finalized in the Bible's §1.3 STRIDE model; the peta-eval R/A IDs are the seed set):

| TM / seed | Threat | Test (pass criterion) |
|---|---|---|
| TM-INJECT (A2/R1) | Prompt-injected session calls an ungranted write tool | Grant identity read-only; call write tool by real name ⇒ gateway DENY (`-32602`), write executes **0×** (writes.log unchanged). *Most important assertion.* |
| TM-APPROVAL (A3/R2) | Write-gate bypass (param trick, repeat, race, timeout) | `dangerLevel:2` call ⇒ durable PENDING; APPROVED ⇒ executes exactly once; REJECTED/PENDING/expired ⇒ **0 executions**; timeout fails **closed**. |
| TM-CUSTODY (A4/R3) | Secret exfiltration from vault/downstream | Secret in encrypted `launchConfig`; token-only identity calls tool ⇒ succeeds via server-side injection; secret appears **0×** in client view + logs (gitleaks/grep). |
| TM-ISO (R4) | Cross-identity action | From identity A attempt to act as / reach B's server ⇒ denied; A's key cannot sign B's repo/memory. |
| TM-SSRF (R5) | SSRF via OAuth client-metadata / internal IP | Internal-IP metadata URL rejected; verify tailnet `100.x` still registers via normal DCR. |
| TM-MGMT (R6, D6) | Management reachable from a session | Session/MCP token hitting `/admin` (GET_USERS, CREATE_USER) ⇒ rejected; `/admin` + `GET_OWNER` not publicly exposed. |
| TM-AUTH (#9) | Unauthenticated reach to sessions/privileged actions | Logged-out request to session list/privileged route ⇒ 401/login only, no metadata leak. |
| TM-LOG (D8) | Secret/PII in audit log | gitleaks + assertion: no raw key/token/recalled-PII cleartext in AuditEntry; args persisted as digest/ref (DM-1). |

Plus SAST (Semgrep), secrets (gitleaks), deps (`npm audit`/Snyk — carry the F2 finding: patch before trusting, re-audit each upgrade). Carry F1/F3 hardening as config tests: peta-core runs non-root, no docker.sock; `/admin` + `GET_OWNER` not exposed; LAN/Tailscale-only network test (M2).

### B.4 E2E smoke (Playwright + axe-core)

Walk the user-journey success path: auth → New Session (existing identity) → grounding inspect → write-approval (approve + deny) → cross-session search/mailbox. **axe-core runs on every screen**; a manual colorblind pass is a gate (CC1). Smoke asserts the deny path commits nothing and the approve path shows a receipt.

### B.5 Pass/fail criteria & Phase 3 entry/exit

- **Pass/fail (per build, CI gate):** all unit + integration green; all TM-* security regressions PASS; coverage targets met; axe-core 0 violations on custom surfaces; **any color-only signal = SEV-2 fail (CC1)**; any ungated write / key-or-token leak / gateway bypass = **SEV-1, stop-the-line** (Manifesto Bug Severity table).
- **Phase 3 entry criteria:** all MVP-cutline features built + unit/integration passing; CI green; no open SEV-1/2; Bible reflects code.
- **Phase 3 exit criteria:** all 6 Phase-3 validation types complete (integration, security hardening with attack payloads, chaos, accessibility incl. colorblind, performance, contract); all TM-* PASS with archived evidence; results archived in `docs/test-results/`; sbom.json generated; SECURITY.md present (web).
- **Where results live:** `docs/test-results/` (archived UAT sessions, scan outputs); CI summary; correlation IDs tie failures back to AuditEntry.

---

## C. UI Component Specs (text specs — NOT mockups)

**Cross-cutting acceptance criteria on EVERY component below (hard, non-negotiable):**
- **CB — Colorblind-safe (CC1, hard AC):** every signal/state/control distinguished by **shape, position, text label, or icon — never color alone.** A color-only cue is a SEV-2 defect.
- **TL — Text label on every interactive element:** every button/toggle/input has a visible text label (not icon-only, not color-only).
- **FS — Fail closed (CC2):** ambiguous/error states default to the safe (deny/untrusted/blocked) outcome and say so in text.
- **Four states defined for each:** Empty, Loading, Error, Success.

### C.1 New Session popup — AI SYSTEM × IDENTITY (#5, #14a)

Two clearly-labeled selectors: **AI SYSTEM** (from BackendRegistry) and **IDENTITY** (`existing | new | none`). Confirm button labeled "Open Session". On confirm: resolve binding (#14a), load persona/authz/Qdrant/Gitea scope, mint per-identity Peta token, open a tab **labeled with identity + backend in text** (never color).
- **Empty:** No identities provisioned ⇒ text "No identities provisioned" + labeled link to the register-existing path (D1). AI SYSTEM still selectable for a "no identity" bare session.
- **Loading:** "Configuring session on <backend>…" with **per-step text progress** (binding → persona → authz → Qdrant → scope → token).
- **Error:** binding violation ⇒ "Identity <X> is bound to <backend Y>, not <Z>" (text), offer the correct bound backend or a bare session; backend/token failure ⇒ "Backend <Y> unreachable — retry or open a bare session". **No partially-configured session opens (FS).**
- **Success:** session tab opens, identity+backend label visible; session-info panel lists persona, binding, authorized tools, Qdrant collection, Gitea scope (verifiable in text).

### C.2 Grounding Inspector — assembled prompt (#13)

Renders the fully-assembled grounded prompt before/after send. **`trusted:false` content is distinguished by LABEL + ICON + POSITION/SECTION — never color.** E.g. each untrusted block sits under a labeled section header ("UNTRUSTED — recalled (Qdrant)") with a distinct shape/icon marker; trusted (this-session typed) input is in its own labeled position. Each grounding source has an individual toggle (shape/label control).
- **Empty:** "No grounding sources active for this session" (text); send still possible (only typed input, trusted).
- **Loading:** "Assembling grounded prompt…" (text + spinner).
- **Error:** per-source "Grounding source <X> unavailable — excluded; send without it?" (text + non-color icon); if the inspector cannot render at all ⇒ **send is blocked (FS)** with a text reason.
- **Success:** full prompt rendered; every untrusted block carries label+icon+position; omitted sources listed; toggles reflect state. Available after send too (retained per D8 short-TTL).

### C.3 Write-Approval Gate (#5, #14c, D4)

Out-of-band, durable (survives device offline; resolvable from any tailnet device). **MUST display the proposed write: the tool name + its arguments/diff**, target scope, and signing identity. Approve / Deny are **distinct shaped + text-labeled buttons in distinct positions** (never red/green-only — Manifesto §8 / handoff §8 explicitly: rely on labels, not color). **Single-resolution across devices: first decision wins / lock (D4).**
- **Empty:** n/a — the gate only exists when a write is proposed (documented as "no pending approvals").
- **Loading:** "Awaiting your approval…" — persists out-of-band; shows the proposed-write preview while pending.
- **Error:** "Write failed after approval — HMAC/scope error, nothing committed" (text); a concurrent second-device action on an already-resolved gate ⇒ "Already resolved by <device> at <time>" (lock honored). Timeout/abandonment ⇒ **defaults to deny, nothing committed (FS, R2)**.
- **Success:** Approve ⇒ gateway signs (key never enters session context) and commits ⇒ "Write committed to <scope>" receipt (text). Deny ⇒ "Write rejected — nothing committed"; model told rejected; decision logged (AuditEntry).

### C.4 Prompt-Master toggle (#12, Should-Have)

Per-message toggle, **default OFF**, a **shape/label control** (not a colored switch). On request, drafted text goes to the isolated rewrite-only service on Alden-1 (no tools, no identity, no session authz; drafts stay on LAN). Result shown **side-by-side with the original + a diff**; operator **picks which sends — never auto-substitute**.
- **Empty:** toggle OFF, no rewrite shown; label reads "Prompt-Master: OFF".
- **Loading:** "Rewriting on Alden-1…" (text).
- **Error:** "Rewriter unavailable — your original is unchanged; send as-is?" — **original is always the default (FS, no auto-substitution)**.
- **Success:** original + rewrite shown side-by-side with a diff; two labeled pick-to-send buttons ("Send original" / "Send rewrite"); chosen text is what appears in the transcript. Toggle state readable without color.

---

## Review Checklist

- [x] Data model: 8 entities, relationships, access control; versioned/reversible; custody invariant (keys/tokens = gateway-only, handles in DB).
- [x] Each store named per entity (control-plane DB / Peta / Qdrant / Gitea / transcript+Meilisearch).
- [x] Test strategy: unit (TDD, ≥90% on pure taint/grounding engine), integration (control-plane↔Peta, MCP↔gateway, reuse peta-eval harness), security (TM-* incl. A2/A3/A4 + R1–R6 regression), e2e smoke; pass/fail + Phase 3 entry/exit; results in docs/test-results/.
- [x] D3 tag→taint→gate ordering test enshrined (write-from-untagged-content = failing test).
- [x] 4 UI components, each with Empty/Loading/Error/Success; every interactive element text-labeled; colorblind-safe as a hard AC; trusted:false distinguished by label/icon/position (never color).
