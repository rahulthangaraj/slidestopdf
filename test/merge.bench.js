// real pdf-lib, comparing the old batch pipeline against the
// new streaming one for correctness and peak memory.
const { PDFDocument } = require('pdf-lib');

const MB = 1048576;
function heapMB() { return process.memoryUsage().heapUsed / MB; }

// One "exported frame": a single-page PDF with a distinctive page size, padded
// with an embedded blob so it is realistically image-heavy.
// Payload goes into the page's own content stream (thousands of randomly placed
// vector ops), not a document attachment — copyPages carries page content, so
// this is what a real image/vector-heavy slide costs the merged document.
async function makeFrame(i, ops) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([400 + i, 300 + i]);
  for (let n = 0; n < ops; n++) {
    page.drawRectangle({
      x: Math.random() * 400, y: Math.random() * 300,
      width: Math.random() * 20, height: Math.random() * 20,
      opacity: Math.random(),
    });
  }
  return doc.save({ useObjectStreams: false });
}

async function main() {
  const COUNT = 40;
  const OPS = 12000; // dense vector content per slide

  process.stdout.write('Generating ' + COUNT + ' source PDFs... ');
  const source = [];
  for (let i = 0; i < COUNT; i++) source.push(await makeFrame(i, OPS));
  const rawMB = source.reduce((n, b) => n + b.length, 0) / MB;
  console.log(rawMB.toFixed(1) + 'MB total\n');

  // ── OLD: every frame expanded to number[], all held, then merged ──
  {
    if (global.gc) global.gc();
    const base = heapMB();
    let peak = 0;
    const track = () => { peak = Math.max(peak, heapMB() - base); };

    const wire = source.map(b => Array.from(b)); // code.ts:105 (old)
    track();
    const results = wire.map(d => new Uint8Array(d)); // ui.ts:237 (old)
    track();

    const merged = await PDFDocument.create();
    for (const bytes of results) {
      const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
      const pages = await merged.copyPages(doc, doc.getPageIndices());
      pages.forEach(p => merged.addPage(p));
      track();
    }
    const out = await merged.save({ useObjectStreams: false });
    track();

    console.log('OLD (batch + Array.from)');
    console.log('  peak heap above baseline: ' + peak.toFixed(0) + 'MB');
    console.log('  ratio to raw deck:        ' + (peak / rawMB).toFixed(1) + 'x');
    console.log('  merged pages:             ' + (await PDFDocument.load(out)).getPageCount());
  }

  if (global.gc) global.gc();
  await new Promise(r => setTimeout(r, 50));

  // ── NEW: Uint8Array over the wire, folded in one at a time ──
  let outBytes;
  {
    if (global.gc) global.gc();
    const base = heapMB();
    let peak = 0;
    const track = () => { peak = Math.max(peak, heapMB() - base); };

    const merged = await PDFDocument.create();
    for (let i = 0; i < COUNT; i++) {
      // Structured clone of a Uint8Array == a plain copy of the bytes.
      let bytes = source[i].slice();
      const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
      const pages = await merged.copyPages(doc, doc.getPageIndices());
      pages.forEach(p => merged.addPage(p));
      bytes = null; // consumed and released before the next frame is requested
      track();
    }
    outBytes = await merged.save({ useObjectStreams: false });
    track();

    console.log('\nNEW (streaming + Uint8Array)');
    console.log('  peak heap above baseline: ' + peak.toFixed(0) + 'MB');
    console.log('  ratio to raw deck:        ' + (peak / rawMB).toFixed(1) + 'x');
  }

  // ── Correctness: page count and page order preserved ──
  const check = await PDFDocument.load(outBytes);
  const sizes = check.getPages().map(p => Math.round(p.getWidth()));
  const want = Array.from({ length: COUNT }, (_, i) => 400 + i);
  const ordered = JSON.stringify(sizes) === JSON.stringify(want);

  console.log('\nCorrectness');
  console.log('  pages: ' + check.getPageCount() + ' (expected ' + COUNT + ') — ' +
    (check.getPageCount() === COUNT ? 'PASS' : 'FAIL'));
  console.log('  page order preserved: ' + (ordered ? 'PASS' : 'FAIL — ' + sizes.join(',')));
  if (check.getPageCount() !== COUNT || !ordered) process.exitCode = 1;
}

main().catch(e => { console.error(e); process.exitCode = 1; });
