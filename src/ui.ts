import { PDFDocument } from 'pdf-lib';
import posthog from 'posthog-js/dist/module.full.no-external';

const posthogKey = process.env.POSTHOG_API_KEY as string;
const posthogHost = process.env.POSTHOG_HOST as string;
if (posthogKey) {
  posthog.init(posthogKey, {
    api_host: posthogHost || 'https://us.i.posthog.com',
    defaults: '2026-05-30',
  });
}

const PLUGIN_VERSION = '1.1.2';

interface Frame {
  id: string;
  name: string;
  width: number;
  height: number;
}

interface FrameExportResult {
  id: string;
  name: string;
  format: 'pdf' | 'jpeg';
  width: number;
  height: number;
  data: Uint8Array | number[];
}

interface ActiveExport {
  mergedDoc: PDFDocument | null;
  successCount: number;
  errors: string[];
  total: number;
  usedImageFallback: boolean;
}

// State — user can reorder/remove within the plugin independently of Figma selection
let frames: Frame[] = [];
let dragSrcIndex: number | null = null;
let pluginOpenedTracked = false;
let activeExport: ActiveExport | null = null;

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
const versionEl = document.getElementById('plugin-version') as HTMLElement;

if (versionEl) {
  versionEl.textContent = 'v' + PLUGIN_VERSION;
}

function postMessage(msg: Record<string, unknown>) {
  parent.postMessage({ pluginMessage: msg }, '*');
}

function toUint8Array(data: Uint8Array | number[]): Uint8Array {
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}

function renderFrameList() {
  frameListEl.innerHTML = '';

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
    const item = document.createElement('div');
    item.className = 'frame-item';
    item.draggable = false;

    item.innerHTML =
      '<div class="item-left">' +
        '<span class="drag-handle" title="Drag to reorder">⠿</span>' +
        '<span class="slide-badge">' + (index + 1) + '</span>' +
        '<div class="slide-info">' +
          '<span class="slide-name" title="' + frame.name + '">' + frame.name + '</span>' +
          '<span class="slide-dim">' + frame.width + ' × ' + frame.height + '</span>' +
        '</div>' +
      '</div>' +
      '<button class="remove-btn" title="Remove from export" data-index="' + index + '">✕</button>';

    const dragHandle = item.querySelector('.drag-handle') as HTMLElement;
    dragHandle.addEventListener('mousedown', () => { item.draggable = true; });
    dragHandle.addEventListener('mouseup', () => { item.draggable = false; });

    item.querySelector('.remove-btn')!.addEventListener('click', () => {
      posthog.capture('frame_removed', { remaining_frame_count: frames.length - 1 });
      frames.splice(index, 1);
      renderFrameList();
    });

    item.addEventListener('dragstart', (e) => {
      dragSrcIndex = index;
      item.classList.add('dragging');
      e.dataTransfer!.effectAllowed = 'move';
    });

    item.addEventListener('dragend', () => {
      item.draggable = false;
      item.classList.remove('dragging');
      document.querySelectorAll('.frame-item').forEach(el => el.classList.remove('drag-over'));
    });

    item.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer!.dropEffect = 'move';
      document.querySelectorAll('.frame-item').forEach(el => el.classList.remove('drag-over'));
      item.classList.add('drag-over');
    });

    item.addEventListener('drop', (e) => {
      e.preventDefault();
      if (dragSrcIndex === null || dragSrcIndex === index) return;
      const moved = frames.splice(dragSrcIndex, 1)[0];
      frames.splice(index, 0, moved);
      posthog.capture('frame_reordered', { frame_count: frames.length });
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

async function addPdfBytesToDoc(doc: PDFDocument, bytes: Uint8Array) {
  const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const pages = await doc.copyPages(pdf, pdf.getPageIndices());
  pages.forEach(page => doc.addPage(page));
}

async function addJpegAsPdfPage(doc: PDFDocument, bytes: Uint8Array, width: number, height: number) {
  const image = await doc.embedJpg(bytes);
  const page = doc.addPage([width, height]);
  page.drawImage(image, { x: 0, y: 0, width, height });
}

async function createSingleSlidePdf(result: FrameExportResult, compress: boolean): Promise<Uint8Array> {
  const bytes = toUint8Array(result.data);

  if (result.format === 'pdf') {
    if (!compress) return bytes;
    const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true });
    return pdf.save({ useObjectStreams: true });
  }

  const doc = await PDFDocument.create();
  await addJpegAsPdfPage(doc, bytes, result.width, result.height);
  return doc.save({ useObjectStreams: compress });
}

