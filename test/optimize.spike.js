// Spike: can we shrink a Figma-style PDF by removing image oversampling only,
// leaving text and vectors completely untouched?
//
// The rule: an image carrying more pixels than can be rendered at the target DPI
// for the area it occupies is carrying waste. Dropping that waste is invisible.
// Anything at or below the ceiling is left exactly as-is.
const { chromium } = require('playwright');
const {
  PDFDocument, PDFRawStream, PDFName, PDFNumber, PDFDict, decodePDFRawStream,
  rgb, StandardFonts,
} = require('pdf-lib');

const PAGE_W = 960, PAGE_H = 540;
const TARGET_DPI = 300;              // print-grade
const mb = n => (n / 1048576).toFixed(2) + ' MB';


// Track the CTM properly instead of pattern-matching. A regex pairs the wrong
// transform with the wrong image across q/Q boundaries, and an over-estimated
// scale is harmless while an under-estimated one destroys quality.
function mul(m, n) {
  return [
    m[0]*n[0] + m[1]*n[2],           m[0]*n[1] + m[1]*n[3],
    m[2]*n[0] + m[3]*n[2],           m[2]*n[1] + m[3]*n[3],
    m[4]*n[0] + m[5]*n[2] + n[4],    m[4]*n[1] + m[5]*n[3] + n[5],
  ];
}

