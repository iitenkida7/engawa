// Composites the scene into an offscreen canvas for recording. Instead of
// mirroring the live DOM (which reflows with the window and breaks the
// recording's aspect ratio on resize), it lays the scene out into a FIXED
// 16:9 frame with a recording-specific composition that is easy to watch back:
//   - screenshare present → screenshare as the main stage + camera tiles down
//     the side.
//   - no screenshare → camera gallery grid.
// The office map is deliberately left out: it adds nothing when watching a
// meeting back. The recording layout is intentionally decoupled from the
// on-screen layout: dragging panels or resizing the window never changes the
// recording. The content (video/audio) is still live; only the framing is
// fixed. It throttles its own draw loop to 15fps so it never starves the main
// game loop.

import { FrameDriver } from '@/media/frame-driver';

export type ObjectFit = 'cover' | 'contain';

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

// Destination rect for drawing a source of srcW×srcH into a box, honoring CSS
// object-fit semantics (cover = fill+crop, contain = letterbox). Pure so the
// scaling math can be unit-tested without a canvas.
export function fitRect(
  srcW: number,
  srcH: number,
  boxX: number,
  boxY: number,
  boxW: number,
  boxH: number,
  fit: ObjectFit,
): { x: number; y: number; w: number; h: number } {
  if (srcW <= 0 || srcH <= 0) return { x: boxX, y: boxY, w: boxW, h: boxH };
  const scale =
    fit === 'contain' ? Math.min(boxW / srcW, boxH / srcH) : Math.max(boxW / srcW, boxH / srcH);
  const w = srcW * scale;
  const h = srcH * scale;
  return { x: boxX + (boxW - w) / 2, y: boxY + (boxH - h) / 2, w, h };
}

export interface RecordingLayout {
  // Main screenshare stage; null when nothing is being shared (gallery view).
  screen: Box | null;
  // One box per camera/mic tile, in the same order as the input tiles.
  tiles: Box[];
}

const GAP = 12;
// Camera tiles are always 16:9 (the camera is captured at 960×540), so a tile
// never turns into a tall sliver that crops away most of the face.
const TILE_ASPECT = 16 / 9;
// Share of the frame width given to the camera sidebar beside a screenshare.
const SIDEBAR_RATIO = 0.26;

// Lays out n 16:9 tiles inside an area as large as possible: tries every column
// count, keeps the one with the widest tile, and centers the block (and a short
// last row) in the area.
export function layoutTileGrid(n: number, area: Box): Box[] {
  if (n <= 0) return [];
  let best = { cols: 1, rows: n, w: 0 };
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const byW = (area.w - GAP * (cols - 1)) / cols;
    const byH = ((area.h - GAP * (rows - 1)) / rows) * TILE_ASPECT;
    const w = Math.min(byW, byH);
    if (w > best.w) best = { cols, rows, w };
  }
  const { cols, rows, w } = best;
  const h = w / TILE_ASPECT;
  const top = area.y + (area.h - (rows * h + GAP * (rows - 1))) / 2;
  const tiles: Box[] = [];
  for (let i = 0; i < n; i++) {
    const row = Math.floor(i / cols);
    const inRow = Math.min(cols, n - row * cols);
    const left = area.x + (area.w - (inRow * w + GAP * (inRow - 1))) / 2;
    tiles.push({ x: left + (i % cols) * (w + GAP), y: top + row * (h + GAP), w, h });
  }
  return tiles;
}

// Pure layout for the recording frame. Given whether a screenshare is on stage
// and how many camera/mic tiles there are, it places everything inside a fixed
// W×H frame. No DOM access so the geometry can be unit-tested.
export function computeRecordingLayout(
  hasScreen: boolean,
  tileCount: number,
  W: number,
  H: number,
): RecordingLayout {
  const frame: Box = { x: GAP, y: GAP, w: W - 2 * GAP, h: H - 2 * GAP };
  if (!hasScreen) return { screen: null, tiles: layoutTileGrid(tileCount, frame) };

  // Nothing to put beside it: the screenshare takes the whole frame.
  if (tileCount === 0) return { screen: frame, tiles: [] };

  // Screenshare is the main stage on the left; 16:9 tiles sit in a right-hand
  // sidebar, centered vertically (and wrapping into two columns when many).
  const sideW = Math.round(W * SIDEBAR_RATIO);
  const mainW = W - sideW;
  const screen: Box = { x: GAP, y: GAP, w: mainW - GAP, h: H - 2 * GAP };
  const sidebar: Box = { x: mainW + GAP, y: GAP, w: sideW - 2 * GAP, h: H - 2 * GAP };
  return { screen, tiles: layoutTileGrid(tileCount, sidebar) };
}

