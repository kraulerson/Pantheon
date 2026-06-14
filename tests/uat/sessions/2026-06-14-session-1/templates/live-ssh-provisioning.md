# UAT Session 1 — Human Test Template: Live SSH Provisioning + Connect

**Tester:** _____________  **Date:** __________  **Build:** Task #16 a/b (uncommitted → committed baseline)

This is the **operator-at-keyboard** portion of UAT-1 — the automated portion (236 tests + adversarial
sweep) is already done. Run these on the Pantheon host (or your dev Mac) with network access to the
dev machines. You'll type each machine's password **once** during provisioning.

Prereqs:
- `cd services/control-plane && npm ci && npm run build`
- `ssh-keygen` + `ssh-copy-id` present (macOS/Debian have them).
- Decide a custody dir + DB path, e.g. `export PANTHEON_KEY_DIR=~/.pantheon/keys PANTHEON_DB=$PWD/data/control-plane.db`

| # | Scenario | Steps | Expected | Pass/Fail | Notes |
|---|---|---|---|---|---|
| 1 | Register a dev machine | Add a DevMachine row (Config page when the app runs, or seed the DB) with logicalName `mac-studio`, host `192.168.1.192`, user `<you>`, port 22 | Row exists, `provisioned=false`, `sshKeyHandle=""` | ☐ | |
| 2 | First provision (keypair gen + ssh-copy-id) | `node dist/cli/provision-devmachine.js mac-studio` | Prompts for the machine password **once**; prints `✓ … provisioned`; key dir `~/.pantheon/keys` now holds `harness` (0600) + `harness.pub`; the registry row shows `provisioned=true` | ☐ | |
| 3 | Key-only reconnect (no password) | `PANTHEON_LIVE_SSH_HOST=192.168.1.192 PANTHEON_LIVE_SSH_USER=<you> npx vitest run test/devmachine-ssh.live.integration.test.ts` | Test passes; the terminal round-trips `PANTHEON_LIVE_OK`; **no password prompt** | ☐ | |
| 4 | Second machine | Repeat 1–3 for `linux-box` / `192.168.1.78` | Re-uses the **existing** harness keypair (CLI prints no new keygen); still asks that machine's password once | ☐ | |
| 5 | Provisioning fails cleanly | Provision a machine with a wrong/unreachable host or cancel the password prompt | CLI exits non-zero with a clear message; registry row stays `provisioned=false` | ☐ | |
| 6 | Custody perms | `ls -l ~/.pantheon/keys` | `harness` is `-rw-------` (0600); dir is `drwx------` (0700) | ☐ | |
| 7 | Re-point resets trust | Edit `mac-studio`'s host to a different IP via the API/Config page | Row flips back to `provisioned=false`, `sshKeyHandle` cleared (re-provision required) | ☐ | |

**Result:** ☐ All pass → live UAT gate can be closed (`scripts/process-checklist.sh` UAT steps → `--reset-counter`).
Any SEV-1/2 failure → file in the bug tracker and stop the next feature until fixed.

**Notes / bugs found:**
