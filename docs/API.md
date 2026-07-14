# API reference

Base: `https://go.tejarahlntpoor.com`

## Status

### `GET /api/status`

```json
{
  "ok": true,
  "publicUrl": "https://go.tejarahlntpoor.com",
  "boardUrl": "https://go.tejarahlntpoor.com/board",
  "payloadPath": "/probe",
  "payloadUrl": "https://go.tejarahlntpoor.com/probe",
  "sqlitePath": "/opt/go-tunnel/data/visits.db",
  "wsUrl": "wss://go.tejarahlntpoor.com/ws",
  "targetUrl": "http://127.0.0.1:3000",
  "clients": 1,
  "pending": 0,
  "traffic": 42,
  "listLimit": 200,
  "uptimeSec": 3600,
  "persisted": true,
  "appendOnly": true
}
```

## Traffic history

### `GET /api/traffic`

Query params:

| Param | Default | Max |
|-------|---------|-----|
| `limit` | 200 | 500 |
| `offset` | 0 | — |

Response:

```json
{
  "items": [ /* traffic records */ ],
  "count": 42,
  "limit": 200,
  "offset": 0,
  "listLimit": 200,
  "appendOnly": true
}
```

Only **payload path** visits (`GET /probe` by default) appear in history. Board loads, API calls, tunneled upstream paths, and `/probe.json` are not stored.

### `GET /api/traffic/:id`

Single record.

### `POST /api/traffic/:id/replay`

Re-send captured payload request through the tunnel. Does **not** create a new history row. Returns:

```json
{
  "ok": true,
  "status": 200,
  "replayOf": "original-uuid",
  "tunnelId": "ephemeral-tunnel-request-id"
}
```

History is **append-only** — there is no delete endpoint.

### Downloads

| Endpoint | Format |
|----------|--------|
| `GET /api/traffic/export.json` | Full history JSON attachment |
| `GET /api/traffic/export.ndjson` | NDJSON stream |
| `GET /api/traffic/:id/download.json` | Single record JSON |
| `GET /api/traffic/:id/download.body` | Raw request body bytes |

## WebSocket

### Agent: `wss://go.tejarahlntpoor.com/ws`

Server → client:

```json
{
  "type": "request",
  "id": "...",
  "method": "POST",
  "path": "/hook",
  "headers": {},
  "body": "...",
  "ip": "...",
  "ipChain": [],
  "geo": { "city": "…", "country_code": "SA", "latitude": "…", "longitude": "…" },
  "userAgent": { "name": "Chrome", "os": "macOS", "is_bot": false },
  "visitor": { "conn": { }, "req": { } }
}
```

`visitor` mirrors ngrok Traffic Policy fields (`conn.*`, `conn.geo.*`, `conn.client_ip.*`, `req.user_agent.*`). Geo/ASN may still be enriching when the agent first receives the event; the board updates live when lookup completes.

Client → server:

```json
{ "type": "response", "id": "...", "status": 200, "headers": {}, "bodyBase64": "..." }
```

### Dashboard: `wss://go.tejarahlntpoor.com/ws/dashboard`

Live events:

- `{ "type": "status", ... }`
- `{ "type": "traffic", "entry": { ... } }`
- `{ "type": "traffic_update", "entry": { ... } }`

## Public tunnel

Any path **not** listed as board/API/WS/payload is forwarded:

```bash
curl https://go.tejarahlntpoor.com/health
curl -X POST https://go.tejarahlntpoor.com/api/auth/login -H "Content-Type: application/json" -d '{}'
```

Tunneled upstream responses are **not** stored in history (payload-only policy).