// Beyond this share of the picture cropped away, a camera tile letterboxes
// instead of filling. A 4:3 camera in a 16:9 tile loses 25% (fill: just the
// background edges); a portrait phone camera would lose ~68% (the face), so it
// letterboxes.
const MAX_COVER_CROP = 0.3;

// Fit for a camera source in a box: fill (cover) when that crops only a little,
// otherwise show it whole (contain).
export function cameraFit(srcW: number, srcH: number, boxW: number, boxH: number): ObjectFit {
  if (srcW <= 0 || srcH <= 0 || boxW <= 0 || boxH <= 0) return 'cover';
  const src = srcW / srcH;
  const box = boxW / boxH;
  const kept = Math.min(src / box, box / src);
  return 1 - kept <= MAX_COVER_CROP ? 'cover' : 'contain';
}

// A video has a paintable frame.
function hasFrame(v: HTMLVideoElement | null): v is HTMLVideoElement {
  return !!v && v.readyState >= 2 && v.videoWidth > 0;
}

// 15fps: every source it composites already arrives at ≤15fps (SFU camera
// layers, screen share), so 30fps only redrew and re-encoded duplicate frames
// of a 2560×1440 canvas — roughly doubling the recording's CPU cost for nothing.
const FPS = 15;
const FRAME_INTERVAL_MS = 1000 / FPS;
const FRAME_BG = '#1a1d24';
// Empty (camera-off) tiles are a shade lighter than the frame so they still
// read as tiles.
const TILE_BG = '#262a33';
const TILE_RADIUS = 8;
const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

// Fixed 16:9 recording frame (logical px). The backing store is always
// REC_SCALE× this (2560×1440), independent of the device pixel ratio: the
// screenshare stage (~74% of the width) then holds an FHD share at ~1:1 and a
// 4K share at ~0.5×, which keeps text legible. Following devicePixelRatio
// instead meant a DPR-1 machine recorded at 1280×720, where a 4K share came out
// at ~0.24× and its text was unreadable (#291).
const REC_WIDTH = 1280;
const REC_HEIGHT = 720;
const REC_SCALE = 2;

export class SceneCompositor {
  private canvas = document.createElement('canvas');
  private ctx: CanvasRenderingContext2D;
  private stream: MediaStream | null = null;
  // rAF while visible, timer while hidden — so a backgrounded tab doesn't freeze
  // the recording's video track (the audio keeps recording, so a frozen composite
  // is worse than none).
  private driver = new FrameDriver((now) => this.loop(now), FRAME_INTERVAL_MS);
  private running = false;
  private lastDrawMs = 0;
  private width = REC_WIDTH;
  private height = REC_HEIGHT;

  constructor() {
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('2d context not available');
    this.ctx = ctx;
  }

  get active() {
    return this.running;
  }

  // Begin compositing and return a 15fps capture stream of the scene. The
  // output is a fixed 16:9 frame for the whole recording, independent of the
  // window size, so resizing never distorts the recording's aspect ratio.
  start(): MediaStream {
    this.width = REC_WIDTH;
    this.height = REC_HEIGHT;
    this.canvas.width = this.width * REC_SCALE;
    this.canvas.height = this.height * REC_SCALE;
    this.ctx.setTransform(REC_SCALE, 0, 0, REC_SCALE, 0, 0);
    // Resizing the canvas resets context state. Downscaling a screenshare with
    // the default (low) filter aliases small text into noise; 'high' resamples
    // properly so a 4K share stays readable at 0.5×.
    this.ctx.imageSmoothingEnabled = true;
    this.ctx.imageSmoothingQuality = 'high';
    this.running = true;
    this.lastDrawMs = 0;
    this.drawFrame(); // paint an initial frame before capture starts
    this.stream = this.canvas.captureStream(FPS);
    this.driver.start();
    return this.stream;
  }

  stop() {
    this.running = false;
    this.driver.stop();
    if (this.stream) {
      for (const t of this.stream.getTracks()) t.stop();
      this.stream = null;
    }
  }

  private loop = (now: number) => {
    if (!this.running) return;
    // Throttle to FPS so the composite never doubles the main loop's cost.
    if (now - this.lastDrawMs < FRAME_INTERVAL_MS) return;
    this.lastDrawMs = now;
    this.drawFrame();
  };

