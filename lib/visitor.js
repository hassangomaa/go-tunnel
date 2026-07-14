'use strict';

/**
 * Visitor / connection enrichment aligned with ngrok Traffic Policy variables:
 * conn.*, conn.geo.*, conn.client_ip.*, req.user_agent.*, req.host, etc.
 *
 * Geo/ASN via ip-api.com (free, cached). Header hints (Cloudflare etc.) used as fast path.
 */

const https = require('https');
const http = require('http');

const GEO_CACHE_TTL_MS = Number(process.env.GEO_CACHE_TTL_MS || 6 * 60 * 60 * 1000);
const GEO_LOOKUP_TIMEOUT_MS = Number(process.env.GEO_LOOKUP_TIMEOUT_MS || 2500);
const GEO_ENABLED = process.env.GEO_LOOKUP !== '0';

/** @type {Map<string, { at: number, data: object|null }>} */
const geoCache = new Map();

const EU_COUNTRY_CODES = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU',
  'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
]);

function headerVal(headers, name) {
  const v = headers && (headers[name] || headers[name.toLowerCase()]);
  if (Array.isArray(v)) return String(v[0] || '');
  return v == null ? '' : String(v);
}

function isPrivateIp(ip) {
  if (!ip) return true;
  let s = String(ip);
  if (s.startsWith('::ffff:')) s = s.slice(7);
  if (s === '::1' || s === '127.0.0.1') return true;
  if (s.startsWith('10.')) return true;
  if (s.startsWith('192.168.')) return true;
  if (s.startsWith('169.254.')) return true;
  const m = s.match(/^172\.(\d+)\./);
  if (m) {
    const n = Number(m[1]);
    if (n >= 16 && n <= 31) return true;
  }
  if (s.startsWith('fc') || s.startsWith('fd') || s.startsWith('fe80')) return true;
  return false;
}

function parseCookies(cookieHeader) {
  const out = {};
  if (!cookieHeader) return out;
  for (const part of String(cookieHeader).split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const name = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if (!name) continue;
    if (!out[name]) out[name] = [];
    out[name].push({ name, value });
  }
  return out;
}

function parseContentType(raw) {
  if (!raw) return { raw: '', media: '', parameters: {} };
  const [media, ...rest] = String(raw).split(';').map((s) => s.trim());
  const parameters = {};
  for (const r of rest) {
    const i = r.indexOf('=');
    if (i > 0) parameters[r.slice(0, i).trim().toLowerCase()] = r.slice(i + 1).trim();
  }
  return { raw: String(raw), media: media.toLowerCase(), parameters };
}

function parseQueryParams(search) {
  const out = {};
  const q = String(search || '').replace(/^\?/, '');
  if (!q) return out;
  for (const pair of q.split('&')) {
    if (!pair) continue;
    const i = pair.indexOf('=');
    const k = decodeURIComponent(i < 0 ? pair : pair.slice(0, i));
    const v = decodeURIComponent(i < 0 ? '' : pair.slice(i + 1));
    if (!out[k]) out[k] = [];
    out[k].push(v);
  }
  return out;
}

/**
 * Lightweight UA parse (no deps) — mirrors ngrok req.user_agent.* shape.
 */
