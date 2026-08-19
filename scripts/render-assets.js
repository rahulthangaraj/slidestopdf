// Renders the publishing assets to PNG at the sizes Figma Community expects.
//   npm install --no-save playwright && node render-assets.js
const { chromium } = require('playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  // Plugin icon — 128x128
  const icon = await browser.newPage({ viewport: { width: 128, height: 128 } });
  await icon.goto('file://' + path.join(__dirname, 'assets', 'icon.svg'));
  await icon.waitForTimeout(300);
  await icon.screenshot({ path: path.join(__dirname, 'assets', 'icon.png'), omitBackground: true });
  await icon.close();

  // Cover art — 1920x960
  const cover = await browser.newPage({ viewport: { width: 1920, height: 960 } });
  await cover.goto('file://' + path.join(__dirname, 'assets', 'cover.html'));
  // Give webfonts a chance; the page has local fallbacks if they don't load.
  await cover.waitForTimeout(2500);
  await cover.screenshot({ path: path.join(__dirname, 'assets', 'cover.png') });
  await cover.close();

  await browser.close();
  console.log('rendered assets/icon.png (128x128) and assets/cover.png (1920x960)');
})().catch(e => { console.error(e); process.exitCode = 1; });
