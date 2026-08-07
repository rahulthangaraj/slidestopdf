/// <reference types="@figma/plugin-typings" />

figma.showUI(__html__, {
  width: 380,
  height: 560,
});

interface FrameInfo {
  id: string;
  name: string;
  width: number;
  height: number;
}

// Nodes we treat as "one slide == one PDF page".
// Named SlideFrame rather than SlideNode because SlideNode is a Figma global.
type SlideFrame = FrameNode | ComponentNode;

function isSlideFrame(node: SceneNode): node is SlideFrame {
  return node.type === 'FRAME' || node.type === 'COMPONENT';
}

function toInfo(node: SlideFrame): FrameInfo {
  return {
    id: node.id,
    name: node.name,
    width: Math.round(node.width),
    height: Math.round(node.height),
  };
}

/* ────────────────────────────────────────────────────────────
   Selection → slide list
   ──────────────────────────────────────────────────────────── */

interface Box {
  x: number;
  y: number;
  h: number;
}

// Page-absolute position, so nodes living under different parents stay comparable.
function boxOf(node: SceneNode): Box {
  const bounds = 'absoluteBoundingBox' in node ? node.absoluteBoundingBox : null;
  if (bounds) {
    return { x: bounds.x, y: bounds.y, h: bounds.height };
  }
  return { x: 0, y: 0, h: 0 };
}

// Visual reading order: left-to-right within a row, rows top-to-bottom.
//
// Slides are laid out by hand and are rarely pixel-aligned, so rows are banded
// with a tolerance of half the median height rather than compared on exact y.
// That keeps a slide nudged a few pixels down in the same row as its neighbours.
function readingOrder<T extends SceneNode>(nodes: T[]): T[] {
  if (nodes.length < 2) return nodes;

  const boxes: { [id: string]: Box } = {};
  for (const node of nodes) {
    boxes[node.id] = boxOf(node);
  }

  const heights = nodes
    .map(node => boxes[node.id].h)
    .filter(h => h > 0)
    .sort((a, b) => a - b);
  const median = heights.length > 0 ? heights[Math.floor(heights.length / 2)] : 0;
  const tolerance = median > 0 ? median / 2 : 1;

  const byTop = nodes.slice().sort((a, b) => {
    return (boxes[a.id].y - boxes[b.id].y) || (boxes[a.id].x - boxes[b.id].x);
  });

  const rows: T[][] = [];
  let row: T[] = [];
  let anchor = 0;

  for (const node of byTop) {
    const top = boxes[node.id].y;
    if (row.length === 0) {
      anchor = top;
    } else if (top - anchor > tolerance) {
      rows.push(row);
      row = [];
      anchor = top;
    }
    row.push(node);
  }
  if (row.length > 0) rows.push(row);

  const ordered: T[] = [];
  for (const current of rows) {
    current.sort((a, b) => boxes[a.id].x - boxes[b.id].x);
    for (const node of current) ordered.push(node);
  }
  return ordered;
}

// Walk a selection into a flat, ordered slide list.
//
// Sections are containers, not slides, so we walk into them and take the frames
// inside — nested sections recurse to any depth. Frames are never descended
// into: a frame inside a frame is slide content, not a separate slide.
// `seen` dedupes the case where a section and a frame inside it are both selected.
function collectSlides(nodes: ReadonlyArray<SceneNode>, out: SlideFrame[], seen: { [id: string]: true }): void {
  for (const node of readingOrder(nodes.slice())) {
    if (node.type === 'SECTION') {
      collectSlides(node.children, out, seen);
    } else if (isSlideFrame(node) && seen[node.id] !== true) {
      seen[node.id] = true;
      out.push(node);
    }
  }
}

function getSelectedFrames(): FrameInfo[] {
  const slides: SlideFrame[] = [];
  collectSlides(figma.currentPage.selection, slides, {});
  return slides.map(toInfo);
}

function sendFrames(reason: 'request' | 'selection') {
  figma.ui.postMessage({ type: 'FRAMES_LIST', frames: getSelectedFrames(), reason: reason });
}

// The UI asks for the initial list once it has mounted its message handler —
// posting here would race the iframe load and get dropped.
figma.on('selectionchange', () => sendFrames('selection'));

