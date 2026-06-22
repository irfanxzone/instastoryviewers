'use strict';

// ─── Session Pool ─────────────────────────────────────────────────────────────
// Reads INSTAGRAM_SESSION_IDS (comma-separated) from env.
// Falls back to INSTAGRAM_SESSION_ID for single-session setups.
//
// Each session is "warmed" by visiting instagram.com with its sessionid cookie
// to obtain the matching csrftoken. Without the correct csrftoken paired to
// the sessionid, Instagram returns 401 on every API call.

const FAILURE_COOLDOWN_MS = 5 * 60 * 1000;  // 5 min
const WARM_TTL_MS         = 25 * 60 * 1000; // 25 min (Instagram CSRF TTL ~30 min)
const WARM_STAGGER_MS     = 1500;            // 1.5 s between warm requests on startup

const WARM_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function loadSessions() {
  const multi = (process.env.INSTAGRAM_SESSION_IDS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  if (multi.length) return multi;
  const single = (process.env.INSTAGRAM_STORY_SESSION_ID || process.env.INSTAGRAM_SESSION_ID || '').trim();
  return single ? [single] : [];
}

let _sessions = [];
let _counter  = 0;
const _failures = new Map(); // encodedId → failedAt timestamp
const _warmed   = new Map(); // decodedId → { cookie, csrfToken, warmedAt }

function reload() {
  _sessions = loadSessions();
  console.log(`[sessions] Loaded ${_sessions.length} session(s)`);
}
reload();

function isHealthy(encodedId) {
  const t = _failures.get(encodedId);
  if (!t) return true;
  if (Date.now() - t > FAILURE_COOLDOWN_MS) { _failures.delete(encodedId); return true; }
  return false;
}

function hasAnySessions() { return _sessions.some(isHealthy); }

// ─── Session warming ──────────────────────────────────────────────────────────
// Visit instagram.com with the session cookie to obtain the paired csrftoken.
// Returns { cookie, csrfToken } or null on failure.
async function warmSession(decodedId) {
  try {
    // Lazy-require to avoid circular dep at module load time
    const { get } = require('../utils/httpClient');
    const res = await get('https://www.instagram.com/', {
      'Cookie':          `sessionid=${decodedId}`,
      'User-Agent':      WARM_UA,
      'Accept':          'text/html,application/xhtml+xml,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Sec-Fetch-Site':  'none',
      'Sec-Fetch-Mode':  'navigate',
      'Upgrade-Insecure-Requests': '1',
    });

    // Collect set-cookie headers
    const rawCookies = res.headers?.['set-cookie'] || [];
    const cookieStr  = (Array.isArray(rawCookies) ? rawCookies : [rawCookies]).join('; ');
    const csrfToken  = cookieStr.match(/csrftoken=([^;,\s]+)/i)?.[1] || '';

    // Also try extracting from HTML if not in headers
    const htmlCsrf = !csrfToken
      ? (String(res.data || '')).match(/"csrf_token"\s*:\s*"([^"]+)"/)?.[1] || ''
      : '';

    const csrf = csrfToken || htmlCsrf;
    const cookie = `sessionid=${decodedId}${csrf ? `; csrftoken=${csrf}` : ''}`;
    const entry  = { cookie, csrfToken: csrf, warmedAt: Date.now() };
    _warmed.set(decodedId, entry);
    console.log(`[sessions] Warmed ...${decodedId.slice(-10)}: csrf=${csrf ? 'ok' : 'missing'}, status=${res.status}`);
    return entry;
  } catch (e) {
    console.warn(`[sessions] Warm failed: ${e.message}`);
    return null;
  }
}

async function getWarmedSession(decodedId) {
  const cached = _warmed.get(decodedId);
  if (cached && Date.now() - cached.warmedAt < WARM_TTL_MS) return cached;
  return warmSession(decodedId);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** Round-robin, returns decoded session string (legacy compat). */
function getNextSession() {
  const healthy = _sessions.filter(isHealthy);
  if (!healthy.length) return null;
  const id = healthy[_counter % healthy.length];
  _counter = (_counter + 1) % healthy.length;
  return decodeURIComponent(id);
}

/**
 * Returns up to `limit` warmed {cookie, csrfToken, decodedId} objects.
 * Async — fetches csrftoken for each session on demand (cached 25 min).
 */
async function getFullSessionsForRetry(limit = 3) {
  const healthy = _sessions.filter(isHealthy);
  if (!healthy.length) return [];
  const start = _counter % healthy.length;
  _counter = (_counter + 1) % healthy.length;

  const selected = [];
  for (let i = 0; i < Math.min(limit, healthy.length); i++) {
    selected.push(decodeURIComponent(healthy[(start + i) % healthy.length]));
  }

  const results = await Promise.all(selected.map(id => getWarmedSession(id)));
  return results
    .map((w, i) => w ? { ...w, decodedId: selected[i] } : null)
    .filter(Boolean);
}

/** Call when a session returns 401/403/429. */
function markFailed(decodedId) {
  const encoded = _sessions.find(s => decodeURIComponent(s) === decodedId) || decodedId;
  _failures.set(encoded, Date.now());
  _warmed.delete(decodedId); // also clear warm cache so it re-warms after cooldown
  const healthy = _sessions.filter(isHealthy).length;
  console.warn(`[sessions] Marked failed (cooldown 5 min). Healthy: ${healthy}/${_sessions.length}`);
}

function stats() {
  return {
    total:   _sessions.length,
    healthy: _sessions.filter(isHealthy).length,
    warmed:  _warmed.size,
    failed:  [..._failures.keys()]
  };
}

/** Pre-warm all sessions in the background on startup (staggered to avoid burst). */
function warmAllInBackground() {
  const ids = _sessions.map(s => decodeURIComponent(s));
  let i = 0;
  function next() {
    if (i >= ids.length) { console.log('[sessions] All sessions pre-warmed'); return; }
    warmSession(ids[i++]).finally(() => setTimeout(next, WARM_STAGGER_MS));
  }
  setTimeout(next, 3000); // let server finish starting first
}

module.exports = {
  getNextSession,
  getFullSessionsForRetry,
  markFailed,
  hasAnySessions,
  stats,
  reload,
  warmAllInBackground,
};
