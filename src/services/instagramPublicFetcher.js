'use strict';

const cheerio = require('cheerio');
const { get } = require('../utils/httpClient');
const { normalizeProfileUser, normalizeMetaOnly } = require('./instagramNormalizer');
const { fetchViaBrowserFallback } = require('./browserFallbackService');
const { isLoginWallText, isBlockedResponse, NotFoundError } = require('../utils/errors');
const proxyService = require('./proxyService');
const { setCache } = require('./cacheService');
const sessionService = require('./sessionService');

// ─── Config ───────────────────────────────────────────────────────────────────
function getQueryHashes() {
  const env = process.env.INSTAGRAM_QUERY_HASHES || '';
  const defaults = ['e7e2f4da98273d3a44e843e8adb3569b', 'c9100bf9110dd6361671f113dd02e7d0', 'd4d88dc1500312af6f937f7b804c68c3'];
  const custom = env.split(',').map(s => s.trim()).filter(Boolean);
  return [...custom, ...defaults].filter((v, i, a) => a.indexOf(v) === i);
}
function getQueryIds() {
  const env = process.env.INSTAGRAM_QUERY_IDS || '';
  const defaults = ['17888483320059182', '17896490967187654', '17858893269056849'];
  const custom = env.split(',').map(s => s.trim()).filter(Boolean);
  return [...custom, ...defaults].filter((v, i, a) => a.indexOf(v) === i);
}

const PROFILE_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ─── Background browser job queue ────────────────────────────────────────────
// When the fast path returns partial data we fire the full browser fetch here.
// The result is written to cache so the frontend's auto-poll picks it up.
const activeBrowserJobs = new Map(); // username → Promise

function scheduleBrowserFetch(username, cacheKey) {
  const key = username.toLowerCase();
  if (activeBrowserJobs.has(key)) return; // already running

  const job = fetchViaBrowserFallback(username, cacheKey)
    .then(async result => {
      if (result?.success && (result.posts?.items?.length > 0 || result.status === 'PRIVATE_ACCOUNT')) {
        // Browser already fetched stories via network interception — only try the HTTP
        // path if the browser came back empty (avoids overwriting good story data with
        // a failed redirect from the server-side HTTP client).
        if (!result.stories?.items?.length && result.profile?.id && sessionService.hasAnySessions()) {
          try {
            const { normalizeStoryItems } = require('./instagramNormalizer');
            const storyItems = await fetchStoriesServerSide(result.profile.id, username, {});
            if (storyItems.length) {
              result.stories = { available: true, items: normalizeStoryItems(storyItems), message: undefined };
              console.log(`[bg] Stories fetched via HTTP for @${username}: ${storyItems.length} items`);
            }
          } catch {}
        }
        setCache(cacheKey, result);
        console.log(`[bg] Browser fetch done @${username}: ${result.posts?.items?.length || 0} posts, ${result.stories?.items?.length || 0} stories`);
      }
    })
    .catch(err => console.warn(`[bg] Browser fetch failed @${username}: ${err?.message}`))
    .finally(() => activeBrowserJobs.delete(key));

  activeBrowserJobs.set(key, job);
}

