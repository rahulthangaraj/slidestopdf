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

type SlideNode = FrameNode | ComponentNode;

function isSlide(node: SceneNode): node is SlideNode {
  return node.type === 'FRAME' || node.type === 'COMPONENT';
}

function toInfo(node: SlideNode): FrameInfo {
  return {
    id: node.id,
    name: node.name,
    width: Math.round(node.width),
    height: Math.round(node.height),
  };
}

function getSelectedFrames(): FrameInfo[] {
  return figma.currentPage.selection.filter(isSlide).map(toInfo);
}

// Send initial selection on startup
figma.ui.postMessage({ type: 'FRAMES_LIST', frames: getSelectedFrames() });

// Auto-update when user changes selection in the canvas
figma.on('selectionchange', () => {
  figma.ui.postMessage({ type: 'FRAMES_LIST', frames: getSelectedFrames() });
});

figma.ui.onmessage = async (msg: { type: string; frameIds?: string[] }) => {
  switch (msg.type) {

    case 'GET_FRAMES': {
      figma.ui.postMessage({ type: 'FRAMES_LIST', frames: getSelectedFrames() });
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

      const results: Array<{ id: string; name: string; data: number[] }> = [];
      const errors: string[] = [];

      figma.ui.postMessage({ type: 'EXPORT_START', total: frameIds.length });

      for (let i = 0; i < frameIds.length; i++) {
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

          const bytes = await node.exportAsync({ format: 'PDF' });
          results.push({
            id,
            name: node.name,
            data: Array.from(bytes),
          });
        } catch (err) {
          const errMsg = (err && typeof err === 'object' && 'message' in err)
            ? (err as Error).message
            : String(err);
          errors.push('Failed to export frame ' + (i + 1) + ': ' + errMsg);
          figma.ui.postMessage({
            type: 'EXPORT_PROGRESS',
            current: i + 1,
            total: frameIds.length,
            name: 'Failed (frame ' + (i + 1) + ')',
          });
        }
      }

      if (results.length === 0) {
        figma.ui.postMessage({
          type: 'EXPORT_ERROR',
          message: 'All frames failed to export.' + (errors.length > 0 ? ' ' + errors[0] : ''),
        });
      } else {
        figma.ui.postMessage({ type: 'EXPORT_COMPLETE', results: results, errors: errors });
      }
      break;
    }

    case 'CLOSE': {
      figma.closePlugin();
      break;
    }
  }
};
