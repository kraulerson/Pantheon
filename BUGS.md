# Bug Tracker

<!--
  This file tracks bugs found during UAT sessions and ad hoc testing.
  Status and severity patterns are read by scripts/test-gate.sh for phase gate checks.
  Do NOT change the table format — the column order and status values are parsed by scripts.
-->

> **Index policy (decision H1, 2026-07-09 — APPROVAL_LOG ruling):** this table is the
> canonical bug **index**; each row links to the UAT triage file holding the full
> evidence. Rows 1–7 backfilled from
> `tests/uat/sessions/2026-06-14-session-1/TRIAGE.md` (found by the Session 1
> adversarial sweep, fixed test-first the same session unless noted).

| # | Severity | Status | Feature | Description | Session | Disposition | Fix Reference | Verified In |
|---|---|---|---|---|---|---|---|---|
| 1 | SEV-2 | Fixed | devmachine-registry | Admin `PUT /api/dev-machines/:id` could forge `provisioned`/`sshKeyHandle` (invariant break); patch fields removed, dedicated `markProvisioned()` is the sole setter | Session 1 | Fix Now | 8caed24 | Session 1 |
| 2 | SEV-2 | Fixed | devmachine-registry | SSH `user`/`logicalName` regex accepted a leading `-` → ssh/ssh-copy-id option injection; leading dash now forbidden | Session 1 | Fix Now | 8caed24 | Session 1 |
| 3 | SEV-2 | Fixed | devmachine-registry | `KEY_HANDLE_RE` allowed `/` and `..` — traversal fail-open in the advertised custody guard; tightened to filename-safe grammar | Session 1 | Fix Now | 8caed24 | Session 1 |
| 4 | SEV-3 | Fixed | devmachine-registry | Editing host/port/user left stale `provisioned=true`; now resets provisioned state and clears the key handle | Session 1 | Fix Now | 8caed24 | Session 1 |
| 5 | SEV-3 | Fixed | devmachine-ssh-connection | Key custody `resolvePrivateKey` followed symlinks with a stat→read TOCTOU window; now `O_NOFOLLOW` + `fstat` on the same fd | Session 1 | Fix Now | 8caed24 | Session 1 |
| 6 | SEV-3 | Fixed | devmachine-ssh-connection | `storeKeyPair` umask window / loose dir mode; now `fchmod 0600` before writing bytes + key dir `0700` | Session 1 | Fix Now | 8caed24 | Session 1 |
| 7 | SEV-4 | Fixed | config-page | HTML forms posted urlencoded with no body parser registered (pre-existing, repo-wide); `@fastify/formbody` registered with the #9 auth work | Session 1 | Defer | bd5cb10 | — |
| 8 | SEV-3 | Fixed | control-plane (dev deps) | `vitest 3.2.4` pinned in `services/control-plane` matches GHSA-5xrq-8626-4rwp (critical-rated: file read/exec, but only when the Vitest **UI server** runs — we never run `--ui`, so dev-only exposure). Fixed 2026-08-17 with the remediation pass: vitest+coverage 3.2.7 exact-pinned in control-plane AND obsidian-mcp; `npm audit fix` cleared 5-week transitive backlog (@hono/node-server, body-parser, brace-expansion, esbuild); both services 0 vulnerabilities, 295+24 tests green | ad hoc (2026-07-09) | Fix Now | see 2026-08-17 remediation commit | — |
| 9 | SEV-3 | Fixed | deploy (install-debian.sh) | `npm ci` cannot install the committed `services/control-plane/package-lock.json` under **npm 10** — `@types/better-sqlite3` and `@types/ws` declare `@types/node: *`, which npm 10 re-resolves to the current latest (26.2.0 + undici-types 8.3.0) and then rejects the lockfile for missing those entries; npm 11 dedupes them to the locked 20.17.6 and installs clean. The installer pinned NodeSource `setup_20.x`, and Node 20 ships npm 10.8.2 → the deploy target could never build. Reproduced both ways on VM 1093 (npm 11.19.0 exit 0 / npm 10.8.2 exit 1). Fixed by raising the installer floor to Node 24 (ships npm 11) — which also lifts the host off a runtime that left security support 2026-04-30 (ADR-0002 amendment, ruling 2026-08-18). Note: `engines` still reads `>=20`, which remains true of the *runtime*; the npm ≥ 11 requirement is a lockfile property, not a runtime one | ad hoc (2026-08-18, skeleton step 1) | Fix Now | this commit | — |
| 10 | SEV-3 | Fixed | deploy (install-debian.sh) | Installer step 2 ran `npm ci && npm run build` as **root** (the script requires root for apt), leaving `~/.npm` root-owned for the service user; every later npm call by that user died `EACCES` on the cache, and the built `node_modules` were root-owned inside a user-owned checkout. Observed on VM 1093. Fixed: step 2 now drops to `$SERVICE_USER` via `sudo -u … env HOME=…` for both `npm ci` and `npm run build`, and repairs an already-root-owned `~/.npm` first so re-runs stay idempotent | ad hoc (2026-08-18, skeleton step 1) | Fix Now | this commit | — |
| 11 | SEV-3 | Fixed | deploy (install-debian.sh) | Same root cause as #10, different artifact: installer step 3 created the registry data dir (`services/control-plane/data`) as **root**, so the control-plane — which runs as `$SERVICE_USER` under the systemd units — could not create or write `control-plane.db` there. Caught on VM 1093 before first service start (dir was `root:root`, no db file). Fixed: step 3 now chowns `$DATA_DIR` to the service user alongside the existing `~/.pantheon` chown | ad hoc (2026-08-18, skeleton step 1) | Fix Now | this commit | — |

<!--
  Severity: SEV-1, SEV-2, SEV-3, SEV-4 (see PROJECT_BIBLE.md Bug Severity Classification)
  Status: Open, Fixed, Deferred, Won't Fix, Post-MVP, Removed
  Disposition: Fix Now, Defer, Won't Fix, Post-MVP (assigned during triage, Step 2.8)
  Session: UAT session number where the bug was found (e.g., "Session 4")
  Fix Reference: PR number or commit hash of the fix (e.g., "PR #12" or "abc1234")
  Verified In: UAT session number where the fix was verified (e.g., "Session 5")
-->

## Status Guide

| Status | Meaning |
|---|---|
| **Open** | Bug confirmed, not yet fixed |
| **Fixed** | Fix implemented and verified |
| **Deferred** | Tracked with justification — must be resolved or feature removed at Phase 2→3 gate |
| **Won't Fix** | Accepted as-is with documented rationale (SEV-3/4 only) |
| **Post-MVP** | Moved to post-MVP backlog (SEV-4 enhancements only) |
| **Removed** | Feature containing the bug was removed |

## Severity Guide

| Severity | Definition | Examples | Can Defer? |
|---|---|---|---|
| **SEV-1** | Data loss, security breach, app crash on core flow | Auth bypass, database corruption, crash on login | No — must fix immediately |
| **SEV-2** | Feature broken but workaround exists, significant UX failure | Form submits wrong data, layout broken on one platform | Yes — but must resolve or remove feature at Phase 2→3 gate |
| **SEV-3** | Minor UX issue, cosmetic, non-core edge case | Alignment off, tooltip truncated, rare edge case | Yes |
| **SEV-4** | Enhancement, suggestion, polish | "Would be nice if...", performance optimization | Automatic Post-MVP |
