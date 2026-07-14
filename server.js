'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { randomUUID } = require('crypto');
const { collectVisitor, enrichVisitor } = require('./lib/visitor');
const { createStore } = require('./lib/store');
const { shouldTrackVisit, PAYLOAD_PATH } = require('./lib/trackable');

const PORT = Number(process.env.PORT || 4055);
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 30000);
const LIST_LIMIT = Number(process.env.LIST_LIMIT || 200);
const MAX_BODY = 10 * 1024 * 1024;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC_URL = process.env.PUBLIC_URL || 'https://go.tejarahlntpoor.com';
const TARGET_URL = process.env.TARGET_URL || 'http://127.0.0.1:3000';
const PAYLOAD_URL = `${PUBLIC_URL}${PAYLOAD_PATH}`;

fs.mkdirSync(DATA_DIR, { recursive: true });

const store = createStore({ dataDir: DATA_DIR });
const bootCache = store.loadRecentIntoCache(500);

/** @type {Map<string, import('ws').WebSocket>} */
const tunnelClients = new Map();
/** @type {Set<import('ws').WebSocket>} */
const dashboards = new Set();
/** @type {Map<string, { resolve: Function, reject: Function, timer: NodeJS.Timeout }>} */
const pending = new Map();
/** @type {Map<string, object>} id -> latest record (live enrich cache) */
const trafficById = bootCache.cache;
/** @type {string[]} ordered ids newest first */
let trafficOrder = bootCache.order;

function getVisit(id) {
  return trafficById.get(id) || store.getVisit(id);
}

function pushTraffic(entry) {
  store.insertVisit(entry);
  trafficById.set(entry.id, entry);
  if (!trafficOrder.includes(entry.id)) trafficOrder.unshift(entry.id);
  broadcastDash({ type: 'traffic', entry });
  return entry;
}

function updateTraffic(id, patch) {
  const row = store.updateVisit(id, patch);
  if (!row) return null;
  trafficById.set(id, row);
  broadcastDash({ type: 'traffic_update', entry: row });
  return row;
}

function broadcastDash(msg) {
  const raw = JSON.stringify(msg);
  for (const ws of dashboards) {
    if (ws.readyState === 1) {
      try {
        ws.send(raw);
      } catch (_) {}
    }
  }
}

