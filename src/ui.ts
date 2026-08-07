import { PDFDocument } from 'pdf-lib';

interface Frame {
  id: string;
  name: string;
  width: number;
  height: number;
}

// State — user can reorder/remove within the plugin independently of Figma selection
let frames: Frame[] = [];
let dragSrcIndex: number | null = null;

// DOM refs
const frameListEl = document.getElementById('frame-list') as HTMLElement;
const refreshBtn = document.getElementById('refresh') as HTMLButtonElement;
const exportBtn = document.getElementById('export-btn') as HTMLButtonElement;
const mergeToggle = document.getElementById('merge') as HTMLInputElement;
const compressToggle = document.getElementById('compress') as HTMLInputElement;
const statusEl = document.getElementById('status') as HTMLElement;
const progressEl = document.getElementById('progress') as HTMLElement;
const progressBarEl = document.getElementById('progress-bar') as HTMLElement;
const progressTextEl = document.getElementById('progress-text') as HTMLElement;
const frameCountEl = document.getElementById('frame-count') as HTMLElement;
const emptyStateEl = document.getElementById('empty-state') as HTMLElement;

function postMessage(msg: Record<string, unknown>) {
  parent.postMessage({ pluginMessage: msg }, '*');
}

/* ────────────────────────────────────────────────────────────
   Slide list
   ──────────────────────────────────────────────────────────── */

function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  // textContent, never innerHTML — frame names are user-controlled document
  // data and would otherwise be parsed as markup.
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderFrameList() {
  frameListEl.textContent = '';

  if (frames.length === 0) {
    emptyStateEl.style.display = 'flex';
    frameListEl.style.display = 'none';
    frameCountEl.textContent = 'No frames selected';
    exportBtn.disabled = true;
    exportBtn.textContent = 'Select frames to export';
    return;
  }

  emptyStateEl.style.display = 'none';
  frameListEl.style.display = 'block';
  frameCountEl.textContent = frames.length + ' frame' + (frames.length !== 1 ? 's' : '') + ' selected';
  exportBtn.disabled = false;
  exportBtn.textContent = 'Export ' + frames.length + ' Slide' + (frames.length !== 1 ? 's' : '') + ' as PDF';

  frames.forEach((frame, index) => {
    const item = el('div', 'frame-item');
    item.draggable = false;

    const left = el('div', 'item-left');

    const dragHandle = el('span', 'drag-handle', '⠿');
    dragHandle.title = 'Drag to reorder';

    const badge = el('span', 'slide-badge', String(index + 1));

    const info = el('div', 'slide-info');
    const name = el('span', 'slide-name', frame.name);
    name.title = frame.name;
    const dim = el('span', 'slide-dim', frame.width + ' × ' + frame.height);
    info.appendChild(name);
    info.appendChild(dim);

    left.appendChild(dragHandle);
    left.appendChild(badge);
    left.appendChild(info);

    const removeBtn = el('button', 'remove-btn', '✕') as HTMLButtonElement;
    removeBtn.title = 'Remove from export';

    item.appendChild(left);
    item.appendChild(removeBtn);

    // Enable drag only from handle
    dragHandle.addEventListener('mousedown', () => { item.draggable = true; });
    dragHandle.addEventListener('mouseup', () => { item.draggable = false; });

    removeBtn.addEventListener('click', () => {
      frames.splice(index, 1);
      renderFrameList();
    });

    // Drag events
    item.addEventListener('dragstart', (e) => {
      dragSrcIndex = index;
      item.classList.add('dragging');
      e.dataTransfer!.effectAllowed = 'move';
    });

    item.addEventListener('dragend', () => {
      item.draggable = false;
      item.classList.remove('dragging');
      document.querySelectorAll('.frame-item').forEach(node => node.classList.remove('drag-over'));
    });

    item.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer!.dropEffect = 'move';
      document.querySelectorAll('.frame-item').forEach(node => node.classList.remove('drag-over'));
      item.classList.add('drag-over');
    });

    item.addEventListener('drop', (e) => {
      e.preventDefault();
      if (dragSrcIndex === null || dragSrcIndex === index) return;
      const moved = frames.splice(dragSrcIndex, 1)[0];
      frames.splice(index, 0, moved);
      dragSrcIndex = null;
      renderFrameList();
    });

    frameListEl.appendChild(item);
  });
}

function setStatus(msg: string, type: 'default' | 'error' | 'success' = 'default') {
  statusEl.textContent = msg;
  statusEl.className = 'status ' + type;
}

function showProgress(show: boolean) {
  progressEl.style.display = show ? 'block' : 'none';
}

function updateProgress(current: number, total: number, name: string) {
  const pct = Math.round((current / total) * 100);
  progressBarEl.style.width = pct + '%';
  progressTextEl.textContent = 'Exporting frame ' + current + ' of ' + total + ' — "' + name + '"';
}

function setLoading(loading: boolean) {
  exportBtn.disabled = loading;
  refreshBtn.disabled = loading;
}

/* ────────────────────────────────────────────────────────────
   Export pipeline
   ──────────────────────────────────────────────────────────── */

// Frames arrive one at a time and are folded into the output as they land, so
// only a single frame's bytes plus the document being built are ever held in
// memory. Accumulating every frame first is what made large decks fail.
let mergedDoc: PDFDocument | null = null;
let mergeMode = false;
let compressMode = false;
let usedNames: { [name: string]: true } = {};
let failures: string[] = [];
let lastDownloadAt = 0;

