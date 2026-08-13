import { PDFDocument } from 'pdf-lib';
import { icon } from './icons';

interface Frame {
  id: string;
  name: string;
  width: number;
  height: number;
}

/* ────────────────────────────────────────────────────────────
   State
   ──────────────────────────────────────────────────────────── */

// Everything the canvas selection gave us.
let frames: Frame[] = [];
// Ids the user ticked in the picker. Order comes from `slides` once we advance.
let picked: { [id: string]: true } = {};
// The curated, reorderable running order used for the editor and the export.
let slides: Frame[] = [];

let screen: 'picker' | 'editor' = 'picker';
let firstLoad = true;
let isRefresh = false;

const THUMB_WIDTH = 440;    // 2x the 222px card, for retina
const PREVIEW_WIDTH = 1400; // large centre pane
const PREVIEW_CACHE_MAX = 8;

// Object URLs, keyed by node id. Revoked when evicted so blobs can be collected.
const thumbs: { [id: string]: string } = {};
const previews: { [id: string]: string } = {};
const previewOrder: string[] = [];
const failedThumbs: { [id: string]: true } = {};

let previewQueue: string[] = [];
let previewBusy = false;

/* ────────────────────────────────────────────────────────────
   DOM
   ──────────────────────────────────────────────────────────── */

function $(id: string): HTMLElement {
  return document.getElementById(id) as HTMLElement;
}

const screenPicker = $('screen-picker');
const screenEditor = $('screen-editor');
const cardGrid = $('card-grid');
const pickerBody = $('picker-body');
const pickerEmpty = $('picker-empty');
const selectAllBox = $('select-all-box');
const selectAllRow = $('select-all-row');
const continueBtn = $('continue-btn') as HTMLButtonElement;
const refreshBtn = $('refresh-btn') as HTMLButtonElement;
const hintText = $('hint-text');
const frameList = $('frame-list');
const stage = $('stage');
const editorCount = $('editor-count');
const exportBtn = $('export-btn') as HTMLButtonElement;
const mergeToggle = $('merge') as HTMLInputElement;
const compressToggle = $('compress') as HTMLInputElement;
const statusEl = $('status');

function post(msg: Record<string, unknown>) {
  parent.postMessage({ pluginMessage: msg }, '*');
}

function el(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  // textContent, never innerHTML — frame names are user-controlled document data.
  if (text !== undefined) node.textContent = text;
  return node;
}

// Icons are trusted, generated constants; frame names never go through here.
function setIcon(host: HTMLElement, name: string, size: number) {
  host.innerHTML = icon(name, size);
}

/* ── Button component ─────────────────────────────────────────
   Idle, busy and progress all live inside the button. Nothing appears
   or disappears around it, so the layout never shifts mid-action. */

const SPINNER =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">' +
  '<circle cx="12" cy="12" r="9" /><path d="M21 12a9 9 0 0 0-9-9" /></svg>';

interface ButtonState {
  label?: string;
  busy?: boolean;
  disabled?: boolean;
}

// Label writes are coalesced to one per frame. An export posts progress far
// faster than the screen refreshes, and writing text on every message is what
// made the button look like it was stuttering rather than working.
const pendingLabel = new WeakMap<HTMLElement, string>();
let labelFlushQueued = false;

function flushLabels() {
  labelFlushQueued = false;
  for (const btn of [continueBtn, exportBtn]) {
    const next = pendingLabel.get(btn);
    if (next === undefined) continue;
    pendingLabel.delete(btn);
    const labelEl = btn.querySelector('.btn-label') as HTMLElement;
    if (labelEl && labelEl.textContent !== next) labelEl.textContent = next;
  }
}

function setButton(btn: HTMLButtonElement, state: ButtonState) {
  const spinEl = btn.querySelector('.btn-spinner') as HTMLElement;
  if (spinEl && !spinEl.innerHTML) spinEl.innerHTML = SPINNER;

  if (state.busy !== undefined) btn.classList.toggle('is-busy', state.busy);
  if (state.disabled !== undefined) btn.disabled = state.disabled;

  if (state.label !== undefined) {
    pendingLabel.set(btn, state.label);
    if (!labelFlushQueued) {
      labelFlushQueued = true;
      requestAnimationFrame(flushLabels);
    }
  }
}

