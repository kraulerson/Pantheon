# UAT Session 1 — Triage: Task #16 DevMachine registry + SSH backend

**Date:** 2026-06-14
**Target:** Phase 2 construction, features `devmachine-registry` (a) + `devmachine-ssh-connection` (b), uncommitted working tree.
**Sweep type:** automated UAT — full suite + coverage, plus one Phase 2.7 adversarial ("malicious user") review agent against the new SSH/registry code (the TM-020 SEV-1 surface).
**Live UAT:** the operator-at-keyboard live provisioning + SSH connect is DEFERRED (human-test template generated separately); this triage covers the automated portion only.

## Per-source verdicts

| Source | Scope | Verdict | Headline |
|---|---|---|---|
| Automated suite + coverage | All 232 tests, v8 coverage | **ship** | 230 pass / 2 guarded-live skipped; 99.08% stmt, 92.8% branch |
| Adversarial agent (Phase 2.7) | `src/devmachine/*`, registry DevMachine CRUD, `/api/dev-machines`, config-page section | **fix-then-ship** | No key-leak path; found 1 invariant-break (forgeable provisioned state) + input-validation hardening gaps |

## Issues, ranked by severity

### S1 — fix-in-branch
**1. `provisioned` / `sshKeyHandle` are forgeable via the admin `PUT /api/dev-machines/:id`.**
Source: agent #6. `DevMachinePatch` includes `provisioned` + `sshKeyHandle`, and the generic update route passes the body straight through, so an admin-token holder can `PUT {"provisioned":true}` on a machine whose key was never installed — breaking invariant #4 ("provisioned only after `ssh-copy-id` succeeds"). `connectTerminal` would then attempt key-only SSH against a machine the operator believes is legitimately provisioned.
Action: remove `provisioned`/`sshKeyHandle` from the generic patch; add a dedicated `markProvisioned(id, handle)` used only by `provisionAndRecord`. Complexity: medium.

### S2 — fix-in-branch
**2. SSH `user` (and `logicalName`) allow a leading `-` → `ssh`/`ssh-copy-id` option injection.**
Source: agent #1. `USER_RE`/`LOGICAL_NAME_RE` = `/^[A-Za-z0-9._-]+$/` accept `-oFoo`, `-v`, etc. The user is spliced into `${user}@${host}` and passed to `ssh-copy-id`/ssh2; a leading dash is argv/option-confusion. (`=`, space, `/` are already blocked, so it is not a clean RCE — but the code comment claims "safe to pass to ssh," and it is admin-reachable.) Action: forbid a leading dash (`/^[A-Za-z0-9_][A-Za-z0-9._-]*$/`). Complexity: small.

**3. Registry `sshKeyHandle` validator allows `/` and `..` → traversal fail-open in the advertised custody guard.**
Source: agent #2. `KEY_HANDLE_RE` permits `/` and `:`, so `"../../etc/passwd"` passes `assertKeyHandle`. Today `FileKeyCustody`'s stricter inner `HANDLE_RE` (no `/`) re-rejects it, so it is not end-to-end exploitable — but the registry validator is the one documented as the TM-020/#14b custody guard, and it fails open; a future vault backend treating the handle as a path/URL would inherit a traversal/SSRF. Action: align the registry handle grammar to the filename-safe custody grammar (`^[A-Za-z0-9._-]+$`). Complexity: small (+ update 2 tests that used `vault:ssh/...`).

### S3 — fix-in-branch
**4. Stale `provisioned=true` after a connectivity-field edit.**
Source: agent #7. Editing `host`/`port`/`user` leaves `provisioned=true` though the new host has no key. Action: reset `provisioned=false` + clear `sshKeyHandle` whenever host/port/user change. (Folds into fix #1.) Complexity: small.

**5. Custody private-key permission check follows symlinks and has a TOCTOU window.**
Source: agent #3. `resolvePrivateKey` `stat()`s (follows symlinks) then separately `readFile()`s. A symlink to an attacker 0600 file passes; the stat→read gap is TOCTOU. Action: `lstat` + refuse symlinks, then open a handle and `fstat` it, reading via the same fd. Complexity: small. (Single-operator host ⇒ low real risk, but custody is the crown jewel.)

### S4 — fix-in-branch
**6. `storeKeyPair` umask window; key dir mode not re-enforced.**
Source: agent #4. `writeFile(mode:0o600)` is umask-masked and an existing looser file keeps its mode until the follow-up `chmod`. Action: open a fresh handle, `fchmod 0o600` before writing bytes; `chmod` the dir to `0o700`. Complexity: small.

### S5 — accept-as-is (pre-existing, repo-wide)
**7. Config-page HTML forms post `application/x-www-form-urlencoded` but no body parser is registered, so `port` would arrive as a string (rejected) if the form were the real client.**
Source: agent note. This affects ALL config forms (backends/endpoints/MCP), not just DevMachine — it predates this feature; the real client is the JSON API. Not a security issue. Action: file as a follow-up (config-page progressive-enhancement / `@fastify/formbody`), out of scope for Task #16.

## What demonstrably works (confirmed, not merely un-disproven)