  private drawFrame() {
    const { ctx, width: W, height: H } = this;
    ctx.fillStyle = FRAME_BG;
    ctx.fillRect(0, 0, W, H);

    // The featured ("main") screenshare is the big stage in the recording; any
    // other concurrent shares fall through to collectTiles() and ride the
    // sidebar as tiles.
    const stage = document.querySelector<HTMLElement>('.screenshare-stage.main');
    const screenVideo = (stage?.querySelector('video') ?? null) as HTMLVideoElement | null;
    const screenVisible = !!stage && hasFrame(screenVideo);

    const tiles = this.collectTiles();
    const layout = computeRecordingLayout(screenVisible, tiles.length, W, H);

    if (screenVisible && layout.screen && stage && screenVideo) {
      this.drawBox(layout.screen, '#000');
      this.drawVideo(screenVideo, layout.screen, 'contain', false);
      this.drawLabel(stage, layout.screen);
    }

    layout.tiles.forEach((box, i) => {
      this.drawTile(tiles[i], box);
    });
  }

  // Visible `.panel` tiles for the recording sidebar: remote camera/mic tiles,
  // any non-main screenshares, and the self preview. The main screenshare is
  // drawn separately as the stage, so it's excluded here. Self preview is sorted
  // last so remote participants lead the gallery.
  private collectTiles(): HTMLElement[] {
    return Array.from(document.querySelectorAll<HTMLElement>('.panel'))
      .filter(
        (el) =>
          !(el.classList.contains('screenshare-stage') && el.classList.contains('main')) &&
          el.offsetParent !== null,
      )
      .sort((a, b) => (a.id === 'self-preview' ? 1 : 0) - (b.id === 'self-preview' ? 1 : 0));
  }

  private drawBox(box: Box, color: string) {
    this.ctx.fillStyle = color;
    roundRect(this.ctx, box.x, box.y, box.w, box.h, TILE_RADIUS);
    this.ctx.fill();
  }

  private drawTile(panel: HTMLElement, box: Box) {
    const video = panel.querySelector('video') as HTMLVideoElement | null;
    if (hasFrame(video)) {
      this.drawBox(box, '#000');
      // Screenshares (styled contain) are never cropped; cameras fill unless
      // their aspect is far off the tile's.
      const fit: ObjectFit =
        getComputedStyle(video).objectFit === 'contain'
          ? 'contain'
          : cameraFit(video.videoWidth, video.videoHeight, box.w, box.h);
      this.drawVideo(video, box, fit, panel.id === 'self-preview');
    } else {
      this.drawPlaceholder(panel, box);
    }
    this.drawLabel(panel, box);
  }

  private drawVideo(video: HTMLVideoElement, box: Box, fit: ObjectFit, mirror: boolean) {
    const { ctx } = this;
    const d = fitRect(video.videoWidth, video.videoHeight, box.x, box.y, box.w, box.h, fit);
    ctx.save();
    roundRect(ctx, box.x, box.y, box.w, box.h, TILE_RADIUS);
    ctx.clip();
    if (mirror) {
      // Flip horizontally within the box so the self preview reads as a mirror.
      ctx.translate(2 * box.x + box.w, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(video, d.x, d.y, d.w, d.h);
    ctx.restore();
  }

  private drawPlaceholder(panel: HTMLElement, box: Box) {
    const { ctx } = this;
    this.drawBox(box, TILE_BG);

    const cx = box.x + box.w / 2;
    const cy = box.y + box.h / 2;
    const initials = panel.querySelector('.no-video-initials')?.textContent ?? '';
    const name = panel.querySelector('.no-video-name')?.textContent ?? '';

    const radius = Math.min(40, box.w / 6, box.h / 4);
    ctx.beginPath();
    ctx.arc(cx, cy - radius / 2, radius, 0, Math.PI * 2);
    ctx.fillStyle = '#3a4050';
    ctx.fill();

    ctx.fillStyle = '#e6e8ee';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `bold ${Math.round(radius * 0.75)}px ${FONT}`;
    ctx.fillText(initials, cx, cy - radius / 2);

    if (name) {
      ctx.fillStyle = '#9da3b0';
      ctx.font = `14px ${FONT}`;
      ctx.fillText(name, cx, cy + radius + 4);
    }
  }

  // Name badge in the box's bottom-left corner — the only chrome we reproduce.
  private drawLabel(panel: HTMLElement, box: Box) {
    const text = panel.querySelector('.panel-header .label')?.textContent?.trim();
    if (!text) return;
    const { ctx } = this;
    ctx.font = `14px ${FONT}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const padX = 8;
    const w = Math.min(ctx.measureText(text).width + padX * 2, box.w - 16);
    const h = 22;
    const x = box.x + 8;
    const y = box.y + box.h - h - 8;
    ctx.fillStyle = 'rgba(0,0,0,0.65)';
    roundRect(ctx, x, y, w, h, 4);
    ctx.fill();
    ctx.save();
    ctx.clip();
    ctx.fillStyle = '#fff';
    ctx.fillText(text, x + padX, y + h / 2 + 1);
    ctx.restore();
  }
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
