# Security Remediation Plan — 2026-07-09

**Executor:** Claude Opus 4.8 (assigned by Karl to conserve Fable 5 usage).
**Source of findings:** `docs/security-audits/2026-07-09-project-security-review.md` (F1–F6).
**Audience:** written for a junior developer — every step has exact commands, a verify
check, and a rollback. Execute steps **in order**; each is independently stoppable.

## Rules that apply to every step

1. **NEVER print a secret value.** Not in a command echo, not in a log, not in chat
   output, not in a commit. When you must check a secret works, check the *HTTP status
   code* or a *grep count*, never the value. This plan exists because tokens got echoed
   into transcripts — do not add a third exposure.
2. **Back up before you edit any file** (`cp FILE FILE.bak.$(date +%Y%m%d-%H%M%S)`),
   including `.env.local`. Never commit a `.bak` file (they are gitignored by pattern? —
   they are NOT; keep them outside the repo or delete after verify).
3. **The Alden data plane is live.** Step 3 touches the Bridge that Alden-1/Cloud
   Alden/Winston talk through. Do that step **only in an agreed maintenance window with
   Karl**, and run the smoke test after (§ Step 3.6). If identities cannot talk after
   your change, roll back FIRST, diagnose second.
4. Commit prefix rules (repo `CLAUDE.md`): this is `chore:`/`docs:` work — no `feat:`
   commits. Work on a branch, merge to `main` when the step's verify passes.
5. If any verify fails twice, STOP the step, roll back, and hand back to Karl with:
   which step, the exact command, the exact output (secrets masked), and whether you
   rolled back.