// Checkbox glyphs carry a class so CSS can show the right one per state.
function tickMarkup(): string {
  return icon('check', 11).replace('class="icon"', 'class="tick"');
}
function dashMarkup(): string {
  return icon('minus', 11).replace('class="icon"', 'class="dash"');
}

/* ────────────────────────────────────────────────────────────
   Preview streaming
   ──────────────────────────────────────────────────────────── */

// Renders are requested in small batches rather than all at once, so scrolling
// away from a slide cancels work that is no longer worth doing.
function requestPreviews(ids: string[], kind: 'thumb' | 'preview') {
  const width = kind === 'thumb' ? THUMB_WIDTH : PREVIEW_WIDTH;
  const cache = kind === 'thumb' ? thumbs : previews;
  const wanted = ids.filter(id => !cache[id] && (kind === 'preview' || !failedThumbs[id]));
  if (wanted.length === 0) return;

  previewQueue = previewQueue.concat(wanted.map(id => kind + ':' + id));
  if (previewBusy) return;

  previewBusy = true;
  post({ type: 'RENDER_PREVIEWS', frameIds: wanted, width: width, kind: kind });
}

function cachePreview(id: string, kind: string, bytes: Uint8Array) {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));

  if (kind === 'thumb') {
    thumbs[id] = url;
    paintThumb(id);
    return;
  }

  previews[id] = url;
  previewOrder.push(id);

  // Large renders are heavy. Keep a small window and release the rest.
  while (previewOrder.length > PREVIEW_CACHE_MAX) {
    const evicted = previewOrder.shift() as string;
    if (previews[evicted] && evicted !== id) {
      URL.revokeObjectURL(previews[evicted]);
      delete previews[evicted];
      const host = document.querySelector('[data-preview="' + evicted + '"]');
      if (host) renderStageCanvas(host as HTMLElement, evicted);
    }
  }
  paintPreview(id);
}

function paintThumb(id: string) {
  const host = document.querySelector('[data-thumb="' + id + '"]');
  if (!host) return;
  host.innerHTML = '';
  if (thumbs[id]) {
    const img = document.createElement('img');
    img.src = thumbs[id];
    img.alt = '';
    host.appendChild(img);
  } else if (failedThumbs[id]) {
    host.appendChild(el('span', 'failed', 'Preview unavailable'));
  } else {
    host.appendChild(el('div', 'placeholder'));
  }
}

function paintPreview(id: string) {
  const host = document.querySelector('[data-preview="' + id + '"]');
  if (host) renderStageCanvas(host as HTMLElement, id);
}

function renderStageCanvas(host: HTMLElement, id: string) {
  host.innerHTML = '';
  if (previews[id]) {
    const img = document.createElement('img');
    img.src = previews[id];
    img.alt = '';
    host.appendChild(img);
  } else if (thumbs[id]) {
    // Show the small render immediately, upscaled, while the big one lands.
    const img = document.createElement('img');
    img.src = thumbs[id];
    img.alt = '';
    host.appendChild(img);
  } else {
    host.appendChild(el('div', 'placeholder'));
  }
}

/* ────────────────────────────────────────────────────────────
   Screen 1 — picker
   ──────────────────────────────────────────────────────────── */

function pickedIds(): string[] {
  return frames.filter(f => picked[f.id]).map(f => f.id);
}

function renderPicker() {
  const has = frames.length > 0;
  pickerBody.style.display = has ? 'flex' : 'none';
  pickerEmpty.style.display = has ? 'none' : 'flex';
  hintText.textContent = has
    ? frames.length + ' frame' + (frames.length !== 1 ? 's' : '') + ' on this page — pick the slides to export'
    : 'Select frames from Figma layers to proceed';

  cardGrid.innerHTML = '';

  frames.forEach(frame => {
    const card = el('button', 'card') as HTMLButtonElement;
    card.type = 'button';
    if (picked[frame.id]) card.classList.add('selected');

    // Selection is shown by tinting the card, per the design — there is no
    // per-card checkbox.
    const thumb = el('div', 'card-thumb');
    thumb.setAttribute('data-thumb', frame.id);

    card.appendChild(thumb);
    card.appendChild(el('span', 'card-name', frame.name));

    card.addEventListener('click', () => {
      if (picked[frame.id]) delete picked[frame.id];
      else picked[frame.id] = true;
      syncPickerSelection();
    });

    cardGrid.appendChild(card);
    paintThumb(frame.id);
  });

  syncPickerSelection();
  requestPreviews(frames.map(f => f.id), 'thumb');
}