- **No private-key leak path found.** The key stays in a closure in `connectTerminal`, is never placed on the `TerminalSession`, never logged, and never embedded in `ProvisioningError`/`SshConnectionError`. Only the public key (a `.pub` scratch file) is passed to `ssh-copy-id`; tests assert the private PEM is in no command args.
- **Shell injection is closed.** `ChildProcessRunner` spawns `shell:false` + argv; no shell line is built.
- **Fail-closed writes confirmed.** Validate-before-write on create/update; `provisionAndRecord` updates the registry strictly after provisioning resolves (no partial write).
- **Config page is XSS-safe and never renders `sshKeyHandle`.**
- **Numeric/whitespace edge cases hold.** `assertPort` rejects `NaN`/strings/floats; `.trim()` + end-anchored regexes reject embedded newlines/whitespace on host/user/logicalName/handle.
- **230/232 tests pass; 99.08% statements, 99.24% functions.**

## Ship decision

**Fix-then-ship.** Fix S1–S4 (issues 1–6) in this branch, test-first, before the commit — they are all small/medium, all on the SEV-1 TM-020 surface, and #1 breaks a stated invariant from the admin API. Accept S5 (issue 7) as a pre-existing repo-wide item to file as a follow-up. No issue blocks merge once 1–6 land green. The live operator-at-keyboard UAT (provisioning + SSH round-trip) remains deferred and gates the *next* feature, not this commit.

## Resolution (2026-06-14, same session, pre-commit)

All S1–S4 items fixed **test-first**, all 236 tests green, tsc + lint clean:

| # | Sev | Fix |
|---|---|---|
| 1 | S1 | `DevMachinePatch` no longer carries `provisioned`/`sshKeyHandle`; added `RegistryService.markProvisioned(id, handle)` as the **sole** setter; `provisionAndRecord` now calls it. The admin `PUT` route can no longer forge provisioned state. Tests: registry `markProvisioned` + HTTP `PUT cannot forge provisioned`. |
| 2 | S2 | `USER_RE`/`LOGICAL_NAME_RE` now forbid a leading `-` (`/^[A-Za-z0-9_][A-Za-z0-9._-]*$/`). Test: rejects logicalName/user beginning with `-`. |
| 3 | S2 | `KEY_HANDLE_RE` tightened to filename-safe `^[A-Za-z0-9._-]{1,128}$` (no `/`/`:`/traversal), matching the custody grammar. Test: rejects handle with separators/traversal. |
| 4 | S3 | `updateDevMachine` resets `provisioned=false` + clears `sshKeyHandle` when host/port/user changes. Tests: reset-on-host-change; keep-on-enabled-change. |
| 5 | S3 | `FileKeyCustody.resolvePrivateKey` opens with `O_NOFOLLOW` (refuses symlinks) and checks mode via `fstat` on the same fd (closes the stat→read TOCTOU). Test: refuses a symlinked key. |
| 6 | S4 | `storeKeyPair` opens the file and `fchmod 0600` **before** writing key bytes, and re-`chmod`s the key dir to `0700` (umask/pre-existing-mode proof). Existing 0600 + group/world-readable-refusal tests still pass. |
| 7 | S5 | **Deferred** — config-page HTML forms posting urlencoded (no body parser) is pre-existing and repo-wide (all config forms); filed as a follow-up. Not security. |

Ship decision honored: fix-then-ship complete for 1–6; 7 deferred. The live operator-at-keyboard UAT (provisioning + SSH round-trip) remains the gate for the *next* feature.

**2026-06-14 — gate decision:** the Orchestrator accepted the automated UAT (236 tests + adversarial sweep + remediation) and directed continuing to sub-task (c). The test-gate batch counter was reset on that basis. The live verification was deferred to the keyboard.

## Live UAT executed — 2026-06-15 — PASSED

Run from the Pantheon host (Mac mini, `192.168.1.192`) against a real remote dev machine
**`linux-box` = `192.168.1.202`** (user `karl`, Linux `7.0.0-22-generic`). The other candidates were
unavailable (`.78` powered off; `.190` MacBook had Remote Login off; `.192` is the host itself).

| # | Scenario | Result |
|---|---|---|
| Register | `register-devmachine --name linux-box --host 192.168.1.202 --user karl` | ✅ row created, `provisioned=0` |
| Provision | `provision-devmachine linux-box` | ✅ harness pubkey installed via `ssh-copy-id -f`; `provisioned=1`. **No password prompt** (operator's existing key let copy-id in). |
| Key-only auth | `ssh -i custody/harness … karl@192.168.1.202` | ✅ `HARNESS_KEY_OK` (key-only, no password) |
| ssh2 broker round-trip | `devmachine-ssh.live.integration.test.ts` (guarded) | ✅ PTY opened, `echo` round-tripped |
| **Full server → WS → PTY** | running `npm start`, WS client → `/terminal/linux-box` (bearer auth) | ✅ `ready` frame + session id; sent `echo …$((1+1))`, got back `…_2` — **a real remote shell evaluating**, through the guarded WS route → `connectTerminal` → real PTY |

**Bug found & fixed (the value of live testing):** macOS `ssh-copy-id -i foo.pub` strips `.pub` and
demands the private key beside it (which we keep in custody, never in scratch) → provisioning failed.
Fixed test-first with `-f` (commit `95c754a`). Re-ran: green.

**Outcome:** Task #16 verified working end-to-end against a real remote machine. The Mac mini now has a
working control-plane + provisioned `linux-box`. Remaining for production are the tracked follow-ups
(browser session auth for #9, CSP, LibreChat/Peta deploy, token rotation) — none are Task #16 defects.
