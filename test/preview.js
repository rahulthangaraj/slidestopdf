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

  // Busy button: spinner opens, fill tracks progress, layout does not shift.
  const beforeBox = await page.locator('#export-btn').boundingBox();
  await page.locator('#export-btn').click();
  await page.waitForTimeout(500);
  const busyLabel = await page.locator('#export-btn .btn-label').innerText();
  const busySpinnerW = await page.locator('#export-btn .btn-spinner').evaluate(n => n.getBoundingClientRect().width);
  const fillPct = await page.locator('#export-btn .btn-fill').evaluate(
    n => Math.round((n.getBoundingClientRect().width / n.parentElement.getBoundingClientRect().width) * 100));
  const afterBox = await page.locator('#export-btn').boundingBox();
  const shifted = Math.abs(beforeBox.y - afterBox.y) > 0.5 || Math.abs(beforeBox.height - afterBox.height) > 0.5;
  await page.screenshot({ path: path.join(outDir, '4-export-busy.png') });

  await browser.close();

  console.log('CTA on load (3 preselected): ' + ctaOnLoad);
  console.log('idle spinner width         : ' + idleSpinnerW + 'px (want 0)');
  console.log('busy label                 : ' + busyLabel);
  console.log('busy spinner width         : ' + busySpinnerW + 'px (want 14)');
  console.log('progress fill              : ' + fillPct + '% (want ~60, 1px border skews it)');
  console.log('button shifted on busy     : ' + shifted + ' (want false)');

  console.log('CTA after ticking 2 more: ' + cta);
  console.log('select-all aria-checked : ' + allState);
  console.log('editor visible          : ' + editorVisible);
  console.log('sidebar rows            : ' + rows);
  console.log('stage items             : ' + stageItems);
  console.log('console errors          : ' + (logs.filter(l => /error/i.test(l)).length || 'none'));
  logs.filter(l => /error/i.test(l)).forEach(l => console.log('   ' + l));
  console.log('\nshots → ' + outDir);

  const ok = ctaOnLoad === 'Continue with Slides (3)' && idleSpinnerW === 0 &&
             cta === 'Continue with Slides (5)' && allState === 'mixed' &&
             editorVisible && rows === 5 && stageItems === 5 &&
             busyLabel === 'Exporting 3 of 5' && Math.round(busySpinnerW) === 14 &&
             Math.abs(fillPct - 60) <= 2 && shifted === false &&
             logs.filter(l => /error/i.test(l)).length === 0;
  console.log(ok ? '\nOK' : '\nMISMATCH');
  if (!ok) process.exitCode = 1;
}

main().catch(e => { console.error(e); process.exitCode = 1; });
