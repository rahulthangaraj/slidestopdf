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
      const results: Array<{ id: string; name: string; data: number[] }> = [];

      figma.ui.postMessage({ type: 'EXPORT_START', total: frameIds.length });

      for (let i = 0; i < frameIds.length; i++) {
        const id = frameIds[i];
        const node = figma.getNodeById(id);

        if (node && (node.type === 'FRAME' || node.type === 'COMPONENT')) {
          try {
            const bytes = await node.exportAsync({ format: 'PDF' });
            results.push({
              id,
              name: node.name,
              data: Array.from(bytes),
            });
            figma.ui.postMessage({
              type: 'EXPORT_PROGRESS',
              current: i + 1,
              total: frameIds.length,
              name: node.name,
            });
          } catch (err) {
            figma.ui.postMessage({
              type: 'EXPORT_ERROR',
              message: 'Failed to export "' + node.name + '". Please try again.',
            });
            return;
          }
        }
      }

      figma.ui.postMessage({ type: 'EXPORT_COMPLETE', results });
      break;
    }

    case 'CLOSE': {
      figma.closePlugin();
      break;
    }
  }
};
