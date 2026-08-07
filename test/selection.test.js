// loads the real built dist/code.js against a stubbed Figma
// API and checks selection expansion + ordering.
const fs = require('fs');

function frame(name, x, y, w = 1920, h = 1080, type = 'FRAME') {
  return {
    id: 'id:' + name, name, type, width: w, height: h, x, y,
    absoluteBoundingBox: { x, y, width: w, height: h },
  };
}
function section(name, x, y, children) {
  return {
    id: 'id:' + name, name, type: 'SECTION', width: 6000, height: 3000, x, y,
    absoluteBoundingBox: { x, y, width: 6000, height: 3000 },
    children,
  };
}

function run(label, pageChildren, selection) {
  const posted = [];
  let onmessage = null;
  const handlers = {};

  global.__html__ = '<html></html>';
  global.figma = {
    showUI() {},
    on(evt, cb) { handlers[evt] = cb; },
    closePlugin() {},
    currentPage: {
      selection,
      children: pageChildren,
      // dynamic-page requires this before children are readable.
      loadAsync: async () => {},
    },
    getNodeByIdAsync: async () => null,
    ui: {
      postMessage: (m) => posted.push(m),
      set onmessage(fn) { onmessage = fn; },
      get onmessage() { return onmessage; },
    },
  };

  // Load a fresh copy of the bundle against these globals.
  eval(fs.readFileSync(require('path').join(__dirname, '..', 'dist', 'code.js'), 'utf8'));

  return onmessage({ type: 'GET_FRAMES' }).then(() => {
    const list = posted.filter(m => m.type === 'FRAMES_LIST').pop();
    console.log('\n' + label);
    console.log('  → listed:   ' + (list.frames.length === 0 ? '(empty)' : list.frames.map(f => f.name).join(', ')));
    console.log('  → ticked:   ' + (list.selected.length === 0 ? '(none)' : list.selected.join(', ')));
    return { listed: list.frames.map(f => f.name), ticked: list.selected };
  });
}

function expect(actual, want) {
  const ok = JSON.stringify(actual) === JSON.stringify(want);
  console.log('  ' + (ok ? 'PASS' : 'FAIL — expected: ' + want.join(', ')));
  if (!ok) process.exitCode = 1;
}

async function check(label, pageChildren, selection, wantListed, wantTicked) {
  const res = await run(label, pageChildren, selection);
  expect(res.listed, wantListed);
  if (wantTicked !== undefined) expect(res.ticked, wantTicked);
}

// Each case passes the same nodes as both page children and selection, so the
// ordering/dedupe rules are exercised through the real GET_FRAMES path.
async function main() {

  // 1. Bare section, 3x2 grid with a few px of vertical jitter (hand-placed slides).
  // Layer order below is deliberately scrambled; positions are the truth.
  // Top row  (y≈0):    S1(x0) S2(x2000) S3(x4000)
  // Bottom row (y≈1200): S4(x0) S5(x2000) S6(x4000)
  const grid = section('Deck', 0, 0, [
    frame('S4', 0,    1200), frame('S5', 2000, 1207),
    frame('S2', 2000, 3),    frame('S3', 4000, 0),
    frame('S1', 0,    0),    frame('S6', 4000, 1195),
  ]);
  await check('1. Section with a jittered 3x2 grid (layer order is scrambled)',
    [grid], [grid], ['S1','S2','S3','S4','S5','S6'], ['id:S1','id:S2','id:S3','id:S4','id:S5','id:S6']);

  // 2. Nested sections recurse to any depth.
  const nested = section('Outer', 0, 0, [
    frame('A', 0, 0),
    section('Inner', 0, 1200, [frame('B', 0, 1200), frame('C', 2000, 1200)]),
    frame('D', 0, 2400),
  ]);
  await check('2. Nested sections', [nested], [nested], ['A','B','C','D']);

  // 3. Section + a frame inside it both selected — must not duplicate.
  const dup = section('Deck2', 0, 0, [frame('X', 0, 0), frame('Y', 2000, 0)]);
  await check('3. Section AND a frame inside it selected',
    [dup], [dup, dup.children[1]], ['X','Y'], ['id:X','id:Y']);

  // 4. Frames nested inside a frame are content, not slides.
  const parent = frame('Slide', 0, 0);
  parent.children = [frame('Card', 100, 100, 400, 300)];
  await check('4. Frame containing child frames', [parent], [parent], ['Slide']);

  // 5. Components count as slides; non-slide nodes are dropped.
  const mixed = [
    frame('Cmp', 2000, 0, 1920, 1080, 'COMPONENT'),
    { id: 'id:txt', name: 'Label', type: 'TEXT', width: 10, height: 10, x: 0, y: 0,
      absoluteBoundingBox: { x: 4000, y: 0, width: 10, height: 10 } },
    frame('Frm', 0, 0),
  ];
  await check('5. Mixed selection: component, text, frame', mixed, mixed, ['Frm','Cmp']);

  // 6. Page with nothing selectable on it.
  const junk = [{ id: 'id:e', name: 'Ellipse', type: 'ELLIPSE', width: 5, height: 5, x: 0, y: 0,
                  absoluteBoundingBox: { x: 0, y: 0, width: 5, height: 5 } }];
  await check('6. Nothing selectable', junk, junk, []);

  // 7. Nothing selected — the whole page is still listed, nothing ticked.
  const page = [frame('P1', 0, 0), frame('P2', 2000, 0), frame('P3', 4000, 0)];
  await check('7. Page frames with an empty selection', page, [], ['P1','P2','P3'], []);

  // 8. A partial selection lists everything but ticks only what was selected.
  await check('8. Page frames with a partial selection',
    page, [page[2], page[0]], ['P1','P2','P3'], ['id:P1','id:P3']);

  // 9. Selecting a section ticks the frames inside it, page still fully listed.
  const sec = section('Group', 0, 2400, [frame('G1', 0, 2400), frame('G2', 2000, 2400)]);
  await check('9. Section selected on a page with loose frames',
    page.concat([sec]), [sec], ['P1','P2','P3','G1','G2'], ['id:G1','id:G2']);

  console.log(process.exitCode ? '\nFAILURES' : '\nALL PASS');
}

main().catch(e => { console.error(e); process.exitCode = 1; });
