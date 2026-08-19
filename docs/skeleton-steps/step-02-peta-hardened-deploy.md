# Step 2 — Peta, hardened: bootstrap owner + identities (charter item 2)

**Commit type: `build:`** (config/records only — never commit tokens).
**Preconditions:** step 1 done (stack running; `peta-core` is up on `127.0.0.1:3002`).

## Goal

A production Peta with: an owner minted, one Peta user per identity, downstream MCP
servers registered over HTTP only, and the hardening posture verified. Peta v1.2.2
pinned (never `:latest`; digest-pin after first pull — deploy/README.md).

## Background you must not skip

Peta has no open-source console; tokens are minted via its `/admin` API. The repo
already contains the proven driver: `peta-eval/harness/peta.mjs` (PBKDF2/AES-GCM
crypto replicated; `userId = SHA-256(token)[:32]` — **token entropy IS auth**). The
eval flow is the template; you are re-running it against the production instance with
fresh tokens. NEVER reuse eval tokens (they are transcript-exposed — security review F1/F2).

## Do

1. On the VM: `cd peta-eval/harness && npm ci`.
2. Point the driver at production: `export PETA_BASE=http://127.0.0.1:3002`.
   The driver persists state to `state.json` (gitignored) — treat it as a secret file;
   `chmod 600 state.json` after each command.
3. **Mint the owner:** `node peta.mjs create-owner` → records `ownerToken` in
   `state.json`. Copy it ONLY into `services/control-plane/.env.local` as
   `PETA_ADMIN_TOKEN` (and set `PETA_URL=http://127.0.0.1:3002`). Never into chat,
   never into a doc, never into git.
4. **Register downstream MCP servers** (HTTP/streamable ONLY — never `CustomStdio`,
   Bible §11). **Corrected 2026-08-19:** the driver does NOT take a URL argument — it reads
   `MOCK_URL`, and auth headers come from `MCP_HEADERS` (added during step-2 execution, so a
   token never appears in argv/the process list). The real invocation is:

   ```
   export MOCK_URL=http://10.100.23.88:8765/mcp
   export MCP_HEADERS='{"Authorization":"Bearer <token from a 0600 env file>"}'
   export MCP_SERVER_NAME='Alden Bridge'
   node peta.mjs register-server alden-bridge
   ```

   Downstreams: the Alden Bridge (`http://10.100.23.88:8765/mcp`) and obsidian-mcp
   (`http://127.0.0.1:<its-port>/mcp` once its unit is enabled — **not built yet**: the
   service has `src/` but no `dist/`). Set capabilities via `set-caps` as the tools require.

   **Credential decision this forces (open, 2026-08-19):** the bridge authenticates with a
   token the harness VM does not have — the VM's `.env.local` was generated fresh in step 1
   with no `BRIDGE_MCP_*` entries. Supplying it means either copying the household bridge
   token to a second host (a deliberate credential fan-out — BUG-010's lesson is that
   rotating it then becomes a multi-host job, and Peta stores a copy too), minting a
   VM-specific bridge token (needs the alden-infra side), or using our own obsidian-mcp as
   the skeleton downstream instead (no household credential, but it must be built first).
   **Do not resolve this by quietly copying the token.**
5. **Create one Peta user per identity:** `node peta.mjs create-user <identity> <permsJSON>`
   with per-tool grants per the ToolClassification rules (Bible §5: every send-type
   tool — `converse`, `alden_mailbox_write`, `alden_queue_message`, `alden_share_write`,
   `gitea_file_write`, `alden_memory_store`, Obsidian writes — is `isWrite=true` ⇒
   `dangerLevel:2` Approval). For the skeleton: one user, `alden-1`.
6. Record what was created (names, userIds, grants — NEVER tokens) in a dated note
   under `docs/`, commit as `build:`.

## Verify

- `docker inspect pantheon-peta-core-1 --format '{{.Config.User}}'` → non-root
  (`nodejs`). `docker inspect ... | grep -i docker.sock` → nothing.
- From the VM: `curl -s -X POST 127.0.0.1:3002/admin -H "Authorization: Bearer $PETA_ADMIN_TOKEN" -d '{"action":1011}'`
  → owner listed. From ANOTHER machine: same call against `<vm-ip>:3002` → connection
  refused (TM-007/M2 — this must fail).
- MCP call as the identity user succeeds for a granted read tool; an ungranted tool
  returns `-32602` (the write-evidence pattern from `peta-eval/harness`).

## Rollback

`docker compose down peta-core peta-postgres` + delete the `peta_pg` volume = factory
reset (only safe pre-skeleton). Token rotation = re-mint + update `.env.local`.

## Acceptance mapping

Prerequisite for the smoke test (`-32602` denial item + the gated-write item both run
through this Peta).
