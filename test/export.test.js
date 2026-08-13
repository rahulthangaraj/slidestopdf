// drives the real built dist/code.js export loop with a
// stub UI, checking the streaming handshake.
const fs = require('fs');

function setup(frames, opts = {}) {
  const posted = [];
  const events = [];
  let onmessage = null;

  global.__html__ = '';
  global.figma = {
    showUI() {}, on() {}, closePlugin() {},
    currentPage: { selection: [] },
    getNodeByIdAsync: async (id) => {
      const f = frames.find(f => f.id === id);
      if (!f) return null;
      return {
        ...f,
        exportAsync: async () => {
          events.push('export:' + f.name);
          if (opts.failOn === f.name) throw new Error('boom');
          await new Promise(r => setTimeout(r, 1));
          return new Uint8Array(f.size || 8);
        },
      };
    },
    ui: {
      reposition() {},
      postMessage: (m) => {
        posted.push(m);
        if (m.type === 'FRAME_DATA') {
          events.push('sent:' + m.name);
          // Stub UI: consume asynchronously, then acknowledge.
          setTimeout(() => {
            events.push('consumed:' + m.name);
            if (opts.abortOn === m.name) onmessage({ type: 'EXPORT_ABORT' });
            else onmessage({ type: 'FRAME_ACK' });
          }, 5);
        }
      },
      set onmessage(fn) { onmessage = fn; },
      get onmessage() { return onmessage; },
    },
  };

  eval(fs.readFileSync(require('path').join(__dirname, '..', 'dist', 'code.js'), 'utf8'));
  return { posted, events, send: (m) => onmessage(m) };
}

function check(label, cond, detail) {
  console.log('  ' + (cond ? 'PASS' : 'FAIL') + ' — ' + label + (detail ? '  [' + detail + ']' : ''));
  if (!cond) process.exitCode = 1;
}

(async () => {
  const frames = [
    { id: 'a', name: 'A', type: 'FRAME', size: 16 },
    { id: 'b', name: 'B', type: 'FRAME', size: 32 },
    { id: 'c', name: 'C', type: 'FRAME', size: 64 },
  ];

  console.log('\n1. Streaming + backpressure');
  {
    const h = setup(frames);
    await h.send({ type: 'EXPORT_FRAMES', frameIds: ['a', 'b', 'c'] });

    const seq = h.events.join(' → ');
    check('strictly serialized (never exports ahead of an ack)',
      seq === 'export:A → sent:A → consumed:A → export:B → sent:B → consumed:B → export:C → sent:C → consumed:C',
      seq);

    const data = h.posted.filter(m => m.type === 'FRAME_DATA');
    check('one FRAME_DATA per frame', data.length === 3, data.length + ' messages');
    check('bytes stay a Uint8Array (no number[] expansion)',
      data.every(m => m.bytes instanceof Uint8Array),
      data.map(m => m.bytes.constructor.name).join(','));
    check('no legacy batch EXPORT_COMPLETE message',
      !h.posted.some(m => m.type === 'EXPORT_COMPLETE'));

    const done = h.posted.find(m => m.type === 'EXPORT_DONE');
    check('EXPORT_DONE reports 3 exported, 0 errors',
      done && done.exported === 3 && done.errors.length === 0);
  }

  console.log('\n2. A frame that fails mid-stream does not stall the rest');
  {
    const h = setup(frames, { failOn: 'B' });
    await h.send({ type: 'EXPORT_FRAMES', frameIds: ['a', 'b', 'c'] });
    const done = h.posted.find(m => m.type === 'EXPORT_DONE');
    check('A and C still exported', done && done.exported === 2, done && done.exported);
    check('B reported as an error', done && done.errors.length === 1, done && done.errors[0]);
  }

  console.log('\n3. Missing / non-frame nodes are skipped, not fatal');
  {
    const h = setup(frames);
    await h.send({ type: 'EXPORT_FRAMES', frameIds: ['a', 'ghost', 'c'] });
    const done = h.posted.find(m => m.type === 'EXPORT_DONE');
    check('2 exported, 1 error', done && done.exported === 2 && done.errors.length === 1,
      done && done.errors[0]);
  }

  console.log('\n4. All frames failing surfaces EXPORT_ERROR');
  {
    const h = setup([frames[0]]);
    await h.send({ type: 'EXPORT_FRAMES', frameIds: ['ghost'] });
    check('EXPORT_ERROR posted', h.posted.some(m => m.type === 'EXPORT_ERROR'));
    check('no EXPORT_DONE', !h.posted.some(m => m.type === 'EXPORT_DONE'));
  }

  console.log('\n5. UI abort unwinds the loop instead of deadlocking');
  {
    const h = setup(frames, { abortOn: 'B' });
    const finished = await Promise.race([
      h.send({ type: 'EXPORT_FRAMES', frameIds: ['a', 'b', 'c'] }).then(() => true),
      new Promise(r => setTimeout(() => r(false), 2000)),
    ]);
    check('export loop terminated (no hang)', finished === true);
    check('stopped early — C never exported', !h.events.includes('export:C'), h.events.join(' → '));
  }

  console.log('\n6. Empty selection is rejected up front');
  {
    const h = setup(frames);
    await h.send({ type: 'EXPORT_FRAMES', frameIds: [] });
    check('EXPORT_ERROR posted', h.posted.some(m => m.type === 'EXPORT_ERROR'));
  }

  console.log(process.exitCode ? '\nFAILURES' : '\nALL PASS');
})();