function scanContent(content, nameToRef, out) {
  const tokens = content.match(/\/[^\s\/\[\]<>(){}]+|[-+]?[0-9.]+(?:[eE][-+]?[0-9]+)?|[A-Za-z*'"]+/g) || [];
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  let ops = [];

  for (const t of tokens) {
    if (t[0] === '/') { ops.push(t); continue; }
    if (/^[-+.0-9]/.test(t)) { ops.push(parseFloat(t)); continue; }

    if (t === 'q') { stack.push(ctm.slice()); }
    else if (t === 'Q') { ctm = stack.pop() || [1, 0, 0, 1, 0, 0]; }
    else if (t === 'cm' && ops.length >= 6) {
      const n = ops.slice(-6);
      if (n.every(v => typeof v === 'number' && isFinite(v))) ctm = mul(n, ctm);
    }
    else if (t === 'Do') {
      const name = ops[ops.length - 1];
      if (typeof name === 'string' && name[0] === '/') {
        const ref = nameToRef[name];
        // An image XObject is painted into the unit square, so the CTM's
        // column magnitudes are its on-page width and height in points.
        if (ref) out[ref] = Math.max(out[ref] || 0, Math.hypot(ctm[0], ctm[1]));
      }
    }
    ops = [];
  }
}

async function main() {
  const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  await page.goto('about:blank');

  // ── A slide like Figma makes: real text, real vectors, oversized photo ──
  const bigJpeg = await page.evaluate(async ([w, h]) => {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    const grad = g.createLinearGradient(0, 0, w, h);
    grad.addColorStop(0, '#3a6ea5'); grad.addColorStop(.5, '#c96f4a'); grad.addColorStop(1, '#22333b');
    g.fillStyle = grad; g.fillRect(0, 0, w, h);
    let x = 1;
    const rnd = () => (x = (x * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let i = 0; i < 800; i++) {
      g.beginPath(); g.arc(rnd() * w, rnd() * h, rnd() * 140, 0, 6.3);
      g.fillStyle = 'rgba(' + (rnd()*255|0) + ',' + (rnd()*255|0) + ',' + (rnd()*255|0) + ',0.12)';
      g.fill();
    }
    const d = g.getImageData(0, 0, w, h);
    for (let i = 0; i < d.data.length; i += 4) {
      const n = (rnd() - .5) * 24;
      d.data[i] += n; d.data[i+1] += n; d.data[i+2] += n;
    }
    g.putImageData(d, 0, 0);
    return c.toDataURL('image/jpeg', 0.95).split(',')[1];
  }, [4000, 2250]); // 4000px wide — wild oversampling for a 960pt page

  // A second, distinct photo that is only ever placed in a small card — the
  // case where the file carries pixels that can never be seen.
  const cardJpeg = await page.evaluate(async ([w, h]) => {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    const grad = g.createLinearGradient(0, 0, w, h);
    grad.addColorStop(0, '#1b998b'); grad.addColorStop(1, '#2d3047');
    g.fillStyle = grad; g.fillRect(0, 0, w, h);
    let x = 99;
    const rnd = () => (x = (x * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let i = 0; i < 800; i++) {
      g.beginPath(); g.arc(rnd() * w, rnd() * h, rnd() * 140, 0, 6.3);
      g.fillStyle = 'rgba(' + (rnd()*255|0) + ',' + (rnd()*255|0) + ',' + (rnd()*255|0) + ',0.12)';
      g.fill();
    }
    const d = g.getImageData(0, 0, w, h);
    for (let i = 0; i < d.data.length; i += 4) {
      const n = (rnd() - .5) * 24;
      d.data[i] += n; d.data[i+1] += n; d.data[i+2] += n;
    }
    g.putImageData(d, 0, 0);
    return c.toDataURL('image/jpeg', 0.95).split(',')[1];
  }, [4000, 2250]);

  const src = await PDFDocument.create();
  const font = await src.embedFont(StandardFonts.Helvetica);
  const img = await src.embedJpg(Buffer.from(bigJpeg, 'base64'));
  const cardImg = await src.embedJpg(Buffer.from(cardJpeg, 'base64'));

  for (let i = 0; i < 4; i++) {
    const p = src.addPage([PAGE_W, PAGE_H]);
    if (i < 2) {
      // Hero image filling the slide — legitimately needs its pixels.
      p.drawImage(img, { x: 0, y: 0, width: PAGE_W, height: PAGE_H });
    }
    // The real-world waste case: a 4000px photo dropped into a small card.
    p.drawImage(cardImg, { x: 640, y: 330, width: 240, height: 135 });
    p.drawRectangle({ x: 40, y: 40, width: 300, height: 90, color: rgb(1, 1, 1), opacity: .9 });
    p.drawText('Quarterly Review ' + (i + 1), { x: 60, y: 95, size: 28, font, color: rgb(.05, .05, .05) });
    p.drawText('Vector text must survive verbatim', { x: 60, y: 62, size: 13, font, color: rgb(.2, .2, .2) });
  }
  const before = await src.save({ useObjectStreams: false });

  // ── Optimize: touch image XObjects only ──
  const doc = await PDFDocument.load(before);
  const ctx = doc.context;
  const report = [];

  // How big is each image actually drawn? Images are painted as
  //   q  <w> 0 0 <h> <x> <y> cm  /Name Do  Q
  // so the CTM scale immediately before `Do` is the displayed size in points.
  // Take the largest placement of each image — downsampling below the biggest
  // use would degrade that one.
  const displayedPt = {};
  for (const pg of doc.getPages()) {
    const res = pg.node.Resources();
    const xobjs = res && res.lookupMaybe(PDFName.of('XObject'), PDFDict);
    if (!xobjs) continue;

    const nameToRef = {};
    xobjs.keys().forEach(k => { nameToRef[k.toString()] = xobjs.get(k).toString(); });

    let content = '';
    const contents = pg.node.Contents();
    const streams = contents && contents.asArray ? contents.asArray() : [contents];
    for (const sref of streams) {
      const st = sref && sref.toString ? ctx.lookup(sref) : sref;
      if (st instanceof PDFRawStream) content += Buffer.from(decodePDFRawStream(st).decode()).toString('latin1');
      else if (st && st.getContents) content += Buffer.from(st.getContents()).toString('latin1');
    }

    scanContent(content, nameToRef, displayedPt);
  }

  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    const d = obj.dict;
    const subtype = d.get(PDFName.of('Subtype'));
    if (!subtype || subtype.toString() !== '/Image') continue;

    const w = d.get(PDFName.of('Width')).asNumber();
    const h = d.get(PDFName.of('Height')).asNumber();
    const filter = String(d.get(PDFName.of('Filter')) || '');

    // Ceiling from the size the image is actually drawn at. Falls back to the
    // full page if we could not determine it, which can only under-optimise.
    const shownPt = displayedPt[ref.toString()] || PAGE_W;
    const maxW = Math.ceil((shownPt / 72) * TARGET_DPI);
    if (w <= maxW) {
      report.push([w, h, 'kept — drawn at ' + Math.round(shownPt) + 'pt, needs ' + maxW + 'px at ' + TARGET_DPI + ' DPI']);
      continue;
    }

    if (!filter.includes('DCTDecode')) { report.push([w, h, 'skipped (' + filter + ')']); continue; }

    const jpegB64 = Buffer.from(obj.getContents()).toString('base64');
    const scaled = await page.evaluate(async ([b64, targetW, q]) => {
      const im = new Image();
      im.src = 'data:image/jpeg;base64,' + b64;
      await im.decode();
      const c = document.createElement('canvas');
      c.width = targetW;
      c.height = Math.round(im.height * (targetW / im.width));
      const g = c.getContext('2d');
      g.imageSmoothingEnabled = true;
      g.imageSmoothingQuality = 'high';
      g.drawImage(im, 0, 0, c.width, c.height);
      return c.toDataURL('image/jpeg', q).split(',')[1];
    }, [jpegB64, maxW, 0.94]);

    const bytes = Buffer.from(scaled, 'base64');
    const newDict = ctx.obj({});
    d.keys().forEach(k => newDict.set(k, d.get(k)));
    newDict.set(PDFName.of('Width'), PDFNumber.of(maxW));
    newDict.set(PDFName.of('Height'), PDFNumber.of(Math.round(h * (maxW / w))));
    newDict.set(PDFName.of('Length'), PDFNumber.of(bytes.length));
    newDict.set(PDFName.of('Filter'), PDFName.of('DCTDecode'));
    newDict.set(PDFName.of('ColorSpace'), PDFName.of('DeviceRGB'));
    newDict.set(PDFName.of('BitsPerComponent'), PDFNumber.of(8));

    ctx.assign(ref, PDFRawStream.of(newDict, new Uint8Array(bytes)));
    report.push([w, h, 'drawn at ' + Math.round(shownPt) + 'pt → ' + maxW + 'px (' + TARGET_DPI + ' DPI), was ' +
                 (w / maxW).toFixed(1) + 'x oversampled']);
  }

  const after = await doc.save({ useObjectStreams: true });

  // ── Did text and vectors survive? ──
  const txt = (buf) => Buffer.from(buf).toString('latin1');
  const countOps = (buf, re) => (txt(buf).match(re) || []).length;

  const reload = await PDFDocument.load(after);
  const beforeDoc = await PDFDocument.load(before);

  console.log('\nimage objects:');
  report.forEach(([w, h, what]) => console.log('  ' + w + 'x' + h + '  ' + what));

  console.log('\nsize');
  console.log('  before ' + mb(before.length));
  console.log('  after  ' + mb(after.length) +
              '   -' + Math.round((1 - after.length / before.length) * 100) + '%');

  const ceiling = Math.ceil((PAGE_W / 72) * TARGET_DPI);
  console.log('\nquality');
  console.log('  page width           ' + PAGE_W + 'pt (' + (PAGE_W / 72).toFixed(1) + ' in)');
  console.log('  pixels kept          ' + ceiling + 'px  → ' +
              Math.round(ceiling / (PAGE_W / 72)) + ' DPI at full-page size');
  console.log('  pages   ' + beforeDoc.getPageCount() + ' → ' + reload.getPageCount());

  const pageSizeSame = JSON.stringify(beforeDoc.getPages().map(p => [Math.round(p.getWidth()), Math.round(p.getHeight())]))
                    === JSON.stringify(reload.getPages().map(p => [Math.round(p.getWidth()), Math.round(p.getHeight())]));

  // Text lives in content streams as Tj/TJ show operators; fonts as /Type /Font.
  const fontsBefore = countOps(before, /\/Type\s*\/Font/g);
  const fontsAfter = countOps(await doc.save({ useObjectStreams: false }), /\/Type\s*\/Font/g);

  console.log('  page sizes unchanged ' + pageSizeSame);
  console.log('  font objects         ' + fontsBefore + ' → ' + fontsAfter);

  await browser.close();

  const ok = pageSizeSame && beforeDoc.getPageCount() === reload.getPageCount() &&
             fontsAfter === fontsBefore && after.length < before.length;
  console.log(ok ? '\nSPIKE OK' : '\nSPIKE FAILED');
  if (!ok) process.exitCode = 1;
}

main().catch(e => { console.error(e); process.exitCode = 1; });
