// Layout math for the media windows (camera tiles, screenshare stages, self
// preview). Windows are always auto-arranged (Zoom/Teams style) — there is no
// free/manual placement. RemoteMediaView picks a mode and this module computes
// one geometry per window to fill the viewport; the DOM write is split out
// (applyPanelGeometry) so the math stays pure and unit-testable.

// The window-layout mode. 'grid' is the default (every window in an even tile
// grid); 'presentation' features a screenshare in a large main area with a
// filmstrip; 'sidebar' stacks every window in a right-hand column. The active
// mode re-flows on viewport/membership/screenshare changes (there is no manual
// drag to escape it). See RemoteMediaView.reflowLayout.
export type LayoutMode = 'grid' | 'presentation' | 'sidebar';

// Layout margin around the usable area (px).
export const PANEL_MARGIN = 12;
// Space reserved at the bottom for the toolbar, so windows never sit under it.
export const PANEL_BOTTOM_RESERVED = 80;
// Gap left between neighbouring windows when arranging (grid/presentation).
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

// Fixed aspect ratio for every camera window (tiles + self preview), so the grid
// stays uniform regardless of each camera's real dimensions. Must match the
// `aspect-ratio` on .panel-body in index.html. The video fills it (object-fit:
// cover), so a differently-shaped camera is cropped rather than resizing the tile.
export const CAM_ASPECT = 16 / 9;

// Writes a computed geometry onto a panel as explicit inline styles. Position +
// size only; aspect-locked windows leave height unset so it follows the CSS
// aspect-ratio.
export function applyPanelGeometry(el: HTMLElement, g: PanelGeometry) {
  el.style.right = 'auto';
  el.style.bottom = 'auto';
  el.style.left = `${g.left}px`;
  el.style.top = `${g.top}px`;
  el.style.width = `${g.width}px`;
  // Aspect-locked windows derive height from width, so leave it unset.
  el.style.height = g.height == null ? '' : `${g.height}px`;
}

// ============= Auto-arrange (tile every window) =============
// A single window to place. `aspectLocked` camera windows (cam/self preview)
// keep their aspect ratio; free-aspect windows (screenshare) fill their cell.
export type LayoutItem = {
  aspectLocked: boolean;
  // content width/height; only used for aspect-locked windows.
  aspect: number;
};

// The usable placement area: viewport minus the margin and the bottom toolbar
// reservation.
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

// Pure: focus layout — the single maximized window fills the whole usable area.
// Every other window is hidden by the caller, so a maximized window is just a
// grid of one: same area, same aspect handling. Kept as a named function because
// the call sites read as intent, not because the math differs.
export function computeFocusLayout(item: LayoutItem, vw: number, vh: number): PanelGeometry {
  return computeGridLayout([item], vw, vh)[0];
}

// Min/max width of the sidebar column (px). The column scales with the viewport
// but is clamped so it stays usable on small screens and leaves the 2D map
// visible on large ones.
export const SIDEBAR_MIN_WIDTH = 200;
export const SIDEBAR_MAX_WIDTH = 360;

// Pure: sidebar layout — every window stacks in a single column pinned to the
// right edge, so the 2D map stays visible on the left. The column width scales
// with the viewport (clamped). Tiles keep their natural (aspect-derived) height
// and the whole stack is centred vertically, so a 1–2 person call sits compact
// instead of spreading tiles far apart. Only when the natural stack would
// overflow do cells divide the column evenly to fit.
export function computeSidebarLayout(items: LayoutItem[], vw: number, vh: number): PanelGeometry[] {
  const n = items.length;
  if (n === 0) return [];
  const area = usableArea(vw, vh);
  const colW = Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, Math.round(vw * 0.25)));
  const w = Math.min(colW, area.w);
  const colX = area.x + area.w - w;
  const innerW = Math.max(1, w - PANEL_GAP);
  // Preferred per-tile cell height from the camera aspect (header + body + gap).
  // Fall back to an even split when nothing is aspect-locked (e.g. all shares),
  // where there is no natural height to pack to.
  const aspect = items.find((it) => it.aspectLocked)?.aspect;
  const preferredCellH = aspect ? PANEL_HEADER + innerW / aspect + PANEL_GAP : area.h / n;
  // Pack at the natural height, but never overflow: fall to an even divide.
  const cellH = Math.min(preferredCellH, area.h / n);
  // Centre the stack vertically in the column.
  const startY = area.y + Math.max(0, (area.h - cellH * n) / 2);
  return items.map((item, i) => fitInCell(item, colX, startY + i * cellH, w, cellH));
}

