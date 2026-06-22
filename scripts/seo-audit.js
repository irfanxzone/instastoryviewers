'use strict';
const fs = require('fs');

function readFile(f) { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } }

const pages = [
  { file: 'public/index.html', url: '/' },
  { file: 'public/about.html', url: '/about' },
  { file: 'public/blog.html', url: '/blog' },
  { file: 'public/contact.html', url: '/contact' },
  { file: 'public/privacy.html', url: '/privacy' },
  { file: 'public/terms.html', url: '/terms' },
  { file: 'public/disclaimer.html', url: '/disclaimer' },
  { file: 'public/dmca.html', url: '/dmca' },
  { file: 'public/blog/view-instagram-stories-anonymously.html', url: '/blog/view-instagram-stories-anonymously' },
  { file: 'public/blog/download-instagram-reels.html', url: '/blog/download-instagram-reels' },
  { file: 'public/blog/instagram-highlights-guide.html', url: '/blog/instagram-highlights-guide' },
  { file: 'public/blog/instagram-story-analytics.html', url: '/blog/instagram-story-analytics' },
  { file: 'public/blog/grow-instagram-profile-tips.html', url: '/blog/grow-instagram-profile-tips' },
  { file: 'public/blog/anonymous-instagram-viewing-legal.html', url: '/blog/anonymous-instagram-viewing-legal' },
  { file: 'public/blog/best-instagram-tools-creators.html', url: '/blog/best-instagram-tools-creators' },
  { file: 'public/blog/what-is-instagram-story-viewer.html', url: '/blog/what-is-instagram-story-viewer' },
  { file: 'public/blog/view-instagram-without-account.html', url: '/blog/view-instagram-without-account' },
];

const issues = [];
function issue(url, check, detail) { issues.push({ url, check, detail }); }

