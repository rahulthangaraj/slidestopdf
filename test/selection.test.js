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

function run(label, selection) {
  const posted = [];
  let onmessage = null;
  const handlers = {};

  global.__html__ = '<html></html>';
  global.figma = {
    showUI() {},
    on(evt, cb) { handlers[evt] = cb; },
    closePlugin() {},
    currentPage: { selection },
    getNodeByIdAsync: async () => null,
    ui: {
      postMessage: (m) => posted.push(m),
      set onmessage(fn) { onmessage = fn; },
      get onmessage() { return onmessage; },
    },
  };

  // Load a fresh copy of the bundle against these globals.
  eval(fs.readFileSync(require('path').join(__dirname, '..', 'dist', 'code.js'), 'utf8'));

  onmessage({ type: 'GET_FRAMES' });

  const list = posted.filter(m => m.type === 'FRAMES_LIST').pop();
  console.log('\n' + label);
  console.log('  → ' + (list.frames.length === 0 ? '(empty)' : list.frames.map(f => f.name).join(', ')));
  return list.frames.map(f => f.name);
}

function expect(label, actual, want) {
  const ok = JSON.stringify(actual) === JSON.stringify(want);
  console.log('  ' + (ok ? 'PASS' : 'FAIL — expected: ' + want.join(', ')));
  if (!ok) process.exitCode = 1;
}

// 1. Bare section, 3x2 grid with a few px of vertical jitter (hand-placed slides).
// Layer order below is deliberately scrambled; positions are the truth.
// Top row  (y≈0):    S1(x0) S2(x2000) S3(x4000)
// Bottom row (y≈1200): S4(x0) S5(x2000) S6(x4000)
const grid = section('Deck', 0, 0, [
  frame('S4', 0,    1200), frame('S5', 2000, 1207),
  frame('S2', 2000, 3),    frame('S3', 4000, 0),
  frame('S1', 0,    0),    frame('S6', 4000, 1195),
]);
expect('grid', run('1. Section with a jittered 3x2 grid (layer order is scrambled)', [grid]),
  ['S1', 'S2', 'S3', 'S4', 'S5', 'S6']);

// 2. Nested sections recurse to any depth.
const nested = section('Outer', 0, 0, [
  frame('A', 0, 0),
  section('Inner', 0, 1200, [frame('B', 0, 1200), frame('C', 2000, 1200)]),
  frame('D', 0, 2400),
]);
expect('nested', run('2. Nested sections', [nested]), ['A', 'B', 'C', 'D']);

// 3. Section + a frame inside it both selected — must not duplicate.
const dupSection = section('Deck2', 0, 0, [frame('X', 0, 0), frame('Y', 2000, 0)]);
expect('dedupe', run('3. Section AND a frame inside it selected', [dupSection, dupSection.children[1]]),
  ['X', 'Y']);

// 4. Frames nested inside a frame are content, not slides — never descended into.
const parent = frame('Slide', 0, 0);
parent.children = [frame('Card', 100, 100, 400, 300)];
expect('no-descend', run('4. Frame containing child frames', [parent]), ['Slide']);

// 5. Components count as slides; non-slide nodes are dropped.
expect('mixed', run('5. Mixed selection: component, text, frame', [
  frame('Cmp', 2000, 0, 1920, 1080, 'COMPONENT'),
  { id: 'id:txt', name: 'Label', type: 'TEXT', width: 10, height: 10, x: 0, y: 0,
    absoluteBoundingBox: { x: 4000, y: 0, width: 10, height: 10 } },
  frame('Frm', 0, 0),
]), ['Frm', 'Cmp']);

// 6. Empty / non-slide-only selection.
expect('empty', run('6. Nothing selectable', [
  { id: 'id:e', name: 'Ellipse', type: 'ELLIPSE', width: 5, height: 5, x: 0, y: 0,
    absoluteBoundingBox: { x: 0, y: 0, width: 5, height: 5 } },
]), []);
