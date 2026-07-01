'use strict';

const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');
const { normalizeProfileUser, normalizeMetaOnly } = require('./instagramNormalizer');
const { setCacheMerged } = require('./cacheService');
const igWorkerService = require('./igWorkerService');

// ─── Chrome detection ─────────────────────────────────────────────────────────
const DEFAULT_CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe') : null,
  '/usr/bin/google-chrome-stable', '/usr/bin/chromium-browser', '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
].filter(Boolean);

function findChrome() {
  const e = process.env.CHROME_EXECUTABLE_PATH;
  if (e && fs.existsSync(e)) return e;
  return DEFAULT_CHROME.find(p => fs.existsSync(p)) || null;
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const STEALTH = `
  Object.defineProperty(navigator,'webdriver',{get:()=>undefined});
  Object.defineProperty(navigator,'plugins',{get:()=>[1,2,3,4,5]});
  Object.defineProperty(navigator,'languages',{get:()=>['en-US','en']});
  window.chrome={runtime:{},loadTimes:()=>{},csi:()=>{},app:{}};
`;
// Each PM2 worker gets its own data dir so they don't fight over Chrome's lock file
const WORKER_ID = String(process.env.NODE_APP_INSTANCE ?? 'local').replace(/[^\w.-]/g, '_');
const CHROME_DATA = path.join(process.cwd(), `.chrome-data-worker-${WORKER_ID}`);
const SESSION_STAMP = path.join(process.cwd(), `.session-stamp-worker-${WORKER_ID}`);
const WORKER_DATA_ROOT = path.join(process.cwd(), '.chrome-data-ig-workers');

// ─── Persistent browser singleton ────────────────────────────────────────────
let _pptr = null, _chromePath = null, _browser = null, _launching = null;
const _workerBrowsers = new Map();
const _workerLaunches = new Map();
const _workerProxyAuth = new Map();

function browserReady(browser = _browser) { return browser && browser.connected; }

function getProxyArgs(proxyUrl = '') {
  if (!proxyUrl) return { args: [], auth: null };
  try {
    const u = new URL(proxyUrl);
    return {
      args: [`--proxy-server=${u.protocol}//${u.hostname}:${u.port}`],
      auth: u.username ? { username: decodeURIComponent(u.username), password: decodeURIComponent(u.password || '') } : null
    };
  } catch { return { args: [], auth: null }; }
}

let _proxyAuth = null;

function pruneLegacyChromeData() {
  const root = process.cwd();
  const cutoff = Date.now() - (24 * 60 * 60 * 1000);
  let removed = 0;
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!/^\.chrome-data-\d+$/.test(entry.name) && !/^\.session-stamp-\d+$/.test(entry.name)) continue;
      const target = path.join(root, entry.name);
      if (fs.statSync(target).mtimeMs > cutoff) continue;
      fs.rmSync(target, { recursive: true, force: true });
      removed++;
    }
  } catch (err) {
    console.warn('[browser] Could not prune legacy Chrome data:', err.message);
  }
  if (removed) console.log(`[browser] Removed ${removed} stale PID-based Chrome artifacts`);
}

// Wipe chrome data when INSTAGRAM_SESSION_ID changes so stale login state can't persist
function clearChromeDataIfSessionChanged() {
  const sessionConfig = [
    process.env.IG_WORKERS || '',
    process.env.INSTAGRAM_SESSION_IDS || '',
    process.env.INSTAGRAM_STORY_SESSION_ID || '',
    process.env.INSTAGRAM_SESSION_ID || ''
  ].join('|');
  const stamp = sessionConfig
    ? crypto.createHash('sha256').update(sessionConfig).digest('hex').slice(0, 24)
    : '';
  if (!stamp) return;
  let stored = '';
  try { stored = fs.readFileSync(SESSION_STAMP, 'utf8').trim(); } catch {}
  if (stamp !== stored) {
    try { fs.rmSync(CHROME_DATA, { recursive: true, force: true }); } catch {}
    try { fs.writeFileSync(SESSION_STAMP, stamp); } catch {}
    console.log('[browser] Session changed — cleared .chrome-data for fresh login');
  }
}