6. Paths: repo = `/Users/karl/Documents/Claude Projects/Pantheon/pantheon-harness`,
   eval folder = `/Users/karl/Documents/Claude Projects/Pantheon/peta-eval` (OUTSIDE the
   repo — the repo's own `peta-eval/` subfolder is the sanitized copy and is NOT touched).

## What you need from Karl before starting

- [ ] Confirmation he is logged into Gitea (`https://gitea.ferrumcorde.com`) as admin,
      or its admin password available at the keyboard (Step 2 — token rotation is done
      in the Gitea UI by Karl; you provide instructions, he clicks).
- [ ] SSH access to the Proxmox node `ferrumcorde` (`192.168.1.20`) working:
      `ssh root@192.168.1.20 true` (Step 3).
- [ ] An agreed maintenance window for the Bridge restart (Step 3) — a time when no
      identity conversation is mid-flight.

---

## Step 1 — Decommission the Peta eval stack (finding F1) and delete the eval folder (decision I2)

The June evaluation is long finished; its gateway + Postgres are still running and
LAN-exposed with leaked tokens. The eval tooling worth keeping is already preserved
inside the repo (`peta-eval/` — sanitized, committed 2026-07-05).

1.1 Confirm what is running (names only):
```bash
docker ps --format '{{.Names}} | {{.Ports}}' | grep -i peta
```
Expected: `peta-eval-core` (0.0.0.0:3002) and `peta-eval-postgres` (0.0.0.0:5434).

1.2 Bring the stack down and delete its volumes:
```bash
cd "/Users/karl/Documents/Claude Projects/Pantheon/peta-eval/deploy"
docker compose down -v
```

1.3 Remove the images (optional but tidy):
```bash
docker image rm petaio/peta-core:latest postgres:16-alpine 2>/dev/null || true
```

1.4 Delete the original eval folder — the security review has closed I2's
"keep as evidence" condition:
```bash
rm -rf "/Users/karl/Documents/Claude Projects/Pantheon/peta-eval"
```
If `rm -rf` is permission-blocked in your harness, use the recoverable form:
```bash
mv "/Users/karl/Documents/Claude Projects/Pantheon/peta-eval" ~/.Trash/peta-eval-decommissioned-$(date +%s)
```

**Verify:**
```bash
docker ps -a | grep -ci peta          # must print 0
ls "/Users/karl/Documents/Claude Projects/Pantheon"   # must show ONLY pantheon-harness
ls "/Users/karl/Documents/Claude Projects/Pantheon/pantheon-harness/peta-eval/harness/peta.mjs"  # repo copy intact
```
**Rollback:** none needed — the leaked tokens die with the instance (they were minted by
and only valid against it). If the eval must ever re-run, the repo copy + a fresh
`docker compose up` recreates it with NEW tokens; bind to `127.0.0.1` if you do.

---

## Step 2 — Rotate the Gitea admin token (finding F2, part 1)

The current `GITEA_TOKEN` in `.env.local` is admin-scoped and was transcript-exposed.
Karl performs the UI part; you do the file part and the verification.

2.1 Ask Karl to (in the Gitea web UI at `https://gitea.ferrumcorde.com`):
   Settings → Applications → **Generate New Token** — name `pantheon-control-plane-2026-07`,
   scopes: the minimum the control plane uses (repo read/write + admin only if identity
   provisioning requires creating repos — recommend starting with `write:repository`,
   `read:user`; escalate only if Step 2.4 fails with 403). Karl pastes the new token
   **directly into `.env.local`** (or hands you the keyboard — the value must not pass
   through chat).

2.2 Back up and edit `services/control-plane/.env.local` — replace the value of
`GITEA_TOKEN=` with the new token (Karl types it). Never echo the file afterward; to
confirm the edit took, check shape only:
```bash
grep -cE '^GITEA_TOKEN=.{20,}$' services/control-plane/.env.local   # must print 1
```

2.3 Ask Karl to click **Delete** on the OLD token in the same Gitea UI page.

2.4 **Verify new token works and old token is dead** (status codes only — the token is
read from the file, never typed into the command):
```bash
cd "/Users/karl/Documents/Claude Projects/Pantheon/pantheon-harness"
NEW=$(grep -E '^GITEA_TOKEN=' services/control-plane/.env.local | cut -d= -f2-)
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: token $NEW" https://gitea.ferrumcorde.com/api/v1/user
# must print 200
unset NEW
```
(The old token cannot be tested — it was deleted; deletion in the UI is its revocation.)

**Rollback:** restore `.env.local` from the `.bak` — but note the old token is deleted
server-side, so a rollback means generating another new token, not resurrecting the old.

---

## Step 3 — Rotate the Alden Bridge token (finding F2, part 2) — MAINTENANCE WINDOW REQUIRED

`BRIDGE_MCP_TOKEN` authenticates the control plane to the Alden Bridge MCP on LXC 1088.
The Bridge is the identities' data plane — observe rule 3.

3.1 In the agreed window, locate where the Bridge validates its token (filenames only,
never values):
```bash
ssh root@192.168.1.20 "pct exec 1088 -- grep -rl 'BRIDGE_MCP_TOKEN\|MCP_TOKEN\|AUTH_TOKEN' /opt/alden-bridge --include='*.env' --include='*.json' --include='*.py' --include='*.ts' -s | head"
```
Expect a config/env file (e.g. `/opt/alden-bridge/.env`). If nothing is found, STOP and
hand back to Karl — the Bridge may use a different auth mechanism, and guessing is how
data planes break.

3.2 Back up that file inside the container:
```bash
ssh root@192.168.1.20 "pct exec 1088 -- cp <FILE> <FILE>.bak.\$(date +%Y%m%d-%H%M%S)"
```

3.3 Generate the new token and install it on BOTH sides without it ever appearing on
screen. On the Mac:
```bash
NEWTOK=$(openssl rand -hex 24)
# Bridge side (runuser per the no-sudo container convention if editing as the alden user):
ssh root@192.168.1.20 "pct exec 1088 -- sed -i.rotbak 's/^\(.*TOKEN=\).*/\1'$NEWTOK'/' <FILE>"
# Mac side — update .env.local in place:
sed -i.rotbak -E "s/^(BRIDGE_MCP_TOKEN=).*/\1$NEWTOK/" services/control-plane/.env.local
unset NEWTOK
```
(Adjust the sed key name to whatever 3.1 found. Delete the `.rotbak` files after verify.)

3.4 Restart the Bridge in the window:
```bash
ssh root@192.168.1.20 "pct exec 1088 -- systemctl restart alden-bridge && pct exec 1088 -- systemctl is-active alden-bridge"
# must print: active
```

3.5 **Verify the control plane can reach the Bridge with the new token** — run the
existing live retriever test or a status-code check against `BRIDGE_MCP_URL` using the
token from `.env.local` (same pattern as 2.4: read from file, print status only; expect
200/OK). Also verify the OLD token is dead if the Bridge supports multiple tokens
(if single-token, replacement IS revocation).

3.6 **Smoke test (golden rule):** send a test message to Alden-1 and confirm a reply
routes back; check the mailbox tail shows the exchange (Appendix A of the Alden Build
Plan). If the identities cannot talk: restore the `.bak` file inside the container,
restart alden-bridge, re-verify, then hand back to Karl.

**Rollback:** the `.bak` from 3.2 + restart. The Mac-side `.env.local.rotbak` restores
the old client value.

---

## Step 4 — Tighten database file permissions (finding F4)

```bash
chmod 600 /Users/karl/.pantheon/control-plane.db /Users/karl/.pantheon/control-plane.db-shm /Users/karl/.pantheon/control-plane.db-wal 2>/dev/null
ls -l /Users/karl/.pantheon/ | grep control-plane   # all three lines must start -rw-------
```
**Rollback:** not needed (permissions only; the app runs as the same user).

---

## Step 5 — Push the cleared history to GitHub (finding F3 close-out; Decision A)

The 2026-07-09 review cleared the full history. The remote is 2+ commits behind
(an early push happened 2026-07-06 — already recorded as a deviation).

```bash
cd "/Users/karl/Documents/Claude Projects/Pantheon/pantheon-harness"
git status --short          # must be empty before pushing
git push origin main
git ls-remote origin refs/heads/main   # hash must equal: git rev-parse main
```
Do NOT push the historical feature branches; `main` is the record.
**Rollback:** none needed — pushing adds commits to a private remote; nothing is
overwritten (do not use `--force` under any circumstances).

---

## Step 6 — Stand up the Gitea mirror of the Pantheon repo (Decision A, second half)

Requires the NEW Gitea token from Step 2. Push-mirror from the Mac (simplest — no
GitHub credentials stored in Gitea):

6.1 Ask Karl to create an empty repo `Pantheon` in Gitea (UI: New Repository, private,
NO initialization — no README/license).

6.2 Add the remote and push (token read from file, never typed):
```bash
cd "/Users/karl/Documents/Claude Projects/Pantheon/pantheon-harness"
NEW=$(grep -E '^GITEA_TOKEN=' services/control-plane/.env.local | cut -d= -f2-)
git remote add gitea "https://oauth2:${NEW}@gitea.ferrumcorde.com/kraulerson/Pantheon.git" 2>/dev/null || git remote set-url gitea "https://oauth2:${NEW}@gitea.ferrumcorde.com/kraulerson/Pantheon.git"
git push gitea main
# IMMEDIATELY strip the credential from the stored remote URL:
git remote set-url gitea "https://gitea.ferrumcorde.com/kraulerson/Pantheon.git"
unset NEW
git config --get remote.gitea.url   # must NOT contain a token
```
(Future mirror pushes: re-insert the token transiently the same way, or ask Karl to add
a credential-helper entry — never persist the token in `.git/config`.)

**Verify:** `git ls-remote gitea refs/heads/main` matches local `main` (it will prompt/
fail without credentials — verifying via the Gitea web UI that the repo shows the latest
commit is equally fine and simpler).
**Rollback:** delete the Gitea repo (UI); `git remote remove gitea`.

---

## Step 7 — Fold the review's tracked hardening into the skeleton charter (findings F5/F6)

Edit `docs/walking-skeleton-milestone.md`: add this subsection at the end of the
**Scope** section, verbatim:

```markdown
### Security hardening pulled in by the 2026-07-09 review (F5/F6)
10. **CSP tightening** — move the harness frame's inline bootstrap to a served file or
    nonce'd script; verify no `unsafe-inline` needed once a real browser is in play.
11. **CSRF token** — per-request token on state-changing admin routes (defense-in-depth
    beyond SameSite=Lax).
12. **Machine-auth TM rows (design-time, with item 9)** — the Facade service principal
    is a distinct credential domain from operator cookie/bearer; add TM entries for the
    admin↔Facade boundary and the ADR-0006 propose-a-change commit authorship (only
    Karl can author/merge alden-infra changes).
13. **C.7 queue depth bound** — reject beyond a fixed queue length (flooding cannot grow
    memory); cost-meter ledger rows carry counts only, never prompt content.
```
And add to the **Acceptance checklist**:
```markdown
- [ ] CSP passes without `unsafe-inline`; CSRF token present on admin mutations.
- [ ] Queue depth is bounded (test: N+1th concurrent request rejected with a labeled error).
```
Backlog (NOT skeleton, record in the charter's "Explicitly NOT" list as deferred-with-
owner): SSH host-key pinning before any non-LAN terminal use; terminal WS input-flood
rate limiting; D6 passkey step-up (unchanged, post-skeleton).

---

## Step 8 — Fix the Gitea ratification-mirror copy of the Build Plan (deferred I4 item)

The vault copy was fixed 2026-07-09; the identities' mirror still has the old line.
Requires the NEW token (Step 2). The mirror lives in Gitea `alden/workspace` under
`ratification/`.

8.1 Clone shallowly to scratch, fix, push (token handling as in Step 6.2):
```bash
cd "$(mktemp -d)"
NEW=$(grep -E '^GITEA_TOKEN=' "/Users/karl/Documents/Claude Projects/Pantheon/pantheon-harness/services/control-plane/.env.local" | cut -d= -f2-)
git clone --depth 1 "https://oauth2:${NEW}@gitea.ferrumcorde.com/alden/workspace.git"
cd workspace/ratification
# Find the build-plan file and apply the same one-line fix as the vault copy:
grep -rn "Phases 1–2 (bus isolation)" .
sed -i '' 's/Phases 1–2 (bus isolation) can proceed in parallel with Phase 0 since they don'"'"'t touch memory\./Phase 1 (bus isolation) can proceed in parallel with Phase 0 since it doesn'"'"'t touch memory./' "<FILE FROM GREP>"
git commit -am "docs: editorial fix — align phase-parallelism wording to recorded R1 (matches vault copy, 2026-07-09)"
git push
unset NEW
```
**Verify:** `grep -rn "Phases 1–2 (bus isolation)" .` returns nothing;
`grep -rc "Phase 1 (bus isolation)" <FILE>` returns ≥1.
**Rollback:** `git revert HEAD && git push`.

---

## Step 9 — Record everything

9.1 In `APPROVAL_LOG.md`, append to the security-review section (it exists — see the
2026-07-09 review ruling): one line per completed step with date + outcome
(eval decommissioned; Gitea token rotated + old deleted; Bridge token rotated + smoke
test passed; db perms tightened; main pushed, remote == local; Gitea mirror live;
skeleton charter amended; ratification mirror fixed). Add matching Approval History rows.

9.2 Update the vault decision doc (`Future State/Pantheon Harness — Review & Decision
Points (2026-07-05).md`): under Decision A's ✅ block, note the mirror is live and the
push is complete; under Decision I, mark I2 (eval folder) DONE.

9.3 Update auto-memory (`alden-harness-architecture.md` + `MEMORY.md` line): rotation
DONE (close the 26-day-old item), eval stack decommissioned, push + mirror live,
remaining security queue = skeleton hardening items only.

9.4 Commit all repo changes (`docs:`/`chore:` on a branch, merge to `main`, push to
both remotes — Step 6.2 token pattern for gitea).

## Final verification checklist (run top to bottom)

- [ ] `docker ps -a | grep -ci peta` → 0; eval folder gone; repo's sanitized copy intact
- [ ] Gitea API 200 with new token; old token deleted in UI
- [ ] Bridge healthy (`systemctl is-active alden-bridge` → active) AND identities
      exchanged a message post-restart (mailbox tail shows it)
- [ ] `gitleaks dir --redact` on the repo still reports only `.env.local` (2 hits)
- [ ] `~/.pantheon/control-plane.db*` all 0600
- [ ] `git ls-remote origin refs/heads/main` == `git rev-parse main`; same for the
      Gitea mirror (or UI check)
- [ ] Skeleton charter contains the F5/F6 hardening items + 2 new acceptance boxes
- [ ] Ratification mirror shows the corrected Phase-1 wording
- [ ] APPROVAL_LOG, vault doc, and memory updated; working tree clean on `main`
