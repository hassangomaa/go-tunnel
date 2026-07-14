# Deployment

## Production (VPS)

| Item | Value |
|------|-------|
| Server | `187.124.9.225` (`srv1381766`) |
| App path | `/opt/go-tunnel` |
| Board port | `127.0.0.1:4055` |
| Forward target | `http://127.0.0.1:3000` |

### One-command deploy (from Mac)

```bash
cd ~/Projects/go-tunnel
chmod +x deploy/deploy.sh
./deploy/deploy.sh
```

### Manual deploy

```bash
# Sync files
rsync -avz --exclude node_modules --exclude data/traffic.ndjson \
  -e "ssh -i ~/.ssh/cursor_ttakka" \
  ~/Projects/go-tunnel/ root@187.124.9.225:/opt/go-tunnel/

# On server
ssh -i ~/.ssh/cursor_ttakka root@187.124.9.225
export NVM_DIR=/root/.nvm && . $NVM_DIR/nvm.sh
cd /opt/go-tunnel
npm install --omit=dev
pm2 start deploy/pm2.ecosystem.config.cjs
pm2 save
```

### Nginx

Config: `deploy/nginx/go.tejarahlntpoor.com.conf`  
Installed at: `/etc/nginx/sites-available/go.tejarahlntpoor.com`

Helper includes on server:
- `/etc/nginx/proxy_params_go_board`
- `/etc/nginx/proxy_params_go_ws`

```bash
nginx -t && systemctl reload nginx
```

### SSL

Certbot cert: `/etc/letsencrypt/live/go.tejarahlntpoor.com/`

```bash
certbot --nginx -d go.tejarahlntpoor.com
```

## PM2 management

```bash
pm2 list
pm2 logs go-tunnel --lines 50
pm2 logs go-tunnel-client --lines 50
pm2 restart go-tunnel go-tunnel-client
```

## Change forward target

Edit `TARGET_URL` in `deploy/pm2.ecosystem.config.cjs`, redeploy, then:

```bash
pm2 restart go-tunnel-client --update-env
```

Examples:
- Nest API: `http://127.0.0.1:3000`
- Laravel: `http://127.0.0.1:4000`
- Another app: `http://127.0.0.1:8080`

## Verify

```bash
curl -sI https://go.tejarahlntpoor.com/board | head
curl -s https://go.tejarahlntpoor.com/api/status | jq
curl -s https://go.tejarahlntpoor.com/health
```

Expected board headers: `x-go-board: 1`

### Payload link (`/probe`)

Ngrok-style payload URL — **HTTP 200** on the phone. Only **`GET /probe`** is stored in SQLite history (append-only).

| URL | Stored? |
|-----|---------|
| `https://go.tejarahlntpoor.com/probe` | Yes |
| `https://go.tejarahlntpoor.com/probe.json` | No (ephemeral JSON only) |
| `https://go.tejarahlntpoor.com/board` | No |
| Tunneled `/health`, `/hook/*` | No |

```bash
curl -sI "https://go.tejarahlntpoor.com/probe?run=test" | grep -iE 'HTTP|x-go-probe'
curl -s https://go.tejarahlntpoor.com/api/status | jq '{traffic,sqlitePath,payloadPath,appendOnly}'
curl -s "https://go.tejarahlntpoor.com/api/traffic?limit=5" | jq '.items[].path'

# Delete is disabled (404)
curl -sX DELETE https://go.tejarahlntpoor.com/api/traffic
```

Board: **Copy payload link** generates `…/probe?run=<timestamp>`.

SQLite file on server: `/opt/go-tunnel/data/visits.db`

## Troubleshooting

| Issue | Fix |
|-------|-----|
| Board shows main site | Hard refresh; use `/board` URL |
| 503 no_client_connected | `pm2 restart go-tunnel-client` |
| Upstream 502 | Check `TARGET_URL` app is running (`pm2 list`) |
| History empty after deploy | First deploy migrates from `traffic.ndjson` if present; open `/probe` to create rows |
| WS disconnects | Check nginx `proxy_read_timeout` (3600s) |
