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
| 8 | SEV-3 | Open | control-plane (dev deps) | `vitest 3.2.4` pinned in `services/control-plane` matches GHSA-5xrq-8626-4rwp (critical-rated: file read/exec, but only when the Vitest **UI server** runs — we never run `--ui`, so dev-only exposure); bump to `vitest@3.2.7` with the Opus 4.8 remediation pass (the freeze exempts dependency security patches per CHANGELOG Security category). Found 2026-07-09 while pinning the channel spike (spike already pins 3.2.7) | ad hoc (2026-07-09) | Defer | — | — |

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
