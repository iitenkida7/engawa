// Floating-panel chrome shared by the camera tiles, the screenshare stage, and
// the self preview: the pip/side/full preset buttons and the layout math behind
// them. A preset only sets an initial position/size as inline styles — panels
// stay freely draggable and resizable afterwards (nothing is locked).

export type PanelPreset = 'pip' | 'side' | 'full';

// Layout margin used when computing presets (px).
const PANEL_MARGIN = 12;
// Space reserved at the bottom for the toolbar, so presets never sit under it.
const PANEL_BOTTOM_RESERVED = 80;

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

// Applies a preset layout as explicit inline geometry. Presets only set an
// initial position/size — the panel stays freely draggable and resizable
// afterwards. Aspect-locked camera windows get width only; their height follows
// the CSS aspect-ratio.
export function applyPanelPreset(el: HTMLElement, preset: PanelPreset, aspectLocked: boolean) {
  const aspect = aspectLocked ? readCamAspect(el) : 4 / 3;
  const g = computePanelPreset(preset, aspectLocked, window.innerWidth, window.innerHeight, aspect);

  el.style.right = 'auto';
  el.style.bottom = 'auto';
  el.style.left = `${g.left}px`;
  el.style.top = `${g.top}px`;
  el.style.width = `${g.width}px`;
  // Aspect-locked windows derive height from width, so leave it unset.
  el.style.height = g.height == null ? '' : `${g.height}px`;
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