pages.forEach(({ file, url }) => {
  const html = readFile(file);
  if (!html) { issue(url, 'FILE_MISSING', 'File does not exist: ' + file); return; }

  // Title
  const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/is);
  const title = titleMatch ? titleMatch[1].replace(/&amp;/g, '&').trim() : null;
  if (!title) issue(url, 'TITLE_MISSING', 'No <title> tag');
  else {
    if (title.length > 60) issue(url, 'TITLE_LONG', 'Title is ' + title.length + ' chars (>60): ' + title);
    if (title.length < 30) issue(url, 'TITLE_SHORT', 'Title is ' + title.length + ' chars (<30): ' + title);
  }

  // Meta description
  const descMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']*)["']/i)
    || html.match(/<meta[^>]*content=["']([^"']*)["'][^>]*name=["']description["']/i);
  const desc = descMatch ? descMatch[1] : null;
  if (!desc) issue(url, 'META_DESC_MISSING', 'No meta description');
  else {
    if (desc.length > 160) issue(url, 'META_DESC_LONG', 'Meta desc ' + desc.length + ' chars (>160)');
    if (desc.length < 120) issue(url, 'META_DESC_SHORT', 'Meta desc only ' + desc.length + ' chars (<120): ' + desc.substring(0,80));
  }

  // Robots meta
  const robotsMatch = html.match(/<meta[^>]*name=["']robots["'][^>]*content=["']([^"']*)["']/i);
  const robots = robotsMatch ? robotsMatch[1] : null;
  if (!robots) issue(url, 'ROBOTS_META_MISSING', 'No robots meta tag');
  else if (/noindex/i.test(robots)) issue(url, 'NOINDEX', 'PAGE IS NOINDEX: ' + robots);

  // Canonical
  const canonMatch = html.match(/<link[^>]*rel=["']canonical["'][^>]*href=["']([^"']*)["']/i);
  if (!canonMatch) issue(url, 'CANONICAL_MISSING', 'No canonical tag');
  else {
    const canon = canonMatch[1];
    if (!canon.startsWith('https://')) issue(url, 'CANONICAL_NOT_HTTPS', 'Canonical not HTTPS: ' + canon);
    if (canon.endsWith('/') && url !== '/') issue(url, 'CANONICAL_TRAILING_SLASH', 'Canonical has trailing slash but URL does not: ' + canon);
  }

  // H1
  const h1Matches = [...html.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/gi)];
  if (h1Matches.length === 0) issue(url, 'H1_MISSING', 'No H1 tag');
  else if (h1Matches.length > 1) issue(url, 'H1_MULTIPLE', h1Matches.length + ' H1 tags found');

  // Favicon
  const hasPNGFavicon = /<link[^>]*rel=["']icon["'][^>]*image\/png[^>]*>/i.test(html);
  const hasSVGIcon = /<link[^>]*rel=["']icon["'][^>]*svg[^>]*>/i.test(html);
  if (hasSVGIcon && !hasPNGFavicon) issue(url, 'FAVICON_SVG_ONLY', 'Only SVG favicon — no PNG fallback. GSC requires PNG.');
  const hasBrokenIco = /<link[^>]*(shortcut icon|rel=["']icon["'][^>]*\.ico)[^>]*>/i.test(html);
  if (hasBrokenIco) issue(url, 'FAVICON_ICO_REF', 'References favicon.ico which redirects to SVG (not a real ICO/PNG)');

  // OG tags
  if (!/<meta[^>]*property=["']og:image["']/i.test(html)) issue(url, 'OG_IMAGE_MISSING', 'No og:image tag');
  if (!/<meta[^>]*property=["']og:title["']/i.test(html)) issue(url, 'OG_TITLE_MISSING', 'No og:title tag');
  if (!/<meta[^>]*property=["']og:description["']/i.test(html)) issue(url, 'OG_DESC_MISSING', 'No og:description tag');

  // Twitter card
  if (!/<meta[^>]*name=["']twitter:card["']/i.test(html)) issue(url, 'TWITTER_CARD_MISSING', 'No twitter:card tag');
  if (!/<meta[^>]*name=["']twitter:image["']/i.test(html)) issue(url, 'TWITTER_IMAGE_MISSING', 'No twitter:image tag');

  // lang attr
  const langMatch = html.match(/<html[^>]*lang=["']([^"']*)["']/i);
  if (!langMatch) issue(url, 'HTML_LANG_MISSING', 'No lang attr on <html>');

  // JSON-LD validity
  const ldMatches = [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  if (ldMatches.length === 0 && !url.includes('/privacy') && !url.includes('/terms') && !url.includes('/disclaimer') && !url.includes('/dmca') && !url.includes('/contact')) {
    issue(url, 'JSON_LD_MISSING', 'No JSON-LD structured data');
  }
  ldMatches.forEach((m, i) => {
    try { JSON.parse(m[1]); } catch (e) { issue(url, 'JSON_LD_INVALID', 'JSON-LD #' + (i + 1) + ' parse error: ' + e.message); }
  });

  // Alt text on images
  const imgs = [...html.matchAll(/<img([^>]*)>/gi)];
  imgs.forEach(m => {
    if (!/alt=/i.test(m[1])) issue(url, 'IMG_ALT_MISSING', 'Image missing alt attr: ' + m[0].substring(0, 100));
  });

  // width/height on images
  imgs.forEach(m => {
    if (!/width=/i.test(m[1]) || !/height=/i.test(m[1])) {
      if (!/role=["']presentation["']/i.test(m[1])) {
        issue(url, 'IMG_DIMENSIONS_MISSING', 'Image missing width/height (CLS risk): ' + m[0].substring(0, 80));
      }
    }
  });

  // Lang mismatch: html is de but content may be english
  const htmlLang = langMatch ? langMatch[1] : '';
  if (htmlLang === 'de' && url.startsWith('/blog/')) {
    issue(url, 'LANG_MISMATCH', 'html lang="de" but blog posts appear to be in English — should be lang="en"');
  }
});

// Sitemap checks
const sitemap = readFile('public/sitemap.xml') || '';
const commentedUrls = (sitemap.match(/<!--[\s\S]*?-->/g) || []).join('');
const commentedCount = (commentedUrls.match(/<url>/g) || []).length;
if (commentedCount > 0) issue('sitemap.xml', 'SITEMAP_BLOG_COMMENTED', commentedCount + ' blog URLs commented out — not submitted to Google');
const activeUrls = [...sitemap.matchAll(/<loc>(.*?)<\/loc>/g)].map(m => m[1]);
console.log('Sitemap active URLs (' + activeUrls.length + '):', activeUrls.join(', '));
if (!sitemap.includes('<image:')) issue('sitemap.xml', 'SITEMAP_NO_IMAGE', 'No image sitemap entries');
const lastmods = [...sitemap.matchAll(/<lastmod>(.*?)<\/lastmod>/g)].map(m => m[1]);
const staleLastmod = lastmods.filter(d => d < '2026-05-01');
if (staleLastmod.length) issue('sitemap.xml', 'SITEMAP_STALE_LASTMOD', 'Stale lastmod dates: ' + staleLastmod.join(', '));

// robots.txt
const robotsTxt = readFile('public/robots.txt') || '';
console.log('robots.txt has Sitemap directive:', robotsTxt.includes('Sitemap:'));
if (!robotsTxt.includes('Sitemap:')) issue('robots.txt', 'ROBOTS_NO_SITEMAP', 'Sitemap not referenced in robots.txt');
if (robotsTxt.includes('Disallow: /src/')) issue('robots.txt', 'ROBOTS_SRC_BLOCKED', 'Disallow: /src/ — fine but double-check no needed assets are there');

// server.js checks
const server = readFile('src/server.js') || '';
if (server.includes("redirect(301, '/logo.svg')")) {
  issue('server.js', 'FAVICON_ICO_REDIRECT', '/favicon.ico 301-redirects to /logo.svg (SVG). Googlebot expects PNG/ICO bytes. Should serve PNG directly.');
}
if (server.includes('contentSecurityPolicy: false')) {
  issue('server.js', 'CSP_DISABLED', 'Content-Security-Policy is explicitly disabled in helmet config — security & trust signal risk');
}
if (!server.includes("'X-Frame-Options'") && !server.includes('"X-Frame-Options"')) {
  // helmet sets X-Frame-Options by default, check if not overridden
  console.log('helmet is used — X-Frame-Options likely set by default');
}
// No 404 custom page
if (!fs.existsSync('public/404.html')) issue('/', 'NO_404_PAGE', 'No custom 404.html page — Express returns no styled error page');

// Blog in sitemap but commented out
const blogFiles = fs.readdirSync('public/blog').filter(f => f.endsWith('.html'));
console.log('Blog post files found:', blogFiles.length, blogFiles.join(', '));
blogFiles.forEach(f => {
  const slug = f.replace('.html', '');
  if (!sitemap.includes('/blog/' + slug)) {
    issue('sitemap.xml', 'SITEMAP_MISSING_BLOG', '/blog/' + slug + ' NOT in sitemap');
  }
});

console.log('\n================== FULL ISSUE LIST ==================');
const bySeverity = {};
issues.forEach(i => {
  const key = i.check;
  if (!bySeverity[key]) bySeverity[key] = [];
  bySeverity[key].push(i.url);
});
issues.forEach(i => console.log('[' + i.check + '] ' + i.url + '\n   => ' + i.detail + '\n'));
console.log('Total issues:', issues.length);
