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
