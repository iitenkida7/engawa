import { describe, expect, it } from 'bun:test';
import {
  computeGridLayout,
  computePanelPreset,
  computePresentationLayout,
  type LayoutItem,
  PANEL_BOTTOM_RESERVED,
  PANEL_HEADER,
  PANEL_MARGIN,
} from '@/ui/panels';

// A roomy reference viewport so the aspect clamps don't kick in unless intended.
const VW = 1000;
const VH = 800;
const ASPECT = 16 / 9;

describe('computePanelPreset — pip', () => {
  it('aspect-locked: fixed 180px width pinned to the top-right, height unset', () => {
    const g = computePanelPreset('pip', true, VW, VH, ASPECT);
    // left = vw - margin(12) - width(180)
    expect(g).toEqual({ left: 808, top: 12, width: 180, height: null });
  });

  it('non-locked: fixed 420x280 in the bottom-left above the toolbar', () => {
    const g = computePanelPreset('pip', false, VW, VH, ASPECT);
    // top = max(12, vh - bottomReserved(80) - height(280)) = max(12, 440)
    expect(g).toEqual({ left: 12, top: 440, width: 420, height: 280 });
  });

  it('non-locked: clamps top to the margin when the viewport is short', () => {
    const g = computePanelPreset('pip', false, VW, 300, ASPECT);
    // vh - 80 - 280 = -60 → clamped to margin 12
    expect(g.top).toBe(12);
  });
});

describe('computePanelPreset — side', () => {
  it('non-locked: ~40% width pinned to the right, full usable height', () => {
    const g = computePanelPreset('side', false, VW, VH, ASPECT);
    // target = max(300, round(1000*0.4)) = 400; maxH = 800-12-80 = 708
    expect(g).toEqual({ left: 588, top: 12, width: 400, height: 708 });
  });

  it('aspect-locked: width is the lesser of the 40% target and aspect*maxH', () => {
    // Short viewport so aspect*maxH < target, exercising the clamp.
    // maxH = 300-12-80 = 208; round(208 * 16/9) = 370 < target 400
    const g = computePanelPreset('side', true, VW, 300, ASPECT);
    expect(g.width).toBe(370);
    expect(g.height).toBeNull();
    expect(g.left).toBe(VW - 12 - 370);
  });
});

describe('computePanelPreset — full', () => {
  it('non-locked: spans the viewport minus margins', () => {
    const g = computePanelPreset('full', false, VW, VH, ASPECT);
    // width = vw - 2*margin = 976; height = maxH = 708
    expect(g).toEqual({ left: 12, top: 12, width: 976, height: 708 });
  });

  it('aspect-locked: width capped by aspect*maxH, height unset', () => {
    // maxH = 300-12-80 = 208; round(208 * 16/9) = 370 < (vw - 24) = 976
    const g = computePanelPreset('full', true, VW, 300, ASPECT);
    expect(g.width).toBe(370);
    expect(g.height).toBeNull();
    expect(g.left).toBe(12);
  });
});

// ============= Batch arrange layouts =============

const cam = (aspect = 4 / 3): LayoutItem => ({ aspectLocked: true, aspect });
const screen = (aspect = 16 / 9): LayoutItem => ({ aspectLocked: false, aspect });

// Resolve a geometry to a concrete bounding box. Aspect-locked windows carry a
// null height (CSS derives it from width), so reconstruct the full window height
// the same way the DOM would: header + width / aspect.
function box(
  g: { left: number; top: number; width: number; height: number | null },
  item: LayoutItem,
) {
  const height = g.height ?? PANEL_HEADER + g.width / item.aspect;
  return { x: g.left, y: g.top, w: g.width, h: height };
}

function overlaps(a: ReturnType<typeof box>, b: ReturnType<typeof box>): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

// The usable area presets/arrange share, for containment checks.
const AREA = {
  left: PANEL_MARGIN,
  top: PANEL_MARGIN,
  right: VW - PANEL_MARGIN,
  bottom: VH - PANEL_BOTTOM_RESERVED,
};

function withinArea(b: ReturnType<typeof box>): boolean {
  // Allow a 1px slack for rounding.
  return (
    b.x >= AREA.left - 1 &&
    b.y >= AREA.top - 1 &&
    b.x + b.w <= AREA.right + 1 &&
    b.y + b.h <= AREA.bottom + 1
  );
}

