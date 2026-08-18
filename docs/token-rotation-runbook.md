# Token Rotation Runbook — the two passwords (Karl-facing)

**Written 2026-08-17** after the non-credential remediation steps executed. These are
the ONLY two remaining items from `security-remediation-plan-2026-07-09.md` (Steps 2,
3, plus Step 6 which unlocks after Step 2). Both tokens leaked into chat transcripts in
mid-June and are still in service. Each guide says what YOU do and what a CLAUDE
SESSION does — do them in this order, they're independent.

**Golden rule for both: the new secret value never passes through chat.** You type it
into files/UIs directly, or you sit at the keyboard while a session runs commands that
generate and install it without ever printing it.

---

## Password 1 — Gitea admin token (~10 minutes, any time)

**What it is:** the master key the harness uses to talk to your Git server
(`gitea.ferrumcorde.com`). Admin-scoped, transcript-exposed since ~June 13.

**YOU do:**
1. Log into `https://gitea.ferrumcorde.com` in your browser.
2. Click your avatar (top right) → **Settings** → **Applications**.
3. Under "Generate New Token": name it `pantheon-control-plane-2026-08`.
   Scopes: pick **write:repository** and **read:user** only (NOT admin — if something
   later fails with 403, we escalate deliberately, not preemptively).
4. Click **Generate Token**. The token shows ONCE. Leave the page open.
5. Open the file `pantheon-harness/services/control-plane/.env.local` in a text editor
   (TextEdit is fine). Find the line starting `GITEA_TOKEN=` and replace everything
   after the `=` with the new token. Save.
6. Back in the Gitea page: find the OLD token in the list and click **Delete** on it.
   (Deleting it is what actually kills the leaked credential.)
7. Tell your Claude session: "Gitea token rotated — verify and finish."

**The SESSION then does** (no values printed, status codes only):
```bash
cd pantheon-harness
NEW=$(grep -E '^GITEA_TOKEN=' services/control-plane/.env.local | cut -d= -f2-)
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: token $NEW" https://gitea.ferrumcorde.com/api/v1/user   # expect 200
unset NEW
```
Then **Step 6 (the mirror)**: you create an empty private repo named `Pantheon` in
Gitea (New Repository, NO initialization), and the session pushes `main` to it using
the transient-credential pattern in the remediation plan (§6.2) and strips the token
from the stored remote URL immediately after.

**Rollback:** if anything breaks, generate another token the same way — the old one is
gone by design and cannot be restored.

---

## Password 2 — Alden Bridge token (needs a maintenance window, ~20 minutes)

**What it is:** the password between the harness and the Aldens' message board (the
bridge on LXC 1088). Transcript-exposed since ~June 13, AND the live value sits in an
unencrypted backup file on this Mac
(`Alden-1/alden-bridge-mcp/backups/20260507-195021/alden-runtime-backup.tar.gz`) —
which is where it was recovered from in July. Changing it touches the identities' data
plane, hence the window.

**Before you start:**
- Pick a moment when no identity conversation is mid-flight (check the bus is quiet).
- Post a one-line notice to the bus (a session can do it): "Bridge token rotation in
  progress, brief restart ahead."
- Since the Phase 0–4 restructure, the alden-infra session owns that container's
  layout — if it is running, tell it the rotation is happening; its Phase 0 deploy may
  have moved the config file the old plan pointed at.

**YOU do (with a session at the keyboard sharing the work):**
1. Confirm SSH works: the session runs `ssh root@192.168.1.20 true` (your Proxmox node).
2. The session FINDS the bridge's token config (filenames only, never values):
   ```bash
   ssh root@192.168.1.20 "pct exec 1088 -- grep -rl 'BRIDGE_AUTH_TOKEN' /opt/alden-bridge --include='*.env' -s"
   ```
   If nothing is found: STOP — the restructure moved it; ask the alden-infra session
   where the bridge env now lives. Guessing is how data planes break.
3. The session backs the file up in place, then generates and installs the new value
   on BOTH sides in one breath, never printing it (remediation plan §3.3 commands):
   new 48-hex token → into the bridge's env file via sed over SSH → into
   `services/control-plane/.env.local` on this Mac via sed.
4. The session restarts the bridge and confirms it's active:
   ```bash
   ssh root@192.168.1.20 "pct exec 1088 -- systemctl restart alden-bridge && pct exec 1088 -- systemctl is-active alden-bridge"
   ```
5. **Smoke test (the golden rule):** the session sends a test message to Alden-1 over
   the bus and confirms a reply comes back. If the identities cannot talk: restore the
   backup file, restart the bridge, verify talk works, THEN diagnose.
6. **NEW — close the old exposure paths** (added 2026-08-17; the old plan misses this):
   - Delete or encrypt the backup tarball on this Mac that contains the OLD token:
     `Alden-1/alden-bridge-mcp/backups/20260507-195021/` (the old token is now dead,
     but the file also holds a dossier + conversation log — move it somewhere
     encrypted or into Trash deliberately, your call).
   - If the claude.ai "Alden Bridge" connector stores the old token, update it there
     too (claude.ai → Settings → Connectors), or it will silently stop working.
7. Tell the session "rotation done" — it updates `.env.local`-dependent checks, runs
   the final remediation checklist, and records everything in APPROVAL_LOG (Step 9),
   including the vault notes.

**Rollback:** the timestamped `.bak` file inside the container + a bridge restart puts
the old token back in service; the Mac-side `.rotbak` restores the client copy.

---

## After both rotations (the session finishes Step 9)

APPROVAL_LOG rows for Steps 2/3/6; vault decision-doc notes (Decision A mirror live;
I2 eval folder DONE); memory updated (26-day → now 60+-day rotation debt CLOSED);
final verification checklist from the remediation plan run top to bottom.
