'use strict';

const PAYLOAD_PATH = process.env.PAYLOAD_PATH || '/probe';

const BOARD_PATHS = new Set(['/', '/board', '/dashboard', '/inspect', '/favicon.ico']);

function shouldTrackVisit(pathname, method) {
  const m = (method || 'GET').toUpperCase();
  return pathname === PAYLOAD_PATH && (m === 'GET' || m === 'HEAD');
}

function isIgnoredPath(pathname) {
  if (BOARD_PATHS.has(pathname)) return true;
  if (pathname === '/probe.json') return true;
  if (pathname.startsWith('/api/')) return true;
  if (pathname === '/ws' || pathname.startsWith('/ws/')) return true;
  return false;
}

module.exports = {
  PAYLOAD_PATH,
  BOARD_PATHS,
  shouldTrackVisit,
  isIgnoredPath,
};