function syncPickerSelection() {
  const ids = pickedIds();

  frames.forEach((frame, i) => {
    const card = cardGrid.children[i] as HTMLElement;
    if (!card) return;
    card.classList.toggle('selected', !!picked[frame.id]);
  });

  const all = frames.length > 0 && ids.length === frames.length;
  const some = ids.length > 0 && !all;
  selectAllBox.classList.toggle('checked', all);
  selectAllBox.classList.toggle('indeterminate', some);
  selectAllBox.setAttribute('aria-checked', all ? 'true' : some ? 'mixed' : 'false');

  setButton(continueBtn, {
    disabled: ids.length === 0,
    label: 'Continue with Slides (' + ids.length + ')',
  });
}

selectAllBox.innerHTML = tickMarkup() + dashMarkup();

function toggleSelectAll() {
  if (pickedIds().length === frames.length) picked = {};
  else frames.forEach(f => { picked[f.id] = true; });
  syncPickerSelection();
}

selectAllRow.addEventListener('click', toggleSelectAll);
selectAllBox.addEventListener('keydown', (e) => {
  if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggleSelectAll(); }
});

/* ────────────────────────────────────────────────────────────
   Screen 2 — editor
   ──────────────────────────────────────────────────────────── */

function showScreen(next: 'picker' | 'editor') {
  screen = next;
  screenPicker.classList.toggle('active', next === 'picker');
  screenEditor.classList.toggle('active', next === 'editor');
  post({ type: 'CANCEL_PREVIEWS' });
  previewQueue = [];
  previewBusy = false;

  if (next === 'editor') renderEditor();
  else requestPreviews(frames.map(f => f.id), 'thumb');
}

function renderEditor() {
  editorCount.textContent = String(slides.length);
  renderFrameList();
  renderStage();
}

function moveSlide(from: number, to: number) {
  if (from === to || from < 0 || to < 0 || from >= slides.length || to >= slides.length) return;
  const moved = slides.splice(from, 1)[0];
  slides.splice(to, 0, moved);
  renderEditor();
}

function removeSlide(index: number) {
  if (index < 0 || index >= slides.length) return;
  slides.splice(index, 1);
  if (slides.length === 0) { showScreen('picker'); return; }
  renderEditor();
}

/* ── Right-click menu ── */

const rowMenu = $('row-menu');
const menuUp = $('menu-up') as HTMLButtonElement;
const menuDown = $('menu-down') as HTMLButtonElement;
const menuRemove = $('menu-remove') as HTMLButtonElement;
let menuIndex = -1;

function openMenu(index: number, x: number, y: number) {
  menuIndex = index;
  menuUp.disabled = index <= 0;
  menuDown.disabled = index >= slides.length - 1;

  rowMenu.classList.add('open');
  // Measure after showing, then nudge back inside the window if it would clip.
  const rect = rowMenu.getBoundingClientRect();
  const left = Math.min(x, window.innerWidth - rect.width - 8);
  const top = Math.min(y, window.innerHeight - rect.height - 8);
  rowMenu.style.left = Math.max(8, left) + 'px';
  rowMenu.style.top = Math.max(8, top) + 'px';
}

function closeMenu() {
  rowMenu.classList.remove('open');
  menuIndex = -1;
}

menuUp.addEventListener('click', () => { const i = menuIndex; closeMenu(); moveSlide(i, i - 1); });
menuDown.addEventListener('click', () => { const i = menuIndex; closeMenu(); moveSlide(i, i + 1); });
menuRemove.addEventListener('click', () => { const i = menuIndex; closeMenu(); removeSlide(i); });