// ===== Immersive meeting layout (issue #263) =====
// Used ONLY while standing in a meeting-room zone. Unlike grid/presentation
// (floating panels over the 2D map), this is full-bleed and gap-free over a
// black backdrop (Gather-style): every panel fills its cell edge-to-edge and
// shows its name as a CSS overlay. Two shapes — gallery (no screenshare) and
// presentation (screenshare main + a LEFT camera filmstrip).

// Tight gap between meeting tiles so the grid reads as one surface, not cards.
export const MEETING_GAP = 4;

// Filmstrip (presentation mode): FIXED-SIZE camera tiles — a touch smaller than a
// hallway tile — filling the left rail. At most MAX_VISIBLE_ROWS rows show at
// once; more than that reveals the ⬇️ "show more" toggle. When they fit they are
// vertically centered beside the share; when there are too many (expanded) they
// shrink to divide the rail so everyone still fits without scrolling.
// The rail holds one column by default and two once dragged wide (#304), so the
// visible cap counts ROWS — five rows is five faces in one column, ten in two.
export const MEETING_FILMSTRIP_MAX_VISIBLE_ROWS = 5;
// Default (and aspect-defining) filmstrip tile size. The rail width is user-
// adjustable by dragging the seam (#288); tiles keep this W:H aspect as they
// scale, and the width snaps back to this default when the meeting ends.
export const MEETING_FILMSTRIP_TILE_W = 148;
export const MEETING_FILMSTRIP_TILE_H = 108;
// Drag bounds for the filmstrip rail: never thinner than a readable thumbnail,
// never wider than half the viewport (the share must stay the main event).
export const MEETING_FILMSTRIP_MIN_W = 96;
export const MEETING_FILMSTRIP_MAX_FRAC = 0.5;
// Near-zero separation between the filmstrip and the share, so they read as one
// surface (the tiles sit flush to the left edge; this is just the seam).
export const MEETING_FILMSTRIP_SEP = 2;
// Two columns start paying off once the rail can hold two default-width tiles.
// Below that a second column would only make both of them smaller.
export const MEETING_FILMSTRIP_2COL_MIN_W = MEETING_FILMSTRIP_TILE_W * 2 + MEETING_GAP;
export const MEETING_FILMSTRIP_MAX_COLS = 2;

// Pure: how many columns a rail of this width is worth. Widening past two
// default tiles splits the rail instead of growing one tile further (#304).
export function computeFilmstripColumns(railW: number): number {
  return railW >= MEETING_FILMSTRIP_2COL_MIN_W ? MEETING_FILMSTRIP_MAX_COLS : 1;
}

// Pure: the tile width inside a rail of this width, once its columns are split.
export function filmstripTileWidth(railW: number): number {
  const cols = computeFilmstripColumns(railW);
  return Math.max(1, Math.floor((railW - MEETING_GAP * (cols - 1)) / cols));
}

// The gutter the main share must avoid = the whole rail (tiles are flush-left).
export function meetingFilmstripColWidth(railW: number = MEETING_FILMSTRIP_TILE_W): number {
  return railW;
}

// Pure: clamps a requested filmstrip width into the draggable range for this
// viewport. Non-finite input (a stray drag) falls back to the default.
export function clampFilmstripWidth(w: number, vw: number): number {
  if (!Number.isFinite(w)) return MEETING_FILMSTRIP_TILE_W;
  const max = Math.max(MEETING_FILMSTRIP_MIN_W, Math.floor(vw * MEETING_FILMSTRIP_MAX_FRAC));
  return Math.round(Math.max(MEETING_FILMSTRIP_MIN_W, Math.min(max, w)));
}

