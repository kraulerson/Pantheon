# Step 1 — Provision the Debian VM and run the install (charter item 1)

**Commit type: `build:`.** No Build Loop (no MVP-cutline code).
**Preconditions:** Proxmox host reachable; this repo cloned or clonable; you can create VMs.

## Goal

The target host exists (D-ENC ruling: **Debian VM on Proxmox** — APPROVAL_LOG
2026-07-09) and `scripts/install-debian.sh` has run through step 7, leaving: native
control-plane built, custody + data dirs created, Docker installed, the third-party
stack running, systemd units installed, and the first dev machine provisioned.

## Do

1. **Create the VM** (Proxmox web UI): Debian 12 (bookworm) netinst ISO; **16 GB RAM**
   (sizing from the 2026-07-09 eval), 4 vCPU, 64 GB disk; bridged NIC on the LAN.
   During install: no desktop, OpenSSH server ON, a non-root user (this becomes
   `PANTHEON_USER`). Static IP or DHCP reservation (pfSense) — the harness address
   must not drift.
2. **Base access:** `apt-get update && apt-get -y upgrade`; install Tailscale if
   off-LAN access is wanted (LAN/Tailscale ONLY — no port forwards, ever).
3. **Clone the repo** to `/opt/pantheon/pantheon-harness` (the path the systemd unit
   templates assume; the install script rewrites paths if you choose differently):
   `sudo install -d -o <user> /opt/pantheon && git clone <origin-url> /opt/pantheon/pantheon-harness`
4. **Fill secrets BEFORE the installer:**
   - `deploy/.env` from `deploy/.env.example` — every blank filled
     (`openssl rand -hex 32`); never committed.
   - `services/control-plane/.env.local` from `.env.local.example` — at minimum
     `ADMIN_API_TOKEN`, `PANTHEON_OPERATOR_PASSWORD`, `PANTHEON_SECURE_COOKIES=true`,
     `PANTHEON_DB`, `PANTHEON_KEY_DIR`; plus `BRIDGE_MCP_URL`/`BRIDGE_MCP_TOKEN` and
     `PETA_URL`/`PETA_ADMIN_TOKEN` (the latter minted in step 2 — leave blank for now).
5. **Run the installer:** `sudo bash scripts/install-debian.sh` — answer each prompt.
   Step 5 will refuse to start the stack if `deploy/.env` is missing: that is
   fail-closed working, not an error.
6. **DNS:** add pfSense host overrides (or client `/etc/hosts`) for `pantheon.lan` and
   `admin.pantheon.lan` → the VM's IP. Trust Caddy's local root CA per
   `deploy/README.md` §TLS.

## Verify

- `docker compose -f deploy/docker-compose.yml ps` — all services `running/healthy`.
- `systemctl status pantheon-admin@<user>` — active; browse
  `https://admin.pantheon.lan/harness` → `/login` works with the operator passphrase.
  (Until skeleton step 3 lands, the admin unit runs `dist/server.js` — the installer
  prints this.)
- **M2 network test from a DIFFERENT machine** (deploy/README.md): Peta port 3002,
  Postgres 5433, Mongo, Meili all unreachable from the LAN. Public reachability is a
  defect, not a recoverable state.