function parseUserAgent(uaRaw) {
  const ua = String(uaRaw || '');
  const lower = ua.toLowerCase();
  const empty = {
    raw: ua,
    name: '',
    version: '',
    os: '',
    os_version: '',
    device: '',
    is_mobile: false,
    is_tablet: false,
    is_desktop: false,
    is_bot: false,
    url: '',
  };
  if (!ua) return empty;

  const isBot =
    /\b(bot|crawler|spider|slurp|bingpreview|facebookexternalhit|embedly|quora|linkedinbot|pinterest|redditbot|applebot|semrush|ahrefs|bytespider|gptbot|claudebot|curl|wget|python-requests|go-http-client|httpclient|okhttp|postman|insomnia)\b/i.test(
      ua
    );
  const isTablet = /\b(ipad|tablet|kindle|silk|playbook)\b/i.test(ua) || (/\bandroid\b/i.test(ua) && !/\bmobile\b/i.test(ua));
  const isMobile =
    !isTablet &&
    /\b(iphone|ipod|android.*mobile|windows phone|blackberry|opera mini|mobile)\b/i.test(ua);
  const isDesktop = !isMobile && !isTablet && !isBot;

  let os = '';
  let os_version = '';
  if (/windows nt 10/i.test(ua)) {
    os = 'Windows';
    os_version = '10';
  } else if (/windows nt 11/i.test(ua) || /windows nt 10\.0.*rv:1[1-9]/i.test(ua)) {
    os = 'Windows';
    os_version = '11';
  } else if (/mac os x (\d+[._]\d+(?:[._]\d+)?)/i.test(ua)) {
    os = 'macOS';
    os_version = (ua.match(/mac os x (\d+[._]\d+(?:[._]\d+)?)/i) || [])[1]?.replace(/_/g, '.') || '';
  } else if (/android (\d+(?:\.\d+)?)/i.test(ua)) {
    os = 'Android';
    os_version = (ua.match(/android (\d+(?:\.\d+)?)/i) || [])[1] || '';
  } else if (/iphone|ipad|ipod/i.test(ua)) {
    os = 'iOS';
    os_version = ((ua.match(/os (\d+[._]\d+(?:[._]\d+)?)/i) || [])[1] || '').replace(/_/g, '.');
  } else if (/linux/i.test(ua)) {
    os = 'Linux';
  } else if (/cros/i.test(ua)) {
    os = 'Chrome OS';
  }

  let name = '';
  let version = '';
  const browsers = [
    [/edg(?:e|a|ios)?\/([\d.]+)/i, 'Edge'],
    [/opr\/([\d.]+)/i, 'Opera'],
    [/samsungbrowser\/([\d.]+)/i, 'Samsung Browser'],
    [/firefox\/([\d.]+)/i, 'Firefox'],
    [/chrome\/([\d.]+)/i, 'Chrome'],
    [/version\/([\d.]+).*safari/i, 'Safari'],
    [/safari\/([\d.]+)/i, 'Safari'],
    [/curl\/([\d.]+)/i, 'curl'],
    [/wget\/([\d.]+)/i, 'wget'],
    [/postmanruntime\/([\d.]+)/i, 'Postman'],
  ];
  for (const [re, n] of browsers) {
    const m = ua.match(re);
    if (m) {
      name = n;
      version = m[1] || '';
      break;
    }
  }
  if (!name && isBot) {
    name = 'Bot';
    const m = ua.match(/^([A-Za-z0-9._-]+)/);
    if (m) name = m[1];
  }

  let device = '';
  if (/iphone/i.test(ua)) device = 'iPhone';
  else if (/ipad/i.test(ua)) device = 'iPad';
  else if (/android/i.test(ua)) {
    const m = ua.match(/;\s*([^;)]*?)\s*(?:build|\))/i);
    device = (m && m[1] && !/android|linux|wv/i.test(m[1]) ? m[1].trim() : 'Android') || 'Android';
  } else if (isDesktop) device = 'Desktop';

  const urlMatch = ua.match(/https?:\/\/[^\s);]+/i);

  return {
    raw: ua,
    name,
    version,
    os,
    os_version,
    device,
    is_mobile: isMobile,
    is_tablet: isTablet,
    is_desktop: isDesktop,
    is_bot: isBot || /\bbot\b/i.test(lower),
    url: urlMatch ? urlMatch[0] : '',
  };
}