function workerChromeData(worker) {
  if (!worker) return CHROME_DATA;
  return path.join(WORKER_DATA_ROOT, worker.id);
}

function workerSessionStamp(worker) {
  if (!worker) return SESSION_STAMP;
  return path.join(WORKER_DATA_ROOT, `${worker.id}.session-stamp`);
}

function clearWorkerChromeDataIfSessionChanged(worker) {
  if (!worker) return;
  const stamp = crypto
    .createHash('sha256')
    .update(`${worker.id}|${worker.sessionId}|${worker.proxyUrl}`)
    .digest('hex')
    .slice(0, 24);
  const stampFile = workerSessionStamp(worker);
  let stored = '';
  try { stored = fs.readFileSync(stampFile, 'utf8').trim(); } catch {}
  if (stamp !== stored) {
    try { fs.rmSync(workerChromeData(worker), { recursive: true, force: true }); } catch {}
    try { fs.mkdirSync(WORKER_DATA_ROOT, { recursive: true }); } catch {}
    try { fs.writeFileSync(stampFile, stamp); } catch {}
    console.log(`[browser] ${worker.id} session/proxy changed - cleared worker Chrome profile`);
  }
}

async function getBrowser(worker = null) {
  if (!worker) {
    if (browserReady()) return _browser;
    if (_launching) return _launching;
  } else {
    const existing = _workerBrowsers.get(worker.id);
    if (browserReady(existing)) return existing;
    const launching = _workerLaunches.get(worker.id);
    if (launching) return launching;
    clearWorkerChromeDataIfSessionChanged(worker);
  }
  console.log('[browser] Launching persistent Chrome…');
  const label = worker ? worker.id : 'legacy';
  const dataDir = worker ? workerChromeData(worker) : CHROME_DATA;
  const { args: proxyArgs, auth } = getProxyArgs(worker?.proxyUrl || '');
  _proxyAuth = auth;
  if (worker) _workerProxyAuth.set(worker.id, auth);
  if (proxyArgs.length) console.log(`[browser] Using fixed proxy for ${label}`);
  const launchPromise = _pptr.launch({
    headless: true, executablePath: _chromePath, userDataDir: dataDir,
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage',
           '--disable-blink-features=AutomationControlled',
           '--disable-features=IsolateOrigins,site-per-process',
           '--disable-infobars','--disable-extensions','--window-size=1440,900','--lang=en-US,en',
           ...proxyArgs],
    ignoreDefaultArgs: ['--enable-automation'], timeout: 30000
  }).then(b => {
    if (worker) {
      _workerBrowsers.set(worker.id, b);
      _workerLaunches.delete(worker.id);
    } else {
      _browser = b;
      _launching = null;
    }
    b.on('disconnected', () => { _browser = null; console.log('[browser] Chrome disconnected — will relaunch'); });
    console.log(`[browser] Chrome ready for ${label}`);
    return b;
  }).catch(err => {
    if (worker) _workerLaunches.delete(worker.id);
    else _launching = null;
    throw err;
  });
  if (worker) _workerLaunches.set(worker.id, launchPromise);
  else _launching = launchPromise;
  return launchPromise;
}

async function openPage(worker = null) {
  const b = await getBrowser(worker);
  const page = await b.newPage();
  const auth = worker ? _workerProxyAuth.get(worker.id) : _proxyAuth;
  if (auth) await page.authenticate(auth);
  await page.evaluateOnNewDocument(STEALTH);
  await page.setUserAgent(UA);
  await page.setViewport({ width: 1440, height: 900 });
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
  return page;
}

