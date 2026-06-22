/**
 * Generates PNG favicons from logo.svg using puppeteer-core + system Chrome.
 * Run once: node scripts/generate-favicons.js
 * Outputs: public/favicon-32.png, public/favicon-192.png, public/favicon-512.png
 */
const fs   = require('fs');
const path = require('path');

const CHROME_PATHS = [
  process.env.CHROME_EXECUTABLE_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe') : null,
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
].filter(Boolean);

function findChrome() {
  return CHROME_PATHS.find(p => { try { return fs.existsSync(p); } catch { return false; } }) || null;
}

async function main() {
  const chromePath = findChrome();
  if (!chromePath) {
    console.error('Chrome not found. Set CHROME_EXECUTABLE_PATH env var.');
    process.exit(1);
  }
  console.log('Using Chrome:', chromePath);

  let puppeteer;
  try { puppeteer = require('puppeteer-core'); }
  catch { console.error('puppeteer-core not installed'); process.exit(1); }

  const svgPath = path.join(__dirname, '../public/logo.svg');
  const svgContent = fs.readFileSync(svgPath, 'utf8');
  const svgDataUri = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgContent);

  const publicDir = path.join(__dirname, '../public');
  const sizes = [32, 192, 512];

  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  try {
    const page = await browser.newPage();

    for (const size of sizes) {
      await page.setViewport({ width: size, height: size, deviceScaleFactor: 1 });
      await page.setContent(`<!DOCTYPE html><html><head>
        <style>*{margin:0;padding:0;overflow:hidden}body{width:${size}px;height:${size}px;background:transparent}</style>
        </head><body><img src="${svgDataUri}" width="${size}" height="${size}" style="display:block"/></body></html>`);
      await page.waitForNetworkIdle({ idleTime: 200, timeout: 5000 }).catch(() => {});

      const buf = await page.screenshot({
        type: 'png',
        omitBackground: true,
        clip: { x: 0, y: 0, width: size, height: size },
      });

      const outFile = path.join(publicDir, `favicon-${size}.png`);
      fs.writeFileSync(outFile, buf);
      console.log('Written:', outFile);
    }
  } finally {
    await browser.close();
  }

  console.log('\nDone. Now update index.html and site.webmanifest (see comments below).');
}

main().catch(e => { console.error(e); process.exit(1); });