function headerGeoHints(headers) {
  const country_code =
    headerVal(headers, 'cf-ipcountry') ||
    headerVal(headers, 'cloudfront-viewer-country') ||
    headerVal(headers, 'x-vercel-ip-country') ||
    headerVal(headers, 'x-country-code') ||
    '';
  const city =
    headerVal(headers, 'cf-ipcity') ||
    headerVal(headers, 'x-vercel-ip-city') ||
    headerVal(headers, 'x-city') ||
    '';
  const subdivision =
    headerVal(headers, 'cf-region') ||
    headerVal(headers, 'cloudfront-viewer-country-region') ||
    headerVal(headers, 'x-vercel-ip-country-region') ||
    '';
  const latitude =
    headerVal(headers, 'cf-iplatitude') || headerVal(headers, 'x-vercel-ip-latitude') || '';
  const longitude =
    headerVal(headers, 'cf-iplongitude') || headerVal(headers, 'x-vercel-ip-longitude') || '';
  if (!country_code && !city && !latitude) return null;
  return {
    city: decodeURIComponent(city || ''),
    country: '',
    country_code: country_code === 'XX' ? '' : country_code.toUpperCase(),
    continent: '',
    subdivision: decodeURIComponent(subdivision || ''),
    latitude: String(latitude || ''),
    longitude: String(longitude || ''),
    postal_code: '',
    metro_code: '',
    radius: '',
    timezone: '',
    is_eu: country_code ? EU_COUNTRY_CODES.has(country_code.toUpperCase()) : false,
    source: 'headers',
  };
}

function emptyLocation() {
  return {
    city: '',
    continent: '',
    country: '',
    country_code: '',
    is_eu: false,
    latitude: '',
    longitude: '',
    metro_code: '',
    postal_code: '',
    radius: '',
    subdivision: '',
    timezone: '',
  };
}

function locationFromApi(d) {
  const country_code = String(d.countryCode || '').toUpperCase();
  return {
    city: String(d.city || ''),
    continent: String(d.continent || ''),
    country: String(d.country || ''),
    country_code,
    is_eu: EU_COUNTRY_CODES.has(country_code),
    latitude: d.lat != null ? String(d.lat) : '',
    longitude: d.lon != null ? String(d.lon) : '',
    metro_code: '',
    postal_code: String(d.zip || ''),
    radius: '',
    subdivision: String(d.regionName || d.region || ''),
    timezone: String(d.timezone || ''),
  };
}

function categoriesFromApi(d) {
  const cats = [];
  if (d.proxy) cats.push('proxy.anonymous');
  if (d.hosting) cats.push('hosting');
  if (d.mobile) cats.push('mobile');
  const org = `${d.org || ''} ${d.isp || ''} ${d.as || ''}`.toLowerCase();
  if (/\btor\b/.test(org)) cats.push('proxy.anonymous.tor');
  if (/\bvpn\b/.test(org)) cats.push('proxy.anonymous.vpn');
  return cats;
}

function parseAsn(asField, asname, org) {
  const raw = String(asField || '');
  const m = raw.match(/^AS(\d+)\s*(.*)$/i);
  const number = m ? Number(m[1]) : 0;
  const organization = String(asname || (m && m[2]) || org || '').trim();
  return { number: number || 0, organization };
}

function httpGetJson(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('geo_timeout'));
    });
    req.on('error', reject);
  });
}

/**
 * Lookup IP intelligence (geo + ASN + proxy/hosting flags).
 * Uses ip-api.com free endpoint; cached in-memory.
 */