// ─── Warmup ───────────────────────────────────────────────────────────────────
async function warmupBrowser() {
  if (process.env.ENABLE_BROWSER_FALLBACK !== 'true') return;
  pruneLegacyChromeData();
  clearChromeDataIfSessionChanged();
  try { _pptr = require('puppeteer-core'); } catch { console.warn('[browser] puppeteer-core not installed'); return; }
  _chromePath = findChrome();
  if (!_chromePath) { console.warn('[browser] Chrome not found — set CHROME_EXECUTABLE_PATH in .env'); return; }
  const warmWorker = igWorkerService.hasWorkers()
    ? await igWorkerService.acquireWorker('pre-warm')
    : null;
  try {
    const page = await openPage(warmWorker);
    // Inject session on warmup so cookies are stored in the persistent profile
    const sessionId = warmWorker?.sessionId || pickSession();
    if (sessionId) {
      const dsUserId = sessionId.split(':')[0] || '';
      await page.setCookie(
        { name: 'sessionid', value: sessionId, domain: '.instagram.com', path: '/', httpOnly: true, secure: true },
        ...(dsUserId ? [{ name: 'ds_user_id', value: dsUserId, domain: '.instagram.com', path: '/', secure: true }] : [])
      );
      console.log('[browser] Session cookie injected during pre-warm');
    }
    await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    await page.close();
    console.log('[browser] Pre-warm complete — ready for requests ✓');
  } catch (err) { console.warn('[browser] Pre-warm error:', err.message); }
  finally { igWorkerService.releaseWorker(warmWorker); }
}

// ─── Helper — builds a synthetic user object from accumulated batches ─────────
function buildSyntheticUser(rawUser, accPosts, accReels, totalCount) {
  return {
    ...rawUser,
    edge_owner_to_timeline_media: {
      count: totalCount || accPosts.length,
      edges: accPosts.map(n => ({ node: n }))
    },
    edge_felix_video_timeline: {
      edges: accReels.map(n => ({ node: n }))
    }
  };
}