document.addEventListener('pointerdown', (e) => {
  if (rowMenu.classList.contains('open') && !rowMenu.contains(e.target as Node)) closeMenu();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
window.addEventListener('blur', closeMenu);

/* ── Drag to reorder ──
   Pointer-driven rather than HTML5 drag-and-drop. The native API gives a
   browser-drawn ghost, no control over easing, and no way to show the gap
   opening up — which is what made the old interaction feel dated. Here the
   lifted row tracks the pointer exactly and its neighbours slide aside. */

interface DragState {
  index: number;
  startY: number;
  rows: HTMLElement[];
  step: number;
  target: number;
}

let drag: DragState | null = null;

function beginDrag(e: PointerEvent, index: number, row: HTMLElement) {
  const rows = Array.prototype.slice.call(frameList.children) as HTMLElement[];
  if (rows.length < 2) return;

  const step = rows.length > 1
    ? rows[1].getBoundingClientRect().top - rows[0].getBoundingClientRect().top
    : row.getBoundingClientRect().height;

  drag = { index: index, startY: e.clientY, rows: rows, step: step, target: index };

  row.classList.add('lifted');
  row.setPointerCapture(e.pointerId);
  rows.forEach((r, i) => { if (i !== index) r.classList.add('shifting'); });
  closeMenu();
}

function updateDrag(e: PointerEvent) {
  if (!drag) return;
  const dy = e.clientY - drag.startY;
  const row = drag.rows[drag.index];
  row.style.transform = 'translateY(' + dy + 'px)';

  const shift = Math.round(dy / drag.step);
  const target = Math.max(0, Math.min(drag.rows.length - 1, drag.index + shift));
  if (target === drag.target) return;
  drag.target = target;

  // Everything between the origin and the target slides one slot to make room.
  drag.rows.forEach((r, i) => {
    if (i === drag!.index) return;
    let offset = 0;
    if (drag!.index < target && i > drag!.index && i <= target) offset = -drag!.step;
    else if (drag!.index > target && i >= target && i < drag!.index) offset = drag!.step;
    r.style.transform = offset ? 'translateY(' + offset + 'px)' : '';
  });
}

function endDrag(e: PointerEvent) {
  if (!drag) return;
  const { index, target, rows } = drag;
  const row = rows[index];
  try { row.releasePointerCapture(e.pointerId); } catch (err) { /* already released */ }

  rows.forEach(r => { r.style.transform = ''; r.classList.remove('shifting', 'lifted'); });
  drag = null;

  if (target !== index) moveSlide(index, target);
}

function renderFrameList() {
  frameList.innerHTML = '';

  slides.forEach((frame, index) => {
    const row = el('div', 'frame-row');
    row.setAttribute('data-index', String(index));

    const grip = el('span', 'grip');
    setIcon(grip, 'grip-vertical', 16);
    grip.title = 'Drag to reorder';

    const pill = el('button', 'frame-pill') as HTMLButtonElement;
    pill.type = 'button';
    const mark = el('span');
    setIcon(mark, 'frame', 12);
    const label = el('span', 'lbl', frame.name);
    label.title = frame.name;
    pill.appendChild(mark);
    pill.appendChild(label);

    row.appendChild(grip);
    row.appendChild(pill);

    grip.addEventListener('pointerdown', (e) => {
      if ((e as PointerEvent).button !== 0) return;
      e.preventDefault();
      beginDrag(e as PointerEvent, index, row);
    });
    row.addEventListener('pointermove', (e) => updateDrag(e as PointerEvent));
    row.addEventListener('pointerup', (e) => endDrag(e as PointerEvent));
    row.addEventListener('pointercancel', (e) => endDrag(e as PointerEvent));

    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openMenu(index, (e as MouseEvent).clientX, (e as MouseEvent).clientY);
    });

    pill.addEventListener('click', () => {
      const target = stage.querySelector('[data-stage="' + frame.id + '"]');
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      setActiveRow(frame.id);
      requestPreviews([frame.id], 'preview');
    });

    frameList.appendChild(row);
  });
}

function setActiveRow(id: string) {
  const index = slides.findIndex(f => f.id === id);
  Array.prototype.forEach.call(frameList.children, (row: HTMLElement, i: number) => {
    row.classList.toggle('active', i === index);
  });
}

let stageObserver: IntersectionObserver | null = null;
let activeRowPending = false;

// The highlighted row is whichever slide currently sits at the top of the pane.
// Derived from scroll position rather than intersection callbacks — with a
// look-ahead margin several slides intersect at once and the last callback wins,
// which highlighted an arbitrary row.
function syncActiveRow() {
  if (slides.length === 0) return;
  const top = stage.getBoundingClientRect().top;
  let current = slides[0].id;

  for (const frame of slides) {
    const node = stage.querySelector('[data-stage="' + frame.id + '"]');
    if (!node) continue;
    if (node.getBoundingClientRect().bottom > top + 8) { current = frame.id; break; }
  }
  setActiveRow(current);
}

stage.addEventListener('scroll', () => {
  if (activeRowPending) return;
  activeRowPending = true;
  requestAnimationFrame(() => { activeRowPending = false; syncActiveRow(); });
});

