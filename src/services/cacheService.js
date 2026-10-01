'use strict';

const fs = require('fs');
const path = require('path');
const { LRUCache } = require('lru-cache');

// TTLs from env — env var names match .env.example
const freshTtlMs = Number(process.env.CACHE_TTL_SECONDS || 900) * 1000;
const staleTtlMs = Number(process.env.STALE_CACHE_TTL_SECONDS || 86400) * 1000;
const emptyStoriesTtlMs = Number(process.env.EMPTY_STORIES_TTL_SECONDS || 120) * 1000;
const storyLifetimeMs = 24 * 60 * 60 * 1000;

// Vercel's filesystem is read-only — /tmp is the only writable directory
const defaultCachePath = process.env.VERCEL
  ? '/tmp/cache.json'
  : path.join(process.cwd(), 'src/storage/cache.json');

const cacheFile = process.env.CACHE_FILE
  ? path.resolve(process.cwd(), process.env.CACHE_FILE)
  : defaultCachePath;

// LRU keeps at most 5 000 entries in memory; they survive up to stale TTL
const memory = new LRUCache({ max: 5000, ttl: staleTtlMs });
let disk = {};

function loadDisk() {
  try {
    if (fs.existsSync(cacheFile)) {
      const raw = fs.readFileSync(cacheFile, 'utf8');
      disk = JSON.parse(raw) || {};
      // Hydrate LRU from disk so restarts keep warm cache
      for (const [key, value] of Object.entries(disk)) {
        memory.set(key, value);
      }
      console.log(`[cache] Loaded ${Object.keys(disk).length} entries from disk`);
    }
  } catch {
    disk = {};
  }
}

function saveDisk() {
  try {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify(disk, null, 2));
  } catch {}
}

function sanitizeStories(data, stale) {
  if (!data?.stories) return data;
  const now = Date.now();
  const original = data.stories.items || [];
  const items = original.filter(item => {
    const takenAt = Date.parse(item?.timestamp || '');
    if (Number.isFinite(takenAt)) return takenAt + storyLifetimeMs > now;
    // Unknown-age stories are safe only in the fresh cache window.
    return !stale;
  });
  if (items.length === original.length) return data;
  return {
    ...data,
    stories: {
      ...data.stories,
      available: items.length > 0,
      items,
      state: items.length ? data.stories.state : 'EMPTY',
      message: items.length ? undefined : 'No active stories in the last 24 hours.'
    }
  };
}

/**
 * @param {string} key
 * @param {{ allowStale?: boolean }} opts
 * @returns {{ hit: boolean, stale: boolean, ageMs: number, data: object } | null}
 */
function getCache(key, { allowStale = true } = {}) {
  let item = memory.get(key) || disk[key];
  // On miss, re-read disk — another PM2 worker may have written a newer entry
  if (!item) {
    try {
      const fresh = JSON.parse(fs.readFileSync(cacheFile, 'utf8') || '{}');
      item = fresh[key];
      if (item) { disk[key] = item; memory.set(key, item); }
    } catch {}
  }
  if (!item || !item.savedAt || !item.data) return null;

  const ageMs = Date.now() - item.savedAt;

  // Don't serve cached error shells (no profile id and status is error)
  const d = item.data;
  if (d?.status === 'ERROR' || (d && !d.success)) return null;

  const effectiveFreshTtl = item.data?.stories?.state === 'EMPTY'
    ? Math.min(freshTtlMs, emptyStoriesTtlMs)
    : freshTtlMs;

  if (ageMs <= effectiveFreshTtl) {
    return { hit: true, stale: false, ageMs, data: sanitizeStories(item.data, false) };
  }
  if (allowStale && ageMs <= staleTtlMs) {
    return { hit: true, stale: true, ageMs, data: sanitizeStories(item.data, true) };
  }
  return null;
}

/**
 * @param {string} key
 * @param {object} data  Normalized profile data object
 */
function setCache(key, data) {
  // Don't cache failed or empty responses
  if (!data || !data.success) return;
  const item = { savedAt: Date.now(), data };
  memory.set(key, item);
  disk[key] = item;
  saveDisk();
}

/**
 * Merge a background result without allowing a poorer response to erase media
 * already collected by another async path (browser, stories HTTP, API sweep).
 */
function setCacheMerged(key, data) {
  if (!data || !data.success) return;

  const current = memory.get(key) || disk[key];
  const previous = current?.data;
  if (!previous?.success) {
    setCache(key, data);
    return;
  }

  const score = value =>
    (value?.posts?.items?.length || 0) +
    (value?.reels?.items?.length || 0) +
    ((value?.stories?.items?.length || 0) * 100) +
    ((value?.highlights?.items?.length || 0) * 10);
  const incomingIsRicher = score(data) >= score(previous);
  const richer = incomingIsRicher ? data : previous;
  const poorer = incomingIsRicher ? previous : data;
  const merged = { ...poorer, ...richer };
  for (const section of ['stories', 'highlights', 'posts', 'reels']) {
    const oldSection = previous[section];
    const newSection = data[section];
    const oldCount = oldSection?.items?.length || 0;
    const newCount = newSection?.items?.length || 0;
    merged[section] = newCount >= oldCount ? newSection : oldSection;
  }

  // Profile API responses can be partial. Keep known fields when the incoming
  // object omits them, while still accepting corrected IDs and fresh counters.
  merged.profile = {
    ...(poorer.profile || {}),
    ...(richer.profile || {})
  };

  setCache(key, merged);
}

function deleteCache(key) {
  memory.delete(key);
  delete disk[key];
  saveDisk();
}

loadDisk();

module.exports = { getCache, setCache, setCacheMerged, deleteCache };