// ─── In-page progressive script ───────────────────────────────────────────────
// Runs inside real Chrome with Instagram's session cookies.
// Calls window.igBatch() after EVERY paginated batch so Node.js can write
// results to cache immediately — frontend gets more posts with each poll.
const IN_PAGE_SCRIPT = async function(username) {
  const csrf = document.cookie.match(/csrftoken=([^;]+)/)?.[1] || '';
  const H = {
    'X-IG-App-ID':'936619743392459','X-ASBD-ID':'129477','X-Requested-With':'XMLHttpRequest',
    'X-CSRFToken':csrf,'X-Instagram-AJAX':'1','Accept':'application/json, text/plain, */*',
    'Accept-Language':'en-US,en;q=0.9','Referer':`https://www.instagram.com/${username}/`
  };
  async function GET(url) {
    try { const r=await fetch(url,{headers:H,credentials:'include'}); return r.ok?r.json():null; }
    catch { return null; }
  }

  // ── Profile ───────────────────────────────────────────────────────────────
  const init = await GET(`/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`);
  let user = init?.data?.user || init?.data?.xdt_api__v1__users__web_profile_info?.user || init?.user;

  // Fallback: extract userId from page DOM if web_profile_info is rate-limited (returns null)
  if (!user || !user.id) {
    const alUrl = document.querySelector('meta[property="al:ios:url"]')?.content || '';
    const pageId = alUrl.match(/id=(\d+)/)?.[1];
    console.log(`[ig-init] web_profile_info failed, al:ios:url id=${pageId||'not found'}`);
    if (pageId) {
      // Minimal user object — enough to fetch stories and posts
      user = { id: pageId, username, pk: pageId,
               edge_owner_to_timeline_media: { count: 0, edges: [] },
               edge_felix_video_timeline:    { edges: [] },
               edge_highlight_reels:         { edges: [] } };
    }
  }

  if (!user || !user.id) {
    const title = document.title || '';
    const url   = window.location.href;
    const isLogin = document.body?.innerText?.toLowerCase().includes('log in') && document.body?.innerText?.length < 5000;
    console.log(`[ig-init] FAIL | url=${url} | title=${title.slice(0,60)} | bodyLen=${document.body?.innerText?.length} | looksLikeLogin=${isLogin}`);
    return { ok: false };
  }
  const uid        = user.id || user.pk;
  const totalPosts = user.edge_owner_to_timeline_media?.count || 0;
  console.log(`[ig-init] uid=${uid} totalPosts=${totalPosts}`);

  // Report the initial user profile immediately
  await window.igBatch({ type: 'init', user, totalCount: totalPosts, moreAvail: totalPosts > 0 });

  // ── Stories — fetch FIRST (before the long post loop) ─────────────────────
  try {
    const storyEndpoints = [
      `/api/v1/feed/reels_media/?reel_ids=${uid}`,
      `/api/v1/feed/user_story/?user_id=${uid}`,
      `/api/v1/user/${uid}/story/`
    ];
    for (const ep of storyEndpoints) {
      let status = 0, d = null;
      try {
        const r = await fetch(ep, { headers: H, credentials: 'include' });
        status = r.status;
        d = await r.json().catch(() => null);
      } catch (e) {
        console.log(`[ig-story] ${ep.split('?')[0]} threw: ${e.message}`);
        continue;
      }
      const items = status < 400
        ? (d?.reels_media?.[0]?.items || d?.reels?.[String(uid)]?.items || d?.story?.items || d?.items || [])
        : [];
      console.log(`[ig-story] ${ep.split('?')[0]} → ${status}, items=${items.length}, body=${JSON.stringify(d).slice(0, 250)}`);
      if (items.length) {
        await window.igBatch({ type: 'stories', items, moreAvail: false });
        break;
      }
    }
  } catch (e) { console.log(`[ig-story] outer error: ${e.message}`); }

  // ── Posts — ALL pages ─────────────────────────────────────────────────────
  // Strategy:
  //  Authenticated session → web_profile_info returns no embedded posts/cursor,
  //    start mobile feed from page 1 (no max_id).
  //  Anonymous session → web_profile_info embeds 12 posts + cursor,
  //    report those first then continue from cursor.
  const embeddedEdges = user.edge_owner_to_timeline_media?.edges || [];
  const hasCursor     = !!user.edge_owner_to_timeline_media?.page_info?.end_cursor;
  const initCursor    = user.edge_owner_to_timeline_media?.page_info?.end_cursor;
  const seenIds       = new Set(embeddedEdges.map(e => (e.node||e)?.id).filter(Boolean));

  // Report embedded posts if present (anonymous path)
  if (embeddedEdges.length > 0) {
    const initItems = embeddedEdges.map(e => e.node || e);
    await window.igBatch({ type: 'posts', items: initItems, totalCount: totalPosts, moreAvail: true });
  }

  // ALWAYS attempt to fetch — moreAvail starts true and the API response controls stopping.
  // This handles authenticated sessions where totalPosts may be 0 from web_profile_info
  // (Instagram omits media_count when a session is active).
  let nextMaxId = hasCursor ? initCursor : null;
  let moreAvail = true;   // always try — API returns empty items when truly done
  let pageNum   = 0;
  let loadedPostCount = embeddedEdges.length;

  while (moreAvail && pageNum < 12 && loadedPostCount < 120) {
    pageNum++;
    const url = nextMaxId
      ? `/api/v1/feed/user/${uid}/?count=12&max_id=${encodeURIComponent(nextMaxId)}`
      : `/api/v1/feed/user/${uid}/?count=12`;
    const feed = await GET(url);
    if (!feed?.items?.length) break;   // API says no more → stop

    // Skip duplicates that were already in the embedded batch
    let newItems = (pageNum === 1 && !hasCursor && seenIds.size > 0)
      ? feed.items.filter(i => !seenIds.has(i.id))
      : feed.items;
    newItems = newItems.slice(0, Math.max(0, 120 - loadedPostCount));

    if (newItems.length) {
      await window.igBatch({ type: 'posts', items: newItems, totalCount: totalPosts, moreAvail: !!feed.more_available });
      loadedPostCount += newItems.length;
    }
    nextMaxId = feed.next_max_id;
    moreAvail = !!feed.more_available;   // API controls whether to continue
  }
  await window.igBatch({ type: 'posts_done', items: [], totalCount: totalPosts, moreAvail: false });

  // ── Reels — ALL pages ─────────────────────────────────────────────────────
  const initReels = (user.edge_felix_video_timeline?.edges || []).map(e => e.node || e);
  if (initReels.length) {
    await window.igBatch({ type: 'reels', items: initReels, moreAvail: true });
  }
  let reelMaxId     = user.edge_felix_video_timeline?.page_info?.end_cursor;
  let reelMoreAvail = true;
  let reelPage      = 0;
  let loadedReelCount = initReels.length;

  while (reelMoreAvail && reelPage < 10 && loadedReelCount < 120) {
    reelPage++;
    const reelUrl = reelMaxId
      ? `/api/v1/clips/user/?user_id=${uid}&max_id=${encodeURIComponent(reelMaxId)}&count=12`
      : `/api/v1/clips/user/?user_id=${uid}&count=12`;
    const feed = await GET(reelUrl);
    if (!feed?.items?.length) break;
    const items = feed.items.map(i => i.media || i).slice(0, Math.max(0, 120 - loadedReelCount));
    await window.igBatch({ type: 'reels', items, moreAvail: !!feed.paging_info?.more_available });
    loadedReelCount += items.length;
    reelMaxId     = feed.paging_info?.max_id;
    reelMoreAvail = !!feed.paging_info?.more_available && !!reelMaxId;
  }

  // ── Highlights ────────────────────────────────────────────────────────────
  try {
    const hlEdges = user.edge_highlight_reels?.edges || [];
    const full = [];
    for (const edge of hlEdges.slice(0, 15)) {
      const node = edge.node || edge;
      const hid  = (node.id || '').replace('highlight:', '');
      if (!hid) { full.push(node); continue; }
      const hData = await GET(`/api/v1/highlights/${hid}/highlights_media/`).catch(() => null);
      const items = hData?.reels?.['highlight:'+hid]?.items || hData?.reels?.[hid]?.items || [];
      full.push({ ...node, _items: items });
    }
    if (full.length) await window.igBatch({ type: 'highlights', items: full, moreAvail: false });
  } catch {}

  await window.igBatch({ type: 'done', moreAvail: false, totalCount: totalPosts });
  return { ok: true };
};