async function processFrameResult(result: FrameExportResult) {
  const merge = mergeToggle.checked;
  const compress = compressToggle.checked;

  if (merge && activeExport && activeExport.mergedDoc) {
    if (result.format === 'pdf') {
      await addPdfBytesToDoc(activeExport.mergedDoc, toUint8Array(result.data));
    } else {
      activeExport.usedImageFallback = true;
      await addJpegAsPdfPage(
        activeExport.mergedDoc,
        toUint8Array(result.data),
        result.width,
        result.height,
      );
    }
    return;
  }

  const pdfBytes = await createSingleSlidePdf(result, compress);
  const safeName = result.name.replace(/[^\w\s\-]/g, '_').trim() || 'slide';
  downloadFile(pdfBytes, safeName + '.pdf');
}

async function finishExport() {
  if (!activeExport) return;

  const { mergedDoc, successCount, errors, usedImageFallback } = activeExport;
  const compress = compressToggle.checked;

  try {
    if (mergeToggle.checked && mergedDoc) {
      if (compress) setStatus('Compressing merged PDF...');
      const finalBytes = await mergedDoc.save({ useObjectStreams: compress });
      downloadFile(finalBytes, 'slides.pdf');
    }

    let doneMsg = 'Done! ' + (
      mergeToggle.checked
        ? '1 merged PDF'
        : successCount + ' PDF' + (successCount !== 1 ? 's' : '')
    ) + ' downloaded.';

    if (usedImageFallback) {
      doneMsg += ' Some slides used image fallback for large files.';
    }
    if (errors.length > 0) {
      doneMsg += ' (' + errors.length + ' frame' + (errors.length !== 1 ? 's' : '') + ' skipped)';
    }

    setStatus(doneMsg, errors.length > 0 ? 'default' : 'success');
    posthog.capture('export_completed', {
      frame_count: successCount,
      skipped_count: errors.length,
      merge_enabled: mergeToggle.checked,
      compress_enabled: compress,
      used_image_fallback: usedImageFallback,
    });
  } catch (err) {
    setStatus('Error: ' + (err as Error).message, 'error');
    posthog.capture('export_failed', { error_message: (err as Error).message });
    posthog.captureException(err as Error);
  }

  activeExport = null;
  showProgress(false);
  setLoading(false);
  renderFrameList();
}

function downloadFile(bytes: Uint8Array, filename: string) {
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

// Button events
refreshBtn.addEventListener('click', () => {
  setStatus('Refreshing from selection...');
  posthog.capture('frames_refreshed');
  postMessage({ type: 'GET_FRAMES' });
});

exportBtn.addEventListener('click', () => {
  if (frames.length === 0) return;
  const ids = frames.map(f => f.id);
  setLoading(true);
  showProgress(true);
  setStatus('Exporting frames from Figma...');
  posthog.capture('export_started', {
    frame_count: frames.length,
    merge_enabled: mergeToggle.checked,
    compress_enabled: compressToggle.checked,
  });
  postMessage({ type: 'EXPORT_FRAMES', frameIds: ids });
});

// Messages from plugin sandbox
window.onmessage = async (event: MessageEvent) => {
  const msg = event.data && event.data.pluginMessage;
  if (!msg) return;

  switch (msg.type) {

    case 'FRAMES_LIST': {
      frames = (msg.frames as Frame[]) || [];
      if (!pluginOpenedTracked) {
        pluginOpenedTracked = true;
        posthog.capture('plugin_opened', { initial_frame_count: frames.length });
      }
      setStatus('');
      renderFrameList();
      break;
    }

    case 'EXPORT_START': {
      activeExport = {
        mergedDoc: mergeToggle.checked ? await PDFDocument.create() : null,
        successCount: 0,
        errors: [],
        total: msg.total as number,
        usedImageFallback: false,
      };
      break;
    }

    case 'EXPORT_PROGRESS': {
      updateProgress(msg.current as number, msg.total as number, msg.name as string);
      break;
    }

    case 'EXPORT_FRAME_DONE': {
      const result = msg.result as FrameExportResult;
      if (activeExport) {
        activeExport.successCount++;
        if (result.format === 'jpeg') {
          activeExport.usedImageFallback = true;
        }
      }
      setStatus('Processing slide ' + (msg.current as number) + ' of ' + (msg.total as number) + '...');
      try {
        await processFrameResult(result);
      } catch (err) {
        const errMsg = (err as Error).message;
        if (activeExport) {
          activeExport.errors.push('Failed to process "' + result.name + '": ' + errMsg);
        }
        posthog.capture('export_failed', { error_message: errMsg });
        posthog.captureException(err as Error);
      }
      break;
    }

    case 'EXPORT_ALL_DONE': {
      if (activeExport) {
        activeExport.errors.push(...((msg.errors as string[]) || []));
      }
      await finishExport();
      break;
    }

    case 'EXPORT_ERROR': {
      setStatus(msg.message as string, 'error');
      posthog.capture('export_failed', { error_message: msg.message as string });
      activeExport = null;
      showProgress(false);
      setLoading(false);
      renderFrameList();
      break;
    }
  }
};