async function lookupIpIntel(ip) {
  if (!GEO_ENABLED || !ip || isPrivateIp(ip)) {
    return {
      ok: false,
      skipped: true,
      location: emptyLocation(),
      registered_location: emptyLocation(),
      as: { number: 0, organization: '' },
      categories: [],
      is_on_blocklist: false,
      is_tor_node: false,
      isp: '',
      org: '',
      source: 'skipped',
    };
  }

  const cached = geoCache.get(ip);
  if (cached && Date.now() - cached.at < GEO_CACHE_TTL_MS) {
    return cached.data;
  }

  const fields =
    'status,message,continent,continentCode,country,countryCode,region,regionName,city,zip,lat,lon,timezone,isp,org,as,asname,mobile,proxy,hosting,query';
  const url = `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=${fields}`;

  try {
    const d = await httpGetJson(url, GEO_LOOKUP_TIMEOUT_MS);
    if (!d || d.status !== 'success') {
      const fail = {
        ok: false,
        skipped: false,
        error: (d && d.message) || 'lookup_failed',
        location: emptyLocation(),
        registered_location: emptyLocation(),
        as: { number: 0, organization: '' },
        categories: [],
        is_on_blocklist: false,
        is_tor_node: false,
        isp: '',
        org: '',
        source: 'ip-api',
      };
      geoCache.set(ip, { at: Date.now(), data: fail });
      return fail;
    }

    const categories = categoriesFromApi(d);
    const location = locationFromApi(d);
    const result = {
      ok: true,
      skipped: false,
      location,
      // Free APIs rarely separate registered vs observed location; mirror observed.
      registered_location: { ...location },
      as: parseAsn(d.as, d.asname, d.org),
      categories,
      is_on_blocklist: categories.some((c) => c.includes('blocklist')),
      is_tor_node: categories.includes('proxy.anonymous.tor'),
      isp: String(d.isp || ''),
      org: String(d.org || ''),
      source: 'ip-api',
    };
    geoCache.set(ip, { at: Date.now(), data: result });
    return result;
  } catch (e) {
    const fail = {
      ok: false,
      skipped: false,
      error: String(e.message || e),
      location: emptyLocation(),
      registered_location: emptyLocation(),
      as: { number: 0, organization: '' },
      categories: [],
      is_on_blocklist: false,
      is_tor_node: false,
      isp: '',
      org: '',
      source: 'ip-api',
    };
    return fail;
  }
}

function mergeLocation(primary, hint) {
  if (!hint) return primary || emptyLocation();
  const base = primary && primary.country_code ? primary : emptyLocation();
  return {
    city: base.city || hint.city || '',
    continent: base.continent || hint.continent || '',
    country: base.country || hint.country || '',
    country_code: base.country_code || hint.country_code || '',
    is_eu:
      base.country_code || hint.country_code
        ? EU_COUNTRY_CODES.has((base.country_code || hint.country_code).toUpperCase())
        : false,
    latitude: base.latitude || hint.latitude || '',
    longitude: base.longitude || hint.longitude || '',
    metro_code: base.metro_code || hint.metro_code || '',
    postal_code: base.postal_code || hint.postal_code || '',
    radius: base.radius || hint.radius || '',
    subdivision: base.subdivision || hint.subdivision || '',
    timezone: base.timezone || hint.timezone || '',
  };
}

/**
 * Sync visitor snapshot from the incoming HTTP request (no network I/O).
 * Shape mirrors ngrok conn.* + req.* inspector fields where practical.
 */