// Pure: the filmstrip tile height for a column width, keeping the default aspect.
export function filmstripTileHeight(stripW: number): number {
  return Math.max(1, Math.round((stripW * MEETING_FILMSTRIP_TILE_H) / MEETING_FILMSTRIP_TILE_W));
}

// Split main area (presentation): clicking a filmstrip tile pins it under the
// featured share, so the main area splits top (share) / bottom (pinned). The
// ratio is the top pane's share of the height, dragged via the horizontal seam
// and clamped so neither pane collapses to an unreadable sliver.
export const MEETING_SPLIT_DEFAULT = 0.5;
export const MEETING_SPLIT_MIN = 0.2;
export const MEETING_SPLIT_MAX = 0.8;

// Pure: clamps a requested split ratio into the draggable range. Non-finite
// input (a stray drag) falls back to the default.
export function clampMeetingSplit(ratio: number): number {
  if (!Number.isFinite(ratio)) return MEETING_SPLIT_DEFAULT;
  return Math.max(MEETING_SPLIT_MIN, Math.min(MEETING_SPLIT_MAX, ratio));
}

// Full-bleed horizontally; only the bottom toolbar strip is reserved so tiles
// never hide under the controls.
function meetingArea(vw: number, vh: number) {
  return { x: 0, y: 0, w: vw, h: Math.max(1, vh - PANEL_BOTTOM_RESERVED) };
}

// A meeting tile fills its whole cell (video object-fit:cover), minus the tight
// gap — no header reserve, since the name rides as an overlay.
function fillCell(cx: number, cy: number, cw: number, ch: number): PanelGeometry {
  const g = MEETING_GAP;
  return {
    left: Math.round(cx + g / 2),
    top: Math.round(cy + g / 2),
    width: Math.max(1, Math.round(cw - g)),
    height: Math.max(1, Math.round(ch - g)),
  };
}

// Pure: gallery — every window fills a cell in a near-square full-bleed grid.
export function computeMeetingGallery(
  items: LayoutItem[],
  vw: number,
  vh: number,
): PanelGeometry[] {
  const n = items.length;
  if (n === 0) return [];
  const area = meetingArea(vw, vh);
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  const cellW = area.w / cols;
  const cellH = area.h / rows;
  return items.map((_item, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    return fillCell(area.x + col * cellW, area.y + row * cellH, cellW, cellH);
  });
}

