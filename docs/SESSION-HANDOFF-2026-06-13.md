# Pantheon Harness — Session Handoff (2026-06-13)

**Phase state:** `current_phase: 2` (Construction). Track: Standard. Gates 0→1 and 1→2 recorded + green (`scripts/check-phase-gate.sh`), snapshots in `docs/snapshots/`.
**Resume:** `cd pantheon-harness && bash scripts/resume.sh`; read `PROJECT_BIBLE.md` + this file. Re-verify all tests with the commands at the bottom.

---

## Verified-complete this session (evidence re-run by the Orchestrator, not just agent claims)

### Planning (Phases 0–1) — DONE & gated
- `PROJECT_INTAKE.md`, `docs/phase-0/{frd,user-journey,data-contract}.md`, **`PRODUCT_MANIFESTO.md`** (decisions D1–D9, MVP cutline), **`PROJECT_BIBLE.md`** (16 sections; ADRs; 19-threat STRIDE TM-001–019; 8-entity data model; test strategy; colorblind UI specs). `APPROVAL_LOG.md` has dated 0→1 and 1→2 self-reviews.

### Phase 2 components — BUILT (TDD) & PASSING
| Component | Path | Tests | Notes |
|---|---|---|---|
| Grounding + `trusted:false` taint engine | `services/control-plane/src/grounding/` | 27 pass, 100% cov | forgery-proof provenance; monotonic taint (no revert); fail-closed `tag→taint→gate` (D3/D5; TM-013) |
| Peta admin client + provisioning | `services/control-plane/src/peta/` | 39 pass total (incl. **live Peta integration**) | crypto byte-ported from validated `peta-eval/harness/peta.mjs`; live test mints→verifies→deletes a user on `:3002`; caught DELETE_USER=`userId` + object-`error` quirks |
| Obsidian/filesystem MCP server | `services/obsidian-mcp/` | 24 pass, 97.8% cov on core | `vault_list/read/search` (READ), `vault_write` (WRITE→intended dangerLevel:2); path-traversal + symlink escape rejected (tested) |
| **Configuration / Service Registry page (MVP M15)** | `services/control-plane/src/{registry,http}/` | (rolled into 145) | **Stands up the control-plane Fastify app + pluggable admin guard** (constant-time `ADMIN_API_TOKEN`; `verifyStepUp()` seam for D6 passkey/WebAuthn). BackendRegistry + ServiceEndpoint CRUD (better-sqlite3, fail-closed validation, seeded defaults); MCP-server register/list/remove via Peta client; server-rendered **colorblind-safe** config page (label+shape+aria, 4 states); #14a backend-rebind impossible-by-absence (`ImmutableBindingError`). Scope change recorded: Manifesto M15/D10, Bible §9 C.5 + §5 ServiceEndpoint, APPROVAL_LOG. |
| **Gitea direct client** | `services/control-plane/src/gitea/` | **145 tests total** (incl. **live round-trip** on `gitea.ferrumcorde.com`) | `getFile`/`writeFile`/`createRepo`/`getRepo`/`listRepos`/`deleteRepo` + `loadPersona` over `/api/v1`; token from **gitignored** env only (never in files/errors); privileged provisioning path (session writes still gated). NOTE: `writeFile` is create (POST); idempotent update (PUT+sha) is a flagged follow-up. **Operator TODO: rotate the transcript-exposed admin token.** |

| **Real grounding retrievers (Qdrant memory + bridge mailbox)** | `services/control-plane/src/{bridge,preprocessor/retrievers}/` | **175 tests total** (incl. live bridge memory + mailbox vs real data) | `BridgeClient` (MCP Streamable-HTTP + Bearer from gitignored env); `MemoryRetriever` (explicit per-identity collection, rejects `"all"`, optional `includeShared`); `MailboxRetriever` (non-destructive `list`, since_id polling — never `read`); `CompositeRetriever` honoring grounding toggles; all results `trusted:false` → taint flips. Integration note: `docs/integration/alden-bridge.md`. Bridge = LXC 1088 @ node 192.168.1.20, svc IP 10.100.23.88. |