describe('computeGridLayout', () => {
  it('returns nothing for zero windows', () => {
    expect(computeGridLayout([], VW, VH)).toEqual([]);
  });

  it('places a single window inside the usable area', () => {
    const items = [cam()];
    const [g] = computeGridLayout(items, VW, VH);
    expect(withinArea(box(g, items[0]))).toBe(true);
  });

  it.each([
    [2, 2, 1],
    [3, 2, 2],
    [4, 2, 2],
    [5, 3, 2],
    [9, 3, 3],
  ])('uses near-square cols/rows for %i windows', (n, cols, rows) => {
    expect(Math.ceil(Math.sqrt(n))).toBe(cols);
    expect(Math.ceil(n / cols)).toBe(rows);
    const items = Array.from({ length: n }, () => cam());
    const geos = computeGridLayout(items, VW, VH);
    expect(geos).toHaveLength(n);
    // Every window stays inside the usable area and none overlap.
    const boxes = geos.map((g, i) => box(g, items[i]));
    boxes.forEach((b) => expect(withinArea(b)).toBe(true));
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        expect(overlaps(boxes[i], boxes[j])).toBe(false);
      }
    }
  });

  it('tiles a mix of cam and screenshare windows without overlap', () => {
    const items = [screen(), cam(), cam(16 / 9), cam()];
    const geos = computeGridLayout(items, VW, VH);
    const boxes = geos.map((g, i) => box(g, items[i]));
    boxes.forEach((b) => expect(withinArea(b)).toBe(true));
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        expect(overlaps(boxes[i], boxes[j])).toBe(false);
      }
    }
  });
});

describe('computePresentationLayout', () => {
  it('falls back to a grid when there is no screenshare', () => {
    const items = [cam(), cam()];
    expect(computePresentationLayout(items, VW, VH)).toEqual(computeGridLayout(items, VW, VH));
  });

  it('gives the screenshare a large main area (~70% width) on the left', () => {
    const items = [screen(), cam(), cam()];
    const geos = computePresentationLayout(items, VW, VH);
    const main = geos[0];
    // Main sits on the left and is roughly 70% of the usable width.
    expect(main.left).toBeLessThan(VW * 0.2);
    const usableW = VW - PANEL_MARGIN * 2;
    expect(main.width).toBeGreaterThan(usableW * 0.6);
  });

  it('stacks the other windows in a right-hand column without overlap', () => {
    const items = [screen(), cam(), cam(), cam()];
    const geos = computePresentationLayout(items, VW, VH);
    const boxes = geos.map((g, i) => box(g, items[i]));
    boxes.forEach((b) => expect(withinArea(b)).toBe(true));
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        expect(overlaps(boxes[i], boxes[j])).toBe(false);
      }
    }
    // The filmstrip windows all sit to the right of the main area.
    const mainRight = boxes[0].x + boxes[0].w;
    expect(boxes[1].x).toBeGreaterThanOrEqual(mainRight);
    expect(boxes[2].x).toBeGreaterThanOrEqual(mainRight);
    expect(boxes[3].x).toBeGreaterThanOrEqual(mainRight);
  });

  it('lets the screenshare fill the area when it is the only window', () => {
    const items = [screen()];
    const [g] = computePresentationLayout(items, VW, VH);
    expect(withinArea(box(g, items[0]))).toBe(true);
  });

  it('features the first (main) screenshare and stacks other screenshares in the filmstrip', () => {
    // Multiple simultaneous shares: the main share (first item) keeps the large
    // left area; the second share and the camera both stack in the right strip.
    const items = [screen(), screen(), cam()];
    const geos = computePresentationLayout(items, VW, VH);
    const boxes = geos.map((g, i) => box(g, items[i]));
    boxes.forEach((b) => expect(withinArea(b)).toBe(true));
    // Main is large (~70% width) on the left.
    const usableW = VW - PANEL_MARGIN * 2;
    expect(geos[0].left).toBeLessThan(VW * 0.2);
    expect(geos[0].width).toBeGreaterThan(usableW * 0.6);
    // The other windows (second screenshare + camera) sit in the right strip,
    // to the right of the main area and without overlapping anything.
    const mainRight = boxes[0].x + boxes[0].w;
    expect(boxes[1].x).toBeGreaterThanOrEqual(mainRight);
    expect(boxes[2].x).toBeGreaterThanOrEqual(mainRight);
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        expect(overlaps(boxes[i], boxes[j])).toBe(false);
      }
    }
  });
});
