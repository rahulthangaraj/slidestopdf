// Renders dist/ui.html in headless Chromium against a mock sandbox and writes
// screenshots of both screens. Lets the UI be checked without loading Figma.
//
//   node test/preview.js [outDir]
//
// Requires playwright (not a project dependency — install ad hoc):
//   npm install --no-save playwright
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const root = path.join(__dirname, '..');
const outDir = process.argv[2] || path.join(root, 'preview-shots');

// A valid PNG of a flat colour, built by hand so the harness needs no assets.
function png(width, height, rgb) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crcBuf]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit, truecolour
  const row = Buffer.concat([Buffer.from([0]), Buffer.concat(Array(width).fill(Buffer.from(rgb)))]);
  const raw = Buffer.concat(Array(height).fill(row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

let table = null;
function crc32(buf) {
  if (!table) {
    table = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ 0xffffffff;
}

const FRAMES = [
  'Title — Q4 Review', 'Agenda', 'Revenue by segment', 'Churn deep dive',
  'Roadmap H1', 'Hiring plan', 'a really long frame name that should truncate nicely', 'Appendix',
];
const TINTS = [[232,240,254],[255,241,230],[233,248,238],[253,236,239],[240,238,252],[236,247,252],[250,246,231],[240,240,240]];

async function main() {
  fs.mkdirSync(outDir, { recursive: true });

  const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

  const logs = [];
  page.on('console', m => logs.push(m.type() + ': ' + m.text()));
  page.on('pageerror', e => logs.push('PAGEERROR: ' + e.message));

  // Stand in for the Figma sandbox: the UI posts to parent, we answer.
  await page.exposeFunction('__sandbox', (raw) => {
    const msg = JSON.parse(raw);
    if (msg.type === 'GET_FRAMES') {
      return JSON.stringify({
        type: 'FRAMES_LIST', reason: 'request',
        // Every frame on the page is listed; `selected` is what starts ticked.
        frames: FRAMES.map((name, i) => ({ id: 'n' + i, name, width: 1920, height: 1080 })),
        selected: ['n0', 'n1', 'n2'],
      });
    }
    if (msg.type === 'EXPORT_FRAMES') {
      // Stop partway so the busy button state can be captured.
      return JSON.stringify({
        type: '__EXPORT__',
        total: msg.frameIds.length,
        current: Math.ceil(msg.frameIds.length / 2),
        name: FRAMES[1],
      });
    }
    if (msg.type === 'RENDER_PREVIEWS') {
      return JSON.stringify({
        type: '__BATCH__',
        items: msg.frameIds.map((id, i) => ({
          type: 'PREVIEW_DATA', id, kind: msg.kind,
          png: png(64, 36, TINTS[Number(id.slice(1)) % TINTS.length]).toString('base64'),
        })),
      });
    }
    return null;
  });

  await page.addInitScript(() => {
    const b64 = (s) => Uint8Array.from(atob(s), c => c.charCodeAt(0));
    // Dispatch directly rather than calling window.postMessage: this page is
    // top-level, so parent === window and the override below would otherwise
    // clobber the very channel used to deliver replies.
    const deliver = (m) => window.dispatchEvent(new MessageEvent('message', { data: { pluginMessage: m } }));
    window.parent.postMessage = async (payload) => {
      const msg = payload && payload.pluginMessage;
      if (!msg) return;
      const res = await window.__sandbox(JSON.stringify(msg));
      if (!res) return;
      const parsed = JSON.parse(res);
      if (parsed.type === '__EXPORT__') {
        deliver({ type: 'EXPORT_START', total: parsed.total });
        deliver({ type: 'EXPORT_PROGRESS', current: parsed.current, total: parsed.total, name: parsed.name });
        return;
      }
      if (parsed.type === '__BATCH__') {
        for (const item of parsed.items) {
          deliver({ type: 'PREVIEW_DATA', id: item.id, kind: item.kind, bytes: b64(item.png) });
        }
        deliver({ type: 'PREVIEW_DONE', kind: 'thumb' });
        return;
      }
      deliver(parsed);
    };
  });

  await page.goto('file://' + path.join(root, 'dist', 'ui.html'));
  await page.waitForTimeout(700);

  await page.screenshot({ path: path.join(outDir, '1-picker.png') });

  const hasOwnHeader = await page.locator('.header').count();
  const footerBox = await page.locator('.footer').boundingBox();
  const vp = page.viewportSize();
  const footerPinned = Math.abs((footerBox.y + footerBox.height) - vp.height) < 1.5;
  const pageScrolls = await page.evaluate(() => document.documentElement.scrollHeight > window.innerHeight + 1);

  const ctaOnLoad = await page.locator('#continue-btn .btn-label').innerText();
  const idleSpinnerW = await page.locator('#continue-btn .btn-spinner').evaluate(n => n.getBoundingClientRect().width);

  // Tick two more cards to exercise the indeterminate state and the CTA count.
  await page.locator('.card').nth(4).click();
  await page.locator('.card').nth(5).click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(outDir, '2-picker-partial.png') });

  const cta = await page.locator('#continue-btn .btn-label').innerText();
  const allState = await page.locator('#select-all-box').getAttribute('aria-checked');

  await page.locator('#continue-btn').click();
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(outDir, '3-editor.png') });

  const rows = await page.locator('.frame-row').count();
  const stageItems = await page.locator('.stage-item').count();
  const editorVisible = await page.locator('#screen-editor').isVisible();

  const names = () => page.locator('.frame-row .lbl').allInnerTexts();
  const order0 = await names();

  // Right-click menu: first row cannot move up, "Move down" reorders.
  await page.locator('.frame-row').nth(0).click({ button: 'right' });
  await page.waitForTimeout(200);
  const menuOpen = await page.locator('#row-menu').isVisible();
  const upDisabled = await page.locator('#menu-up').isDisabled();
  await page.screenshot({ path: path.join(outDir, '5-context-menu.png') });
  await page.locator('#menu-down').click();
  await page.waitForTimeout(250);
  const orderAfterMenu = await names();
  const menuClosed = !(await page.locator('#row-menu').isVisible());

  // Remove via the menu.
  const beforeRemove = (await names()).length;
  await page.locator('.frame-row').nth(2).click({ button: 'right' });
  await page.waitForTimeout(150);
  await page.locator('#menu-remove').click();
  await page.waitForTimeout(250);
  const afterRemove = (await names()).length;

  // Pointer drag: grab row 0's grip and pull it down past two rows.
  const orderBeforeDrag = await names();
  const g = await page.locator('.frame-row').nth(0).locator('.grip').boundingBox();
  const rowA = await page.locator('.frame-row').nth(0).boundingBox();
  const rowB = await page.locator('.frame-row').nth(1).boundingBox();
  const step = rowB.y - rowA.y;
  await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
  await page.mouse.down();
  await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2 + step * 0.6, { steps: 6 });
  const liftedDuring = await page.locator('.frame-row.lifted').count();
  await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2 + step * 2.2, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  const orderAfterDrag = await names();
  const liftedAfter = await page.locator('.frame-row.lifted').count();

  // Busy button: spinner opens, layout does not shift. The count is derived —
  // the menu/drag steps above change how many slides remain.
  const slidesAtExport = (await names()).length;
  const wantBusyLabel = 'Exporting ' + Math.ceil(slidesAtExport / 2) + ' of ' + slidesAtExport;
  const beforeBox = await page.locator('#export-btn').boundingBox();
  await page.locator('#export-btn').click();
  await page.waitForTimeout(500);
  const busyLabel = await page.locator('#export-btn .btn-label').innerText();
  const busySpinnerW = await page.locator('#export-btn .btn-spinner').evaluate(n => n.getBoundingClientRect().width);
  const hasFill = await page.locator('#export-btn .btn-fill').count();
  const labelPx = await page.locator('#export-btn .btn-label').evaluate(n => getComputedStyle(n).fontSize);
  const busyDisabled = await page.locator('#export-btn').isDisabled();
  const afterBox = await page.locator('#export-btn').boundingBox();
  const shifted = Math.abs(beforeBox.y - afterBox.y) > 0.5 || Math.abs(beforeBox.height - afterBox.height) > 0.5;
  await page.screenshot({ path: path.join(outDir, '4-export-busy.png') });

  await browser.close();

  console.log('own header elements        : ' + hasOwnHeader + ' (want 0 — Figma draws one)');
  console.log('action bar pinned to bottom: ' + footerPinned);
  console.log('picker page scrolls        : ' + pageScrolls + ' (want false)');
  console.log('busy button disabled       : ' + busyDisabled + ' (want true)');
  console.log('CTA on load (3 preselected): ' + ctaOnLoad);
  console.log('idle spinner width         : ' + idleSpinnerW + 'px (want 0)');
  console.log('busy label                 : ' + busyLabel + ' (want ' + wantBusyLabel + ')');
  console.log('busy spinner width         : ' + busySpinnerW + 'px (want 14)');
  console.log('progress fill elements     : ' + hasFill + ' (want 0 — removed)');
  console.log('busy label font-size       : ' + labelPx + ' (want 15px, same as idle)');
  console.log('button shifted on busy     : ' + shifted + ' (want false)');
  console.log('');
  console.log('context menu opens         : ' + menuOpen);
  console.log('  first row Move up disabled: ' + upDisabled);
  console.log('  Move down reordered       : ' + (orderAfterMenu[0] === order0[1] && orderAfterMenu[1] === order0[0]));
  console.log('  menu closed after action  : ' + menuClosed);
  console.log('  Remove dropped a row      : ' + (afterRemove === beforeRemove - 1));
  console.log('drag lifted class during   : ' + liftedDuring + ' (want 1)');
  console.log('  drag reordered            : ' + (orderAfterDrag[0] !== orderBeforeDrag[0]));
  console.log('  lifted cleaned up after   : ' + (liftedAfter === 0));

  console.log('CTA after ticking 2 more: ' + cta);
  console.log('select-all aria-checked : ' + allState);
  console.log('editor visible          : ' + editorVisible);
  console.log('sidebar rows            : ' + rows);
  console.log('stage items             : ' + stageItems);
  console.log('console errors          : ' + (logs.filter(l => /error/i.test(l)).length || 'none'));
  logs.filter(l => /error/i.test(l)).forEach(l => console.log('   ' + l));
  console.log('\nshots → ' + outDir);

  const ok = hasOwnHeader === 0 && footerPinned && !pageScrolls && busyDisabled &&
             ctaOnLoad === 'Continue with Slides (3)' && idleSpinnerW === 0 &&
             cta === 'Continue with Slides (5)' && allState === 'mixed' &&
             editorVisible && rows === 5 && stageItems === 5 &&
             menuOpen && upDisabled && menuClosed &&
             orderAfterMenu[0] === order0[1] && orderAfterMenu[1] === order0[0] &&
             afterRemove === beforeRemove - 1 &&
             liftedDuring === 1 && liftedAfter === 0 &&
             orderAfterDrag[0] !== orderBeforeDrag[0] &&
             busyLabel === wantBusyLabel && Math.round(busySpinnerW) === 14 &&
             hasFill === 0 && labelPx === '15px' && shifted === false &&
             logs.filter(l => /error/i.test(l)).length === 0;
  console.log(ok ? '\nOK' : '\nMISMATCH');
  if (!ok) process.exitCode = 1;
}

main().catch(e => { console.error(e); process.exitCode = 1; });
