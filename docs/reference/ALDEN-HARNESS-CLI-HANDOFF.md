# Alden Harness — CLI Handoff & Peta Evaluation Runbook

**Created:** 2026-06-13. Findings are current as of this date — **re-verify against live repos/docs; product behavior changes.**
**Produced by:** an architecture session in the Claude Code *desktop app*, which **cannot reach the Proxmox host or internal LAN**. This file is the handoff so a Claude Code *CLI* session on a dev machine **with Proxmox + internal-network access** can run the live test cold.
**Audience:** a Claude Code CLI agent that has **no memory of the prior conversation**. Everything needed is in this file.

---

## 0. How to use this doc
1. Read §1–§4 for context and the decision already made. **Do not re-litigate the architecture** — it's settled; your job is the live evaluation.
2. Execute §5 (the runbook) in order: provision VM → deploy Peta → functional test → security audit → red-team.
3. §6 is the go/no-go criteria. §7 is the network map. §8 is hard constraints. §9 is references.
4. Convert §5 into a TodoWrite checklist before you start.
5. **Mark uncertainty honestly and verify with web/docs where product knowledge may be stale.** Several specifics below (exact env vars, flags) must be read from Peta's own files on the VM — they are flagged "READ, don't assume."

---

## 1. The system ("Alden") and deployment model
A solo-operator homelab AI ecosystem:
- **Cloud Alden** — Claude via Anthropic API / claude.ai.
- **Alden-1** — local Qwen 3.5 122B on a Corsair workstation, OpenAI-compatible, at `192.168.1.89:8080`.
- **Claude Code CLI** — execution layer.
- **Alden Bridge** — an MCP server at `10.100.23.88:8765` (mailbox, memory, gitea, converse tools — see §7).
- **Gitea** (scoped identity repos), **Qdrant** vector DB (`10.100.23.79`), **Obsidian** vault (LiveSync/CouchDB).
- **pfSense + Tailscale**; **Caddy** reverse proxy.

**Deployment model (FIRM, do not design against):** single user; no multi-tenant; **no public exposure; reached only from inside the LAN or over Tailscale; NO Cloudflare Tunnel / public ingress.** UI-to-internal traffic is plain LAN.

---