function renderStage() {
  stage.innerHTML = '';
  if (stageObserver) stageObserver.disconnect();

  slides.forEach(frame => {
    const item = el('div', 'stage-item');
    item.setAttribute('data-stage', frame.id);

    const name = el('div', 'stage-name', frame.name);
    name.title = frame.name;

    const canvas = el('div', 'stage-canvas');
    canvas.setAttribute('data-preview', frame.id);
    renderStageCanvas(canvas, frame.id);

    item.appendChild(name);
    item.appendChild(canvas);
    stage.appendChild(item);
  });

  // Only render what is on screen — a 200-slide deck should not queue 200
  // full-size renders on open. The margin deliberately runs ahead of the
  // viewport so a render is usually ready by the time a slide scrolls in.
  stageObserver = new IntersectionObserver((entries) => {
    const visible: string[] = [];
    entries.forEach(entry => {
      const id = (entry.target as HTMLElement).getAttribute('data-stage');
      if (id && entry.isIntersecting) visible.push(id);
    });
    if (visible.length > 0) requestPreviews(visible, 'preview');
  }, { root: stage, rootMargin: '400px 0px' });

  stage.querySelectorAll('.stage-item').forEach(node => stageObserver!.observe(node));
  syncActiveRow();
}

/* ────────────────────────────────────────────────────────────
   Export
   ──────────────────────────────────────────────────────────── */

let mergedDoc: PDFDocument | null = null;
let mergeMode = false;
let compressMode = false;
let usedNames: { [name: string]: true } = {};
let failures: string[] = [];
let lastDownloadAt = 0;

const DOWNLOAD_GAP_MS = 300;

function setStatus(msg: string, type: 'default' | 'error' | 'success' = 'default') {
  statusEl.textContent = msg;
  statusEl.className = 'status ' + type;
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
  while (usedNames[candidate] === true) { candidate = base + ' (' + n + ')'; n++; }
  usedNames[candidate] = true;
  return candidate + '.pdf';
}

function delay(ms: number): Promise<void> {
  return new Promise<void>(resolve => setTimeout(resolve, ms));
}

async function downloadFile(bytes: Uint8Array, filename: string) {
  const wait = lastDownloadAt + DOWNLOAD_GAP_MS - Date.now();
  if (wait > 0) await delay(wait);
  lastDownloadAt = Date.now();

  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function nextFrame(): Promise<void> {
  return new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
}

async function consumeFrame(name: string, bytes: Uint8Array) {
  // Let the browser paint before starting the next chunk of synchronous
  // pdf-lib work, otherwise the spinner freezes on heavy decks.
  await nextFrame();

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
    setStatus('');
    await nextFrame();
    const bytes = await mergedDoc!.save({ useObjectStreams: compressMode });
    await downloadFile(bytes, 'slides.pdf');
    fileCount = 1;
  } else {
    fileCount = Object.keys(usedNames).length;
  }

  mergedDoc = null;

  const skipped = exportErrors.length + failures.length;
  let msg = 'Done — ' + (mergeMode ? '1 merged PDF' : fileCount + ' PDF' + (fileCount !== 1 ? 's' : '')) + ' downloaded.';
  if (skipped > 0) msg += ' ' + skipped + ' frame' + (skipped !== 1 ? 's' : '') + ' skipped.';
  setStatus(msg, skipped > 0 ? 'default' : 'success');
}

function setExporting(busy: boolean) {
  setButton(exportBtn, {
    busy: busy,
    disabled: busy,
    label: busy ? 'Preparing…' : 'Export',
  });
  mergeToggle.disabled = busy;
  compressToggle.disabled = busy;
}

/* ────────────────────────────────────────────────────────────
   Events
   ──────────────────────────────────────────────────────────── */

setIcon($('hint-icon'), 'mouse-pointer-click', 20);
setIcon(refreshBtn, 'refresh-ccw', 12);
setIcon($('back-btn'), 'arrow-left', 14);
setIcon($('feedback-icon'), 'mouse-pointer-click', 14);

$('feedback-btn').addEventListener('click', () => post({ type: 'FEEDBACK' }));

// Refresh re-scans the page for frames added or deleted since the plugin
// opened. Selection changes arrive on their own, so without a rescan this
// button looked inert. The spin is held briefly because the round trip is
// usually instant and an imperceptible flicker reads as "nothing happened".
const REFRESH_SPIN_MS = 550;
let refreshStartedAt = 0;

