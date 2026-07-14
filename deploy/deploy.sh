#!/usr/bin/env bash
set -euo pipefail

REMOTE="${REMOTE:-root@187.124.9.225}"
REMOTE_DIR="${REMOTE_DIR:-/opt/go-tunnel}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/cursor_ttakka}"
SSH_OPTS=(-i "$SSH_KEY" -o IdentitiesOnly=yes)

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "==> Sync to $REMOTE:$REMOTE_DIR"
rsync -avz --delete \
  -e "ssh ${SSH_OPTS[*]}" \
  --exclude node_modules \
  --exclude data/traffic.ndjson \
  --exclude data/visits.db \
  --exclude data/visits.db-wal \
  --exclude data/visits.db-shm \
  --exclude inbox \
  "$ROOT/" "$REMOTE:$REMOTE_DIR/"

echo "==> Install + restart PM2"
ssh "${SSH_OPTS[@]}" "$REMOTE" bash -s << 'REMOTE_SCRIPT'
set -euo pipefail
export NVM_DIR=/root/.nvm
. "$NVM_DIR/nvm.sh"
cd /opt/go-tunnel
mkdir -p data inbox
if ! command -v make >/dev/null 2>&1; then
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq build-essential python3
fi
npm install --omit=dev
node --check server.js
node --check client.js

cp deploy/nginx/go.tejarahlntpoor.com.conf /etc/nginx/sites-available/go.tejarahlntpoor.com
ln -sfn /etc/nginx/sites-available/go.tejarahlntpoor.com /etc/nginx/sites-enabled/go.tejarahlntpoor.com

cat > /etc/nginx/proxy_params_go_board << 'EOF'
proxy_http_version 1.1;
proxy_set_header Host $host;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
add_header X-Go-Board 1 always;
add_header Cache-Control "no-store" always;
EOF

cat > /etc/nginx/proxy_params_go_ws << 'EOF'
proxy_http_version 1.1;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "upgrade";
proxy_set_header Host $host;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_read_timeout 3600s;
proxy_send_timeout 3600s;
EOF

nginx -t && systemctl reload nginx

pm2 delete go-tunnel go-tunnel-client 2>/dev/null || true
pm2 start deploy/pm2.ecosystem.config.cjs
pm2 save

echo "==> Status"
curl -fsS https://go.tejarahlntpoor.com/api/status
echo
pm2 list | grep go-tunnel || true
REMOTE_SCRIPT

echo "==> Done. Board: https://go.tejarahlntpoor.com/board"
