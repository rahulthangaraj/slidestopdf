// Does compression actually help? Measures three strategies against a deck built
// the way Figma builds one — full-resolution images embedded regardless of the
// size they are displayed at.
//
//   npm install --no-save playwright && node test/size.bench.js
//
// The downsampling runs in headless Chromium via canvas, which is the same
// mechanism available to the plugin's iframe. Nothing here needs network.
const { chromium } = require('playwright');
const { PDFDocument } = require('pdf-lib');
const path = require('path');

const PAGES = 6;
const SLIDE_W = 960;   // pt, i.e. the size the image is actually shown at
const SLIDE_H = 540;
const SOURCE_W = 2400; // px, what Figma keeps in the file
const SOURCE_H = 1350;

const MB = 1048576;
const mb = (n) => (n / MB).toFixed(1) + ' MB';

async function main() {
  const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  await page.goto('about:blank');

  // Two content types, because they behave very differently under JPEG.
  const kinds = ['photo', 'screenshot'];
  const sources = {};

  for (const kind of kinds) {
    sources[kind] = [];
    for (let variant = 0; variant < PAGES; variant++) {
    sources[kind].push(await page.evaluate(async ([w, h, kind, variant]) => {
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const g = c.getContext('2d');

      const seed = variant * 7919;
      const rnd = (() => { let x = seed + 1; return () => (x = (x * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff; })();
      if (kind === 'photo') {
        // Smooth gradients plus grain — how a photograph behaves.
        const grad = g.createLinearGradient(0, 0, w, h);
        grad.addColorStop(0, 'hsl(' + (variant * 47 % 360) + ',45%,42%)');
        grad.addColorStop(.5, 'hsl(' + ((variant * 47 + 120) % 360) + ',50%,55%)');
        grad.addColorStop(1, 'hsl(' + ((variant * 47 + 240) % 360) + ',40%,25%)');
        g.fillStyle = grad; g.fillRect(0, 0, w, h);
        for (let i = 0; i < 900; i++) {
          g.beginPath();
          g.arc(rnd() * w, rnd() * h, rnd() * 120, 0, 6.3);
          g.fillStyle = 'rgba(' + (rnd() * 255 | 0) + ',' + (rnd() * 255 | 0) + ',' + (rnd() * 255 | 0) + ',0.10)';
          g.fill();
        }
        const img = g.getImageData(0, 0, w, h);
        for (let i = 0; i < img.data.length; i += 4) {
          const n = (rnd() - .5) * 26;
          img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n;
        }
        g.putImageData(img, 0, 0);
      } else {
        // Flat fills, sharp edges, dense small text — a UI screenshot.
        g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, h);
        g.fillStyle = '#f4f6f8'; g.fillRect(0, 0, w * .22, h);
        for (let i = 0; i < 26; i++) {
          g.fillStyle = ['#0a78ff', '#e5484d', '#1a9e5f', '#212121'][i % 4];
          g.fillRect(w * .26, 40 + i * 48, rnd() * w * .6 + 60, 16);
          g.fillStyle = '#dfe3e8';
          g.fillRect(w * .26, 62 + i * 48, rnd() * w * .5 + 40, 8);
        }
        g.fillStyle = '#212121';
        g.font = '18px sans-serif';
        for (let i = 0; i < 40; i++) g.fillText('Resource integration row ' + i + ' — 147 resources', 40, 30 + i * 32);
      }
      return c.toDataURL('image/png').split(',')[1];
    }, [SOURCE_W, SOURCE_H, kind, variant]));
    }
  }

  // Downsample + re-encode inside the browser, exactly as the plugin would.
  async function reencode(b64, targetW, quality) {
    return page.evaluate(async ([b64, targetW, quality]) => {
      const img = new Image();
      img.src = 'data:image/png;base64,' + b64;
      await img.decode();
      const scale = targetW / img.width;
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      const g = c.getContext('2d');
      g.imageSmoothingQuality = 'high';
      g.drawImage(img, 0, 0, c.width, c.height);
      return c.toDataURL('image/jpeg', quality).split(',')[1];
    }, [b64, targetW, quality]);
  }

  // One distinct image per page — pdf-lib dedupes a shared embed, which would
  // make a deck look far smaller than a real one.
  async function buildPdf(list, kind, useObjectStreams) {
    const doc = await PDFDocument.create();
    for (const b64 of list) {
      const bytes = Buffer.from(b64, 'base64');
      const img = kind === 'png' ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
      const p = doc.addPage([SLIDE_W, SLIDE_H]);
      p.drawImage(img, { x: 0, y: 0, width: SLIDE_W, height: SLIDE_H });
    }
    return doc.save({ useObjectStreams: !!useObjectStreams });
  }

  console.log('\n' + PAGES + ' slides, ' + SOURCE_W + 'x' + SOURCE_H + ' image shown at ' +
              SLIDE_W + 'x' + SLIDE_H + 'pt (what Figma embeds)\n');

  for (const kind of kinds) {
    const src = sources[kind];
    const base = await buildPdf(src, 'png', false);
    const objs = await buildPdf(src, 'png', true);

    console.log('── ' + kind.toUpperCase() + ' ──');
    console.log('  baseline (no compression)      ' + mb(base.length).padStart(9));
    console.log('  Compress toggle (obj streams)  ' + mb(objs.length).padStart(9) +
                '   ' + pct(base.length, objs.length));

    for (const [label, w, q] of [['1600px q0.85', 1600, .85], ['1200px q0.82', 1200, .82], ['960px q0.80', 960, .80]]) {
      const re = [];
      for (const one of src) re.push(await reencode(one, w, q));
      const out = await buildPdf(re, 'jpg', true);
      console.log('  downsample ' + label.padEnd(14) + ' ' + mb(out.length).padStart(9) +
                  '   ' + pct(base.length, out.length));
    }
    console.log('');
  }

  await browser.close();
}

function pct(from, to) {
  const saved = (1 - to / from) * 100;
  return (saved >= 0 ? '-' : '+') + Math.abs(saved).toFixed(0) + '%';
}

main().catch(e => { console.error(e); process.exitCode = 1; });