function clientIp(req) {
  const h = req.headers || {};
  const chain = [];
  if (h['cf-connecting-ip']) chain.push(String(h['cf-connecting-ip']));
  if (h['true-client-ip']) chain.push(String(h['true-client-ip']));
  if (h['x-real-ip']) chain.push(String(h['x-real-ip']));
  String(h['x-forwarded-for'] || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .forEach((ip) => chain.push(ip));
  if (req.socket && req.socket.remoteAddress) chain.push(String(req.socket.remoteAddress));
  const uniq = [];
  for (let ip of chain) {
    if (ip.startsWith('::ffff:')) ip = ip.slice(7);
    if (ip && !uniq.includes(ip)) uniq.push(ip);
  }
  return { ip: uniq[0] || '', ipChain: uniq };
}

function pickClient() {
  for (const [, ws] of tunnelClients) {
    if (ws.readyState === 1) return ws;
  }
  return null;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS,HEAD',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function statusPayload() {
  return {
    ok: true,
    publicUrl: PUBLIC_URL,
    boardUrl: `${PUBLIC_URL}/board`,
    probeUrl: PAYLOAD_URL,
    payloadPath: PAYLOAD_PATH,
    payloadUrl: PAYLOAD_URL,
    sqlitePath: store.sqlitePath,
    wsUrl: `${PUBLIC_URL.replace('https://', 'wss://').replace('http://', 'ws://')}/ws`,
    targetUrl: TARGET_URL,
    clients: tunnelClients.size,
    pending: pending.size,
    traffic: store.countVisits(),
    listLimit: LIST_LIMIT,
    uptimeSec: Math.floor(process.uptime()),
    persisted: true,
    appendOnly: true,
  };
}

/**
 * Build a probe/payload visit snapshot. Persists only when track=true and path matches payload.
 */
function recordProbeVisit(req, url, { track = true } = {}) {
  const { ip, ipChain } = clientIp(req);
  const reqPath = url.pathname + url.search;
  const id = randomUUID();
  const visitor = collectVisitor(req, { ip, ipChain, bodyBytes: 0, urlObj: url });

  const entry = {
    id,
    at: new Date().toISOString(),
    method: req.method || 'GET',
    path: reqPath,
    ip,
    ipChain,
    visitor,
    geo: visitor.conn.geo,
    userAgent: visitor.req.user_agent,
    reqHeaders: req.headers,
    reqBody: '',
    reqBodyBase64: '',
    reqBytes: 0,
    status: 200,
    resHeaders: { 'content-type': 'text/html; charset=utf-8', 'x-go-probe': '1' },
    resBody: '',
    durationMs: 0,
    tunneled: false,
    probe: true,
    error: null,
    replayOf: null,
  };

  const persist = track && shouldTrackVisit(url.pathname, req.method);
  if (persist) {
    pushTraffic(entry);
    enrichVisitor(visitor)
      .then((enriched) => {
        updateTraffic(id, {
          visitor: enriched,
          geo: enriched.conn.geo,
          userAgent: enriched.req.user_agent,
        });
      })
      .catch(() => {});
  }

  return entry;
}

function probeHtml(entryId) {
  const boardUrl = `${PUBLIC_URL}/board`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>go probe · visitor captured</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=Outfit:wght@400;500;600;700&display=swap" rel="stylesheet" />
  <style>
    :root{--bg0:#0b0d10;--bg1:#12151b;--bg2:#181c24;--line:#2c3442;--text:#f2f5fa;--muted:#93a0b5;--faint:#66748a;--orange:#ff6a3d;--green:#3dd68c}
    *{box-sizing:border-box}html,body{margin:0;min-height:100%}
    body{font-family:Outfit,system-ui,sans-serif;color:var(--text);background:radial-gradient(900px 420px at 0% -10%,rgba(255,106,61,.16),transparent 55%),linear-gradient(180deg,#0e1116 0%,var(--bg0) 100%);padding:24px 16px 48px}
    .wrap{max-width:560px;margin:0 auto}
    .mark{width:44px;height:44px;border-radius:12px;background:linear-gradient(145deg,#ff8f66,var(--orange) 60%,#d94820);display:grid;place-items:center;font-family:"IBM Plex Mono",monospace;font-weight:700;font-size:14px;margin-bottom:16px}
    h1{margin:0 0 6px;font-size:22px;font-weight:650}
    .sub{color:var(--muted);font-size:13px;margin-bottom:20px;line-height:1.5}
    .ok{display:inline-flex;align-items:center;gap:8px;padding:8px 14px;border-radius:999px;background:rgba(61,214,140,.12);border:1px solid rgba(61,214,140,.35);color:var(--green);font-size:12px;font-weight:600;margin-bottom:20px}
    .grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:20px}
    .card{border:1px solid var(--line);border-radius:12px;background:var(--bg1);padding:12px}
    .card .l{color:var(--faint);font-size:10px;text-transform:uppercase;letter-spacing:.08em}
    .card .v{margin-top:6px;font-family:"IBM Plex Mono",monospace;font-size:12px;word-break:break-all}
    .card.wide{grid-column:1/-1}
    .actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:20px}
    a.btn{display:inline-flex;align-items:center;height:36px;padding:0 14px;border-radius:10px;border:1px solid var(--line);background:var(--bg2);color:var(--text);text-decoration:none;font-size:13px;font-weight:500}
    a.btn.primary{background:var(--orange);border-color:transparent;color:#fff}
    .spin{color:var(--muted);font-size:13px}
    .err{color:#ff6b7a;font-size:13px}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="mark">go</div>
    <h1>Visitor captured</h1>
    <p class="sub">Diagnostic probe on <strong>${PUBLIC_URL.replace(/https?:\/\//, '')}</strong>. Request logged on the inspect board with IP geolocation and client metadata (ngrok-style).</p>
    <div class="ok" id="statusBadge">HTTP 200 · recording</div>
    <div class="grid" id="grid">
      <div class="card"><div class="l">Request ID</div><div class="v" id="reqId">${entryId}</div></div>
      <div class="card"><div class="l">Public IP</div><div class="v" id="ip">…</div></div>
      <div class="card"><div class="l">Client</div><div class="v" id="client">…</div></div>
      <div class="card"><div class="l">Location</div><div class="v" id="loc">enriching…</div></div>
      <div class="card"><div class="l">Lat / Lon</div><div class="v" id="coords">…</div></div>
      <div class="card"><div class="l">ISP / ASN</div><div class="v" id="isp">…</div></div>
      <div class="card wide"><div class="l">Timezone · Categories</div><div class="v" id="meta">…</div></div>
    </div>
    <p class="spin" id="hint">Resolving geo / ASN…</p>
    <div class="actions">
      <a class="btn primary" href="${boardUrl}" target="_blank" rel="noopener">Open inspect board</a>
      <a class="btn" href="/probe.json?id=${entryId}" target="_blank" rel="noopener">Raw JSON</a>
    </div>
  </div>
  <script>
    const id=${JSON.stringify(entryId)};
    const $=i=>document.getElementById(i);
    function locLabel(loc){
      if(!loc)return '—';
      return [loc.city,loc.subdivision,loc.country||loc.country_code].filter(Boolean).join(', ')||'—';
    }
    function render(ev){
      const v=ev.visitor||{};
      const conn=v.conn||{};
      const intel=conn.client_ip_intel||{};
      const loc=(intel.geo&&intel.geo.location)||conn.geo||ev.geo||{};
      const ua=ev.userAgent||(v.req&&v.req.user_agent)||{};
      const st=intel.enrich_status||'pending';
      $('ip').textContent=ev.ip||'—';
      $('client').textContent=[ua.name,ua.version,ua.os,ua.os_version].filter(Boolean).join(' · ')||ua.raw||'—';
      $('loc').textContent=locLabel(loc);
      $('coords').textContent=(loc.latitude&&loc.longitude)?(loc.latitude+' / '+loc.longitude):'—';
      $('isp').textContent=[intel.isp,intel.org,(intel.as&&intel.as.number)?'AS'+intel.as.number:'',intel.as&&intel.as.organization].filter(Boolean).join(' · ')||'—';
      $('meta').textContent=[loc.timezone,(intel.categories||[]).join(', ')].filter(Boolean).join(' · ')||'—';
      if(st==='ok'||st==='skipped'||st==='error'){
        $('hint').textContent=st==='ok'?'Geo enrichment complete.':'Enrichment '+st+(intel.enrich_error?': '+intel.enrich_error:'');
        $('statusBadge').textContent='HTTP 200 · captured';
        if(st==='error')$('hint').className='err';
        return true;
      }
      return false;
    }
    async function poll(){
      for(let i=0;i<24;i++){
        try{
          const r=await fetch('/api/traffic/'+encodeURIComponent(id));
          if(!r.ok)throw new Error('not found');
          const ev=await r.json();
          if(render(ev))return;
        }catch(e){}
        await new Promise(r=>setTimeout(r,500));
      }
      $('hint').textContent='Geo still pending — open the board for live updates.';
    }
    poll();
  </script>
</body>
</html>`;
}

async function tunnelRequest(opts) {
  const {
    method,
    path: reqPath,
    headers,
    bodyBuf,
    ip,
    ipChain,
    req = null,
    urlObj = null,
    replayOf = null,
    visitorSeed = null,
  } = opts;

  const id = randomUUID();
  const started = Date.now();
  const reqBodyText = bodyBuf.length ? bodyBuf.toString('utf8') : '';

  const visitor =
    visitorSeed ||
    (req
      ? collectVisitor(req, { ip, ipChain, bodyBytes: bodyBuf.length, urlObj })
      : collectVisitor({ method, headers, url: reqPath, httpVersion: '1.1', socket: null }, {
          ip,
          ipChain,
          bodyBytes: bodyBuf.length,
          urlObj,
        }));

  const payload = {
    type: 'request',
    id,
    method,
    path: reqPath,
    headers,
    body: reqBodyText,
    bodyBase64: bodyBuf.length ? bodyBuf.toString('base64') : '',
    ip,
    ipChain,
    visitor,
    geo: visitor.conn.geo,
    userAgent: visitor.req.user_agent,
    at: new Date().toISOString(),
    bytes: bodyBuf.length,
    replayOf,
  };

  const client = pickClient();
  if (!client) {
    const errBody = { error: 'no_client_connected', id };
    return { id, status: 503, body: errBody, headers: { 'content-type': 'application/json' } };
  }

  const responsePromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('client_timeout'));
    }, REQUEST_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    broadcastDash({ type: 'status', ...statusPayload() });
  });

  try {
    client.send(JSON.stringify(payload));
  } catch (e) {
    pending.delete(id);
    return { id, status: 502, body: { error: 'failed_to_send_to_client' }, headers: {} };
  }

  try {
    const reply = await responsePromise;
    const status = Number(reply.status) || 200;
    const outHeaders = Object.assign(
      { 'X-Go-Tunnel': '1', 'X-Go-Request-Id': id },
      reply.headers && typeof reply.headers === 'object' ? reply.headers : {}
    );
    delete outHeaders['content-length'];
    delete outHeaders['transfer-encoding'];

    let out;
    if (reply.bodyBase64) out = Buffer.from(reply.bodyBase64, 'base64');
    else if (typeof reply.body === 'string') out = Buffer.from(reply.body, 'utf8');
    else if (reply.body != null) out = Buffer.from(JSON.stringify(reply.body), 'utf8');
    else out = Buffer.alloc(0);

    broadcastDash({ type: 'status', ...statusPayload() });
    return { id, status, body: out, headers: outHeaders };
  } catch (e) {
    const isTimeout = String(e.message) === 'client_timeout';
    const status = isTimeout ? 504 : 502;
    const body = { error: isTimeout ? 'client_timeout' : 'tunnel_failed', id };
    broadcastDash({ type: 'status', ...statusPayload() });
    return { id, status, body, headers: { 'content-type': 'application/json' } };
  }
}

async function tunnelAndRespond(res, opts) {
  const result = await tunnelRequest(opts);
  const outHeaders = Object.assign({ 'Access-Control-Allow-Origin': '*' }, result.headers || {});
  const body = Buffer.isBuffer(result.body)
    ? result.body
    : Buffer.from(typeof result.body === 'string' ? result.body : JSON.stringify(result.body), 'utf8');
  res.writeHead(result.status, outHeaders);
  res.end(body);
}

function dashboardHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>go board · inspect dashboard</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=Outfit:wght@400;500;600;700&display=swap" rel="stylesheet" />
  <style>
    :root{--bg0:#0b0d10;--bg1:#12151b;--bg2:#181c24;--bg3:#1f2530;--line:#2c3442;--text:#f2f5fa;--muted:#93a0b5;--faint:#66748a;--orange:#ff6a3d;--orange2:#ff8f66;--green:#3dd68c;--yellow:#f5c542;--red:#ff6b7a;--blue:#5b9dff;--purple:#b48cff}
    *{box-sizing:border-box}html,body{height:100%;margin:0}
    body{font-family:Outfit,system-ui,sans-serif;color:var(--text);overflow:hidden;background:radial-gradient(900px 420px at 0% -10%,rgba(255,106,61,.16),transparent 55%),radial-gradient(700px 360px at 100% 0%,rgba(91,157,255,.10),transparent 50%),linear-gradient(180deg,#0e1116 0%,var(--bg0) 100%)}
    .app{height:100%;display:grid;grid-template-rows:72px 52px minmax(0,1fr)}
    .top{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:0 20px;border-bottom:1px solid var(--line);background:rgba(11,13,16,.72);backdrop-filter:blur(14px)}
    .brand{display:flex;align-items:center;gap:12px;min-width:0}
    .mark{width:36px;height:36px;border-radius:11px;background:linear-gradient(145deg,var(--orange2),var(--orange) 60%,#d94820);display:grid;place-items:center;font-family:"IBM Plex Mono",monospace;font-weight:700;font-size:13px}
    .brand h1{margin:0;font-size:16px;font-weight:650}
    .brand .sub{margin-top:2px;color:var(--muted);font-size:11px;font-family:"IBM Plex Mono",monospace}
    .brand a{color:var(--orange2);text-decoration:none}
    .chips{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}
    .chip{display:inline-flex;align-items:center;gap:8px;height:32px;padding:0 12px;border-radius:999px;background:var(--bg2);border:1px solid var(--line);font-size:11px;color:var(--muted)}
    .chip b{color:var(--text);font-family:"IBM Plex Mono",monospace;font-weight:600}
    .pulse{width:8px;height:8px;border-radius:50%;background:var(--red)}
    .pulse.on{background:var(--green);animation:pulse 1.8s infinite}
    @keyframes pulse{50%{transform:scale(1.15);opacity:.75}}
    .bar{display:flex;align-items:center;gap:8px;padding:0 16px;border-bottom:1px solid var(--line);background:rgba(18,21,27,.85);flex-wrap:wrap}
    .search{flex:1;min-width:160px;height:34px;border-radius:10px;border:1px solid var(--line);background:var(--bg1);color:var(--text);padding:0 12px;font-family:"IBM Plex Mono",monospace;font-size:12px}
    .btn{height:34px;padding:0 12px;border-radius:10px;border:1px solid var(--line);background:var(--bg2);color:var(--text);font:500 12px Outfit,sans-serif;cursor:pointer}
    .btn:hover{background:var(--bg3)}.btn.primary{background:var(--orange);border-color:transparent;color:#fff}
    .stage{min-height:0;display:grid;grid-template-columns:minmax(300px,400px) minmax(0,1fr)}
    @media(max-width:960px){body{overflow:auto}.app{height:auto;min-height:100%}.stage{grid-template-columns:1fr;grid-template-rows:42vh 58vh}}
    .pane{min-height:0;overflow:auto;border-right:1px solid var(--line)}.pane.detail{border-right:0}
    .pane-h{position:sticky;top:0;z-index:3;height:42px;display:flex;align-items:center;justify-content:space-between;padding:0 14px;background:rgba(18,21,27,.94);border-bottom:1px solid var(--line);font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--faint)}
    .row{display:grid;grid-template-columns:70px minmax(0,1fr) 56px;gap:10px;padding:12px 14px;cursor:pointer;border-bottom:1px solid rgba(44,52,66,.7)}
    .row:hover{background:rgba(255,255,255,.02)}.row.active{background:rgba(255,106,61,.10);box-shadow:inset 3px 0 0 var(--orange)}
    .m{font-family:"IBM Plex Mono",monospace;font-size:11px;font-weight:600}
    .m.GET{color:var(--blue)}.m.POST{color:var(--green)}.m.PUT{color:var(--yellow)}.m.DELETE{color:var(--red)}
    .p{font-family:"IBM Plex Mono",monospace;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .meta{margin-top:5px;display:flex;gap:10px;color:var(--faint);font-size:11px;font-family:"IBM Plex Mono",monospace}
    .st{font-family:"IBM Plex Mono",monospace;font-size:12px;font-weight:600;text-align:right}
    .st.s2{color:var(--green)}.st.s3{color:var(--yellow)}.st.s4,.st.s5{color:var(--red)}.st.s0{color:var(--faint)}
    .empty{padding:56px 24px;text-align:center;color:var(--muted)}
    .empty h2{margin:0 0 8px;color:var(--text)}
    .detail-body{padding:16px 18px 40px}
    .hero{display:flex;justify-content:space-between;gap:12px;padding:14px;border:1px solid var(--line);border-radius:14px;background:var(--bg2);margin-bottom:14px}
    .hero .title{font-family:"IBM Plex Mono",monospace;font-size:14px;font-weight:600}
    .badges{display:flex;gap:6px;flex-wrap:wrap}
    .badge{height:26px;padding:0 10px;border-radius:999px;border:1px solid var(--line);font-size:11px;color:var(--muted);font-family:"IBM Plex Mono",monospace;display:inline-flex;align-items:center}
    .badge.good{color:var(--green)}.badge.bad{color:var(--red)}
    .grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin-bottom:14px}
    .grid-6{grid-template-columns:repeat(3,minmax(0,1fr))}
    .card{border:1px solid var(--line);border-radius:12px;background:var(--bg1);padding:12px}
    .card .l{color:var(--faint);font-size:11px;text-transform:uppercase}
    .card .v{margin-top:6px;font-family:"IBM Plex Mono",monospace;font-size:12px;word-break:break-all}
    .geo-flag{font-size:18px;margin-right:6px;vertical-align:middle}
    .tabs,.actions{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px}
    .tab{height:30px;padding:0 11px;border-radius:9px;border:1px solid transparent;background:transparent;color:var(--muted);cursor:pointer}
    .tab.active{background:var(--bg2);border-color:var(--line);color:var(--text)}
    pre.block{margin:0;padding:14px;border-radius:12px;border:1px solid var(--line);background:#090b0e;color:#dbe3f0;font-family:"IBM Plex Mono",monospace;font-size:12px;overflow:auto;max-height:min(52vh,560px);white-space:pre-wrap}
    .toast{position:fixed;right:16px;bottom:16px;z-index:20;padding:11px 13px;border-radius:12px;background:var(--bg2);border:1px solid var(--line);font-size:12px;opacity:0;transition:.18s}
    .toast.show{opacity:1}
  </style>
</head>
<body>
  <div class="app">
    <header class="top">
      <div class="brand">
        <div class="mark">go</div>
        <div>
          <h1>Inspect Board</h1>
          <div class="sub">Public: <a id="publicLink" href="/" target="_blank">…</a></div>
          <div class="sub">Forward → <b id="targetUrl">…</b> · <a href="/board">/board</a> · <a href="/dashboard">/dashboard</a></div>
        </div>
      </div>
      <div class="chips">
        <div class="chip"><span class="pulse" id="liveDot"></span> agent <b id="clientCount">0</b></div>
        <div class="chip">history <b id="reqCount">0</b></div>
        <div class="chip">pending <b id="pendingCount">0</b></div>
        <div class="chip">feed <b id="liveState">…</b></div>
      </div>
    </header>
    <div class="bar">
      <input class="search" id="filter" placeholder="Filter method · path · status · ip · country · city…" />
      <button class="btn" id="btnLoadMore" type="button">Load more</button>
      <button class="btn" id="btnExportJson" type="button">JSON</button>
      <button class="btn" id="btnExportNdjson" type="button">NDJSON</button>
      <button class="btn" id="btnCopyUrl" type="button">Copy URL</button>
      <button class="btn" id="btnCopyProbe" type="button">Copy payload link</button>
      <button class="btn primary" id="btnTest" type="button">Test</button>
    </div>
    <div class="stage">
      <aside class="pane"><div class="pane-h"><span>HTTP History</span><span id="listMeta">0</span></div><div id="list"></div></aside>
      <section class="pane detail"><div class="pane-h"><span>Inspector</span><span id="detailMeta">select</span></div><div class="detail-body" id="detail"><div class="empty"><h2>Waiting for payload visits</h2><p id="emptyHint">Open the payload link (<a href="/probe">/probe</a>) from a device — only payload hits are recorded.</p></div></div></section>
    </div>
  </div>
  <div class="toast" id="toast"></div>
  <script>
    const state={items:[],selectedId:null,filter:'',tab:'visitor',offset:0,limit:200,total:0,status:null};
    const $=id=>document.getElementById(id);
    const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    function toast(m){const el=$('toast');el.textContent=m;el.classList.add('show');clearTimeout(toast._t);toast._t=setTimeout(()=>el.classList.remove('show'),1800)}
    function stClass(c){if(!c)return 's0';if(c<300)return 's2';if(c<400)return 's3';return 's4'}
    function fmtTime(iso){try{return new Date(iso).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'})}catch{return iso}}
    function pretty(v){if(v==null||v==='')return '—';if(typeof v==='object')return JSON.stringify(v,null,2);const s=String(v);try{return JSON.stringify(JSON.parse(s),null,2)}catch{return s}}
    function filtered(){const q=state.filter.trim().toLowerCase();if(!q)return state.items;return state.items.filter(it=>{
      const geo=it.geo||(it.visitor&&it.visitor.conn&&it.visitor.conn.geo)||{};
      const ua=it.userAgent||(it.visitor&&it.visitor.req&&it.visitor.req.user_agent)||{};
      const intel=it.visitor&&it.visitor.conn&&it.visitor.conn.client_ip_intel||{};
      return [it.method,it.path,it.ip,String(it.status||''),it.reqBody||'',geo.country,geo.country_code,geo.city,geo.subdivision,ua.name,ua.os,ua.raw,intel.isp,intel.org,(intel.as&&intel.as.organization)||''].join(' ').toLowerCase().includes(q);
    })}
    function geoLine(it){
      const geo=it.geo||(it.visitor&&it.visitor.conn&&it.visitor.conn.geo)||{};
      const parts=[geo.city,geo.subdivision,geo.country_code||geo.country].filter(Boolean);
      return parts.length?parts.join(', '):'';
    }
    function visitorSummary(it){
      const v=it.visitor||{};
      const conn=v.conn||{};
      const intel=conn.client_ip_intel||{};
      const loc=(intel.geo&&intel.geo.location)||conn.geo||it.geo||{};
      const ua=it.userAgent||(v.req&&v.req.user_agent)||{};
      const as=intel.as||{};
      const cats=(intel.categories||[]).join(', ')||'—';
      const flags=[intel.is_tor_node?'TOR':'',intel.is_on_blocklist?'blocklist':'',(intel.categories||[]).includes('proxy.anonymous')?'proxy':'',(intel.categories||[]).includes('hosting')?'hosting':'',(intel.categories||[]).includes('mobile')?'mobile':''].filter(Boolean).join(' · ')||'—';
      return {loc,ua,as,cats,flags,intel,conn,req:v.req||{}};
    }
    function renderList(){
      const rows=filtered();$('listMeta').textContent=rows.length+' / '+state.total;$('reqCount').textContent=String(state.total);
      const list=$('list');
      if(!rows.length){list.innerHTML='<div class="empty"><h2>No payload visits</h2><p id="emptyList">Open the payload link (<a href="/probe">/probe</a>) from a device. Board views are not tracked.</p></div>';return}
      list.innerHTML=rows.map(it=>{
        const active=it.id===state.selectedId?'active':'';
        const st=it.status!=null?it.status:(it.error?'ERR':'…');
        const replay=it.replayOf?' ↺':'';
        const g=geoLine(it);
        return '<div class="row '+active+'" data-id="'+esc(it.id)+'"><div class="m '+esc(it.method)+'">'+esc(it.method)+'</div><div><div class="p">'+esc(it.path)+replay+'</div><div class="meta"><span>'+esc(fmtTime(it.at))+'</span><span>'+esc(it.ip||'—')+'</span><span>'+esc(g||'…')+'</span><span>'+(it.durationMs!=null?it.durationMs+'ms':'—')+'</span></div></div><div class="st '+stClass(it.status)+'">'+esc(st)+'</div></div>';
      }).join('');
      list.querySelectorAll('.row').forEach(el=>el.addEventListener('click',()=>{state.selectedId=el.dataset.id;renderList();renderDetail()}));
    }
    function renderDetail(){
      const it=state.items.find(x=>x.id===state.selectedId);const root=$('detail');
      if(!it){$('detailMeta').textContent='select';root.innerHTML='<div class="empty"><h2>No selection</h2><p id="emptyHint">Payload visits appear here with geo and ASN. Opening this board does not create history rows.</p></div>';return}
      $('detailMeta').textContent=it.method+' '+it.path;
      const tab=state.tab;
      const tun=it.probe?'<span class="badge good">probe</span>':(it.tunneled?'<span class="badge good">tunneled</span>':'<span class="badge bad">failed</span>');
      const vs=visitorSummary(it);
      const locLabel=[vs.loc.city,vs.loc.subdivision,vs.loc.country||vs.loc.country_code].filter(Boolean).join(', ')||'—';
      const uaLabel=[vs.ua.name,vs.ua.version].filter(Boolean).join(' ')||(vs.ua.raw?vs.ua.raw.slice(0,40):'—');
      root.innerHTML='<div class="hero"><div><div class="title">'+esc(it.method)+' '+esc(it.path)+'</div><div class="sub">'+esc(it.id)+(it.replayOf?' · replay of '+esc(it.replayOf):'')+'</div></div><div class="badges">'+tun+'<span class="badge">'+esc(String(it.status??it.error??'…'))+'</span>'+(vs.loc.country_code?'<span class="badge">'+esc(vs.loc.country_code)+'</span>':'')+(vs.ua.is_bot?'<span class="badge bad">bot</span>':'')+'</div></div><div class="grid"><div class="card"><div class="l">IP</div><div class="v">'+esc(it.ip||'—')+'</div></div><div class="card"><div class="l">Location</div><div class="v">'+esc(locLabel)+'</div></div><div class="card"><div class="l">Client</div><div class="v">'+esc(uaLabel)+'</div></div><div class="card"><div class="l">Duration</div><div class="v">'+esc(it.durationMs!=null?it.durationMs+' ms':'—')+'</div></div></div><div class="actions"><button class="btn primary" id="btnReplay" type="button">Replay</button><button class="btn" id="btnOpenPublic" type="button">Open public URL</button><button class="btn" id="dlOneJson" type="button">JSON</button><button class="btn" id="dlOneRaw" type="button">Raw body</button><button class="btn" id="copyPayload" type="button">Copy payload</button></div><div class="tabs"><button class="tab '+(tab==='visitor'?'active':'')+'" data-tab="visitor">Visitor</button><button class="tab '+(tab==='payload'?'active':'')+'" data-tab="payload">Payload</button><button class="tab '+(tab==='response'?'active':'')+'" data-tab="response">Response</button><button class="tab '+(tab==='headers'?'active':'')+'" data-tab="headers">Headers</button><button class="tab '+(tab==='raw'?'active':'')+'" data-tab="raw">Raw</button></div><div id="detailPanel"></div>';
      const panel=$('detailPanel');
      if(tab==='visitor'){
        const maps=(vs.loc.latitude&&vs.loc.longitude)?('<a href="https://www.openstreetmap.org/?mlat='+esc(vs.loc.latitude)+'&mlon='+esc(vs.loc.longitude)+'#map=10/'+esc(vs.loc.latitude)+'/'+esc(vs.loc.longitude)+'" target="_blank" rel="noopener">Open map</a>'):'—';
        panel.innerHTML='<div class="grid grid-6" style="margin-bottom:14px"><div class="card"><div class="l">City</div><div class="v">'+esc(vs.loc.city||'—')+'</div></div><div class="card"><div class="l">Subdivision</div><div class="v">'+esc(vs.loc.subdivision||'—')+'</div></div><div class="card"><div class="l">Country</div><div class="v">'+esc((vs.loc.country||vs.loc.country_code)?((vs.loc.country||'')+(vs.loc.country_code?' ('+vs.loc.country_code+')':'')):'—')+'</div></div><div class="card"><div class="l">Continent</div><div class="v">'+esc(vs.loc.continent||'—')+'</div></div><div class="card"><div class="l">Lat / Lon</div><div class="v">'+esc((vs.loc.latitude||'—')+' / '+(vs.loc.longitude||'—'))+'</div></div><div class="card"><div class="l">Timezone</div><div class="v">'+esc(vs.loc.timezone||'—')+'</div></div><div class="card"><div class="l">Postal</div><div class="v">'+esc(vs.loc.postal_code||'—')+'</div></div><div class="card"><div class="l">EU (GDPR)</div><div class="v">'+esc(vs.loc.is_eu?'yes':'no')+'</div></div><div class="card"><div class="l">ASN</div><div class="v">'+esc((vs.as.number?'AS'+vs.as.number+' ':'')+(vs.as.organization||'—'))+'</div></div><div class="card"><div class="l">ISP / Org</div><div class="v">'+esc([vs.intel.isp,vs.intel.org].filter(Boolean).join(' · ')||'—')+'</div></div><div class="card"><div class="l">Categories</div><div class="v">'+esc(vs.cats)+'</div></div><div class="card"><div class="l">Flags</div><div class="v">'+esc(vs.flags)+'</div></div><div class="card"><div class="l">UA name</div><div class="v">'+esc(uaLabel)+'</div></div><div class="card"><div class="l">OS / Device</div><div class="v">'+esc([vs.ua.os,vs.ua.os_version,vs.ua.device].filter(Boolean).join(' · ')||'—')+'</div></div><div class="card"><div class="l">Client port</div><div class="v">'+esc(vs.conn.client_port||'—')+'</div></div><div class="card"><div class="l">Map</div><div class="v">'+maps+'</div></div></div><pre class="block">'+esc(pretty({conn:vs.conn,req:vs.req,ip_chain:it.ipChain||(it.visitor&&it.visitor.ip_chain)||[]}))+'</pre>';
      } else {
        panel.innerHTML='<pre class="block" id="detailBlock"></pre>';
        const block=$('detailBlock');
        if(tab==='payload')block.textContent=pretty(it.reqBody);
        if(tab==='response')block.textContent=pretty(it.resBody||it.error||'');
        if(tab==='headers')block.textContent='Request\\n'+pretty(it.reqHeaders)+'\\n\\nResponse\\n'+pretty(it.resHeaders||{})+'\\n\\nIP chain\\n'+pretty(it.ipChain||[]);
        if(tab==='raw')block.textContent=pretty(it);
      }
      root.querySelectorAll('.tab').forEach(btn=>btn.addEventListener('click',()=>{state.tab=btn.dataset.tab;renderDetail()}));
      $('btnReplay').onclick=async()=>{const r=await fetch('/api/traffic/'+encodeURIComponent(it.id)+'/replay',{method:'POST'});const j=await r.json();toast('Replay → HTTP '+(j.status||r.status)+(j.tunnelId?' · tunnel '+j.tunnelId.slice(0,8):''))};
      $('btnOpenPublic').onclick=()=>{window.open((state.status&&state.status.publicUrl||'')+it.path,'_blank')};
      $('dlOneJson').onclick=()=>{location.href='/api/traffic/'+encodeURIComponent(it.id)+'/download.json'};
      $('dlOneRaw').onclick=()=>{location.href='/api/traffic/'+encodeURIComponent(it.id)+'/download.body'};
      $('copyPayload').onclick=async()=>{await navigator.clipboard.writeText(it.reqBody||'');toast('Copied')};
    }
    function upsert(entry){
      const i=state.items.findIndex(x=>x.id===entry.id);
      if(i>=0)state.items[i]=entry;else{state.items.unshift(entry);if(!state.selectedId)state.selectedId=entry.id}
      renderList();if(state.selectedId===entry.id)renderDetail();
    }
    async function loadHistory(reset){
      if(reset){state.offset=0;state.items=[]}
      const r=await fetch('/api/traffic?limit='+state.limit+'&offset='+state.offset);
      const j=await r.json();
      state.total=j.count||0;
      const merged=[...state.items];
      for(const it of j.items||[]){if(!merged.find(x=>x.id===it.id))merged.push(it)}
      state.items=merged.sort((a,b)=>new Date(b.at)-new Date(a.at));
      state.offset+=j.items.length;
      renderList();renderDetail();
    }
    function applyStatus(s){
      state.status=s;
      $('publicLink').textContent=s.publicUrl;$('publicLink').href=s.publicUrl;
      $('targetUrl').textContent=s.targetUrl||'—';
      $('clientCount').textContent=String(s.clients);$('pendingCount').textContent=String(s.pending);
      $('liveDot').classList.toggle('on',s.clients>0);
      const hint=$('emptyHint');if(hint)hint.innerHTML='Payload-only history · '+esc(s.publicUrl)+(s.payloadPath?(' · <a href="'+esc(s.payloadPath)+'">'+esc(s.payloadPath)+'</a>'):'')+(s.clients?' · agent online':' · agent offline');
    }
    async function boot(){
      const status=await fetch('/api/status').then(r=>r.json());applyStatus(status);
      await loadHistory(true);
      const ws=new WebSocket((location.protocol==='https:'?'wss:':'ws:')+'//'+location.host+'/ws/dashboard');
      ws.onopen=()=>{$('liveState').textContent='live'};
      ws.onclose=()=>{$('liveState').textContent='retry';setTimeout(boot,1200)};
      ws.onmessage=ev=>{
        const msg=JSON.parse(ev.data);
        if(msg.type==='status')applyStatus(msg);
        if(msg.type==='traffic'){upsert(msg.entry);state.total=Math.max(state.total,state.items.length)}
        if(msg.type==='traffic_update')upsert(msg.entry);
      };
    }
    $('filter').addEventListener('input',e=>{state.filter=e.target.value;renderList()});
    $('btnLoadMore').onclick=()=>loadHistory(false);
    $('btnExportJson').onclick=()=>{location.href='/api/traffic/export.json'};
    $('btnExportNdjson').onclick=()=>{location.href='/api/traffic/export.ndjson'};
    $('btnCopyUrl').onclick=async()=>{await navigator.clipboard.writeText(state.status&&state.status.publicUrl||location.origin);toast('URL copied')};
    $('btnCopyProbe').onclick=async()=>{const base=state.status&&(state.status.payloadUrl||state.status.probeUrl||state.status.publicUrl)||location.origin;const u=base.replace(/\\/?$/,'')+'?run='+Date.now();await navigator.clipboard.writeText(u);toast('Payload link copied')};
    $('btnTest').onclick=async()=>{const r=await fetch('/hook/board-test',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({t:Date.now()})});toast('Test → '+r.status)};
    boot();
  </script>
</body>
</html>`;
}

console.log(`[go-tunnel] SQLite ${store.sqlitePath} · ${store.countVisits()} payload visits loaded`);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS,HEAD',
    });
    return res.end();
  }

  if (url.pathname === '/api/status') return sendJson(res, 200, statusPayload());

  if (url.pathname === '/api/traffic' && req.method === 'GET') {
    const limit = Math.min(Number(url.searchParams.get('limit')) || LIST_LIMIT, 500);
    const offset = Math.max(Number(url.searchParams.get('offset')) || 0, 0);
    const items = store.listVisits({ offset, limit });
    return sendJson(res, 200, {
      items,
      count: store.countVisits(),
      limit,
      offset,
      listLimit: LIST_LIMIT,
      appendOnly: true,
    });
  }

  if (url.pathname === '/api/traffic/export.json') {
    const all = store.exportAll();
    const body = JSON.stringify(
      { exportedAt: new Date().toISOString(), count: all.length, items: all },
      null,
      2
    );
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': 'attachment; filename="go-traffic.json"',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    });
    return res.end(body);
  }

  if (url.pathname === '/api/traffic/export.ndjson') {
    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Content-Disposition': 'attachment; filename="go-traffic.ndjson"',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    });
    return res.end(store.exportNdjsonLines());
  }

  const replayMatch = url.pathname.match(/^\/api\/traffic\/([^/]+)\/replay$/);
  if (replayMatch && req.method === 'POST') {
    const orig = getVisit(replayMatch[1]);
    if (!orig) return sendJson(res, 404, { error: 'not_found' });
    let bodyBuf = Buffer.alloc(0);
    if (orig.reqBodyBase64) bodyBuf = Buffer.from(orig.reqBodyBase64, 'base64');
    else if (orig.reqBody) bodyBuf = Buffer.from(orig.reqBody, 'utf8');
    const { ip, ipChain } = clientIp(req);
    const result = await tunnelRequest({
      method: orig.method,
      path: orig.path,
      headers: { ...orig.reqHeaders, 'x-go-replay': '1', 'x-go-replay-of': orig.id },
      bodyBuf,
      ip: ip || orig.ip,
      ipChain: ipChain.length ? ipChain : orig.ipChain,
      req,
      replayOf: orig.id,
      visitorSeed: orig.visitor || null,
    });
    return sendJson(res, 200, {
      ok: true,
      status: result.status,
      replayOf: orig.id,
      tunnelId: result.id,
    });
  }

  const oneJson = url.pathname.match(/^\/api\/traffic\/([^/]+)\/download\.json$/);
  if (oneJson && req.method === 'GET') {
    const item = getVisit(oneJson[1]);
    if (!item) return sendJson(res, 404, { error: 'not_found' });
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="go-${item.id}.json"`,
      'Cache-Control': 'no-store',
    });
    return res.end(JSON.stringify(item, null, 2));
  }

  const oneBody = url.pathname.match(/^\/api\/traffic\/([^/]+)\/download\.body$/);
  if (oneBody && req.method === 'GET') {
    const item = getVisit(oneBody[1]);
    if (!item) return sendJson(res, 404, { error: 'not_found' });
    const buf = item.reqBodyBase64
      ? Buffer.from(item.reqBodyBase64, 'base64')
      : Buffer.from(item.reqBody || '', 'utf8');
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="go-${item.id}.bin"`,
      'Cache-Control': 'no-store',
    });
    return res.end(buf);
  }

  const oneGet = url.pathname.match(/^\/api\/traffic\/([^/]+)$/);
  if (oneGet && req.method === 'GET') {
    const item = getVisit(oneGet[1]);
    if (!item) return sendJson(res, 404, { error: 'not_found' });
    return sendJson(res, 200, item);
  }

  const boardPaths = new Set(['/', '/board', '/dashboard', '/inspect', '/favicon.ico']);
  if (boardPaths.has(url.pathname) && (req.method === 'GET' || req.method === 'HEAD')) {
    if (url.pathname === '/favicon.ico') {
      res.writeHead(204, { 'Cache-Control': 'no-store' });
      return res.end();
    }
    const html = dashboardHtml();
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      'Pragma': 'no-cache',
      'X-Go-Board': '1',
    });
    if (req.method === 'HEAD') return res.end();
    return res.end(html);
  }

  if (
    (url.pathname === PAYLOAD_PATH || url.pathname === '/probe.json') &&
    (req.method === 'GET' || req.method === 'HEAD')
  ) {
    const existingId = url.searchParams.get('id');
    if (url.pathname === '/probe.json' && existingId) {
      const item = getVisit(existingId);
      if (!item) return sendJson(res, 404, { error: 'not_found' });
      return sendJson(res, 200, item);
    }
    const track = url.pathname === PAYLOAD_PATH;
    const entry = recordProbeVisit(req, url, { track });
    if (url.pathname === '/probe.json') {
      return sendJson(res, 200, entry);
    }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      'Pragma': 'no-cache',
      'X-Go-Probe': '1',
    });
    if (req.method === 'HEAD') return res.end();
    return res.end(probeHtml(entry.id));
  }

  if (url.pathname.startsWith('/api/') || url.pathname === '/ws' || url.pathname.startsWith('/ws/')) {
    return sendJson(res, 404, { error: 'not_found', hint: `${PUBLIC_URL}/board` });
  }

  let bodyBuf = Buffer.alloc(0);
  try {
    bodyBuf = await readBody(req);
  } catch (e) {
    return sendJson(res, 413, { error: String(e.message || e) });
  }

  const { ip, ipChain } = clientIp(req);
  await tunnelAndRespond(res, {
    method: req.method,
    path: url.pathname + url.search,
    headers: req.headers,
    bodyBuf,
    ip,
    ipChain,
    req,
    urlObj: url,
  });
});

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url || '/', 'http://localhost');
  if (pathname === '/ws' || pathname === '/ws/dashboard') {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req, pathname);
    });
  } else {
    socket.destroy();
  }
});

