// Loads the Kenney "Roguelike Indoors" CC0 tilesheet and draws individual
// cells from it. The sheet is one committed PNG (engawa/client/src/assets);
// tiles are 16x16 with a 1px margin, addressed by (col,row). Used by the
// renderer to bake the static map layer into an offscreen cache — until the
// image has loaded, callers fall back to the procedural tile drawing, so a
// slow/failed asset never leaves the map blank.

import sheetUrl from '@/assets/roguelike-indoors.png?url';

const SRC_TILE = 16; // source tile size, px
const SRC_MARGIN = 1; // gap between tiles, px
const STRIDE = SRC_TILE + SRC_MARGIN;

export class SpriteSheet {
  private img = new Image();
  ready = false;
  private onReady: (() => void) | null = null;

  constructor() {
    this.img.onload = () => {
      this.ready = true;
      this.onReady?.();
    };
    this.img.onerror = () => {
      console.warn('[sprites] failed to load tilesheet; using procedural fallback');
    };
    this.img.src = sheetUrl;
  }

  // Run `cb` once the sheet is loaded (immediately if it already is). Used to
  // invalidate the renderer's map cache so it rebuilds with real sprites.
  whenReady(cb: () => void) {
    if (this.ready) cb();
    else this.onReady = cb;
  }

  // Draw source cell (col,row) into the destination square (dx,dy,size). No-op
  // until the sheet is loaded. Pair with ctx.imageSmoothingEnabled=false so the
  // pixel art stays crisp when scaled from 16px up to a 50px tile.
  draw(
    ctx: CanvasRenderingContext2D,
    col: number,
    row: number,
    dx: number,
    dy: number,
    size: number,
  ) {
    if (!this.ready) return;
    ctx.drawImage(this.img, col * STRIDE, row * STRIDE, SRC_TILE, SRC_TILE, dx, dy, size, size);
  }
}