// Safely decode URL-encoded session IDs (Instagram stores them URL-encoded)
function getSessionId() {
  const raw = process.env.INSTAGRAM_SESSION_ID || '';
  if (!raw) return '';
  try { return decodeURIComponent(raw); } catch { return raw; }
}

// Pick a session from the pool, fall back to the single env var
function pickSession() {
  try {
    const { getNextSession } = require('./sessionService');
    return getNextSession() || getSessionId();
  } catch { return getSessionId(); }
}

// ─── Main fallback function ───────────────────────────────────────────────────
async function fetchViaBrowserFallbackAttempt(username, cacheKey = null, triedWorkerIds = null) {
  if (process.env.ENABLE_BROWSER_FALLBACK !== 'true') return null;

  // Self-initialize if warmup never ran (e.g. warmup failed on startup)
  if (!_pptr) {
    try { _pptr = require('puppeteer-core'); }
    catch { console.warn('[browser] puppeteer-core not installed'); return null; }
  }
  if (!_chromePath) {
    _chromePath = findChrome();
    if (!_chromePath) { console.warn('[browser] Chrome not found'); return null; }
  }

  const worker = igWorkerService.hasWorkers()
    ? await igWorkerService.acquireWorker(`@${username}`, triedWorkerIds)
    : null;
  if (igWorkerService.hasWorkers() && !worker) return null;
  if (worker && triedWorkerIds instanceof Set) triedWorkerIds.add(worker.id);

  let page;
  try { page = await openPage(worker); }
  catch (err) {
    console.warn('[browser] Could not open page:', err.message);
    igWorkerService.markWorkerFailed(worker, `openPage:${err.message}`);
    igWorkerService.releaseWorker(worker);
    return null;
  }

  // Surface console.log calls from the in-page script (story diagnostics tagged [ig-story])
  page.on('console', msg => {
    const text = msg.text();
    if (text.startsWith('[ig-')) console.log(`[browser-page] ${text}`);
  });

  // Accumulate batches in Node.js scope
  const accPosts    = [];
  const accReels    = [];
  let   rawUser     = null;
  let   totalCount  = 0;
  let   jobDone     = false;   // only true after explicit 'done' signal

  try {
    // igBatch is called from browser JS after each pagination batch
    await page.exposeFunction('igBatch', payload => {
      try {
        const { type, user, items = [], totalCount: tc = 0, moreAvail = false } = payload;

        if (type === 'init' && user) {
          rawUser = user;
          totalCount = tc;
          // Include the first 12 posts that come with web_profile_info
          const initItems = (user.edge_owner_to_timeline_media?.edges || []).map(e => e.node || e);
          accPosts.push(...initItems);
        }
        else if (type === 'posts' && items.length) {
          accPosts.push(...items);
          if (tc) totalCount = tc;
        }
        else if (type === 'reels' && items.length) {
          accReels.push(...items);
        }
        else if (type === 'stories' && items.length && rawUser) {
          rawUser._stories = items;
        }
        else if (type === 'highlights' && items.length && rawUser) {
          rawUser._highlights = items;
        }
        else if (type === 'done') {
          jobDone = true;
        }

        // Write to cache after every batch so the frontend can poll for progress
        if (rawUser && cacheKey) {
          const synthetic = buildSyntheticUser(rawUser, accPosts, accReels, totalCount);
          const result    = normalizeProfileUser(synthetic, 'instagram_browser_fallback');
          // Stay in backgroundLoading until the explicit 'done' signal
          // (moreAvail alone is unreliable since totalPosts may be 0 with auth sessions)
          if (!jobDone) {
            result.backgroundLoading = true;
            result.loadingProgress   = {
              postsLoaded: accPosts.length,
              postsTotal:  totalCount || accPosts.length,
              reelsLoaded: accReels.length
            };
          }
          setCacheMerged(cacheKey, result);
          if (accPosts.length > 12) {
            console.log(`[browser] Cache updated: ${accPosts.length}/${totalCount || '?'} posts, ${accReels.length} reels`);
          }
        }
      } catch (e) { console.warn('[browser] igBatch error:', e.message); }
    });

    // Inject session cookie from pool — unlocks stories, highlights and richer data.
    // Rotates through the 8-session pool so no single account gets hammered.
    const sessionId = worker?.sessionId || pickSession();
    const dsUserId = worker?.dsUserId || sessionId?.split(':')[0] || '';
    if (sessionId) {
      const existing = await page.cookies('https://www.instagram.com/').catch(() => []);
      if (existing.length) await page.deleteCookie(...existing).catch(() => {});
      const cookies = [
        { name: 'sessionid',  value: sessionId, domain: '.instagram.com', path: '/', httpOnly: true,  secure: true },
        { name: 'ds_user_id', value: dsUserId,  domain: '.instagram.com', path: '/', httpOnly: false, secure: true }
      ].filter(c => c.value);
      await page.setCookie(...cookies);
      if (worker) console.log(`[browser] Worker ${worker.id} owns @${username} for this fetch`);
      console.log(`[browser] Session injected for @${username} (…${sessionId.slice(-8)})`);
    }

    console.log(`[browser] Fetching @${username}…`);
    await page.goto(`https://www.instagram.com/${encodeURIComponent(username)}/`, {
      waitUntil: 'domcontentloaded', timeout: 20000
    });

    // Detect scraping challenge and auto-dismiss it
    const finalUrl = page.url();
    if (/\/accounts\/(suspended|login|challenge|scraping_warning)/i.test(finalUrl)) {
      throw new Error(`bad_session_redirect:${finalUrl}`);
    }
    if (finalUrl.includes('scraping_warning') || finalUrl.includes('challenge')) {
      console.warn(`[browser] Scraping challenge detected — attempting to dismiss…`);
      try {
        // Click the "OK" / "Continue" button on the challenge page
        await page.evaluate(() => {
          const btn = document.querySelector('button[type="button"], button[type="submit"]');
          if (btn) btn.click();
        });
        await new Promise(r => setTimeout(r, 2000));
        // Navigate to the actual profile after dismissal
        await page.goto(`https://www.instagram.com/${encodeURIComponent(username)}/`, {
          waitUntil: 'domcontentloaded', timeout: 15000
        });
        console.log(`[browser] Post-challenge URL: ${page.url()}`);
      } catch (e) {
        console.warn(`[browser] Challenge dismiss failed: ${e.message}`);
      }
    }

    // Wait for Instagram's own JS to fire its network requests
    await new Promise(r => setTimeout(r, 3000));

    // Run the full in-page script: profile + ALL posts + ALL reels + stories + highlights
    await page.evaluate(IN_PAGE_SCRIPT, username).catch(err => {
      console.warn('[browser] Script error:', err.message);
    });

    // Build final result from accumulated data
    if (rawUser) {
      const synthetic = buildSyntheticUser(rawUser, accPosts, accReels, totalCount);
      const result    = normalizeProfileUser(synthetic, 'instagram_browser_fallback');
      console.log(`[browser] @${username} done: ${accPosts.length} posts, ${accReels.length} reels, ${rawUser._stories?.length||0} stories`);
      return result;
    }

    const html = await page.content();
    return normalizeMetaOnly(username, html);

  } catch (err) {
    console.warn(`[browser] Error @${username}: ${err.message}`);
    igWorkerService.markWorkerFailed(worker, err.message);
    return null;
  } finally {
    await page.close().catch(() => {});  // keep browser alive, close only the tab
    igWorkerService.releaseWorker(worker);
  }
}

