'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { shouldTrackVisit, PAYLOAD_PATH } = require('./trackable');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS visits (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  ip TEXT,
  status INTEGER,
  duration_ms INTEGER,
  tunneled INTEGER NOT NULL DEFAULT 0,
  probe INTEGER NOT NULL DEFAULT 0,
  record_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_visits_at ON visits(at DESC);
`;

function rowToRecord(row) {
  if (!row) return null;
  try {
    return JSON.parse(row.record_json);
  } catch {
    return null;
  }
}

function syncColumns(record) {
  return {
    id: record.id,
    at: record.at,
    method: record.method || 'GET',
    path: record.path || '/',
    ip: record.ip || null,
    status: record.status != null ? Number(record.status) : null,
    duration_ms: record.durationMs != null ? Number(record.durationMs) : null,
    tunneled: record.tunneled ? 1 : 0,
    probe: record.probe ? 1 : 0,
    record_json: JSON.stringify(record),
  };
}

function createStore(opts = {}) {
  const dataDir = opts.dataDir || path.join(__dirname, '..', 'data');
  const sqlitePath = opts.sqlitePath || process.env.SQLITE_PATH || path.join(dataDir, 'visits.db');
  const ndjsonPath = path.join(dataDir, 'traffic.ndjson');

  fs.mkdirSync(dataDir, { recursive: true });
  const db = new Database(sqlitePath);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);

  const insertStmt = db.prepare(`
    INSERT INTO visits (id, at, method, path, ip, status, duration_ms, tunneled, probe, record_json)
    VALUES (@id, @at, @method, @path, @ip, @status, @duration_ms, @tunneled, @probe, @record_json)
  `);

  const updateStmt = db.prepare(`
    UPDATE visits SET
      at = @at,
      method = @method,
      path = @path,
      ip = @ip,
      status = @status,
      duration_ms = @duration_ms,
      tunneled = @tunneled,
      probe = @probe,
      record_json = @record_json
    WHERE id = @id
  `);

  const getStmt = db.prepare('SELECT * FROM visits WHERE id = ?');
  const countStmt = db.prepare('SELECT COUNT(*) AS n FROM visits');
  const listStmt = db.prepare('SELECT * FROM visits ORDER BY at DESC LIMIT ? OFFSET ?');
  const exportStmt = db.prepare('SELECT * FROM visits ORDER BY at DESC');

  function countVisits() {
    return countStmt.get().n;
  }

  function migrateFromNdjson() {
    if (countVisits() > 0) return 0;
    if (!fs.existsSync(ndjsonPath)) return 0;

    const lines = fs.readFileSync(ndjsonPath, 'utf8').split('\n').filter(Boolean);
    const byId = new Map();
    for (const line of lines) {
      try {
        const row = JSON.parse(line);
        if (row && row.id) byId.set(row.id, row);
      } catch (_) {}
    }

    let imported = 0;
    const tx = db.transaction((rows) => {
      for (const row of rows) {
        const pathname = String(row.path || '').split('?')[0];
        if (!shouldTrackVisit(pathname, row.method) && !(row.probe && pathname === PAYLOAD_PATH)) {
          continue;
        }
        if (pathname === '/probe.json') continue;
        try {
          insertStmt.run(syncColumns(row));
          imported++;
        } catch (_) {}
      }
    });
    tx([...byId.values()]);
    if (imported > 0) {
      console.log(`[go-tunnel] migrated ${imported} payload visits from NDJSON → SQLite`);
    }
    return imported;
  }

  migrateFromNdjson();

  function insertVisit(record) {
    insertStmt.run(syncColumns(record));
    return record;
  }

  function updateVisit(id, patch) {
    const existing = rowToRecord(getStmt.get(id));
    if (!existing) return null;
    const merged = Object.assign({}, existing, patch, { id });
    updateStmt.run(syncColumns(merged));
    return merged;
  }

  function getVisit(id) {
    return rowToRecord(getStmt.get(id));
  }

  function listVisits({ offset = 0, limit = 200 } = {}) {
    return listStmt.all(limit, offset).map(rowToRecord).filter(Boolean);
  }

  function exportAll() {
    return exportStmt.all().map(rowToRecord).filter(Boolean);
  }

  function exportNdjsonLines() {
    return exportAll().map((r) => JSON.stringify(r)).join('\n') + '\n';
  }

  function loadRecentIntoCache(limit = 500) {
    const items = listVisits({ offset: 0, limit });
    const cache = new Map();
    const order = [];
    for (const item of items) {
      cache.set(item.id, item);
      order.push(item.id);
    }
    return { cache, order };
  }

  return {
    sqlitePath,
    countVisits,
    insertVisit,
    updateVisit,
    getVisit,
    listVisits,
    exportAll,
    exportNdjsonLines,
    loadRecentIntoCache,
    close() {
      db.close();
    },
  };
}

module.exports = { createStore, syncColumns };
