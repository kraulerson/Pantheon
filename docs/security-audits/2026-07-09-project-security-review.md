# Project Security Review — 2026-07-09

**Reviewer:** Claude Fable 5, at the Orchestrator's direction (supersedes the earlier
plan to run this review on Opus 4.8; Opus 4.8 instead executes the remediation plan).
**Scope:** the whole pantheon-harness project — git history, working tree, dependencies,
SAST, auth implementation, key custody, deployment/exposure state, prior audit-doc
follow-ups, and threat-model deltas from the 2026-07-09 decision session. Per-feature
audit depth was NOT re-done (the seven existing docs in this folder stand).
**Method:** gitleaks 8.x (`git` full-history + `dir` working-tree, `--redact`),
`npm audit --omit=dev` (both services), semgrep `p/typescript` (ERROR+WARNING), manual
code review of `src/http/auth/*`, file-permission inspection, live container inspection,
GitHub remote inspection. **No secret values were printed at any point** (redacted
scans; env files inspected by key-name only).

## Verdicts (cleared)

| Check | Result |
|---|---|
| Git history secrets (17 commits, all refs) | **CLEAN — no leaks.** The Decision A push gate is **CLEARED**. |
| Working-tree secrets | 2 hits, both in `services/control-plane/.env.local` — the *intended* location for live secrets; untracked + gitignored. Not a defect. |
| Dependencies (`npm audit --omit=dev`) | control-plane: 0 vulnerabilities · obsidian-mcp: 0 vulnerabilities |
| SAST (semgrep p/typescript, ERROR+WARNING) | 0 findings on `services/control-plane/src/` |
| Key custody permissions | `~/.pantheon` 0700 → `keys/` 0700 → private key `harness` 0600. Correct. |
| Operator auth implementation | timing-safe comparisons throughout; 256-bit random session ids; cookie is httpOnly + SameSite=Lax, `Secure` flag config-driven; WS handshake covered by the same guard (per audit doc + code). Sound for tier-1; D6 step-up remains the tracked seam. |
| GitHub repo `kraulerson/Pantheon` | visibility **PRIVATE** confirmed. |
| Prior audit docs (7) | All PASS with tracked, non-blocking follow-ups (see F5). |

## Findings

### F1 — HIGH · Peta eval stack still running, LAN-exposed, with transcript-leaked tokens
`peta-eval-core` (`petaio/peta-core:latest`) and `peta-eval-postgres` have been **up 9+
days** on this Mac, bound to **`0.0.0.0:3002` and `0.0.0.0:5434`** — reachable from the
entire LAN, not just localhost. The instance's owner/reader/writer tokens sit in
`../peta-eval/harness/state.json` and were **echoed into session transcripts twice**
(2026-06-13 handoff; 2026-07-05 pre-commit check). Live gateway + leaked credentials +
LAN binding = the top finding. Blast radius is limited (eval instance, mock downstreams)
but non-zero (Postgres port is also exposed; `JWT_SECRET`/`DB_PASSWORD` live in
`../peta-eval/deploy/.env`).
**Remediation:** decommission the stack (`docker compose down -v`), then delete the
original `../peta-eval/` folder — this review closes decision I2's "keep as evidence"
condition. Plan step 1.

### F2 — HIGH (standing since 2026-06-13) · Gitea + Bridge tokens transcript-exposed, still unrotated
`GITEA_TOKEN` (Gitea **admin** token) and `BRIDGE_MCP_TOKEN` in
`services/control-plane/.env.local` were each exposed in earlier session transcripts and
flagged for rotation in three separate records (APPROVAL_LOG scope change, 2026-06-13
handoff, 2026-07-02 re-validation §R2). Twenty-six days open. The Gitea token is
admin-scoped on a LAN service that also hosts the identities' ratification mirror.
**Remediation:** rotate both, update `.env.local`, verify old tokens dead. Plan steps
2–3 (the Bridge step observes the Alden golden rule — maintenance window + smoke test).

### F3 — MEDIUM (process) · Repo was pushed to GitHub before the history was cleared
Decision A (2026-07-05) gated the first push on this review. The remote shows
`pushedAt 2026-07-06T15:52Z`, remote `main` = `794dcc2` — the 2026-07-06 session (Alden
ratification work) pushed the repo a day later, before any history scan. **Material
harm: none** — today's full-history scan is clean, and the repo is private. But the gate
was bypassed without a record, and the vault/memory records ("nothing pushed") were
wrong until corrected today. Remote is currently 2 commits behind local `main`.
**Remediation:** deviation recorded (APPROVAL_LOG + corrected vault/memory records,
done with this review); push the current cleared `main`; proceed with the Gitea mirror
after F2 rotation. Plan steps 5–6.

### F4 — LOW · `control-plane.db` is 0644
`~/.pantheon/control-plane.db` is world-readable by mode, though the 0700 parent
directory gates access in practice. Defense-in-depth: chmod 600 (+ `-shm`/`-wal`).
Plan step 4.

### F5 — LOW (tracked) · Pre-exposure hardening follow-ups from the feature audits
Consistent, already-tracked residuals, none blocking today, all due **at or before the
walking skeleton serves a real browser**: CSP tightening (inline bootstrap script → nonce
or served file), per-request CSRF token (defense-in-depth beyond SameSite=Lax), SSH
host-key pinning (TOFU today — required before any non-LAN terminal use), terminal WS
input-flood rate limiting, D6 passkey step-up (post-skeleton seam, unchanged). Plan
step 7 folds these into the skeleton charter so they cannot silently slip.

### F6 — INFO · Threat-model deltas from the 2026-07-09 decisions
New TM entries to write at design time (not defects today): (a) ADR-0007 — the Facade's
future machine-auth principal must be a distinct credential domain from the operator
cookie/bearer, and the admin↔Facade boundary needs a TM row; (b) ADR-0006 — the
propose-a-change flow must ensure only Karl can author/merge `alden-infra` commits
(a session or the admin service itself must never hold commit rights); (c) C.7 queue —
bound the queue depth so a flooding client cannot grow it unbounded; (d) cost-meter
ledger rows must never carry prompt content (usage counts only). Plan step 7 records
these in the skeleton charter; the TM rows land with each component's design.

## Disposition

Remediation is specified junior-dev-executable in
`docs/security-remediation-plan-2026-07-09.md`, assigned to **Opus 4.8**. The walking
skeleton freeze (Ruling C) is unaffected; nothing here is `feat:` work.