function resetExportState() {
  mergedDoc = null;
  usedNames = {};
  failures = [];
  lastDownloadAt = 0;
}

function describeError(err: unknown): string {
  return (err && typeof err === 'object' && 'message' in err)
    ? (err as Error).message
    : String(err);
}

function uniqueFileName(rawName: string): string {
  const base = rawName.replace(/[^\w\s\-]/g, '_').trim() || 'slide';
  let candidate = base;
  let n = 2;
  while (usedNames[candidate] === true) {
    candidate = base + ' (' + n + ')';
    n++;
  }
  usedNames[candidate] = true;
  return candidate + '.pdf';
}

function delay(ms: number): Promise<void> {
  return new Promise<void>(resolve => setTimeout(resolve, ms));
}

// Chromium throttles downloads fired back-to-back, so unmerged exports are
// spaced out rather than dumped in a tight loop.
const DOWNLOAD_GAP_MS = 300;

async function downloadFile(bytes: Uint8Array, filename: string) {
  const wait = lastDownloadAt + DOWNLOAD_GAP_MS - Date.now();
  if (wait > 0) await delay(wait);
  lastDownloadAt = Date.now();

  const blob = new Blob([bytes], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function consumeFrame(name: string, bytes: Uint8Array) {
  if (mergeMode) {
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const pages = await mergedDoc!.copyPages(doc, doc.getPageIndices());
    for (const page of pages) mergedDoc!.addPage(page);
    return;
  }

  let out = bytes;
  if (compressMode) {
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
    out = await doc.save({ useObjectStreams: true });
  }
  await downloadFile(out, uniqueFileName(name));
}

async function finishExport(exportErrors: string[]) {
  let fileCount = 0;

  if (mergeMode) {
    setStatus(compressMode ? 'Compressing merged PDF...' : 'Saving merged PDF...');
    const bytes = await mergedDoc!.save({ useObjectStreams: compressMode });
    await downloadFile(bytes, 'slides.pdf');
    fileCount = 1;
  } else {
    fileCount = Object.keys(usedNames).length;
  }

  // Release the document before reporting — it is the largest thing we hold.
  mergedDoc = null;

  const skipped = exportErrors.length + failures.length;
  let doneMsg = 'Done! ' + (mergeMode ? '1 merged PDF' : fileCount + ' PDF' + (fileCount !== 1 ? 's' : '')) + ' downloaded.';
  if (skipped > 0) {
    doneMsg += ' (' + skipped + ' frame' + (skipped !== 1 ? 's' : '') + ' skipped)';
  }
  setStatus(doneMsg, skipped > 0 ? 'default' : 'success');
}

/* ────────────────────────────────────────────────────────────
   Events
   ──────────────────────────────────────────────────────────── */

refreshBtn.addEventListener('click', () => {
  setStatus('Refreshing from selection...');
  postMessage({ type: 'GET_FRAMES' });
});

exportBtn.addEventListener('click', () => {
  if (frames.length === 0) return;
  // Latch the options for the whole run so toggling mid-export can't produce a
  // half-merged result.
  mergeMode = mergeToggle.checked;
  compressMode = compressToggle.checked;
  setLoading(true);
  showProgress(true);
  setStatus('Exporting frames from Figma...');
  postMessage({ type: 'EXPORT_FRAMES', frameIds: frames.map(f => f.id) });
});

// Messages from plugin sandbox
window.onmessage = async (event: MessageEvent) => {
  const msg = event.data && event.data.pluginMessage;
  if (!msg) return;

  switch (msg.type) {

    case 'FRAMES_LIST': {
      const incoming = (msg.frames as Frame[]) || [];
      // A selection change that clears the canvas selection shouldn't throw away
      // a list the user has already reordered or pruned. Refresh always syncs.
      if (msg.reason === 'selection' && incoming.length === 0 && frames.length > 0) break;
      frames = incoming;
      setStatus('');
      renderFrameList();
      break;
    }

    case 'EXPORT_START': {
      resetExportState();
      if (mergeMode) mergedDoc = await PDFDocument.create();
      break;
    }

    case 'EXPORT_PROGRESS': {
      updateProgress(msg.current as number, msg.total as number, msg.name as string);
      break;
    }

    case 'FRAME_DATA': {
      try {
        await consumeFrame(msg.name as string, msg.bytes as Uint8Array);
      } catch (err) {
        failures.push('"' + msg.name + '": ' + describeError(err));
      }
      // Always acknowledge, including after a failure — the sandbox is blocked
      // waiting on this and would otherwise stall the whole export.
      postMessage({ type: 'FRAME_ACK' });
      break;
    }

    case 'EXPORT_DONE': {
      setStatus('Processing PDF...');
      try {
        await finishExport((msg.errors as string[]) || []);
      } catch (err) {
        setStatus('Error: ' + describeError(err), 'error');
        mergedDoc = null;
      }
      showProgress(false);
      setLoading(false);
      renderFrameList();
      break;
    }

    case 'EXPORT_ERROR': {
      setStatus(msg.message as string, 'error');
      mergedDoc = null;
      showProgress(false);
      setLoading(false);
      renderFrameList();
      break;
    }
  }
};

// Ask for the initial selection now that the handler above is live. The sandbox
// can't push it at startup — that would race the iframe load and be dropped.
postMessage({ type: 'GET_FRAMES' });