async function fetchViaBrowserFallback(username, cacheKey = null) {
  const maxAttempts = igWorkerService.hasWorkers()
    ? Number(process.env.IG_WORKER_FETCH_ATTEMPTS || 3)
    : 1;
  const triedWorkerIds = new Set();
  let bestZeroStoryResult = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await fetchViaBrowserFallbackAttempt(username, cacheKey, triedWorkerIds);
    if (result) {
      const storyCount = result.stories?.items?.length || 0;
      const mediaCount = (result.posts?.items?.length || 0) + (result.reels?.items?.length || 0);
      const hasProfile = !!result.profile?.username;

      if (storyCount > 0 || !igWorkerService.hasWorkers()) return result;

      // Instagram sometimes returns 200 OK with an empty stories payload for one
      // session, while another healthy session can see the stories. Treat zero
      // stories as inconclusive when the profile/media loaded successfully.
      if (hasProfile || mediaCount > 0) {
        bestZeroStoryResult ||= result;
        if (attempt < maxAttempts) {
          console.warn(`[browser] @${username} returned 0 stories; trying another worker (${attempt + 1}/${maxAttempts})`);
          continue;
        }
      }

      return result;
    }
    if (attempt < maxAttempts) {
      console.warn(`[browser] Retrying @${username} with another worker (${attempt + 1}/${maxAttempts})`);
    }
  }

  return bestZeroStoryResult;
}

module.exports = { fetchViaBrowserFallback, warmupBrowser };