wss.on('connection', (ws, req, pathname) => {
  if (pathname === '/ws/dashboard') {
    dashboards.add(ws);
    ws.send(JSON.stringify({ type: 'status', ...statusPayload() }));
    ws.on('close', () => dashboards.delete(ws));
    return;
  }

  const clientId = randomUUID();
  tunnelClients.set(clientId, ws);
  broadcastDash({ type: 'status', ...statusPayload() });
  ws.send(
    JSON.stringify({
      type: 'hello',
      clientId,
      targetUrl: TARGET_URL,
      message: `Connected. Forwarding public traffic to ${TARGET_URL}`,
    })
  );

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      ws.send(JSON.stringify({ type: 'error', error: 'invalid_json' }));
      return;
    }

    if (msg.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong', at: new Date().toISOString() }));
      return;
    }

    if (msg.type === 'response' && msg.id) {
      const p = pending.get(msg.id);
      if (!p) {
        ws.send(JSON.stringify({ type: 'error', error: 'unknown_request_id', id: msg.id }));
        return;
      }
      clearTimeout(p.timer);
      pending.delete(msg.id);
      p.resolve(msg);
      broadcastDash({ type: 'status', ...statusPayload() });
      return;
    }

    ws.send(JSON.stringify({ type: 'error', error: 'unknown_type', got: msg.type }));
  });

  ws.on('close', () => {
    tunnelClients.delete(clientId);
    broadcastDash({ type: 'status', ...statusPayload() });
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[go-tunnel] board ${PUBLIC_URL}/board → ${TARGET_URL} on 127.0.0.1:${PORT}`);
});
