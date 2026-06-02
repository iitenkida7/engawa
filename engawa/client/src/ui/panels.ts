// Floating-panel chrome shared by the camera tiles, the screenshare stage, and
// the self preview: the pip/side/full preset buttons and the layout math behind
// them. A preset only sets an initial position/size as inline styles — panels
// stay freely draggable and resizable afterwards (nothing is locked).

export type PanelPreset = 'pip' | 'side' | 'full';

// A persistent window-layout mode. 'free' is the default (windows are freely
// draggable/resizable, nothing reflows). The others auto-arrange every window
// and re-arrange on viewport/membership/screenshare changes until the user
// drags a window (which drops back to 'free'). See RemoteMediaView.reflowLayout.
export type LayoutMode = 'free' | 'grid' | 'presentation' | 'sidebar';

// Layout margin used when computing presets (px).
export const PANEL_MARGIN = 12;
// Space reserved at the bottom for the toolbar, so presets never sit under it.
export const PANEL_BOTTOM_RESERVED = 80;
// Gap left between neighbouring windows when batch-arranging (grid/presentation).
export const PANEL_GAP = 8;
// Approx. height of a panel header bar; reserved on top of an aspect-locked
// camera window's body so the whole window (header + video) fits its cell.
export const PANEL_HEADER = 34;

export type PanelGeometry = {
  left: number;
  top: number;
  width: number;
  // null → derive height from the CSS aspect-ratio (aspect-locked camera
  // windows), so only the width is pinned.
  height: number | null;
};

// Pure: computes a preset's geometry from the viewport size. Split from the DOM
// write so the layout math can be unit-tested. `aspect` is the content's
// width/height, used only for aspect-locked (camera) windows.
export function computePanelPreset(
  preset: PanelPreset,
  aspectLocked: boolean,
  vw: number,
  vh: number,
  aspect: number,
): PanelGeometry {
  const m = PANEL_MARGIN;
  const maxH = vh - m - PANEL_BOTTOM_RESERVED;

  if (preset === 'pip') {
    const width = aspectLocked ? 180 : 420;
    if (aspectLocked) {
      return { left: vw - m - width, top: m, width, height: null };
    }
    const height = 280;
    return { left: m, top: Math.max(m, vh - PANEL_BOTTOM_RESERVED - height), width, height };
  }

  if (preset === 'side') {
    const target = Math.max(300, Math.round(vw * 0.4));
    const width = aspectLocked ? Math.min(target, Math.round(maxH * aspect)) : target;
    return { left: vw - m - width, top: m, width, height: aspectLocked ? null : maxH };
  }

  // full
  const width = aspectLocked ? Math.min(vw - m * 2, Math.round(maxH * aspect)) : vw - m * 2;
  return { left: m, top: m, width, height: aspectLocked ? null : maxH };
}

// Reads the camera aspect ratio stored in --cam-aspect ("w / h"); falls back
// to 4/3. Used to size aspect-locked camera windows by width.
export function readCamAspect(el: HTMLElement): number {
  const v = getComputedStyle(el).getPropertyValue('--cam-aspect').trim();
  const m = v.match(/([\d.]+)\s*\/\s*([\d.]+)/);
  if (m) {
    const r = parseFloat(m[1]) / parseFloat(m[2]);
    if (r > 0) return r;
  }
  return 4 / 3;
}

// Writes a computed geometry onto a panel as explicit inline styles. Shared by
// the header presets and the batch arrange so both lay panels out the same way:
// position + size only, so the panel stays freely draggable/resizable after.
export function applyPanelGeometry(el: HTMLElement, g: PanelGeometry) {
  el.style.right = 'auto';
  el.style.bottom = 'auto';
  el.style.left = `${g.left}px`;
  el.style.top = `${g.top}px`;
  el.style.width = `${g.width}px`;
  // Aspect-locked windows derive height from width, so leave it unset.
  el.style.height = g.height == null ? '' : `${g.height}px`;
}

// Applies a preset layout as explicit inline geometry. Presets only set an
// initial position/size — the panel stays freely draggable and resizable
// afterwards. Aspect-locked camera windows get width only; their height follows
// the CSS aspect-ratio.
export function applyPanelPreset(el: HTMLElement, preset: PanelPreset, aspectLocked: boolean) {
  const aspect = aspectLocked ? readCamAspect(el) : 4 / 3;
  const g = computePanelPreset(preset, aspectLocked, window.innerWidth, window.innerHeight, aspect);
  applyPanelGeometry(el, g);
}

// ============= Batch arrange (one-shot "tidy all windows") =============
// A single window to place. `aspectLocked` camera windows (cam/self preview)
// keep their aspect ratio; free-aspect windows (screenshare) fill their cell.
export type LayoutItem = {
  aspectLocked: boolean;
  // content width/height; only used for aspect-locked windows.
  aspect: number;
};

// The usable placement area: viewport minus the margin and the bottom toolbar
// reservation. Matches the preset math so arrange and presets agree.
function usableArea(vw: number, vh: number) {
  const m = PANEL_MARGIN;
  return { x: m, y: m, w: vw - m * 2, h: vh - m - PANEL_BOTTOM_RESERVED };
}

