# go-tunnel

Ngrok-style public HTTPS tunnel for **go.tejarahlntpoor.com** — forwards traffic to a VPS app, with a live inspect board, **visitor geo/IP intelligence**, and **~10k persisted traffic history**.

## Live URLs

| Role | URL |
|------|-----|
| **Inspect board** | https://go.tejarahlntpoor.com/board |
| Dashboard alias | https://go.tejarahlntpoor.com/dashboard |
| Public tunnel | https://go.tejarahlntpoor.com/* |
| Status API | https://go.tejarahlntpoor.com/api/status |
| WS agent | wss://go.tejarahlntpoor.com/ws |

## How it works

```
Internet → Nginx (go.tejarahlntpoor.com) → go-tunnel :4055
  ├─ /board, /api, /ws  → inspect UI + APIs (never tunneled)
  └─ everything else      → WebSocket → go-tunnel-client → TARGET_URL
```

Default forward target: **`http://127.0.0.1:3000`** (Muqraa Nest API on the same VPS).

## Quick test

```bash
curl https://go.tejarahlntpoor.com/health
curl https://go.tejarahlntpoor.com/api/status
open https://go.tejarahlntpoor.com/board
```

## Project layout

```
go-tunnel/
├── server.js          # Board + relay + history (port 4055)
├── client.js          # VPS forward agent (WS → TARGET_URL)
├── lib/visitor.js     # ngrok-style geo / ASN / UA enrichment
├── package.json
├── data/              # traffic.ndjson (up to 10k records)
├── inbox/             # per-request dumps from client agent
├── deploy/
│   ├── deploy.sh
│   ├── pm2.ecosystem.config.cjs
│   └── nginx/go.tejarahlntpoor.com.conf
└── docs/
    ├── HISTORY.md     # full implementation timeline
    ├── ARCHITECTURE.md
    ├── API.md
    └── DEPLOYMENT.md
```

## Visitor intel (ngrok parity)

Every tunneled request records:

- Geolocation: city, country, country code, lat/lon, subdivision, timezone, EU flag
- IP intelligence: ASN, ISP/org, proxy/hosting/mobile/tor categories
- Client: User-Agent parse (browser, OS, device, bot/mobile/desktop)
- Connection: client IP/port, scheme, host, query, cookies, Accept-Language, Referer

Shown on the board **Visitor** tab. Geo lookup is async (does not slow the tunnel).
## Local run

```bash
npm install
# Terminal 1 — board
PORT=4055 TARGET_URL=http://127.0.0.1:3000 node server.js
# Terminal 2 — forward agent
TARGET_URL=http://127.0.0.1:3000 GO_WS=ws://127.0.0.1:4055/ws node client.js
```

## Deploy to VPS

```bash
chmod +x deploy/deploy.sh
./deploy/deploy.sh
```

Server path: `/opt/go-tunnel` on `187.124.9.225`

## Export traffic history

- All JSON: https://go.tejarahlntpoor.com/api/traffic/export.json
- NDJSON: https://go.tejarahlntpoor.com/api/traffic/export.ndjson
- Per request: `/api/traffic/:id/download.json` and `/download.body`

## Docs

- [Implementation history](docs/HISTORY.md)
- [Architecture](docs/ARCHITECTURE.md)
- [API reference](docs/API.md)
- [Deployment](docs/DEPLOYMENT.md)

## Server

| Item | Value |
|------|-------|
| Host | `187.124.9.225` (`srv1381766`) |
| PM2 | `go-tunnel`, `go-tunnel-client` |
| Nginx | `/etc/nginx/sites-available/go.tejarahlntpoor.com` |
| SSL | Let's Encrypt `go.tejarahlntpoor.com` |
| SSH | `ssh -i ~/.ssh/cursor_ttakka root@187.124.9.225` |
