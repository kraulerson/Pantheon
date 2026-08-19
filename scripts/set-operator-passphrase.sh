#!/usr/bin/env bash
# set-operator-passphrase.sh — change the control-plane browser login passphrase.
#
# Prompts silently and writes the value straight into the gitignored .env.local, so the
# passphrase never appears in a transcript, in shell history, or in process arguments
# (`ps` shows nothing; the value is handed to python via the environment, not argv).
#
# Usage:  sudo bash scripts/set-operator-passphrase.sh [path-to-.env.local]
set -euo pipefail

ENV_FILE="${1:-/opt/pantheon/pantheon-harness/services/control-plane/.env.local}"
[ -f "$ENV_FILE" ] || { echo "[X] no such env file: $ENV_FILE" >&2; exit 1; }
[ "$(id -u)" -eq 0 ] || { echo "[X] run with sudo (the file is 0600 and the unit needs a restart)." >&2; exit 1; }

read -rsp "New operator passphrase: " P1; echo
read -rsp "Repeat it: "             P2; echo
[ -n "$P1" ]        || { echo "[X] empty passphrase refused (that would disable browser login)." >&2; exit 1; }
[ "$P1" = "$P2" ]   || { echo "[X] the two entries differ — nothing changed." >&2; exit 1; }

P="$P1" python3 - "$ENV_FILE" <<'PY'
import os, sys
path, val = sys.argv[1], os.environ["P"]
lines = open(path).read().splitlines()
out, replaced = [], False
for line in lines:
    if line.startswith("PANTHEON_OPERATOR_PASSWORD="):
        out.append("PANTHEON_OPERATOR_PASSWORD=" + val); replaced = True
    else:
        out.append(line)
if not replaced:
    out.append("PANTHEON_OPERATOR_PASSWORD=" + val)
open(path, "w").write("\n".join(out) + "\n")
os.chmod(path, 0o600)
print(f"[OK] passphrase written to {path} (0600){' — replaced' if replaced else ' — appended'}")
PY

UNIT="pantheon-admin@${SUDO_USER:-pantheon}"
if systemctl restart "$UNIT" 2>/dev/null; then
  sleep 2
  echo "[OK] $UNIT restarted ($(systemctl is-active "$UNIT")). Log in at https://admin.pantheon.lan/login"
else
  echo "[!] could not restart $UNIT — restart it yourself for the change to take effect." >&2
fi
