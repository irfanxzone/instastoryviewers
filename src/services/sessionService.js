'use strict';

// ─── Session Pool ─────────────────────────────────────────────────────────────
// Reads INSTAGRAM_SESSION_IDS (comma-separated) from env.
// Falls back to INSTAGRAM_SESSION_ID for single-session setups.
// Provides round-robin rotation with per-session failure cooldown.

const FAILURE_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

function loadSessions() {
  const multi = (process.env.INSTAGRAM_SESSION_IDS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  if (multi.length) return multi;
  const single = (process.env.INSTAGRAM_STORY_SESSION_ID || process.env.INSTAGRAM_SESSION_ID || '').trim();
  return single ? [single] : [];
}

let _sessions = [];
let _counter  = 0;
const _failures = new Map(); // sessionId → failedAt timestamp

function reload() {
  _sessions = loadSessions();
  console.log(`[sessions] Loaded ${_sessions.length} session(s)`);
}
reload();

function isHealthy(id) {
  const t = _failures.get(id);
  if (!t) return true;
  if (Date.now() - t > FAILURE_COOLDOWN_MS) { _failures.delete(id); return true; }
  return false;
}

function hasAnySessions() { return _sessions.some(isHealthy); }

/** Returns decoded sessionid value, rotating round-robin across healthy sessions. */
function getNextSession() {
  const healthy = _sessions.filter(isHealthy);
  if (!healthy.length) return null;
  const id = healthy[_counter % healthy.length];
  _counter = (_counter + 1) % healthy.length;
  return decodeURIComponent(id);
}

/**
 * Returns up to `limit` distinct decoded sessions for retry loops.
 * First entry is always the "next" in rotation.
 */
function getSessionsForRetry(limit = 3) {
  const healthy = _sessions.filter(isHealthy);
  if (!healthy.length) return [];
  const start = _counter % healthy.length;
  _counter = (_counter + 1) % healthy.length;
  const result = [];
  for (let i = 0; i < Math.min(limit, healthy.length); i++) {
    result.push(decodeURIComponent(healthy[(start + i) % healthy.length]));
  }
  return result;
}

/** Call this when a session returns 401 / 403 / 429 so it gets skipped for a while. */
function markFailed(decodedId) {
  const encoded = _sessions.find(s => decodeURIComponent(s) === decodedId);
  const key = encoded || decodedId;
  _failures.set(key, Date.now());
  const healthy = _sessions.filter(isHealthy).length;
  console.warn(`[sessions] Marked failed (cooldown 5 min). Healthy remaining: ${healthy}/${_sessions.length}`);
}

function stats() {
  return {
    total:   _sessions.length,
    healthy: _sessions.filter(isHealthy).length,
    failed:  [..._failures.keys()]
  };
}

module.exports = { getNextSession, getSessionsForRetry, markFailed, hasAnySessions, stats, reload };
