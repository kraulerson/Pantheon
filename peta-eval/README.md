# Peta Live-Evaluation Artifacts

Preserved from the June 2026 live evaluation of Peta (`dunialabs/peta-core`) that led to
its adoption as the trust-core gateway (ADR-0001, ADR-0003). The full eval narrative and
results (scenarios A1–A4, R1–R6) are in
[`docs/reference/ALDEN-HARNESS-CLI-HANDOFF.md`](../docs/reference/ALDEN-HARNESS-CLI-HANDOFF.md).

These artifacts exist so the eval can be **re-run against the production stack in
Phase 4** of the Alden future-state build plan ("re-run the eval's A1–A4 + R1–R6 on the
real stack").

## Contents

- `harness/peta.mjs` — the eval driver (admin provisioning, per-identity tokens, tool-call scenarios)
- `harness/mock-server.mjs` — mock MCP downstream used to observe what Peta forwards/blocks
- `harness/package.json` / `package-lock.json` — pinned deps; `npm ci` to restore
- `deploy/docker-compose.yml` — the eval deployment topology (secrets via env vars, no values committed)

## Deliberately NOT committed

- `state.json` / `writes.log` — runtime artifacts containing eval-instance tokens (gitignored)
- `.env` — eval deployment secrets (gitignored)
- the `peta-core/` upstream clone — re-clone from `dunialabs/peta-core` when needed;
  original eval copy remains on disk at `../../peta-eval/peta-core/` (outside this repo)