**New requirements recorded this session (governance):** Gitea = direct client (operator input RESOLVED). **Claude-CLI = persistent web SSH terminal tab** (NOT a chat backend) → ADR-0005 (amends ADR-0001: harness frame hosts LibreChat chat tabs + xterm.js terminal tabs behind #9 auth), `DevMachine` entity (§5), TM-020 (SEV-1: SSH custody + RCE), M16 Must-Have, D11, UI spec C.6. **This is task #16, the next major build.**

Test-results evidence: `docs/test-results/`.

---

## Remaining Phase 2 — NEXT INCREMENT — ✅ DONE 2026-06-13 (task #13)
1. ✅ **Control-plane pre-processor** — `POST /v1/chat/completions` (identity-gated) resolves identity→bound backend (TM-002/#14a: backend NEVER taken from the request body), runs grounding assembly + `trusted:false` tagging + monotonic taint, stashes the assembled prompt, forwards to the bound backend. `GET /inspector/:sessionId/latest` (assembled prompt w/ trust labels) and `GET /approvals` + `POST /approvals/:id/decide` (proxy Peta client), both admin-guarded. **126 tests pass** incl. a live Alden-1 completion. Files: `src/{session,preprocessor,backend}/`, `src/http/routes/`. Seams (clearly marked, later increments): Anthropic/Claude translation, streaming, real Qdrant/mailbox/cross-session retrievers (only `StubRetriever` now), full Identity provisioning.
2. ✅ **Obsidian-MCP behind Peta — proven e2e** (`services/obsidian-mcp/scripts/e2e-peta-gating.mjs`, 5/5): reads frictionless; `vault_write` (dangerLevel:2) paused→approve→file written / reject→not written; clean teardown. Re-runnable anytime Peta is up.

### Design note for LibreChat wiring
The chat route reads session id from `x-pantheon-session` (falls back to a constant per request). **LibreChat must pass a stable per-conversation session id + the `x-pantheon-identity` header** (via custom-endpoint headers) before multi-session use.

## Remaining Phase 2 — BLOCKED on operator inputs (the genuine stop-for-input items)
- **Gitea base URL + identity-repo format** — needed for persona-load (#5 i) and the provisioning Gitea write (#14a/b). Operator deferred ("provide when asked"). The provisioning code currently mints the Peta user + perms; the Gitea repo/HMAC-key steps are stubbed pending this.
- **Passkey / step-up mechanism choice** (privileged tier: write approvals + gateway management) — Manifesto D6 chose "passkey/WebAuthn or equivalent"; concrete mechanism to confirm.
- **LibreChat deployment** — deploy + configure the custom endpoint to point at the control-plane pre-processor; built-in auth; Meilisearch for cross-session search (#4). Needs a deploy decision + host.
- **Full new-identity provisioning UX** (Should-have, S1) — the transactional cross-system provision (Gitea repo + Qdrant collection + HMAC keygen→gateway custody + backend binding + Peta user) with rollback; depends on Gitea + key-custody decisions.

---

## Environment notes for the next session
- Peta eval instance was running on `:3002` this session (containers `peta-eval-core`/`peta-eval-postgres`); the control-plane integration tests rely on it. If down: `docker-compose -p peta-eval -f peta-eval/deploy/docker-compose.yml --env-file peta-eval/deploy/.env up -d`. Owner token in `peta-eval/harness/state.json`.
- Toolchain: Node 20, TS 5.7 strict, vitest, eslint. Dev-only dep advisories (esbuild via vitest; express/SDK tree in obsidian-mcp) flagged — re-audit/pin on upgrade per CLAUDE.md; runtime prod deps audit clean.
- `.alden-harness-discarded/` (renamed-away first scaffold) can be deleted.

## Re-verify everything
```
cd services/control-plane && npm test          # 175 pass (live Peta/Alden/Gitea/Bridge tests skip if unreachable)
cd services/obsidian-mcp   && npm test          # 24 pass
cd .. && bash scripts/check-phase-gate.sh       # gates 0→1, 1→2 green
```

---

## ▶ START HERE — next session (build Task #16: Claude-CLI SSH terminal = option B)

**1. Open the project + a fresh agent**
```
cd "/Users/karl/Documents/Claude Projects/Pantheon/pantheon-harness"
claude
```

**2. Paste this priming prompt:**
> Read these in order, then summarize the project, current phase, what's already built, and what's next BEFORE acting: `CLAUDE.md`, `PROJECT_BIBLE.md` (esp. ADR-0005, §5 DevMachine, §9 C.5/C.6, TM-020, §7), `docs/SESSION-HANDOFF-2026-06-13.md` (build state + this START-HERE section), `.claude/phase-state.json`. Then re-verify green: `cd services/control-plane && npm test` ; `cd ../obsidian-mcp && npm test` ; `cd .. && bash scripts/check-phase-gate.sh`. Then build **Task #16 — the Claude-CLI SSH terminal modality (option B)** with strict TDD, per section 4 below. Stop only for genuine blockers.

**3. Preconditions (already on this machine):**
- Secrets in `services/control-plane/.env.local` (gitignored): `GITEA_BASE_URL`, `GITEA_TOKEN`, `BRIDGE_MCP_URL`, `BRIDGE_MCP_TOKEN`. **Rotate the Gitea + Bridge tokens — both were pasted in chat.** For live HTTP runs also set `ADMIN_API_TOKEN` here.
- `node_modules` installed; Node 20 / TS 5.7.
- Live deps (guarded tests skip if down): Peta `:3002` — restart from the Pantheon parent with `docker-compose -p peta-eval -f peta-eval/deploy/docker-compose.yml --env-file peta-eval/deploy/.env up -d`; Alden-1 `192.168.1.89:8080`; Gitea `gitea.ferrumcorde.com`; Bridge `10.100.23.88:8765`.
- Dev machines for the live SSH connect: `192.168.1.192` (Mac), `192.168.1.78` (Linux). Be at the keyboard for the one `ssh-copy-id` password prompt per machine.

**4. Task #16 spec — Claude-CLI SSH terminal (build in this order, strict TDD)**
Refs: ADR-0005 (amends ADR-0001), M16/D11, DevMachine entity §5, TM-020, UI spec C.6.
- **a) DevMachine registry** — extend `src/registry` + the Config page: `DevMachine {id, logicalName, host, port=22, user, sshKeyHandle, provisioned, enabled, createdAt, updatedAt}`. CRUD + a Config-page section. SSH key material lives in vault/custody by **handle** — never the raw key in DB/session/logs.
- **b) SSH auth model (operator decision):** first connect to a machine runs **`ssh-copy-id` with an interactive password prompt** (operator enters once) to install the harness public key; the harness keypair is generated once and the private key custodied; set `provisioned=true`. Every session after = **key-only, no password**.
- **c) SSH→PTY→WebSocket backend** — `ssh2` (+ `node-pty` if needed) bridging a WebSocket to a PTY on the selected dev machine; persistent, reconnectable session lifecycle; connect key-only via the custodied key.
- **d) xterm.js terminal tab** (frontend) — colorblind-safe (labels/shape/icon, four states: Empty/Loading/Error/Success).
- **e) Harness frame** — the top-level UI behind the #9 auth that hosts LibreChat chat tabs **and** xterm.js terminal tabs; the New Session popup routes "Claude CLI → dev machine (by logicalName)" to a terminal tab.
- **Security (TM-020):** SSH key in vault only; #9 auth gates terminal access; identity binds to the `claude_cli` backend and references the machine by **logicalName** (IP editable without breaking #14a); Claude Code's own permission model is the inner guard on the remote.
- **TDD:** unit-test registry + SSH connection/auth logic (mock `ssh2`); guarded live test connects to a reachable dev machine after provisioning. Build backend first (unit-testable), then the xterm.js frontend + harness frame.

**5. After B — deployment/integration items needing operator action:** deploy **LibreChat** + wire its custom endpoint to the pre-processor (`x-pantheon-identity` + stable session-id headers, Meilisearch search, built-in auth); **passkey/WebAuthn** for the admin guard's `verifyStepUp()` seam; full **new-identity provisioning UX** (S1); the Anthropic-translation + streaming seams in `src/backend`.
