#!/bin/bash
# Runs as root on the Google Cloud VM at every boot (and when gcp-deploy.sh pushes an update).
# Installs Node.js 22 and Caddy once, unpacks the app from VM metadata, and (re)starts the services.
set -euo pipefail
log() { echo "film-room-setup: $*"; }
md() { curl -fs -H "Metadata-Flavor: Google" "http://metadata.google.internal/computeMetadata/v1/instance/$1" || true; }

APP=/opt/film-room
DATA=/var/lib/film-room
export DEBIAN_FRONTEND=noninteractive

# 1 GB of RAM is tight while apt runs; add a little swap once.
if [[ ! -f /swapfile ]]; then
  fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

if ! command -v node >/dev/null || (( $(node -p 'process.versions.node.split(".")[0]') < 22 )); then
  log "installing Node.js 22"
  apt-get update -q
  apt-get install -y -q ca-certificates curl gnupg
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -q nodejs
fi
if ! command -v caddy >/dev/null; then
  log "installing Caddy and automatic security updates"
  apt-get update -q
  apt-get install -y -q unattended-upgrades
  if ! apt-get install -y -q caddy; then
    # fall back to Caddy's own package repository
    apt-get install -y -q debian-keyring debian-archive-keyring apt-transport-https gnupg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -q && apt-get install -y -q caddy
  fi
fi

log "unpacking app"
md attributes/app-bundle | base64 -d > /tmp/film-room.tgz
rm -rf "$APP.new" && mkdir -p "$APP.new"
tar -xzf /tmp/film-room.tgz -C "$APP.new"
rm -rf "$APP" && mv "$APP.new" "$APP"
rm -f /tmp/film-room.tgz

id filmroom >/dev/null 2>&1 || useradd --system --home-dir "$DATA" --shell /usr/sbin/nologin filmroom
mkdir -p "$DATA/backups"
chown -R filmroom:filmroom "$DATA"

# The admin password is only used when the database is first created.
ADMIN_PW="$(md attributes/admin-password)"
if [[ -n "$ADMIN_PW" && ! -f "$DATA/filmroom.db" ]]; then
  umask 077
  printf 'ADMIN_PASSWORD=%s\nADMIN_MUST_CHANGE=1\n' "$ADMIN_PW" > /etc/film-room.env
else
  : > /etc/film-room.env
fi
chmod 600 /etc/film-room.env

cat > /etc/systemd/system/film-room.service <<EOF
[Unit]
Description=FTC Film Room
After=network-online.target
Wants=network-online.target

[Service]
User=filmroom
Group=filmroom
Environment=PORT=3000 HOST=127.0.0.1 DATA_DIR=$DATA SECURE_COOKIE=1 TRUST_PROXY=1
EnvironmentFile=/etc/film-room.env
ExecStart=/usr/bin/node $APP/server.js
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$DATA

[Install]
WantedBy=multi-user.target
EOF

HOST="$(md attributes/site-host)"
if [[ -z "$HOST" ]]; then
  IP="$(md network-interfaces/0/access-configs/0/external-ip)"
  HOST="${IP//./-}.sslip.io"
fi
cat > /etc/caddy/Caddyfile <<EOF
$HOST {
	encode gzip
	reverse_proxy 127.0.0.1:3000
}
EOF

# Copy backups off the VM to Cloud Storage every 6 hours (the app itself writes them every 6 hours).
BUCKET="$(md attributes/backup-bucket)"
if [[ -n "$BUCKET" ]]; then
  cat > /etc/cron.d/film-room-backup <<EOF
SHELL=/bin/bash
40 */6 * * * root gcloud storage rsync $DATA/backups gs://$BUCKET/backups --quiet > /var/log/film-room-backup.log 2>&1
EOF
fi

# Updater: waits for a new app-version in VM metadata (set by GitHub deploys) and reinstalls the app.
cat > /usr/local/bin/film-room-updater.new <<'UPDATER'
#!/bin/bash
URL="http://metadata.google.internal/computeMetadata/v1/instance/attributes/app-version"
cur="$(curl -fs -H 'Metadata-Flavor: Google' "$URL" || true)"
while true; do
  new="$(curl -fs -H 'Metadata-Flavor: Google' "$URL?wait_for_change=true&timeout_sec=300")" || { sleep 15; continue; }
  if [[ "$new" != "$cur" ]]; then
    echo "film-room-updater: deploying version $new"
    cur="$new"
    google_metadata_script_runner startup || echo "film-room-updater: deploy failed"
  fi
done
UPDATER
chmod 755 /usr/local/bin/film-room-updater.new
mv /usr/local/bin/film-room-updater.new /usr/local/bin/film-room-updater   # atomic swap: a running copy keeps working
cat > /etc/systemd/system/film-room-updater.service <<'UNIT'
[Unit]
Description=FTC Film Room updater (installs new versions pushed from GitHub)
After=network-online.target

[Service]
ExecStart=/usr/local/bin/film-room-updater
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable film-room caddy >/dev/null
systemctl enable --now film-room-updater >/dev/null   # never restarted here: it may be what is running this script
systemctl restart film-room
systemctl restart caddy
log "running at https://$HOST"
