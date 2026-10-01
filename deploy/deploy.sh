#!/usr/bin/env bash
# Deploys the current directory to a Linux host as /srv/veriscope.
#
#   ssh -p 22022 root@YOUR_VPS_IP 'bash -s' < deploy/deploy.sh
#
# Spaceship Starlight VMs listen on SSH port 22022, not 22.
set -euo pipefail

APP_SRC="${APP_SRC:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
APP_DIR=/srv/veriscope
SERVICE_USER=veriscope

log() { printf '\033[1;34m==>\033[0m %s\n' "$1"; }

[[ $EUID -eq 0 ]] || { echo "Run as root." >&2; exit 1; }

log "Creating service user"
id -u "$SERVICE_USER" >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"

log "Checking Node.js (needs >= 22.5 for node:sqlite)"
if ! command -v node >/dev/null; then
  echo "Node.js missing. Install it first:" >&2
  echo "  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -" >&2
  echo "  sudo apt-get install -y nodejs" >&2
  exit 1
fi
node -e 'const [a,b]=process.versions.node.split(".").map(Number); if(a<22||(a===22&&b<5)){console.error("Node "+process.versions.node+" too old, need >=22.5");process.exit(1)}'
node -v

log "Stopping service"
systemctl stop veriscope 2>/dev/null || true

log "Syncing files to $APP_DIR"
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" "$APP_DIR"
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" "$APP_DIR/data"

# rsync keeps data/ and node_modules/ on the server and avoids copying dev cruft.
if command -v rsync >/dev/null; then
  rsync -a --delete \
    --exclude 'data/' --exclude 'node_modules/' --exclude '.git' \
    --exclude '*.log' \
    "$APP_SRC"/ "$APP_DIR"/
else
  echo "rsync not found; falling back to tar copy."
  tar -C "$APP_SRC" --exclude=./data --exclude=./node_modules --exclude=./.git -cf - . \
    | tar -C "$APP_DIR" -xf -
fi
chown -R "$SERVICE_USER:$SERVICE_USER" "$APP_DIR"

log "Installing systemd unit"
install -m 644 "$APP_DIR/deploy/veriscope.service" /etc/systemd/system/veriscope.service

if [[ ! -f /etc/veriscope.env ]]; then
  log "No /etc/veriscope.env found"
  echo "Create it on the server:  bash $APP_DIR/deploy/make-env.sh your-domain.com" >&2
fi

log "Enabling and starting service"
systemctl daemon-reload
systemctl enable --now veriscope
sleep 2
systemctl --no-pager --lines=20 status veriscope || true

log "Local health check"
curl -fsS http://127.0.0.1:3000/api/me && echo || echo "no response"

cat <<'EOF'

Remaining steps:
  1. Caddy:   set VERISCOPE_DOMAIN in /etc/caddy/Caddyfile, then
              systemctl reload caddy
  2. DNS:     point an A record for your domain at this server's IP
  3. Verify:  curl -I https://your-domain.com  (expect HTTP/2 200)
  4. Backups: bash deploy/backup.sh (schedule in cron)
EOF