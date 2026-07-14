'use strict';
/**
 * VPS tunnel agent — forwards public go.tejarahlntpoor.com traffic to TARGET_URL.
 *
 * PM2:
 *   TARGET_URL=http://127.0.0.1:3000 GO_WS=wss://go.tejarahlntpoor.com/ws node client.js
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { URL } = require('url');
const WebSocket = require('ws');

const WS_URL = process.env.GO_WS || 'wss://go.tejarahlntpoor.com/ws';
const TARGET_URL = process.env.TARGET_URL || 'http://127.0.0.1:3000';
const ECHO = process.env.ECHO === '1';
const INBOX = path.join(__dirname, 'inbox');
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
]);

fs.mkdirSync(INBOX, { recursive: true });

function saveInbox(msg) {
  const stamp = `${Date.now()}-${msg.id || 'event'}`;
  const file = path.join(INBOX, `${stamp}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        savedAt: new Date().toISOString(),
        id: msg.id,
        method: msg.method,
        path: msg.path,
        ip: msg.ip,
        ipChain: msg.ipChain,
        visitor: msg.visitor || null,
        geo: msg.geo || null,
        userAgent: msg.userAgent || null,
        headers: msg.headers,
        body: msg.body,
        bodyBase64: msg.bodyBase64,
        bytes: msg.bytes,
        at: msg.at,
      },
      null,
      2
    )
  );
  if (msg.bodyBase64) {
    fs.writeFileSync(path.join(INBOX, `${stamp}.bin`), Buffer.from(msg.bodyBase64, 'base64'));
  } else if (msg.body) {
    fs.writeFileSync(path.join(INBOX, `${stamp}.txt`), msg.body);
  }
  return file;
}

function buildForwardHeaders(msg) {
  const headers = {};
  for (const [k, v] of Object.entries(msg.headers || {})) {
    if (!HOP_BY_HOP.has(String(k).toLowerCase())) headers[k] = v;
  }
  if (msg.ip) {
    headers['x-forwarded-for'] = msg.ip;
    headers['x-real-ip'] = msg.ip;
  }
  headers['x-forwarded-proto'] = 'https';
  headers['x-forwarded-host'] = 'go.tejarahlntpoor.com';
  return headers;
}

function forwardToTarget(msg) {
  return new Promise((resolve, reject) => {
    if (!TARGET_URL && !ECHO) {
      reject(new Error('TARGET_URL not configured'));
      return;
    }

    const target = new URL(msg.path || '/', TARGET_URL);
    const lib = target.protocol === 'https:' ? https : http;
    const headers = buildForwardHeaders(msg);
    const body = msg.bodyBase64
      ? Buffer.from(msg.bodyBase64, 'base64')
      : Buffer.from(msg.body || '', 'utf8');
    headers['content-length'] = String(body.length);

    const req = lib.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path: target.pathname + target.search,
        method: msg.method || 'GET',
        headers,
        timeout: 25000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          const outHeaders = {};
          for (const [k, v] of Object.entries(res.headers || {})) {
            if (!HOP_BY_HOP.has(String(k).toLowerCase())) outHeaders[k] = v;
          }
          resolve({
            type: 'response',
            id: msg.id,
            status: res.statusCode || 200,
            headers: outHeaders,
            bodyBase64: buf.toString('base64'),
          });
        });
      }
    );
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('upstream_timeout'));
    });
    req.on('error', reject);
    if (body.length) req.write(body);
    req.end();
  });
}

function echoResponse(msg) {
  const replyBody = JSON.stringify(
    {
      ok: true,
      echoed: true,
      received: {
        method: msg.method,
        path: msg.path,
        ip: msg.ip,
        ipChain: msg.ipChain,
        bytes: msg.bytes,
        body: msg.body,
      },
      at: new Date().toISOString(),
    },
    null,
    2
  );
  return {
    type: 'response',
    id: msg.id,
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: replyBody,
  };
}

function connect() {
  const ws = new WebSocket(WS_URL);

  ws.on('open', () => {
    console.log('[client] connected — waiting for events…');
    console.log('[client] inbox:', INBOX);
    if (TARGET_URL) console.log('[client] forwarding to', TARGET_URL);
    else if (ECHO) console.log('[client] echo mode (ECHO=1)');
    else console.warn('[client] no TARGET_URL — set TARGET_URL or ECHO=1');
    setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
    }, 25000);
  });

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return console.log(String(raw));
    }

    if (msg.type === 'hello' || msg.type === 'pong') {
      console.log('[client]', msg.type, msg.message || msg.at || msg.clientId || '');
      return;
    }

    if (msg.type !== 'request') {
      console.log('[client] message', msg);
      return;
    }

    const file = saveInbox(msg);
    console.log('\n=== EVENT ===');
    console.log(msg.method, msg.path);
    console.log('ip:', msg.ip, msg.ipChain || []);
    if (msg.geo) console.log('geo:', msg.geo.city || '', msg.geo.country_code || msg.geo.country || '');
    if (msg.userAgent) console.log('ua:', msg.userAgent.name || msg.userAgent.raw || '');
    console.log('bytes:', msg.bytes);
    console.log('saved:', file);
    console.log('=============');

    try {
      let reply;
      if (TARGET_URL) {
        reply = await forwardToTarget(msg);
      } else if (ECHO) {
        reply = echoResponse(msg);
      } else {
        throw new Error('TARGET_URL not configured');
      }
      ws.send(JSON.stringify(reply));
    } catch (e) {
      ws.send(
        JSON.stringify({
          type: 'response',
          id: msg.id,
          status: 502,
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
          body: JSON.stringify({
            error: 'upstream_forward_failed',
            target: TARGET_URL || null,
            detail: String(e.message || e),
          }),
        })
      );
    }
  });

  ws.on('close', () => {
    console.log('[client] disconnected — reconnecting in 2s');
    setTimeout(connect, 2000);
  });

  ws.on('error', (err) => console.error('[client] error', err.message));
}

connect();
