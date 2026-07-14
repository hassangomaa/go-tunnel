# Implementation history

Chronological record of how **go.tejarahlntpoor.com** became an ngrok-style VPS tunnel with full traffic inspect.

## Phase 1 — SSH + subdomain (Jul 14, 2026)

- Domain `go.tejarahlntpoor.com` DNS → `187.124.9.225`
- Root SSH key auth configured (`~/.ssh/cursor_ttakka`)
- Initial nginx vhost + Let's Encrypt SSL for `go.tejarahlntpoor.com`

## Phase 2 — Basic tunnel (ngrok-style listener)

- Built `/opt/go-tunnel` on VPS
- Public HTTP → WebSocket → local client waits and responds
- PM2 process `go-tunnel` on `127.0.0.1:4055`
- First inspect page at `/` (later moved to `/board`)

## Phase 3 — Inspect board v1

- Live traffic list + request inspector
- WebSocket feed at `/ws/dashboard`
- Capture: method, path, IP, headers, body, response, latency
- Export JSON / NDJSON / per-request downloads
- No authentication (open board)

## Phase 4 — Board routing fix

**Problem:** Visiting `go.tejarahlntpoor.com` showed the main Arabic marketing site (Nest on `:3000`) or tunneled `/board` to the WS client.

**Fix:**
- Reserved paths never tunneled: `/`, `/board`, `/dashboard`, `/inspect`, `/api/*`, `/ws*`
- Nginx split: board paths vs tunnel paths → always `127.0.0.1:4055`
- Canonical board URL: **https://go.tejarahlntpoor.com/board**

## Phase 5 — Ngrok VPS plan (final)

### Decisions

| Decision | Choice |
|----------|--------|
| Forward target | VPS app only (`http://127.0.0.1:3000`) |
| History depth | ~10,000 requests persisted on disk |
| Auth | None on board |

### Implemented

1. **VPS forward mode** (`client.js`)
   - Default `TARGET_URL=http://127.0.0.1:3000`
   - Forwards method, path, query, headers, body to upstream
   - Sets `X-Forwarded-For`, `X-Real-IP`, `X-Forwarded-Proto`
   - Saves each event under `/opt/go-tunnel/inbox/`
   - PM2: `go-tunnel-client`

2. **10k traffic history** (`server.js`)
   - `MAX_EVENTS=10000`
   - Persist: `/opt/go-tunnel/data/traffic.ndjson` (append + compact at 12k lines)
   - In-memory index for fast list + live dashboard
   - Pagination: `GET /api/traffic?limit=200&offset=0`

3. **Board UX**
   - Header: public URL, forward target, agent online, request count
   - Tabs: Payload / Response / Headers / Raw
   - Replay: `POST /api/traffic/:id/replay`
   - Copy URL, export, load more, send test

4. **Nginx + PM2 frozen**
   - `go-tunnel` — board + relay
   - `go-tunnel-client` — forward agent
   - README on server at `/opt/go-tunnel/README.md`

## Verification results (Jul 14, 2026)

| Check | Result |
|-------|--------|
| `/board` → 200, inspect UI | Pass |
| Not main Arabic site | Pass |
| `GET /health` → Nest response, tunneled | Pass |
| IP + payload + headers in history | Pass |
| Export JSON / NDJSON | Pass |
| Replay API | Pass |
| History survives PM2 restart | Pass |
| Pagination API | Pass |

## Phase 6 — Visitor intel (ngrok parity)

Collects connection + client metadata on every tunneled request, aligned with ngrok:

- `conn.client_ip`, client/server ports, bytes in/out
- `conn.geo.*` — city, country, country_code, lat/lon, subdivision
- `conn.client_ip.*` — ASN, ISP/org, categories (proxy/hosting/mobile/tor), EU flag, timezone, postal
- `req.user_agent.*` — name, version, OS, device, mobile/tablet/desktop/bot
- URL, host, scheme, query params, cookies, Accept-Language, Referer

Source: Cloudflare/CDN header hints (instant) + `ip-api.com` lookup (cached, async). Board **Visitor** tab + list geo line. Module: `lib/visitor.js`.

## Out of scope (by design)

- Laptop/local ngrok CLI as primary agent
- Reverse shell / remote command execution
- Multi-tenant tunnels / auth on board
- Multi-subdomain accounts

## Related paths

| Location | Path |
|----------|------|
| Local project | `/Users/hassangomaa/Projects/go-tunnel` |
| VPS production | `/opt/go-tunnel` |
| Traffic store | `/opt/go-tunnel/data/traffic.ndjson` |
| Agent inbox | `/opt/go-tunnel/inbox/` |