refreshBtn.addEventListener('click', () => {
  refreshBtn.classList.add('spinning');
  refreshStartedAt = Date.now();
  isRefresh = true;
  post({ type: 'GET_FRAMES' });
});

function stopRefreshSpin() {
  const elapsed = Date.now() - refreshStartedAt;
  const wait = Math.max(0, REFRESH_SPIN_MS - elapsed);
  window.setTimeout(() => refreshBtn.classList.remove('spinning'), wait);
}

continueBtn.addEventListener('click', () => {
  const ids = pickedIds();
  if (ids.length === 0) return;
  slides = frames.filter(f => picked[f.id]);
  setStatus('');
  showScreen('editor');
});

$('back-btn').addEventListener('click', () => showScreen('picker'));

exportBtn.addEventListener('click', () => {
  if (slides.length === 0) return;
  mergeMode = mergeToggle.checked;
  compressMode = compressToggle.checked;
  setExporting(true);
  setStatus('');
  post({ type: 'EXPORT_FRAMES', frameIds: slides.map(f => f.id) });
});

window.onmessage = async (event: MessageEvent) => {
  const msg = event.data && event.data.pluginMessage;
  if (!msg) return;

  switch (msg.type) {

    case 'FRAMES_LIST': {
      const incoming = (msg.frames as Frame[]) || [];
      const preselected = (msg.selected as string[]) || [];

      // Don't discard a curated picker state when the canvas selection is
      // simply cleared.
      if (msg.reason === 'selection' && incoming.length === 0 && frames.length > 0) {
        stopRefreshSpin();
        break;
      }

      if (isRefresh && !firstLoad) {
        // A rescan picks up frames added or deleted on the canvas. Ticks the
        // user already made are kept for every frame that still exists.
        const kept: { [id: string]: true } = {};
        incoming.forEach(f => { if (picked[f.id]) kept[f.id] = true; });
        frames = incoming;
        picked = kept;
        if (Object.keys(picked).length === 0) preselected.forEach(id => { picked[id] = true; });
      } else {
        // Every slide on the page is listed. The canvas selection only decides
        // what starts ticked, so the plugin never opens on an empty screen.
        frames = incoming;
        picked = {};
        preselected.forEach(id => { picked[id] = true; });
      }

      isRefresh = false;
      firstLoad = false;
      stopRefreshSpin();
      if (screen === 'picker') renderPicker();
      break;
    }

    case 'PREVIEW_DATA': {
      cachePreview(msg.id as string, msg.kind as string, msg.bytes as Uint8Array);
      post({ type: 'PREVIEW_ACK' });
      break;
    }

    case 'PREVIEW_FAILED': {
      if (msg.kind === 'thumb') {
        failedThumbs[msg.id as string] = true;
        paintThumb(msg.id as string);
      }
      break;
    }

    case 'PREVIEW_DONE': {
      previewBusy = false;
      previewQueue = [];
      break;
    }

    case 'EXPORT_START': {
      mergedDoc = null;
      usedNames = {};
      failures = [];
      lastDownloadAt = 0;
      if (mergeMode) mergedDoc = await PDFDocument.create();
      break;
    }

    case 'EXPORT_PROGRESS': {
      setButton(exportBtn, {
        busy: true,
        label: 'Exporting ' + msg.current + ' of ' + msg.total,
      });
      break;
    }

    case 'FRAME_DATA': {
      try {
        await consumeFrame(msg.name as string, msg.bytes as Uint8Array);
      } catch (err) {
        failures.push('"' + msg.name + '": ' + describeError(err));
      }
      // Always acknowledge, even after a failure — the sandbox is blocked on this.
      post({ type: 'FRAME_ACK' });
      break;
    }

    case 'EXPORT_DONE': {
      setButton(exportBtn, { busy: true, label: 'Building PDF…' });
      try {
        await finishExport((msg.errors as string[]) || []);
      } catch (err) {
        setStatus('Export failed: ' + describeError(err), 'error');
        mergedDoc = null;
        post({ type: 'EXPORT_ABORT' });
      }
      setExporting(false);
      break;
    }

    case 'EXPORT_ERROR': {
      setStatus(msg.message as string, 'error');
      mergedDoc = null;
      setExporting(false);
      break;
    }
  }
};

// Ask for the initial selection now that the handler above is live. The sandbox
// can't push it at startup — that would race the iframe load and be dropped.
post({ type: 'GET_FRAMES' });