/* ────────────────────────────────────────────────────────────
   Export
   ──────────────────────────────────────────────────────────── */

// Frames are streamed to the UI one at a time, and the next frame is not
// exported until the UI acknowledges the previous one. Without that
// backpressure the sandbox races ahead and every frame's bytes pile up in the
// UI's message queue, which is what made large decks run out of memory.
let ackPending: (() => void) | null = null;
let exporting = false;
let aborted = false;

function waitForAck(): Promise<void> {
  return new Promise<void>(resolve => {
    ackPending = resolve;
  });
}

function resolveAck() {
  const resolve = ackPending;
  ackPending = null;
  if (resolve) resolve();
}

function describeError(err: unknown): string {
  return (err && typeof err === 'object' && 'message' in err)
    ? (err as Error).message
    : String(err);
}

async function runExport(frameIds: string[]) {
  const errors: string[] = [];
  let exported = 0;

  figma.ui.postMessage({ type: 'EXPORT_START', total: frameIds.length });

  for (let i = 0; i < frameIds.length; i++) {
    if (aborted) break;

    const id = frameIds[i];

    try {
      const node = await figma.getNodeByIdAsync(id);

      if (!node) {
        errors.push('Frame "' + id + '" not found (may have been deleted).');
        figma.ui.postMessage({
          type: 'EXPORT_PROGRESS',
          current: i + 1,
          total: frameIds.length,
          name: 'Skipped (not found)',
        });
        continue;
      }

      if (node.type !== 'FRAME' && node.type !== 'COMPONENT') {
        errors.push('"' + node.name + '" is not a frame or component — skipped.');
        figma.ui.postMessage({
          type: 'EXPORT_PROGRESS',
          current: i + 1,
          total: frameIds.length,
          name: 'Skipped: ' + node.name,
        });
        continue;
      }

      figma.ui.postMessage({
        type: 'EXPORT_PROGRESS',
        current: i + 1,
        total: frameIds.length,
        name: node.name,
      });

      // Sent as a Uint8Array. Figma's postMessage clones these natively, so
      // there is no reason to expand the buffer into a number[] first.
      const bytes = await node.exportAsync({ format: 'PDF' });

      const ack = waitForAck();
      figma.ui.postMessage({
        type: 'FRAME_DATA',
        index: i,
        total: frameIds.length,
        id: id,
        name: node.name,
        bytes: bytes,
      });
      await ack;

      exported++;
    } catch (err) {
      errors.push('Failed to export frame ' + (i + 1) + ': ' + describeError(err));
      figma.ui.postMessage({
        type: 'EXPORT_PROGRESS',
        current: i + 1,
        total: frameIds.length,
        name: 'Failed (frame ' + (i + 1) + ')',
      });
    }
  }

  exporting = false;

  if (aborted) return;

  if (exported === 0) {
    figma.ui.postMessage({
      type: 'EXPORT_ERROR',
      message: 'All frames failed to export.' + (errors.length > 0 ? ' ' + errors[0] : ''),
    });
  } else {
    figma.ui.postMessage({ type: 'EXPORT_DONE', exported: exported, errors: errors });
  }
}

figma.ui.onmessage = async (msg: { type: string; frameIds?: string[] }) => {
  switch (msg.type) {

    case 'GET_FRAMES': {
      sendFrames('request');
      break;
    }

    case 'EXPORT_FRAMES': {
      const frameIds = msg.frameIds || [];

      if (frameIds.length === 0) {
        figma.ui.postMessage({
          type: 'EXPORT_ERROR',
          message: 'No frames selected. Please select frames and try again.',
        });
        return;
      }

      if (exporting) return;
      exporting = true;
      aborted = false;

      await runExport(frameIds);
      break;
    }

    // UI has consumed the last frame it was sent and is ready for the next.
    case 'FRAME_ACK': {
      resolveAck();
      break;
    }

    // UI hit a fatal error mid-stream. Unblock the export loop so it can unwind
    // instead of waiting on an acknowledgement that will never arrive.
    case 'EXPORT_ABORT': {
      aborted = true;
      resolveAck();
      break;
    }

    case 'CLOSE': {
      figma.closePlugin();
      break;
    }
  }
};
