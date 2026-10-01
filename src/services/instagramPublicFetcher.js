'use strict';

const cheerio = require('cheerio');
const { get } = require('../utils/httpClient');
const { normalizeProfileUser, normalizeMetaOnly } = require('./instagramNormalizer');
const { fetchViaBrowserFallback } = require('./browserFallbackService');
const { isLoginWallText, isBlockedResponse, NotFoundError } = require('../utils/errors');
const proxyService = require('./proxyService');
const { setCache, setCacheMerged } = require('./cacheService');
const sessionService = require('./sessionService');
const { fetchStoriesViaOpenHandle, fetchMediaViaOpenHandle } = require('./openHandleService');

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

function unavailableStories(message = 'Stories could not be loaded right now. Please try again shortly.') {
  return { available: false, items: [], source: 'openhandle', state: 'TEMPORARILY_UNAVAILABLE', message };
}

async function attachOpenHandleStories(username, result) {
  if (!result?.success) return result;
  if (result.profile?.isPrivate) {
    result.stories = {
      available: false, items: [], source: 'openhandle', state: 'PRIVATE',
      message: 'This account is private. Stories are not publicly available.'
    };
    return result;
  }
  try {
    result.stories = await fetchStoriesViaOpenHandle(username);
    result.source = `${result.source || 'instagram_public'}+openhandle_stories`;
  } catch (error) {
    console.warn(`[openhandle:stories] Failed @${username}: HTTP ${error.status || 'network'}`);
    result.stories = unavailableStories();
  }
  return result;
}

async function attachProviderFallbacks(username, result) {
  result = await attachOpenHandleStories(username, result);
  if (!result?.success || result.profile?.isPrivate) return result;

  const missing = ['posts', 'reels'].filter(section => !result[section]?.items?.length);
  const fetched = await Promise.allSettled(
    missing.map(section => fetchMediaViaOpenHandle(username, section))
  );
  fetched.forEach((entry, index) => {
    const section = missing[index];
    if (entry.status === 'fulfilled') result[section] = entry.value;
    else console.warn(`[openhandle:${section}:fallback] Failed @${username}: HTTP ${entry.reason?.status || 'network'}`);
  });

  if (result.posts?.items?.length && result.reels?.items?.length) {
    result.backgroundLoading = false;
    result.source = `${result.source || 'instagram_public'}+openhandle_media_fallback`;
  }
  return result;
}

function scheduleBrowserFetch(username, cacheKey) {
  const key = username.toLowerCase();
  if (activeBrowserJobs.has(key)) return; // already running

  const job = fetchViaBrowserFallback(username, cacheKey)
    .then(async result => {
      if (result?.success && result.profile?.username) {
        // Browser supplies profile/posts/reels only. Stories come exclusively
        // from OpenHandle in the foreground response.
        result.stories = unavailableStories();
        result.backgroundLoading = false;
        setCacheMerged(cacheKey, result);
        console.log(`[bg] Browser fetch done @${username}: ${result.posts?.items?.length || 0} posts, ${result.reels?.items?.length || 0} reels`);
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
  const cacheKey = `all:hybrid-v2:${username.toLowerCase()}`;
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
    if (htmlResult?.posts?.items?.length > 0) return attachProviderFallbacks(username, htmlResult);

    // Build partial immediately — profile (name/avatar/stats) visible to user right away
    const partial = (htmlResult && htmlResult.profile?.username) ? htmlResult : normalizeMetaOnly(username, session.html);
    partial.backgroundLoading = true;
    if (!partial.profile?.isPrivate && !partial.stories?.items?.length) {
      partial.stories = {
        ...(partial.stories || {}),
        available: false,
        items: [],
        state: 'TEMPORARILY_UNAVAILABLE',
        message: 'Stories could not be loaded right now. Please try again shortly.'
      };
    }

    // Sweep API endpoints in background — use a warmed session for proper auth
    if (!process.env.IG_WORKERS) {
      sessionService.getFullSessionsForRetry(1).then(pool => {
        const sweepSession = pool[0]
          ? { ...session, cookie: pool[0].cookie, csrfToken: pool[0].csrfToken }
          : session;
        return sweepEndpoints(username, sweepSession);
      }).then(apiResult => {
        if (apiResult && !apiResult.blocked && apiResult.posts?.items?.length > 0) {
          // The API sweep is often profile-only. Never let it erase stories or
          // browser batches that completed while this request was in flight.
          apiResult.backgroundLoading = hasPendingBrowserJob(username);
          setCacheMerged(cacheKey, apiResult);
          console.log(`[fetcher] API sweep cached @${username}: ${apiResult.posts.items.length} posts`);
        }
      }).catch(() => {});
    }

    return attachProviderFallbacks(username, partial);
  }

  // No session at all — run browser directly (blocking)
  const browserResult = await fetchViaBrowserFallback(username);
  if (browserResult) return attachProviderFallbacks(username, browserResult);

  const err = new Error('Could not reach Instagram. Try again shortly.');
  err.status = 503; err.igStatus = 'BLOCKED_OR_RATE_LIMITED';
  throw err;
}

module.exports = { fetchAllPublic, hasPendingBrowserJob };