function collectVisitor(req, opts = {}) {
  const headers = req.headers || {};
  const { ip = '', ipChain = [], bodyBytes = 0, urlObj = null } = opts;
  const uaRaw = headerVal(headers, 'user-agent');
  const ct = parseContentType(headerVal(headers, 'content-type'));
  const host = headerVal(headers, 'host') || (urlObj && urlObj.host) || '';
  const pathWithQuery =
    (urlObj && urlObj.pathname + urlObj.search) || req.url || '/';
  const pathOnly = (urlObj && urlObj.pathname) || String(pathWithQuery).split('?')[0] || '/';
  const query = (urlObj && urlObj.search ? urlObj.search.slice(1) : '') || (String(req.url || '').includes('?') ? String(req.url).split('?')[1] : '');
  const scheme =
    headerVal(headers, 'x-forwarded-proto') ||
    (req.socket && req.socket.encrypted ? 'https' : 'http');
  const clientPort = req.socket && req.socket.remotePort ? Number(req.socket.remotePort) : 0;
  const serverPort = req.socket && req.socket.localPort ? Number(req.socket.localPort) : 0;
  const acceptLang = headerVal(headers, 'accept-language');
  const referer = headerVal(headers, 'referer') || headerVal(headers, 'referrer');
  const headerHints = headerGeoHints(headers);

  const locationSeed = headerHints
    ? {
        city: headerHints.city,
        continent: '',
        country: '',
        country_code: headerHints.country_code,
        is_eu: headerHints.is_eu,
        latitude: headerHints.latitude,
        longitude: headerHints.longitude,
        metro_code: '',
        postal_code: '',
        radius: '',
        subdivision: headerHints.subdivision,
        timezone: '',
      }
    : emptyLocation();

  return {
    collectedAt: new Date().toISOString(),
    // ngrok conn.*
    conn: {
      client_ip: ip,
      client_port: clientPort,
      server_ip: (req.socket && req.socket.localAddress) || '',
      server_port: serverPort,
      server_region: process.env.SERVER_REGION || '',
      ts: { start: new Date().toISOString() },
      bytes_in: bodyBytes,
      bytes_out: null,
      geo: {
        city: locationSeed.city,
        country: locationSeed.country,
        country_code: locationSeed.country_code,
        latitude: locationSeed.latitude,
        longitude: locationSeed.longitude,
        radius: locationSeed.radius,
        subdivision: locationSeed.subdivision,
      },
      client_ip_intel: {
        categories: [],
        is_on_blocklist: false,
        is_tor_node: false,
        as: { number: 0, organization: '' },
        geo: {
          location: locationSeed,
          registered_location: emptyLocation(),
        },
        isp: '',
        org: '',
        enrich_status: headerHints ? 'header_hints' : 'pending',
        enrich_source: headerHints ? 'headers' : null,
      },
    },
    // ngrok req.* subset useful on the board
    req: {
      method: req.method || '',
      host,
      version: req.httpVersion ? `HTTP/${req.httpVersion}` : '',
      content_type: ct.media,
      content_type_raw: ct.raw,
      content_type_parameters: ct.parameters,
      content_encoding: String(headerVal(headers, 'content-encoding') || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      content_length: Number(headerVal(headers, 'content-length')) || bodyBytes || 0,
      url: `${scheme}://${host}${pathWithQuery}`,
      url_path: pathOnly,
      url_query: query,
      url_query_params: parseQueryParams(query),
      url_scheme: scheme,
      user_agent: parseUserAgent(uaRaw),
      cookies: parseCookies(headerVal(headers, 'cookie')),
      accept_language: acceptLang,
      referer,
      origin: headerVal(headers, 'origin'),
    },
    ip_chain: ipChain,
    private_ip: isPrivateIp(ip),
  };
}

/**
 * Async enrich visitor.conn with geo + ASN (ngrok IP Intelligence).
 * Mutates and returns the visitor object.
 */
async function enrichVisitor(visitor) {
  if (!visitor || !visitor.conn) return visitor;
  const ip = visitor.conn.client_ip;
  const intel = await lookupIpIntel(ip);
  const prevLoc = visitor.conn.client_ip_intel?.geo?.location || emptyLocation();
  const location = mergeLocation(intel.location, prevLoc);
  const registered = intel.registered_location || emptyLocation();

  visitor.conn.geo = {
    city: location.city,
    country: location.country,
    country_code: location.country_code,
    latitude: location.latitude,
    longitude: location.longitude,
    radius: location.radius,
    subdivision: location.subdivision,
  };

  visitor.conn.client_ip_intel = {
    categories: intel.categories || [],
    is_on_blocklist: !!intel.is_on_blocklist,
    is_tor_node: !!intel.is_tor_node,
    as: intel.as || { number: 0, organization: '' },
    geo: {
      location,
      registered_location: registered,
    },
    isp: intel.isp || '',
    org: intel.org || '',
    enrich_status: intel.skipped ? 'skipped' : intel.ok ? 'ok' : 'error',
    enrich_source: intel.source || null,
    enrich_error: intel.error || null,
  };

  visitor.enrichedAt = new Date().toISOString();
  return visitor;
}

module.exports = {
  collectVisitor,
  enrichVisitor,
  lookupIpIntel,
  parseUserAgent,
  isPrivateIp,
  EU_COUNTRY_CODES,
};
