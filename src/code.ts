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

function isTopLevelSlideInContainer(slide: ExportableSlide, container: SceneNode): boolean {
  let parent = slide.parent;
  while (parent && parent !== container) {
    if (isExportableSlide(parent)) return false;
    parent = parent.parent;
  }
  return true;
}

function isTopLevelSlideOnPage(slide: ExportableSlide): boolean {
  let parent = slide.parent;
  while (parent && parent.type !== 'PAGE') {
    if (isExportableSlide(parent)) return false;
    parent = parent.parent;
  }
  return true;
}

function isExpandableContainer(node: SceneNode): boolean {
  return (
    node.type === 'SECTION' ||
    node.type === 'SLIDE_ROW' ||
    node.type === 'SLIDE_GRID' ||
    node.type === 'GROUP' ||
    node.type === 'FRAME'
  );
}

function boundsContainsPoint(bounds: Rect, node: SceneNode): boolean {
  const nodeBounds = node.absoluteBoundingBox;
  if (!nodeBounds) return false;

  const centerX = nodeBounds.x + nodeBounds.width / 2;
  const centerY = nodeBounds.y + nodeBounds.height / 2;

  return (
    centerX >= bounds.x &&
    centerX <= bounds.x + bounds.width &&
    centerY >= bounds.y &&
    centerY <= bounds.y + bounds.height
  );
}

function sortSlidesByPosition(slides: ExportableSlide[]): ExportableSlide[] {
  return slides.slice().sort((a, b) => {
    const ab = a.absoluteBoundingBox;
    const bb = b.absoluteBoundingBox;
    if (!ab || !bb) return 0;
    if (Math.abs(ab.y - bb.y) > 40) return ab.y - bb.y;
    return ab.x - bb.x;
  });
}

/**
 * Walk descendants of a container and collect slide-level nodes.
 * Nested exportable nodes inside an existing slide are not listed separately.
 */
function collectSlidesUnderContainer(container: SceneNode): ExportableSlide[] {
  const slides: ExportableSlide[] = [];

  if (container.type === 'SECTION' && 'findAll' in container) {
    const matches = (container as SectionNode).findAll((n) => isExportableSlide(n));
    for (const slide of matches) {
      if (isTopLevelSlideInContainer(slide, container)) {
        slides.push(slide);
      }
    }
    return sortSlidesByPosition(slides);
  }

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

  return sortSlidesByPosition(slides);
}

/**
 * Figma sections often visually group frames that are not parented under the
 * section node. Also collect exportable nodes whose center lies inside the
 * section bounds on the current page.
 */
function collectSlidesForSection(section: SectionNode): ExportableSlide[] {
  const slides: ExportableSlide[] = [];
  const seen = new Set<string>();

  function addSlide(slide: ExportableSlide) {
    if (!seen.has(slide.id)) {
      seen.add(slide.id);
      slides.push(slide);
    }
  }

  for (const slide of collectSlidesUnderContainer(section)) {
    addSlide(slide);
  }

  const bounds = section.absoluteBoundingBox;
  if (bounds) {
  const candidates = figma.currentPage.findAll((n) => isExportableSlide(n));
    for (const node of candidates) {
      if (boundsContainsPoint(bounds, node) && isTopLevelSlideOnPage(node)) {
        addSlide(node);
      }
    }
  }

  return sortSlidesByPosition(slides);
}

function collectSlidesFromContainer(container: SceneNode): ExportableSlide[] {
  if (container.type === 'SECTION') {
    return collectSlidesForSection(container);
  }
  return collectSlidesUnderContainer(container);
}

function shouldExpandContainer(node: SceneNode): boolean {
  if (!isExpandableContainer(node)) return false;
  if (node.type === 'FRAME') {
    return collectSlidesFromContainer(node).length > 0;
  }
  return true;
}

function shouldAutoExpandOnCanvas(node: SceneNode): boolean {
  return node.type === 'SECTION' || node.type === 'SLIDE_ROW';
}

function getSelectedFrames(): FrameInfo[] {
  const seen = new Set<string>();
  const result: FrameInfo[] = [];

  for (const node of figma.currentPage.selection) {
    if (shouldExpandContainer(node)) {
      const innerSlides = collectSlidesFromContainer(node);
      if (innerSlides.length > 0) {
        for (const slide of innerSlides) {
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

function collectSlidesFromAutoExpandable(selection: readonly SceneNode[]): ExportableSlide[] {
  const slides: ExportableSlide[] = [];
  const seen = new Set<string>();

  for (const node of selection) {
    if (!shouldAutoExpandOnCanvas(node)) continue;
    for (const slide of collectSlidesFromContainer(node)) {
      if (!seen.has(slide.id)) {
        seen.add(slide.id);
        slides.push(slide);
      }
    }
  }

  return sortSlidesByPosition(slides);
}

function postFramesList() {
  figma.ui.postMessage({ type: 'FRAMES_LIST', frames: getSelectedFrames() });
}

function handleSelectionChange() {
  const selection = figma.currentPage.selection;

  const expandableOnly =
    selection.length > 0 &&
    selection.every((node) => shouldAutoExpandOnCanvas(node));

  if (expandableOnly) {
    const slides = collectSlidesFromAutoExpandable(selection);
    if (slides.length > 0) {
      figma.currentPage.selection = slides;
      postFramesList();
      return;
    }
  }

  postFramesList();
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

(async () => {
  await figma.currentPage.loadAsync();
  handleSelectionChange();
})();

figma.on('selectionchange', () => {
  handleSelectionChange();
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
