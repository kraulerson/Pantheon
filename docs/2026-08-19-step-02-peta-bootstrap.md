# Step 2 — Peta hardened bootstrap: what was created (2026-08-19)

Record of the production Peta bootstrap on VM 1093. **No tokens appear here or in git** —
they live only in `services/control-plane/.env.local` (0600) and
`peta-eval/harness/state.json` (0600, gitignored) on the VM.

## Done

| Item | Result |
|---|---|
| Peta reachable | `127.0.0.1:3002` → 200, container healthy |
| **ADR-0003 posture** | runs as **`nodejs`** (non-root); **no `docker.sock`** mount; published **only** to `127.0.0.1:3002` — verified by `docker inspect` |
| **Owner minted** | `name: owner`, `role: 1`, userId `1f0a8942…`. Token written to `.env.local` as `PETA_ADMIN_TOKEN` with `PETA_URL=http://127.0.0.1:3002`; authenticated `GET_USERS` (action 1011) returns the owner — auth proven |
| **Identity user** | `alden-1`, `role: 3`, `permissions: "{}"` — deny-all by default |
| **Deny-by-default proven** | `client alden-1 list` → `TOOLS: []`. The identity is granted nothing and can see nothing |
| Downstream registered | `alden-bridge` → `http://10.100.23.88:8765/mcp`, HTTP transport (never `CustomStdio`) |

## Not done, and why

- **The bridge server will not start: HTTP 401 from the bridge.** The harness VM has no
  `BRIDGE_MCP_*` credentials — `.env.local` was generated fresh during step 1 and those entries
  were never added, so the registration carried an empty bearer. The bridge was right to refuse.
- **The charter's `-32602` denial evidence is NOT yet captured.** Calling an ungranted tool today
  returns **`-32601` (tool not found)**, because no downstream is running and therefore no tool
  exists to deny. `-32601` and `-32602` are different claims: "there is no such tool" is not
  "you may not use this tool". The acceptance box needs the second one, so it needs a live
  downstream with an ungranted tool.
- **Per-tool grants not set.** The exact `permissions` JSON shape Peta expects is not documented
  in the eval records (it round-trips as a JSON *string*; owner and `alden-1` both show `"{}"`).
  Determine it empirically against a live server before writing grants — guessing the shape risks
  writing a permission set that silently grants more than intended.
- **obsidian-mcp is not a candidate downstream yet** — `services/obsidian-mcp` has `src/` and
  `test/` but no `dist/`; it has never been built or deployed.

## The decision this is blocked on

Supplying the bridge credential means one of:

1. **Copy the household bridge token to the VM.** Fastest. It is a deliberate credential
   fan-out: rotation becomes a multi-host job (BUG-010's lesson), and Peta keeps its own
   encrypted copy once the server starts.
2. **Mint a VM-specific bridge token.** Cleaner blast radius, but the bridge is the alden-infra
   session's territory and may only support a single shared token — needs their input.
3. **Build and run our own obsidian-mcp as the skeleton downstream.** No household credential at
   all, and it is cutline work we owe anyway (#8) — but it is a build, not a config step, and the
   framework's test gate currently wants a UAT session before the next feature.

## Driver changes made to get here

`peta-eval/harness/peta.mjs` gained `MCP_HEADERS` (JSON auth headers, read from the environment so
a token never reaches argv) and `MCP_SERVER_NAME` (it hard-coded every registered server as
"Mock MCP" — wrong for a production instance). The eval path is unchanged when both are unset.
