import { PDFDocument } from 'pdf-lib';

interface Frame {
  id: string;
  name: string;
  width: number;
  height: number;
}

interface ExportResult {
  id: string;
  name: string;
  data: number[];
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

    // Enable drag only from handle
    const dragHandle = item.querySelector('.drag-handle') as HTMLElement;
    dragHandle.addEventListener('mousedown', () => { item.draggable = true; });
    dragHandle.addEventListener('mouseup', () => { item.draggable = false; });

    // Remove button
    item.querySelector('.remove-btn')!.addEventListener('click', () => {
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
  progressTextEl.textContent = 'Exporting "' + name + '" (' + current + '/' + total + ')';
}

function setLoading(loading: boolean) {
  exportBtn.disabled = loading;
  refreshBtn.disabled = loading;
}

// Button events
refreshBtn.addEventListener('click', () => {
  setStatus('Refreshing from selection...');
  postMessage({ type: 'GET_FRAMES' });
});

exportBtn.addEventListener('click', () => {
  if (frames.length === 0) return;
  const ids = frames.map(f => f.id);
  setLoading(true);
  showProgress(true);
  setStatus('Exporting frames from Figma...');
  postMessage({ type: 'EXPORT_FRAMES', frameIds: ids });
});

// Messages from plugin sandbox
window.onmessage = async (event: MessageEvent) => {
  const msg = event.data && event.data.pluginMessage;
  if (!msg) return;

  switch (msg.type) {

    case 'FRAMES_LIST': {
      frames = (msg.frames as Frame[]) || [];
      setStatus('');
      renderFrameList();
      break;
    }

    case 'EXPORT_PROGRESS': {
      updateProgress(msg.current as number, msg.total as number, msg.name as string);
      break;
    }

    case 'EXPORT_COMPLETE': {
      const results = msg.results as ExportResult[];
      setStatus('Processing PDF...');
      try {
        await processPDFs(results);
        const merged = mergeToggle.checked;
        setStatus(
          'Done! ' + (merged ? '1 merged PDF' : results.length + ' PDF' + (results.length !== 1 ? 's' : '')) + ' downloaded.',
          'success'
        );
      } catch (err) {
        setStatus('Error: ' + (err as Error).message, 'error');
      }
      showProgress(false);
      setLoading(false);
      renderFrameList();
      break;
    }

    case 'EXPORT_ERROR': {
      setStatus(msg.message as string, 'error');
      showProgress(false);
      setLoading(false);
      renderFrameList();
      break;
    }
  }
};

async function processPDFs(results: ExportResult[]) {
  const merge = mergeToggle.checked;
  const compress = compressToggle.checked;

  if (merge) {
    setStatus('Merging PDFs...');
    const merged = await PDFDocument.create();

    for (const result of results) {
      const bytes = new Uint8Array(result.data);
      const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true });
      // ✅ Correct pdf-lib API: copyPages (not copyPagesFrom)
      const pages = await merged.copyPages(pdf, pdf.getPageIndices());
      pages.forEach(page => merged.addPage(page));
    }

    if (compress) setStatus('Compressing...');
    const finalBytes = await merged.save({ useObjectStreams: compress });
    downloadFile(finalBytes, 'slides.pdf');
  } else {
    for (const result of results) {
      let bytes = new Uint8Array(result.data);

      if (compress) {
        const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true });
        bytes = await pdf.save({ useObjectStreams: true });
      }

      const safeName = result.name.replace(/[^\w\s\-]/g, '_').trim() || 'slide';
      downloadFile(bytes, safeName + '.pdf');
    }
  }
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