- Re-run `sudo bash scripts/install-debian.sh` end-to-end: every step must be a no-op
  or an idempotent success (acceptance-checklist item: "install-debian.sh re-run on
  the VM is idempotent").

## Rollback

The VM is disposable pre-skeleton: snapshot before step 5 (Proxmox), restore on a bad
state. `docker compose down` stops the stack without data loss (named volumes persist).

## Acceptance mapping

Satisfies the idempotent-install checklist item; prerequisite for every other step.

---

## Execution notes — 2026-08-18 (EXECUTED; charter item 1 satisfied)

**Target as built:** Proxmox node `ferrumcorde` (192.168.1.20) → **VM 1093 `pantheon-harness`**,
4 vCPU / 16 GB RAM / 64 GB disk, `onboot=1`, bridged on `vmbr0` untagged, static
**192.168.1.93/24** (gw .1, DNS 192.168.1.41/.42 + 1.1.1.1), user `pantheon`, key-only SSH.
Repo at `/opt/pantheon/pantheon-harness` (the path the unit templates assume), cloned from the
Gitea mirror over the LAN.

**Deviations from the plan above (all ruled, APPROVAL_LOG 2026-08-18):**

1. **Debian 13 (trixie) cloud image + cloud-init via `qm`, not Debian 12 netinst by hand.**
   Operator's call: same recipe as `alden-gateway` VM 1089, scripted end-to-end, no console
   session. The D-ENC ruling (Debian VM on Proxmox) is unaffected.
2. **IP scheme:** house rule confirmed by the operator — *the last three digits of the VMID are
   the last octet*: VM 1093 → 192.168.1.**93**.
3. **Rollback mechanism:** storage `VM` is plain LVM (not thin), so Proxmox **snapshots are not
   available**. Pre-change protection on this host is `vzdump` to `PBS-NAS` instead. Amend the
   Rollback section above accordingly.
4. **Node 24 LTS, not Node 20** — ADR-0002 amended (see below).
5. **Repo clone needs no credentials:** the Gitea mirror `kraulerson/Pantheon` is
   `private: false`, i.e. readable by anything that can reach the internal Gitea. Convenient here
   (no deploy key, no shared-credential fan-out — BUG-010), but it is an exposure decision that
   was never explicitly ruled. **Flagged to the operator; open question.**

**Defects found and fixed while executing (BUGS #9, #10, #11 — fixed in this commit):**

- **#9** `install-debian.sh` pinned NodeSource `setup_20.x`; Node 20 ships npm 10.8.2, and the
  committed `package-lock.json` only validates under npm ≥ 11 → `npm ci` failed and the install
  aborted at step 2. Proven both ways on this VM (npm 11.19.0 → exit 0; npm 10.8.2 → exit 1,
  `Missing: @types/node@26.2.0`). Fixed by raising the floor to **Node 24** (`NODE_MIN=24`,
  `setup_24.x`), which also lifts the host off a runtime that lost security support 2026-04-30.
- **#10** step 2 ran `npm ci`/`npm run build` as **root**, leaving `~/.npm` and `node_modules`
  root-owned. Now runs as `$SERVICE_USER` and repairs an already-root-owned cache first.
- **#11** step 3 created `services/control-plane/data` as **root**, so the service user could not
  create `control-plane.db`. Now chowned to the service user.
- **compose:** `petaio/peta-core:v1.2.2` does not exist upstream — the tag is bare **`1.2.2`**
  (the file's own `# VERIFY` comment called it). Fixed; all six images now pull.

**Verify results (all green):**

- `docker compose ps` → caddy, librechat, meilisearch, mongodb up; **peta-core healthy**
  (127.0.0.1:3002), **peta-postgres healthy** (127.0.0.1:5433).
- `systemctl is-active pantheon-admin@pantheon` → **active**, **enabled**. Runs
  `dist/server.js` via a temporary drop-in at
  `/etc/systemd/system/pantheon-admin@.service.d/10-single-service.conf` — **skeleton step 3 must
  delete that drop-in** when `dist/server-admin.js` lands.
- HTTP through Caddy (tested with `--resolve`, DNS not yet in place):
  `https://admin.pantheon.lan/login` → **200**, `/harness` → **401** (fail-closed),
  `https://pantheon.lan/` → **200** (LibreChat). Security headers present on both
  (HSTS, nosniff, no-referrer, X-Frame-Options DENY / SAMEORIGIN); `Server` header stripped.
- **M2 network test from a different machine (operator's Mac):** 3002, 5433, 27017, 7700 all
  **unreachable**. 80/443 (Caddy) and 8088 (admin, Caddy's upstream) reachable by design.
- **Idempotent re-run:** full `install-debian.sh` re-run end-to-end → **exit 0**, every step a
  no-op or idempotent success. *(Acceptance-checklist item satisfied.)*
- Registry DB created at `services/control-plane/data/control-plane.db`, chmod **0600** by hand —
  the app creates it 0644, so the F4 remediation posture is **not enforced by code**. Backlog.

**Image digests as pulled 2026-08-18** (for the step-2 digest pin — no re-pull needed):

```
caddy:2-alpine                    @sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648
getmeili/meilisearch:v1.12        @sha256:c9fac23131cca4db95173d41cc50fd5639121ee381795528fdd7522d7978a7b8
ghcr.io/danny-avila/librechat:v0.8.7 @sha256:c5db3331b845e1f289f8d04c0c77936c4bbe372f76730a804abc1c37e44d23a9
mongo:7                           @sha256:b6421fd6d1c5ded6377b397d8983e2f82e2100dc5123332dcfda2065a472be5b
petaio/peta-core:1.2.2            @sha256:d0cf0277c9bf4c9259575657d2e9cfb5a8c95d119bae1336f924a5e92854a743
postgres:16-alpine                @sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685
```

**Left open (operator actions, none blocking step 2):**

- pfSense host overrides `pantheon.lan` + `admin.pantheon.lan` → 192.168.1.93, and trust Caddy's
  local root CA (`deploy/README.md` §TLS). Until then, browse by `--resolve`/hosts entry.
- Browser login at `https://admin.pantheon.lan/login` with the generated operator passphrase
  (stored only in `services/control-plane/.env.local` on the VM, 0600 — never printed).
- Installer **step 7** (first Claude-CLI dev machine) skipped: `provision-devmachine` needs
  Remote Login enabled on the Mac and its password typed once. Not required by the charter's
  step-1 acceptance items.
- **Hardening candidate:** the admin service binds `0.0.0.0:8088`, so it is reachable on the LAN
  without TLS (auth still fail-closed). Binding it to the Docker bridge gateway instead would
  leave only Caddy's 443 exposed. Not changed unilaterally — operator's call.