function hasPendingBrowserJob(username) {
  return activeBrowserJobs.has(username.toLowerCase());
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function tryJsonParse(text) {
  if (!text || typeof text !== 'string') return null;
  const t = text.trim();
  if (t[0] !== '{' && t[0] !== '[') return null;
  try { return JSON.parse(t); } catch { return null; }
}
function parseSetCookies(h) {
  if (!h) return '';
  return (Array.isArray(h) ? h : [h]).map(c => c.split(';')[0].trim()).filter(Boolean).join('; ');
}
function mergeCookies(base, overlay) {
  const m = new Map();
  const add = s => { if (!s) return; s.split(';').forEach(p => { const e = p.indexOf('='); const k = (e >= 0 ? p.slice(0, e) : p).trim(); if (k) m.set(k, e >= 0 ? p.slice(e + 1) : ''); }); };
  add(base); add(overlay);
  return Array.from(m.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
}
function extractCsrfToken(c, h) {
  return (c || '').match(/(?:^|;\s*)csrftoken=([^;]+)/i)?.[1] ||
    (h || '').match(/["']csrf_token["']\s*[:=]\s*["']([^"']{8,})/i)?.[1] || '';
}
function buildApiHeaders(username, s) {
  return {
    'User-Agent': PROFILE_UA, 'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9', 'Cache-Control': 'no-cache', 'Pragma': 'no-cache',
    'Referer': `https://www.instagram.com/${username}/`, 'X-IG-App-ID': '936619743392459',
    'X-ASBD-ID': '129477', 'X-Requested-With': 'XMLHttpRequest', 'X-Instagram-AJAX': '1',
    'X-IG-WWW-Claim': '0', 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty',
    ...(s?.csrfToken ? { 'X-CSRFToken': s.csrfToken } : {}),
    ...(s?.cookie ? { 'Cookie': s.cookie } : {})
  };
}

// ─── Session preload ──────────────────────────────────────────────────────────
// Cache the instagram.com homepage cookies for 30 min — saves one proxy round-trip per cold fetch
let _baseCookiesCache = { value: '', fetchedAt: 0 };
const BASE_COOKIE_TTL_MS = 30 * 60 * 1000;

async function fetchBaseCookies() {
  if (_baseCookiesCache.value && Date.now() - _baseCookiesCache.fetchedAt < BASE_COOKIE_TTL_MS) {
    return _baseCookiesCache.value;
  }
  try {
    const r = await get('https://www.instagram.com/', { 'User-Agent': PROFILE_UA, 'Accept': 'text/html,*/*', 'Accept-Language': 'en-US,en;q=0.9', 'Sec-Fetch-Site': 'none', 'Sec-Fetch-Mode': 'navigate', 'Upgrade-Insecure-Requests': '1' });
    const cookies = parseSetCookies(r.headers?.['set-cookie']);
    if (cookies) _baseCookiesCache = { value: cookies, fetchedAt: Date.now() };
    return cookies || _baseCookiesCache.value;
  } catch { return _baseCookiesCache.value; }
}

async function fetchProfileSession(username) {
  const baseCookies = await fetchBaseCookies();
  const url = `https://www.instagram.com/${encodeURIComponent(username)}/`;
  let res;
  try {
    res = await get(url, { 'User-Agent': PROFILE_UA, 'Accept': 'text/html,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9', 'Referer': 'https://www.instagram.com/', 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'navigate', 'Upgrade-Insecure-Requests': '1', ...(baseCookies ? { 'Cookie': baseCookies } : {}) });
  } catch (err) {
    if (proxyService.shouldRotateOnError(err)) proxyService.rotateProxy();
    throw new Error(`Network error: ${err.message}`);
  }
  if (res.status === 404) throw new NotFoundError('Profile not found. Check the username and try again.');
  const html = String(res.data || '');
  if (html.includes('"loginErrorCode":"not_found"') || (html.includes('<title>Page Not Found') && !html.includes(username))) throw new NotFoundError('Profile not found.');
  const cookie = mergeCookies(baseCookies, parseSetCookies(res.headers?.['set-cookie']));
  const csrfToken = extractCsrfToken(cookie, html);
  console.log(`[fetcher] Session @${username}: ${res.status}, csrf=${csrfToken ? 'yes' : 'no'}, cookies=${cookie.split(';').length}`);
  return { html, cookie, csrfToken, status: res.status };
}

// ─── Server-side story fetch (via proxy) ─────────────────────────────────────
async function fetchStoriesServerSide(userId, username, session) {
  if (!userId) return [];

  const endpoints = [
    `https://www.instagram.com/api/v1/feed/reels_media/?reel_ids=${userId}`,
    `https://www.instagram.com/api/v1/feed/user_story/?user_id=${userId}`,
    `https://www.instagram.com/api/v1/user/${userId}/story/`
  ];

  // Try 1: no session — residential proxy IP alone is often enough for public stories
  try {
    const anonHeaders = {
      'User-Agent': PROFILE_UA,
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9',
      'X-IG-App-ID': '936619743392459',
      'X-ASBD-ID': '129477',
      'Referer': `https://www.instagram.com/${username}/`
    };
    for (const url of endpoints) {
      const res = await get(url, anonHeaders);
      const data = typeof res.data === 'object' ? res.data : tryJsonParse(res.data);
      const items = res.status < 400
        ? (data?.reels_media?.[0]?.items || data?.reels?.[String(userId)]?.items || data?.story?.items || data?.items || [])
        : [];
      console.log(`[stories:anon] ${url.split('instagram.com')[1]?.split('?')[0]} → ${res.status}, items=${items.length}, body=${JSON.stringify(data).slice(0, 300)}`);
      if (items.length) return items;
    }
  } catch (e) { console.warn(`[stories:anon] request error: ${e.message}`); }

  // Try 2: warmed session pool — each entry has matching {cookie, csrfToken}
  // so Instagram does not reject the request as a csrf mismatch.
  const sessionPool = await sessionService.getFullSessionsForRetry(3);
  if (!sessionPool.length) return [];

  for (const { cookie, csrfToken, decodedId } of sessionPool) {
    const storySession = { cookie, csrfToken };
    let sessionFailed = false;
    try {
      for (const url of endpoints) {
        const res = await get(url, buildApiHeaders(username, storySession));
        const data = typeof res.data === 'object' ? res.data : tryJsonParse(res.data);
        const items = res.status < 400
          ? (data?.reels_media?.[0]?.items || data?.reels?.[String(userId)]?.items || data?.story?.items || data?.items || [])
          : [];
        console.log(`[stories:session] ${url.split('instagram.com')[1]?.split('?')[0]} → ${res.status}, items=${items.length}`);
        if ([401, 403, 429].includes(res.status)) { sessionFailed = true; break; }
        if (items.length) return items;
      }
    } catch (e) { console.warn(`[stories:session] request error: ${e.message}`); }
    if (sessionFailed) {
      sessionService.markFailed(decodedId);
      console.warn(`[stories:session] session rejected, trying next. pool: ${JSON.stringify(sessionService.stats())}`);
      continue;
    }
  }

  return [];
}

// ─── API endpoint attempts ────────────────────────────────────────────────────
async function tryWebProfileInfo(username, session) {
  const url = `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`;
  try {
    const res = await get(url, buildApiHeaders(username, session));
    const text = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
    if (res.status === 404) throw new NotFoundError();
    if (isBlockedResponse(res.status, text)) { proxyService.rotateProxy(); return { blocked: true }; }
    if (res.status >= 400) return null;
    const data = typeof res.data === 'object' ? res.data : tryJsonParse(text);
    const user = data?.data?.user || data?.data?.xdt_api__v1__users__web_profile_info?.user || data?.user;
    if (user && (user.username || user.id)) { console.log(`[fetcher] web_profile_info OK @${username}`); return normalizeProfileUser(user, 'instagram_browser_direct_fetch'); }
    return null;
  } catch (err) { if (err.name === 'NotFoundError') throw err; return null; }
}
async function tryGraphQlHash(username, hash, session) {
  const vars = JSON.stringify({ username, include_reel: true, first: 12 });
  const url = `https://www.instagram.com/api/graphql/?${new URLSearchParams({ query_hash: hash, variables: vars })}`;
  try {
    const res = await get(url, buildApiHeaders(username, session));
    const text = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
    if (isBlockedResponse(res.status, text)) { proxyService.rotateProxy(); return { blocked: true }; }
    if (res.status >= 400) return null;
    const data = typeof res.data === 'object' ? res.data : tryJsonParse(text);
    const user = data?.data?.user || data?.user;
    if (user && (user.username || user.id)) return normalizeProfileUser(user, 'instagram_browser_direct_fetch');
    return null;
  } catch { return null; }
}
async function sweepEndpoints(username, session) {
  const tasks = [
    tryWebProfileInfo(username, session),
    ...getQueryHashes().map(h => tryGraphQlHash(username, h, session))
  ];
  try {
    return await Promise.any(
      tasks.map(p => p.then(r => (r && !r.blocked ? r : Promise.reject(null))))
    );
  } catch {
    return null;
  }
}

// ─── HTML extraction ──────────────────────────────────────────────────────────
function findUserInJson(obj, depth = 0) {
  if (depth > 14 || !obj || typeof obj !== 'object') return null;
  if (Array.isArray(obj)) { for (const i of obj) { const f = findUserInJson(i, depth + 1); if (f) return f; } return null; }
  const fields = ['username', 'biography', 'full_name', 'follower_count', 'edge_followed_by', 'profile_pic_url', 'is_private', 'is_verified'];
  if (fields.filter(f => Object.prototype.hasOwnProperty.call(obj, f)).length >= 3 && (obj.username || obj.id)) return obj;
  for (const k of ['user', 'data', 'xdt_api__v1__users__web_profile_info', 'graphql']) { if (obj[k]) { const f = findUserInJson(obj[k], depth + 1); if (f) return f; } }
  for (const v of Object.values(obj)) { if (v && typeof v === 'object') { const f = findUserInJson(v, depth + 1); if (f) return f; } }
  return null;
}
function extractUserFromHtml(html, username) {
  if (!html) return null;
  const $ = cheerio.load(html);
  for (const el of $('script[type="application/json"], script:not([src]):not([type])').toArray()) {
    const text = $(el).html() || '';
    if (text.length < 200 || (!text.includes('"username"') && !text.includes('__bbox'))) continue;
    for (const prefix of ['window._sharedData', 'window.__initialDataLoaded', 'window.__additionalDataLoaded']) {
      const idx = text.indexOf(prefix);
      if (idx < 0) continue;
      const after = text.slice(idx + prefix.length);
      const jStart = after.search(/[{[]/);
      if (jStart < 0) continue;
      const parsed = tryJsonParse(after.slice(jStart).replace(/;\s*$/, ''));
      if (parsed) { const user = findUserInJson(parsed); if (user && (user.username || user.id)) return normalizeProfileUser(user, 'instagram_browser_direct_fetch'); }
    }
    const trimmed = text.trim();
    if (trimmed.startsWith('{')) { const parsed = tryJsonParse(trimmed); if (parsed) { const user = findUserInJson(parsed); if (user && (user.username || user.id)) return normalizeProfileUser(user, 'instagram_browser_direct_fetch'); } }
  }
  const needle = `"username":"${username}"`;
  let pos = 0;
  while (pos < html.length) {
    const found = html.indexOf(needle, pos);
    if (found < 0) break;
    pos = found + 1;
    let depth = 0; let objStart = -1;
    for (let i = found - 1; i >= Math.max(0, found - 20000); i--) {
      if (html[i] === '}') depth++; else if (html[i] === '{') { if (depth === 0) { objStart = i; break; } depth--; }
    }
    if (objStart < 0) continue;
    let pd = 0; let objEnd = -1;
    for (let i = objStart; i < Math.min(html.length, objStart + 40000); i++) {
      if (html[i] === '{') pd++; else if (html[i] === '}') { pd--; if (pd === 0) { objEnd = i + 1; break; } }
    }
    if (objEnd < 0) continue;
    const candidate = tryJsonParse(html.slice(objStart, objEnd));
    if (candidate?.username === username && (candidate.id || candidate.pk)) return normalizeProfileUser(candidate, 'instagram_browser_direct_fetch');
    const nested = candidate?.user || candidate?.data?.user;
    if (nested?.username === username) return normalizeProfileUser(nested, 'instagram_browser_direct_fetch');
  }
  return null;
}

// ─── Main entry point ─────────────────────────────────────────────────────────
async function fetchAllPublic(username) {
  const cacheKey = `all:${username.toLowerCase()}`;
  let session = null;

  try {
    session = await fetchProfileSession(username);
  } catch (err) {
    if (err.name === 'NotFoundError') throw err;
    console.warn(`[fetcher] Session preload failed @${username}: ${err.message}`);
  }

  if (session) {
    // Fast: try HTML deep extraction (no extra requests)
    const htmlResult = extractUserFromHtml(session.html, username);
    if (htmlResult?.posts?.items?.length > 0) return htmlResult;

    // Build partial immediately — profile (name/avatar/stats) visible to user right away
    const partial = (htmlResult && htmlResult.profile?.username) ? htmlResult : normalizeMetaOnly(username, session.html);
    partial.backgroundLoading = true;

    // Fetch stories server-side — needs profile.id; fall back to web_profile_info when HTML gave null
    if (sessionService.hasAnySessions()) {
      const { normalizeStoryItems } = require('./instagramNormalizer');
      const fireStories = (userId) => {
        fetchStoriesServerSide(userId, username, session).then(storyItems => {
          if (storyItems.length) {
            partial.stories = { available: true, items: normalizeStoryItems(storyItems), message: undefined };
            setCache(cacheKey, partial);
          }
        }).catch(() => {});
      };
      if (partial.profile?.id) {
        fireStories(partial.profile.id);
      } else {
        // HTML extraction returned no ID — fetch it from web_profile_info before stories can fire
        tryWebProfileInfo(username, session).then(r => {
          if (r && !r.blocked && r.profile?.id) {
            partial.profile.id = r.profile.id;
            console.log(`[fetcher] Resolved profile.id=${r.profile.id} via API for @${username}`);
            fireStories(r.profile.id);
          } else {
            console.warn(`[fetcher] Could not resolve profile.id for @${username} — fast-path stories skipped`);
          }
        }).catch(() => {});
      }
    }

    // Start browser fetch in background — needs the most lead time, kick it off first
    if (process.env.ENABLE_BROWSER_FALLBACK === 'true') {
      scheduleBrowserFetch(username, cacheKey);
    }

    // Sweep API endpoints in background — use a warmed session for proper auth
    sessionService.getFullSessionsForRetry(1).then(pool => {
      const sweepSession = pool[0]
        ? { ...session, cookie: pool[0].cookie, csrfToken: pool[0].csrfToken }
        : session;
      return sweepEndpoints(username, sweepSession);
    }).then(apiResult => {
      if (apiResult && !apiResult.blocked && apiResult.posts?.items?.length > 0) {
        setCache(cacheKey, apiResult);
        console.log(`[fetcher] API sweep cached @${username}: ${apiResult.posts.items.length} posts`);
      }
    }).catch(() => {});

    return partial;
  }

  // No session at all — run browser directly (blocking)
  const browserResult = await fetchViaBrowserFallback(username).catch(() => null);
  if (browserResult) return browserResult;

  const err = new Error('Could not reach Instagram. Try again shortly.');
  err.status = 503; err.igStatus = 'BLOCKED_OR_RATE_LIMITED';
  throw err;
}

module.exports = { fetchAllPublic, hasPendingBrowserJob };
