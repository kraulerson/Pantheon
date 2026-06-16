#!/usr/bin/env bash
#
# install-debian.sh — guided first-time install of the Pantheon Harness control-plane on a fresh
# Debian-based VM (the intended production host — a VM on Proxmox; see PROJECT_BIBLE §5/§7, ADR-0005).
#
# What it does, with a prompt before each consequential step:
#   1. installs OS prerequisites (Node 20 LTS, build toolchain for better-sqlite3, openssh-client)
#   2. installs control-plane npm deps and builds the TypeScript
#   3. creates the harness SSH key-custody dir (0700) and the control-plane data dir
#   4. prints the remaining manual steps (register dev machines, provision them, run the service)
#
# It is idempotent and re-runnable. It does NOT generate the harness SSH keypair or run ssh-copy-id —
# that happens per dev machine via `provision-devmachine` (it needs you at the keyboard for the
# one-time password prompt). It also does not deploy LibreChat or Peta (separate components).
#
# Usage:   sudo bash scripts/install-debian.sh
# Env:     PANTHEON_USER (service user, default: the invoking sudo user or 'pantheon')
#          PANTHEON_HOME (install root, default: this repository checkout)
#          NONINTERACTIVE=1 to accept all prompts (for automation)

set -euo pipefail

# --- helpers ---------------------------------------------------------------
c_info()  { printf '\033[1;34m[*]\033[0m %s\n' "$*"; }
c_ok()    { printf '\033[1;32m[OK]\033[0m %s\n' "$*"; }
c_warn()  { printf '\033[1;33m[!]\033[0m %s\n' "$*" >&2; }
c_err()   { printf '\033[1;31m[X]\033[0m %s\n' "$*" >&2; }

confirm() {
  # confirm "Question?"  -> returns 0 on yes
  if [ "${NONINTERACTIVE:-0}" = "1" ]; then return 0; fi
  local reply
  read -r -p "$1 [y/N] " reply
  [ "$reply" = "y" ] || [ "$reply" = "Y" ]
}

require_root() {
  if [ "$(id -u)" -ne 0 ]; then
    c_err "Run as root (sudo). System packages and Node need to be installed."
    exit 1
  fi
}

# --- resolve paths ---------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CONTROL_PLANE="$REPO_ROOT/services/control-plane"
PANTHEON_HOME="${PANTHEON_HOME:-$REPO_ROOT}"
SERVICE_USER="${PANTHEON_USER:-${SUDO_USER:-pantheon}}"

c_info "Pantheon Harness — control-plane install (Debian)"
c_info "Repo:            $REPO_ROOT"
c_info "Service user:    $SERVICE_USER"
echo

# --- 0. sanity -------------------------------------------------------------
if ! grep -qiE 'debian|ubuntu' /etc/os-release 2>/dev/null; then
  c_warn "This does not look like a Debian/Ubuntu system. Package steps may fail."
  confirm "Continue anyway?" || exit 1
fi
require_root

# --- 1. OS prerequisites ---------------------------------------------------
# build-essential + python3 are needed to compile better-sqlite3's native addon.
# openssh-client provides ssh-keygen + ssh-copy-id used by provisioning.
if confirm "Step 1: apt-get install prerequisites (curl, git, build-essential, python3, openssh-client)?"; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y curl ca-certificates git build-essential python3 openssh-client
  c_ok "Prerequisites installed."
fi

# Node 20 LTS via NodeSource (only if a suitable node is absent).
NODE_OK=0
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  [ "$NODE_MAJOR" -ge 20 ] && NODE_OK=1
fi
if [ "$NODE_OK" -eq 1 ]; then
  c_ok "Node $(node -v) already present (>= 20)."
elif confirm "Step 1b: install Node.js 20 LTS via NodeSource?"; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
  c_ok "Installed Node $(node -v)."
else
  c_warn "Node 20+ is required to build and run the control-plane."
fi

# --- 2. build the control-plane -------------------------------------------
if confirm "Step 2: install npm deps and build the control-plane (npm ci && npm run build)?"; then
  ( cd "$CONTROL_PLANE" && npm ci && npm run build )
  c_ok "Control-plane built ($CONTROL_PLANE/dist)."
fi

# --- 3. custody + data directories ----------------------------------------
# The harness SSH PRIVATE key lives here (0700 dir, 0600 file) and is resolved server-side by
# handle at connect time — never sent to the browser/terminal/logs (TM-020/#14b).
SERVICE_HOME="$(getent passwd "$SERVICE_USER" | cut -d: -f6 || true)"
SERVICE_HOME="${SERVICE_HOME:-/home/$SERVICE_USER}"
KEY_DIR="${PANTHEON_KEY_DIR:-$SERVICE_HOME/.pantheon/keys}"
DATA_DIR="$CONTROL_PLANE/data"

if confirm "Step 3: create key-custody dir ($KEY_DIR, 0700) and data dir ($DATA_DIR)?"; then
  install -d -m 700 -o "$SERVICE_USER" -g "$SERVICE_USER" "$KEY_DIR" 2>/dev/null \
    || { mkdir -p "$KEY_DIR"; chmod 700 "$KEY_DIR"; }
  mkdir -p "$DATA_DIR"
  chown -R "$SERVICE_USER":"$SERVICE_USER" "$SERVICE_HOME/.pantheon" 2>/dev/null || true
  c_ok "Custody dir: $KEY_DIR (0700).  Data dir: $DATA_DIR."
fi

# --- 4. next steps ---------------------------------------------------------
cat <<EOF

$(c_ok "Base install complete.")

Run the control-plane (serves the Config page + harness frame + terminals):

     cd "$CONTROL_PLANE"
     ADMIN_API_TOKEN=<a strong token> \\
     PANTHEON_OPERATOR_PASSWORD=<your login passphrase> PANTHEON_SECURE_COOKIES=true \\
     PANTHEON_DB="$DATA_DIR/control-plane.db" PANTHEON_KEY_DIR="$KEY_DIR" \\
     npm start            # listens on PORT (default 8088); open /harness → /login

     (PANTHEON_OPERATOR_PASSWORD enables the browser login at /login; set
      PANTHEON_SECURE_COOKIES=true only when served over HTTPS via your reverse proxy.)

Per Claude-CLI dev machine (env shared with the steps above):
  1. Register it (logicalName, host/IP, user[, --port]):
       node dist/cli/register-devmachine.js --name <logicalName> --host <ip> --user <you>
     (or add it on the Configuration page once the server is running)
  2. Provision it ONCE — installs the harness public key, you type the machine password once:
       node dist/cli/provision-devmachine.js <logicalName>
     After this, all terminal sessions to that machine connect key-only.

Secrets (gitignored .env.local in $CONTROL_PLANE), set before live runs:
     ADMIN_API_TOKEN, GITEA_BASE_URL, GITEA_TOKEN, BRIDGE_MCP_URL, BRIDGE_MCP_TOKEN,
     and PETA_URL + PETA_ADMIN_TOKEN for MCP-server registration.

Not handled here (separate components — see docs/SESSION-HANDOFF): deploying LibreChat and Peta,
and wiring LibreChat's custom endpoint to the control-plane. Consider a systemd unit running
\`npm start\` to bring the control-plane up on boot, behind your reverse proxy + TLS (wss://).
EOF
