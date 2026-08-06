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

type ExportableSlide = FrameNode | ComponentNode | SlideNode | InstanceNode;

function isExportableSlide(node: SceneNode): node is ExportableSlide {
  return (
    node.type === 'FRAME' ||
    node.type === 'COMPONENT' ||
    node.type === 'SLIDE' ||
    node.type === 'INSTANCE'
  );
}

function toInfo(node: ExportableSlide): FrameInfo {
  return {
    id: node.id,
    name: node.name,
    width: Math.round(node.width),
    height: Math.round(node.height),
  };
}

function isExpandableContainer(node: SceneNode): boolean {
  return (
    node.type === 'SECTION' ||
    node.type === 'SLIDE_ROW' ||
    node.type === 'SLIDE_GRID' ||
    node.type === 'GROUP'
  );
}

/**
 * Walk descendants of a container and collect slide-level nodes.
 * Stops at each slide boundary so nested frames inside a slide are not listed separately.
 */
function collectSlidesUnderContainer(container: SceneNode): ExportableSlide[] {
  const slides: ExportableSlide[] = [];

  function walk(node: SceneNode) {
    if (isExportableSlide(node)) {
      slides.push(node);
      return;
    }
    if ('children' in node) {
      for (const child of node.children) {
        walk(child);
      }
    }
  }

  if ('children' in container) {
    for (const child of container.children) {
      walk(child);
    }
  }

  return slides;
}

function getSelectedFrames(): FrameInfo[] {
  const seen = new Set<string>();
  const result: FrameInfo[] = [];

  for (const node of figma.currentPage.selection) {
    if (isExpandableContainer(node)) {
      const slides = collectSlidesUnderContainer(node);
      if (slides.length > 0) {
        for (const slide of slides) {
          if (!seen.has(slide.id)) {
            seen.add(slide.id);
            result.push(toInfo(slide));
          }
        }
        continue;
      }
    }

    if (isExportableSlide(node)) {
      if (!seen.has(node.id)) {
        seen.add(node.id);
        result.push(toInfo(node));
      }
    }
  }

  return result;
}

interface ExportPayload {
  format: 'pdf' | 'jpeg';
  data: Uint8Array;
  width: number;
  height: number;
}

const LARGE_SLIDE_MAX_DIMENSION = 2560;

function shouldUseImageExport(node: ExportableSlide): boolean {
  return node.width > LARGE_SLIDE_MAX_DIMENSION || node.height > LARGE_SLIDE_MAX_DIMENSION;
}

async function exportSlideAsJpeg(node: ExportableSlide): Promise<ExportPayload> {
  const targetWidth = Math.min(1920, Math.max(1, Math.round(node.width)));
  try {
    const bytes = await node.exportAsync({
      format: 'JPG',
      constraint: { type: 'WIDTH', value: targetWidth },
    });
    return {
      format: 'jpeg',
      data: bytes,
      width: node.width,
      height: node.height,
    };
  } catch {
    const bytes = await node.exportAsync({
      format: 'JPG',
      constraint: { type: 'SCALE', value: 0.5 },
    });
    return {
      format: 'jpeg',
      data: bytes,
      width: node.width,
      height: node.height,
    };
  }
}

async function exportSlideBytes(node: ExportableSlide): Promise<ExportPayload> {
  if (shouldUseImageExport(node)) {
    return exportSlideAsJpeg(node);
  }

  try {
    const bytes = await node.exportAsync({ format: 'PDF' });
    return {
      format: 'pdf',
      data: bytes,
      width: node.width,
      height: node.height,
    };
  } catch {
    return exportSlideAsJpeg(node);
  }
}

function postFramesList() {
  figma.ui.postMessage({ type: 'FRAMES_LIST', frames: getSelectedFrames() });
}

// Send initial selection on startup
postFramesList();

// Auto-update when user changes selection in the canvas
figma.on('selectionchange', () => {
  postFramesList();
});

figma.ui.onmessage = async (msg: { type: string; frameIds?: string[] }) => {
  switch (msg.type) {

    case 'GET_FRAMES': {
      postFramesList();
      break;
    }

    case 'EXPORT_FRAMES': {
      const frameIds = msg.frameIds || [];

      if (frameIds.length === 0) {
        figma.ui.postMessage({
          type: 'EXPORT_ERROR',
          message: 'No frames selected. Please select frames or a section and try again.',
        });
        return;
      }

      const errors: string[] = [];
      let successCount = 0;

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

          if (!isExportableSlide(node)) {
            errors.push('"' + node.name + '" is not a frame, slide, or component — skipped.');
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

          const exported = await exportSlideBytes(node);
          successCount++;

          figma.ui.postMessage({
            type: 'EXPORT_FRAME_DONE',
            current: i + 1,
            total: frameIds.length,
            result: {
              id,
              name: node.name,
              format: exported.format,
              width: exported.width,
              height: exported.height,
              data: exported.data,
            },
          });
        } catch (err) {
          const errMsg = (err && typeof err === 'object' && 'message' in err)
            ? (err as Error).message
            : String(err);
          errors.push('Failed to export "' + id + '": ' + errMsg);
          figma.ui.postMessage({
            type: 'EXPORT_PROGRESS',
            current: i + 1,
            total: frameIds.length,
            name: 'Failed (frame ' + (i + 1) + ')',
          });
        }
      }

      if (successCount === 0) {
        figma.ui.postMessage({
          type: 'EXPORT_ERROR',
          message: 'All frames failed to export.' + (errors.length > 0 ? ' ' + errors[0] : ''),
        });
      } else {
        figma.ui.postMessage({
          type: 'EXPORT_ALL_DONE',
          successCount,
          errors,
        });
      }
      break;
    }

    case 'CLOSE': {
      figma.closePlugin();
      break;
    }
  }
};