// Pure: presentation — items[0] is the featured screenshare (fills the main area
// on the right); every other item fills the LEFT filmstrip rail. The caller has
// already trimmed the filmstrip to the visible (collapsed ≤ MAX / expanded) set,
// so this just places what it is given inside a rail `stripW` wide (default
// MEETING_FILMSTRIP_TILE_W; user-dragged, #288). The rail runs one column, or
// two once it is wide enough to hold two default tiles (#304); tiles are
// centered in the rail when they fit and shrink to divide it when they don't.
// With a `splitRatio`, items[1] is the pinned window: the main area splits into
// the share on top (that fraction of the height) and items[1] below, and the
// rail holds items[2..]. With nothing left for the rail the split spans the
// full width.
export function computeMeetingPresentation(
  items: LayoutItem[],
  vw: number,
  vh: number,
  stripW: number = MEETING_FILMSTRIP_TILE_W,
  splitRatio: number | null = null,
): PanelGeometry[] {
  const n = items.length;
  if (n === 0) return [];
  const area = meetingArea(vw, vh);
  const result = new Array<PanelGeometry>(n);
  const pinned = splitRatio != null && n >= 2 ? 1 : 0;
  if (n === 1 + pinned) {
    if (pinned) splitMain(result, area.x, area.y, area.w, area.h, splitRatio!);
    else result[0] = fillCell(area.x, area.y, area.w, area.h);
    return result;
  }
  const first = 1 + pinned;
  const strip = n - first;
  const cols = computeFilmstripColumns(stripW);
  const tileW = filmstripTileWidth(stripW);
  const tileH = filmstripTileHeight(tileW);
  // Row-major fill: left to right, then down — reading order, so a newcomer
  // lands where the eye expects rather than extending a column.
  const rows = Math.ceil(strip / cols);
  const colX = (k: number) => area.x + ((k - first) % cols) * (tileW + MEETING_GAP);
  const rowOf = (k: number) => Math.floor((k - first) / cols);
  // Main share abuts the whole rail with only the thin seam between them, and
  // runs full-bleed on the other three edges.
  const mainX = area.x + stripW + MEETING_FILMSTRIP_SEP;
  const mainW = Math.max(1, area.w - mainX);
  if (pinned) splitMain(result, mainX, area.y, mainW, area.h, splitRatio!);
  else result[0] = { left: mainX, top: area.y, width: mainW, height: area.h };

  const fixedTotalH = rows * tileH + (rows - 1) * MEETING_GAP;
  if (fixedTotalH <= area.h) {
    // Fits: fixed-size tiles, flush-left and vertically centered beside the share.
    const startY = area.y + (area.h - fixedTotalH) / 2;
    for (let k = first; k < n; k++) {
      result[k] = {
        left: Math.round(colX(k)),
        top: Math.round(startY + rowOf(k) * (tileH + MEETING_GAP)),
        width: tileW,
        height: tileH,
      };
    }
  } else {
    // Too many at the current size (the expanded view on a short viewport, or a
    // rail dragged wide): divide the rail height so all rows fit, shrinking the
    // width along with it so tiles keep their aspect instead of cropping to a
    // letterbox, centered in their column.
    const cellH = area.h / rows;
    const h = Math.max(1, Math.round(cellH - MEETING_GAP));
    const w = Math.max(
      1,
      Math.min(tileW, Math.round((h * MEETING_FILMSTRIP_TILE_W) / MEETING_FILMSTRIP_TILE_H)),
    );
    for (let k = first; k < n; k++) {
      result[k] = {
        left: Math.round(colX(k) + (tileW - w) / 2),
        top: Math.round(area.y + rowOf(k) * cellH),
        width: w,
        height: h,
      };
    }
  }
  return result;
}

// Splits the main box [x, y, w, h] into the share (result[0], top) and the
// pinned window (result[1], bottom) with the thin seam between them.
function splitMain(
  result: PanelGeometry[],
  x: number,
  y: number,
  w: number,
  h: number,
  ratio: number,
) {
  const topH = Math.max(1, Math.round((h - MEETING_FILMSTRIP_SEP) * clampMeetingSplit(ratio)));
  const bottomY = y + topH + MEETING_FILMSTRIP_SEP;
  result[0] = { left: x, top: y, width: w, height: topH };
  result[1] = { left: x, top: bottomY, width: w, height: Math.max(1, y + h - bottomY) };
}

// ===== Minimized meeting sidebar (#263) =====
// When a meeting is minimized the tiles ride the right-hand column over the map.
// Like the meeting filmstrip, at most MAX_VISIBLE show at a fixed size (sized so
// ~FIT fit the column — the "6-person size" as the floor); a chevron reveals the
// rest, and the expanded view falls back to the normal sidebar (divide-to-fit).
export const MINIMIZED_SIDEBAR_MAX_VISIBLE = 5;
export const MINIMIZED_SIDEBAR_FIT = 6;
export function minimizedSidebarWidth(vw: number): number {
  return Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, Math.round(vw * 0.25)));
}

// Pure: fixed-size right column — each tile gets a cell sized so FIT of them fill
// the column (so 5 sit at the "6-person" size), aspect-locked + centered like the
// normal sidebar. The caller trims `items` to the visible set.
export function computeMinimizedSidebar(
  items: LayoutItem[],
  vw: number,
  vh: number,
): PanelGeometry[] {
  const n = items.length;
  if (n === 0) return [];
  const area = usableArea(vw, vh);
  const w = Math.min(minimizedSidebarWidth(vw), area.w);
  const colX = area.x + area.w - w;
  const cellH = area.h / MINIMIZED_SIDEBAR_FIT;
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