// Fits one window into a cell box [cx, cy, cw, ch], leaving PANEL_GAP between
// neighbours. Aspect-locked windows are sized by width (height follows CSS)
// and centred in the cell; free-aspect windows fill the cell.
function fitInCell(
  item: LayoutItem,
  cx: number,
  cy: number,
  cw: number,
  ch: number,
): PanelGeometry {
  const innerW = Math.max(1, cw - PANEL_GAP);
  const innerH = Math.max(1, ch - PANEL_GAP);
  if (!item.aspectLocked) {
    return {
      left: Math.round(cx + PANEL_GAP / 2),
      top: Math.round(cy + PANEL_GAP / 2),
      width: Math.round(innerW),
      height: Math.round(innerH),
    };
  }
  // Body height is bounded by the cell minus the header; pick the largest width
  // that keeps header + aspect-derived body within the cell.
  const bodyMaxH = Math.max(1, innerH - PANEL_HEADER);
  const width = Math.max(1, Math.round(Math.min(innerW, bodyMaxH * item.aspect)));
  const fullH = PANEL_HEADER + width / item.aspect;
  const left = Math.round(cx + (cw - width) / 2);
  const top = Math.round(cy + (ch - fullH) / 2);
  return { left, top, width, height: null };
}

// Pure: tiles every window into a near-square grid (cols = ceil(sqrt(n))) that
// fills the usable area. Returns one geometry per item, in input order.
export function computeGridLayout(items: LayoutItem[], vw: number, vh: number): PanelGeometry[] {
  const n = items.length;
  if (n === 0) return [];
  const area = usableArea(vw, vh);
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  const cellW = area.w / cols;
  const cellH = area.h / rows;
  return items.map((item, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    return fitInCell(item, area.x + col * cellW, area.y + row * cellH, cellW, cellH);
  });
}

// Min/max width of the sidebar column (px). The column scales with the viewport
// but is clamped so it stays usable on small screens and leaves the 2D map
// visible on large ones.
export const SIDEBAR_MIN_WIDTH = 200;
export const SIDEBAR_MAX_WIDTH = 360;

// Pure: sidebar layout — every window stacks in a single column pinned to the
// right edge, so the 2D map stays visible on the left. The column width scales
// with the viewport (clamped). Windows split the column height evenly.
export function computeSidebarLayout(items: LayoutItem[], vw: number, vh: number): PanelGeometry[] {
  const n = items.length;
  if (n === 0) return [];
  const area = usableArea(vw, vh);
  const colW = Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, Math.round(vw * 0.25)));
  const w = Math.min(colW, area.w);
  const colX = area.x + area.w - w;
  const cellH = area.h / n;
  return items.map((item, i) => fitInCell(item, colX, area.y + i * cellH, w, cellH));
}

// Pure: presentation layout — the (first) screenshare fills a large main area on
// the left (~70% width); every other window stacks in a right-hand filmstrip.
// Falls back to a grid when there is no screenshare to feature.
export function computePresentationLayout(
  items: LayoutItem[],
  vw: number,
  vh: number,
): PanelGeometry[] {
  const screenIdx = items.findIndex((it) => !it.aspectLocked);
  if (screenIdx === -1) return computeGridLayout(items, vw, vh);

  const area = usableArea(vw, vh);
  const others = items.map((_, i) => i).filter((i) => i !== screenIdx);
  const result = new Array<PanelGeometry>(items.length);

  // No companions → the screenshare just takes the whole area.
  if (others.length === 0) {
    result[screenIdx] = fitInCell(items[screenIdx], area.x, area.y, area.w, area.h);
    return result;
  }

  const mainW = Math.round((area.w - PANEL_GAP) * 0.7);
  const stripW = area.w - PANEL_GAP - mainW;
  result[screenIdx] = fitInCell(items[screenIdx], area.x, area.y, mainW, area.h);

  const stripX = area.x + mainW + PANEL_GAP;
  const cellH = area.h / others.length;
  others.forEach((idx, k) => {
    result[idx] = fitInCell(items[idx], stripX, area.y + k * cellH, stripW, cellH);
  });
  return result;
}

// Keeps a camera panel's --cam-aspect in sync with its live video dimensions,
// so the aspect-locked PiP window matches the actual camera (and re-adjusts
// when the device changes). No-op until the video reports real dimensions.
export function bindCamAspect(panel: HTMLElement, video: HTMLVideoElement) {
  const update = () => {
    if (video.videoWidth > 0 && video.videoHeight > 0) {
      panel.style.setProperty('--cam-aspect', `${video.videoWidth} / ${video.videoHeight}`);
    }
  };
  // loadedmetadata: first frame sized; resize: intrinsic size changed (device switch).
  video.addEventListener('loadedmetadata', update);
  video.addEventListener('resize', update);
  update();
}

// The pip/side/full preset buttons shown in every panel header. Markup matches
// the static .stage-controls block in index.html so CSS is shared.
export function createModeControls(): HTMLDivElement {
  const controls = document.createElement('div');
  controls.className = 'stage-controls';
  const presets: Array<[PanelPreset, string, string]> = [
    ['pip', '🪟', '小窓'],
    ['side', '◧', 'サイドパネル'],
    ['full', '⬜', '全画面'],
  ];
  for (const [preset, icon, title] of presets) {
    const btn = document.createElement('button');
    btn.dataset.mode = preset;
    btn.title = title;
    btn.textContent = icon;
    controls.appendChild(btn);
  }
  return controls;
}

// Wires the header preset buttons. Each click applies a one-shot layout preset
// (position + size) as inline styles; the panel remains freely draggable and
// resizable afterwards. `aspectLocked` panels (camera windows) get width-only
// presets. `onActivate` fires on each click (e.g. raise z-order).
export function setupPanelModes(
  el: HTMLElement,
  opts: { aspectLocked?: boolean; onActivate?: () => void } = {},
) {
  const controls = el.querySelector('.stage-controls');
  // Don't let a click/drag on the buttons start a header drag.
  controls?.addEventListener('mousedown', (e) => e.stopPropagation());
  el.querySelectorAll<HTMLButtonElement>('.stage-controls button').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      applyPanelPreset(el, btn.dataset.mode as PanelPreset, !!opts.aspectLocked);
      opts.onActivate?.();
    });
  });
}