## 2. What the harness must do (the security-critical core)
The full requirement set is 14 items; the ones that drive THIS evaluation:
- **Identity as a session-creation profile** — selecting an identity configures persona, tool/MCP authorizations, a private memory store (Qdrant collection), and Gitea write scope, at session birth. Each identity is **permanently bound to one backend**.
- **A single local MCP gateway** all AI systems talk through, with **two distinct auth directions**: (a) server *registration* auth; (b) client/*call* auth — which session may invoke which server's tools, **enforced at the gateway, not in the LLM** (this is what contains prompt injection).
- **Trust boundary:** all cross-session/recalled/Qdrant/mailbox content enters context tagged `trusted:false`; only the user's typed input is trusted. Enforcement is **three-layered**: retrieval tag → gateway blocks write-scoped calls traceable to untrusted origin → explicit out-of-band confirmation for privileged writes.
- **Per-identity isolation + write integrity:** each identity has its own repo, Qdrant collection, and signing key; keys are held by the **gateway**, never loaded into a session's context; any write from a session that holds *any* `trusted:false` content requires human approval (**taint-by-presence**, not taint-by-judgment).

**Why this matters for the test:** Peta is being evaluated as the component that provides the gateway + credential custody + the human-approval gate. The test must prove those three things are real and that **an unauthorized or injected call is rejected by the gateway regardless of what the session asks.**

---

## 3. The decision already made (DO NOT RE-LITIGATE)
Recommended stack:
- **UI plane — ADOPT LibreChat.** Gives auth, multi-backend via OpenAI-compatible custom endpoints (covers Alden-1 + Claude), Meilisearch conversation search, and **Agents** that map almost 1:1 to "identity" (persona + one endpoint = backend binding + per-agent tool authz with server-side ACL).
- **Trust core / MCP gateway — EVALUATE Peta** (`dunialabs/peta-core`). This runbook is that evaluation.
- **Glue (custom, build later):** identity-creation popup + provisioning orchestrator, inspectable grounding pipeline + `trusted:false` taint, prompt-master isolated rewriter (on Alden-1), Obsidian/filesystem MCP server, per-session-identity wiring from LibreChat → gateway.

**Mapping to keep in view while testing:**
- **Alden identity = one Peta "user"** (Peta's policy model is per-user/per-tool; map each identity to a Peta user).
- **Reads/reasoning = frictionless; writes to scoped systems = `dangerLevel: Approval`** (gate fires only on the write).
- **Peta Desk (on the tailnet) = the out-of-band confirmation surface** for those writes.
- **Peta vault = credential custody** (the "key never in session context" requirement; note Peta does cross-identity isolation via *policy + per-entry secrets*, not per-identity HMAC crypto — acceptable, but understand it).

**Fallback if Peta fails the audit:** **Bifrost** (`maximhq/bifrost`, Apache-2.0) — real per-tool authz but **no human-in-the-loop approval**, so you'd move approval out-of-band into the control plane; or a small purpose-built gateway.

---

## 4. What was verified about Peta (2026-06-13) — and the open risk
Verified by reading the repo tree + `docs/security.md` directly, and the in-request enforcement call-path was corroborated by a second source-reading agent. Confidence noted per row.

| Capability | Verdict | Evidence (peta-core) |
|---|---|---|
| Gateway proxies many servers behind one `/mcp` endpoint | Real | `src/controllers/handlers/ProxyHandler.ts`; namespacing `serverId::toolName` |
| Per-**tool** authz, server-side, three-layer filter | Real (per-user/per-tool) | `docs/security.md` ("direct calls to a non-permitted capability are rejected"); `src/controllers/handlers/PolicyHandler.ts`; `src/repositories/PolicyRepository.ts` |
| Pre-execution **human approval** (HITL) | Real | tool `dangerLevel: Approval` → pause → Socket.IO → Peta Desk → execute only on approve; `ApprovalHandler.ts` + `ApprovalRepository.ts` (durable queue) |
| **Credential custody** (server-side injection; client never sees secret) | Real, well-designed | `src/security/CryptoService.ts` — PBKDF2-HMAC-SHA256 (100k+ iters, per-record salt) + AES-256-GCM w/ auth tag; keys never written to disk |
| Server registration + OAuth2 (PKCE, dynamic client registration) | Real | `ServerHandler.ts` (large); built-in OAuth server |
| Management UI (#11) | Split | **Peta Console GUI is closed-source** (`dunialabs/peta-console` → 404). The **admin REST API is in OSS core** (Policy/User/Server handlers) — drive it directly. **Peta Desk** (approval app) **is open**, MIT, Electron: `dunialabs/peta-desk` |

**Stack/runtime:** TypeScript/Node ≥18, PostgreSQL 15+, Prisma ORM. Dockerized (`Dockerfile`, `docker-compose.yml`, `DOCKER_BUILD.md`). License **Elastic License 2.0** (self-host fine; can't resell as a service — non-issue for single-user).

**Known limitations / notes:**
- **No `sampling` / `roots` / `elicitation` reverse-requests** in the shared runtime (downstream servers can't interactively prompt the user *through* Peta).
- **Cloudflare Tunnel is baked in** (`cloudflared/`, `CloudflaredService.ts`). You do NOT want public ingress — **do not configure it.**
- **SSRF guard** on URL-based OAuth client-metadata fetches rejects private/loopback IPs, with an `OAUTH_CLIENT_METADATA_ALLOW_FAKE_IP` flag for VPN fake-IP ranges — **may interact with Tailscale `100.x`** (test R5).
- Approval trigger is **static per-tool `dangerLevel`**, not session-aware. "Gate all writes" maps natively; the **taint-by-presence** refinement needs either the content-aware policy DSL to accept an external per-call signal, or control-plane logic (open question Q2 below).

**THE LOAD-BEARING RISK:** peta-core is **~52 GitHub stars, ~2 primary committers, and heavily AI-authored** (31KB `CLAUDE.md`, `.cursorrules`, `START_HERE_FOR_AI.md`). It is a *security boundary holding your keys*. The feature list is real; **the question is whether the implementation is trustworthy. The §5.4 audit is the point of this whole exercise.**

**Letta (`letta-ai/letta`, Apache-2.0), for reference:** memory blocks + per-agent MCP tool scoping + a real server-side tool-approval gate are usable self-hosted; but its `Identity` object is **deprecated and not backend-bound** — the durable primitive is the *agent*. Verdict: borrow the design / optional memory+approval backend, **not** the harness. Not part of this test unless the Peta path fails.

---

## 5. RUNBOOK

### 5.0 Read first (READ, don't assume)
On the VM after cloning `dunialabs/peta-core`, read before configuring: `DOCKER_BUILD.md`, `.env.example`, `docs/deployment.md`, `docs/reference.md`, `docs/architecture.md`, `docs/security.md`. Exact env var names (vault master secret, DB URL, OAuth issuer, ports) **come from those files**, not from this doc.

### 5.1 Provision a throwaway VM (Proxmox)
- Spin up a disposable Debian/Ubuntu VM. **Snapshot before** each phase so you can roll back.
- Prefer an **isolated VLAN**; this is a security test of an unaudited component holding secrets — don't run it next to production trust.
- Install Docker + Docker Compose, git, and Node ≥18 (for tooling).
- **Do NOT point the test at real Gitea/Qdrant/Obsidian writes.** Use mocks (5.3) for write paths.

### 5.2 Deploy peta-core + Peta Desk
- `git clone https://github.com/dunialabs/peta-core && cd peta-core`; follow `DOCKER_BUILD.md` / `docker-compose.yml`. Bring up Postgres + core. Set the vault master secret and DB config per `.env.example` (READ it).
- **Do not enable** Cloudflared or anonymous `/mcp/public`.
- Confirm the gateway is healthy and serving `/mcp`. Confirm the admin REST API responds (Policy/User/Server handlers).
- Build/run **Peta Desk** (`git clone https://github.com/dunialabs/peta-desk`; it's Electron — `package.json` scripts) and connect it to core via Socket.IO so approvals have a surface. If a desktop GUI is impractical on the VM, write a tiny Socket.IO listener that prints/answers approval events — the channel is the contract, Desk is just one client.

### 5.3 Functional test — prove the four assertions
Set up **one mock downstream MCP server** on the VM exposing two tools: `read_thing` (benign) and `write_thing` (sensitive). Register it in Peta. Create **one Peta user = identity "alden"**. Test with an MCP client pointed at Peta's `/mcp` — recommended: **`npx @modelcontextprotocol/inspector`**, or `claude mcp add` the Peta gateway into a scratch CLI session, or a small MCP SDK script.

- **A1 — Proxy works:** the client, through Peta, sees the mock server's tools namespaced (`serverId::read_thing`). ✅ if tools list resolves through the gateway.
- **A2 — Per-tool authz is server-side (the injection-containment proof):** grant identity "alden" **only** `read_thing`. Then have the client call `write_thing` anyway. ✅ **only if the gateway rejects it** (policy DENY in the audit log), even though the client explicitly requested it. ❌ if the call goes through. *This is the most important assertion.*
- **A3 — HITL approval:** mark `write_thing` `dangerLevel: Approval` and grant it. Call it. ✅ if the gateway **pauses**, an approval event reaches Peta Desk / the Socket.IO listener, the tool runs **only after approve**, and **does not run on deny**. Record the **timeout behavior** (see R2).
- **A4 — Credential custody:** give the mock server a secret credential via Peta's vault. Confirm the secret is injected server-side and **never appears** in the client's view or in logs. ✅ if the client never receives the secret and `grep`-ing logs for it finds nothing.

> Once A1–A4 pass on the mock, optionally repeat A1/A2 against the **real Alden Bridge** (`10.100.23.88:8765`) using **read-only** tools only (`alden_mailbox_read`, `alden_memory_search`, `gitea_file_read`) to confirm real-world proxying. Do **not** exercise real write tools here.

### 5.4 Security audit (THE POINT — code-level)
Clone the repo locally and run the `/security-review` skill over it, plus a manual pass on these files. You are looking for whether a *young, AI-authored security boundary* is actually sound:
- **Vault** — `src/security/CryptoService.ts`: correct PBKDF2 params; **fresh IV per encryption** (no nonce reuse); **auth-tag verified on decrypt**; where the master key lives; is it ever logged or written to disk; key rotation story.
- **Policy enforcement** — `ProxyHandler.ts` + the proxy/enforcement engine (likely under `src/mcp/`): is it **fail-closed** on malformed/unknown input? Is enforcement applied **at call time**, not only by hiding tools from `tools/list`? (A2 tests behavior; confirm it in code.)
- **OAuth server** — `src/security/OAuthTokenValidator.ts`, `TokenValidator.ts`: PKCE correctness; token **audience** validation; **scope** enforcement per MCP method family; DCR abuse; the SSRF guard logic.
- **Secret hygiene** — confirm secrets are excluded from logs (`LogHandler.ts`/Pino config); scan git history for committed secrets.
- **Admin/management exposure** — confirm `/admin` (Policy/User/Server handlers) and the Socket.IO channel **require admin auth** and are **not reachable with a session/MCP-client token** (ties to R6).
- **Supply chain / container** — `npm audit`; Dockerfile runs as **non-root**; no secrets baked into the image; pinned deps.

### 5.5 Red-team (adversarial)
- **R1 — Injection → unauthorized tool:** as identity "alden" (granted read-only), feed a recalled/`trusted:false`-style message instructing the model to call `write_thing` (or a real write tool). ✅ **only if the gateway blocks it** (DENY), independent of model compliance. The proof is the gateway log, not the model's manners.
- **R2 — Approval-gate bypass:** try to get a `dangerLevel: Approval` tool to execute without the approval round-trip (param tricks, repeated calls, race). Confirm a **denied** approval prevents execution, and that an approval **timeout fails CLOSED** (no execution), not open.
- **R3 — Secret exfiltration:** via a tool whose output echoes config/env, try to surface a vault secret. ✅ if secrets never reach the client.
- **R4 — Cross-identity:** create a second Peta user/identity "bravo" with different grants; from "alden" attempt to call "bravo"'s server / act as "bravo". ✅ if denied.
- **R5 — SSRF + Tailscale:** attempt to register an OAuth client whose metadata URL points at an internal host (e.g. `http://192.168.1.89/...`). ✅ if rejected by the SSRF guard. Then test the **Tailscale `100.x`** interaction and the `OAUTH_CLIENT_METADATA_ALLOW_FAKE_IP` flag — does legitimate tailnet client registration still work?
- **R6 — Management reachable from a session?** With only a session/MCP-client token, attempt to hit `/admin` endpoints. ✅ if rejected (management must be unreachable from any session — your privilege-tiering requirement).

---

## 6. Go / no-go — and the four sharp questions
**Adopt Peta if:** A1–A4 pass **and** the §5.4 audit finds **no critical flaw** in vault/policy/OAuth **and** red-team R1–R4 are contained (R5/R6 fixable/configurable acceptable). **Otherwise:** fall back to **Bifrost** (move approval out-of-band) or a small custom gateway.

The four questions this test must answer (each maps to a step):
1. **Security review of peta-core** — is the vault/policy/OAuth implementation trustworthy? → §5.4. *Highest priority.*
2. **Can the policy DSL gate a tool call on an external per-call signal** (your taint-by-presence flag), or is `dangerLevel` static-only? → probe during §5.3 A3 / read policy code in §5.4. Determines how taint-by-presence is implemented.
3. **Does identity = Peta user scale cleanly** — provision N users via `UserHandler`, each per-tool scoped, no per-session leakage? → §5.3 A2 + R4.
4. **Tailscale + SSRF guard** interaction for client auth? → R5.

---

## 7. Internal network map (confirm reachability from the VM; use Tailscale if needed)
| Host | Address | Notes |
|---|---|---|
| Alden-1 (Qwen 122B) | `192.168.1.89:8080` | OpenAI-compatible; a LibreChat backend |
| Alden Bridge (MCP) | `10.100.23.88:8765` | existing MCP server; register behind Peta as a downstream |
| Qdrant | `10.100.23.79` | default REST `:6333` / gRPC `:6334` — **confirm** |
| Gitea | **confirm address** | scoped identity repos |
| Obsidian / CouchDB (LiveSync) | **confirm address** | vault sync target |
| pfSense / Tailscale / Caddy | — | network edge; no public ingress |

**Alden Bridge tool taxonomy** (useful for designing grant lists / picking what to mark `Approval`):
- **Read (frictionless):** `alden_mailbox_check/list/read`, `alden_memory_search`, `alden_history`, `gitea_file_read`, `gitea_repo_list`, `gitea_commits_list`, `alden_share_list/read`, `alden_status`, `alden_instance_list`, `alden_hub_feed`.
- **Write-scoped (mark `dangerLevel: Approval`, test authz rejection against):** `gitea_file_write`, `gitea_repo_create`, `gitea_branch_create`, `alden_memory_store`, `alden_mailbox_write`, `alden_share_write`, `alden_queue_message`, `alden_instance_register/remove`, `alden_dossier_sync`.

---

## 8. Constraints (carry into everything)
- **Operator is colorblind.** Any UI guidance or status signal must use **shape, position, text labels, or icons — never color alone.** When reading Peta Desk's approve/deny, rely on **labels**, not red/green.
- **No public ingress** — LAN/Tailscale only; do not enable Cloudflared.
- **Single user**, no multi-tenant assumptions.
- **Throwaway VM only** for this test; do not exercise real write tools against prod Gitea/Qdrant/Obsidian.
- **ELv2** license on peta-core (fine for single-user self-host).
- The operator **orchestrates via Claude Code** — produce precise, runnable steps and report results faithfully (if an assertion fails, say so with the evidence).

---

## 9. References
- **Peta Core** (gateway, ELv2): https://github.com/dunialabs/peta-core — audit `src/security/CryptoService.ts`, `src/controllers/handlers/{Policy,Approval,Server,User,Proxy}Handler.ts`, `src/repositories/{Policy,Approval}Repository.ts`, `src/security/OAuthTokenValidator.ts`; read `docs/security.md`, `docs/deployment.md`, `.env.example`, `DOCKER_BUILD.md`.
- **Peta Desk** (approval surface, MIT): https://github.com/dunialabs/peta-desk
- **Peta docs:** https://docs.peta.io
- **Bifrost** (fallback gateway, Apache-2.0): https://github.com/maximhq/bifrost
- **Letta** (reference for identity/memory model, Apache-2.0): https://github.com/letta-ai/letta
- **LibreChat** (UI plane): https://www.librechat.ai/docs — MCP, Agents, Custom Endpoints, Meilisearch, Authentication.
- **MCP Inspector** (functional testing client): `npx @modelcontextprotocol/inspector`

---

*End of original handoff. The full architecture rationale lives in the originating session transcript; this file is the actionable subset for the live evaluation.*

---
---

# RESULTS — Live Peta Evaluation (executed 2026-06-13)

**Environment:** Mac mini (Apple Silicon, macOS 26.4.1, 24 GB RAM), local Docker (per your choice — not a Proxmox VM). `petaio/peta-core:latest` (Node 20 Alpine, arm64) + `postgres:16-alpine`, deployed **hardened**: no Cloudflared, no `peta-auth`, **non-root, no docker.sock**. MCP SDK 1.29.0. This box also has direct LAN reach to Alden-1 (`192.168.1.89:8080`), the Bridge (`10.100.23.88:8765`), and Qdrant (`10.100.23.79:6333`).

**Reproducibility:** all artifacts live in `peta-eval/` — `deploy/` (compose + .env), `peta-core/` (cloned source), `harness/` (`peta.mjs` crypto/admin/client tool, `mock-server.mjs`, `state.json`). Bring-up: `docker-compose -p peta-eval -f peta-eval/deploy/docker-compose.yml --env-file peta-eval/deploy/.env up -d`; then `node peta-eval/harness/peta.mjs create-owner` etc.

## Headline verdict: **ADOPT Peta** as the Alden gateway — conditional on the hardening checklist below.
The go/no-go bar from §6 is met: **A1–A4 all pass; red-team R1–R6 contained; the audit found no critical flaw in vault/policy/OAuth.** The real risks are operational/maturity, all mitigable. Fall back to Bifrost only if the dependency/maturity posture is unacceptable to you.

## Functional tests (A1–A4) — ALL PASS
Used a real MCP mock (`read_thing`, `write_thing`) registered as an owner-managed CustomRemote; `write_thing` records evidence so deny == provably zero execution. Two scoped identities: `reader` (read only) and `writer` (read + write).

| # | Assertion | Result | Evidence |
|---|---|---|---|
| A1 | Proxy lists downstream tools through one endpoint | **PASS** | Peta connected to mock, auto-discovered both tools; client saw them (names exposed as `read_thing_-_N`, **not** `serverId::tool` as the internal docs imply) |
| A2 | Per-**tool** authz enforced server-side at call time | **PASS (decisive)** | `reader`'s tool list omits `write_thing`; calling it by its **real** name returns `-32602 "Permission denied for tool"` and `write_thing` executed **0** times. Denial is by identity permission regardless of what the caller requests — the injection-containment property. |
| A3 | Pre-execution human approval (dangerLevel 2) | **PASS (both paths)** | Call **blocked**; durable PENDING approval created (identity, tool, args, 10-min expiry, resumeToken). **APPROVED** → executes exactly once (writes=1, record `EXECUTED`). **REJECTED** → client gets `isError` "rejected by administrator", writes stays 1 (no execution). Fail-closed by construction. |
| A4 | Credential custody (secret injected server-side, never held by client) | **PASS** | Mock made to require a secret header (401 without it). Secret placed in Peta's **encrypted** `launchConfig`. Token-only `writer` (no secret) calls the tool → **succeeds** (Peta injected it downstream); secret appears **0×** in logs; `launchConfig` is ciphertext at rest. |

## Red-team (R1–R6) — contained
- **R1 injection → unauthorized tool: CONTAINED** (= A2). The gateway blocks by identity permission below the LLM; a session cannot call a tool it isn't granted, regardless of prompt content.
- **R2 approval-gate bypass: CONTAINED (by design).** Only an explicit `APPROVED` decision executes; PENDING/REJECTED never do; requests carry an expiry. *(Wall-clock expiry not tested; deny path proven.)*
- **R3 secret exfiltration: MOSTLY CONTAINED — 1 finding.** Downstream secrets never reach client/logs (A4). **But** `GET_OWNER` (action 1016) is **unauthenticated** and returns the owner's `encryptedToken`; `GET_USERS` returns every user's. The blob is AES-GCM/PBKDF2-encrypted under a high-entropy token (hard to brute), but unauthenticated exposure is needless attack surface. *(See F3.)*
- **R4 cross-identity isolation: CONTAINED.** Each token resolves only to its own user's permissions (`userId = SHA-256(token)[:32]`); acting as another identity requires that identity's token. Maps to Alden's per-identity boundary via per-user policy (not crypto) — as the design anticipated.
- **R5 SSRF via OAuth client-metadata URL: CONTAINED.** Internal-IP metadata URLs rejected (HTTPS required; private-IP fetch errors). **Caveat:** with `OAUTH_CLIENT_METADATA_ALLOW_FAKE_IP`, verify Tailscale `100.x` if you ever use URL-based client metadata (normal DCR is unaffected).
- **R6 management unreachable from a session: PASS.** A non-admin (`reader`) token calling `/admin` GET_USERS and attempting CREATE_USER both rejected (`success:false`). `/admin/*` requires Owner/Admin; `/mcp` + `/user` are separate. This satisfies the privilege-tiering requirement.

## Security audit (focused, evidence-based — not an exhaustive formal review)
Vault read at source (`src/security/CryptoService.ts`); policy/approval validated behaviorally; mechanical checks run.

| ID | Severity | Finding |
|---|---|---|
| F1 | **HIGH (mitigable)** | Supported deploy (`docs/docker-deploy.sh`) runs peta-core as **root with `/var/run/docker.sock` mounted** to spawn stdio child-containers ⇒ container compromise ≈ host takeover. **Mitigation (confirmed working):** the image default is **non-root (`USER nodejs`)**; Alden uses only remote/HTTP downstreams, so run **non-root, no socket** (as this eval did). Only stdio `CustomStdio` servers need the socket — avoid them. |
| F2 | **MED** | **17 dependency vulns (10 high, 7 moderate)**, incl. `ws` uninitialized-memory disclosure via the `engine.io`/`socket.io-adapter` stack. `npm audit fix` resolves them; upstream hasn't bumped. Patch before trusting; re-check each release. |
| F3 | **MED** | `GET_OWNER` (1016) is **public/unauthenticated** and returns the owner record incl. `encryptedToken`; `GET_USERS` returns all users' encrypted tokens. Encrypted (PBKDF2 100k + AES-256-GCM under the token), so not plaintext, but restrict network exposure (LAN/Tailscale only — already your model) and treat as offline-attack surface. |
| F4 | **LOW** | Maturity smells: CLAUDE.md states test infra "not yet set up"; error logging serializes strings into char-indexed objects (`{"0":"C",...}`); admin failures return `success:false` with `error:null`. Reinforces "young, ~2-dev, AI-authored" — none block adoption, but argue for pinning a known-good image and a deeper formal review before high-trust production. |
| — | **PASS** | **Vault crypto is sound:** PBKDF2 (100k, SHA-256) → AES-256-GCM, random 16-byte salt + 12-byte IV per op, auth-tag verified on decrypt, keys never written to disk. Standard WebCrypto, no obvious flaw. (Stale "MD5" comment; actually SHA-256.) |
| — | **PASS** | **Policy enforcement is server-side, at call time, fail-closed** (A2/A3 behavioral proof: `-32602 Permission denied`, denied/pending calls never execute). |

## Answers to the four sharp questions (§6)
1. **Is peta-core trustworthy enough to hold keys?** Vault and policy/approval cores are sound; no critical flaw found. Risks are operational (F1), dependency hygiene (F2), and maturity (F4) — all mitigable. **Conditional yes**, with the checklist below + a deeper formal review before high-trust production if you want belt-and-suspenders.
2. **Can the policy gate on an external per-call signal (taint-by-presence)?** Not natively — `dangerLevel` is **static per-tool** (0/1/2). So Alden's "gate ALL writes" maps natively (mark write tools `dangerLevel:2`); the taint-by-presence *refinement* must live in the Alden control plane (compute taint, and either keep writes always-gated or toggle the tool's danger level per session). No DSL hook for an external signal was found.
3. **Does identity = Peta user scale cleanly?** **Yes.** One Alden identity = one Peta user; per-user × per-tool permissions enforce scoping (A2), and users are scriptable via the `/admin` API without the closed Console (this eval created Owner + 2 users + a server entirely via API). The closed Peta Console is **not required**.
4. **Tailscale × SSRF guard?** Private-IP SSRF block works (R5). Only URL-based OAuth client metadata is affected; verify `100.x` behavior there if used. Not a blocker.

## Hardening checklist for adoption (do these when wiring the real stack)
1. Run peta-core **non-root, without the docker.sock mount**; use only **remote/HTTP** downstreams (Bridge, Qdrant, Obsidian-MCP). Avoid `CustomStdio`.
2. `npm audit fix` (or pin a patched image) and re-audit each upgrade.
3. Keep the gateway **LAN/Tailscale-only** (already your model); never expose `/admin` or `GET_OWNER` publicly. Do **not** enable Cloudflared or anonymous `/mcp/public`.
4. Map **identity → Peta user**; mark every write-scoped tool `dangerLevel:2`; drive approvals via the admin API (9201/9203) and/or Peta Desk on the tailnet.
5. Implement taint-by-presence in the Alden control plane (Peta won't do it natively).
6. Strong, unique Peta access tokens per identity (token entropy is the whole of auth).
7. Before high-trust production: a deeper formal review of `src/oauth/*` and the proxy enforcement path (`src/mcp/core/ProxySession.ts`), plus basic regression tests.

**Bottom line:** Peta does, in real code on real hardware, what the docs claimed — single gateway, server-side per-tool authz that contains injection, a durable human-approval gate, and server-side credential custody. It punches above its 52 stars. Adopt it for Alden's trust core with the hardening above; revisit Bifrost only if F2/F4 prove unacceptable.

*End of results.*
