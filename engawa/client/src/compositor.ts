// Composites the scene into an offscreen canvas for recording. Instead of
// mirroring the live DOM (which reflows with the window and breaks the
// recording's aspect ratio on resize), it lays the scene out into a FIXED
// 16:9 frame with a recording-specific composition that is easy to watch back:
//   - screenshare present → screenshare as the main stage + camera tiles and a
//     small office-map inset down the side.
//   - no screenshare → camera gallery grid + a small office-map inset.
// The recording layout is intentionally decoupled from the on-screen layout:
// dragging panels or resizing the window never changes the recording. The
// content (video/audio/avatars) is still live; only the framing is fixed.
// It reuses the already-rendered floor canvas (no second world render) and
// throttles its own draw loop to 30fps so it never starves the main game loop.

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
    fit === 'contain'
      ? Math.min(boxW / srcW, boxH / srcH)
      : Math.max(boxW / srcW, boxH / srcH);
  const w = srcW * scale;
  const h = srcH * scale;
  return { x: boxX + (boxW - w) / 2, y: boxY + (boxH - h) / 2, w, h };
}

export interface RecordingLayout {
  // Main screenshare stage; null when nothing is being shared (gallery view).
  screen: Box | null;
  // One box per camera/mic tile, in the same order as the input tiles.
  tiles: Box[];
  // Small office-map inset (kept for engawa identity — "where you were").
  map: Box;
}

const GAP = 12;

// Pure layout for the recording frame. Given whether a screenshare is on stage
// and how many camera/mic tiles there are, it places everything inside a fixed
// W×H frame. No DOM access so the geometry can be unit-tested.
export function computeRecordingLayout(
  hasScreen: boolean,
  tileCount: number,
  W: number,
  H: number,
): RecordingLayout {
  if (hasScreen) {
    // Screenshare is the main stage on the left; tiles + map stack down a
    // right-hand sidebar.
    const sideW = Math.round(W * 0.26);
    const mainW = W - sideW;
    const screen: Box = { x: GAP, y: GAP, w: mainW - GAP, h: H - 2 * GAP };

    const sideX = mainW + GAP;
    const innerW = sideW - 2 * GAP;
    const slots = tileCount + 1; // camera tiles + the map slot
    const availH = H - GAP * (slots + 1);
    const slotH = availH / slots;
    const slotY = (i: number) => GAP + i * (slotH + GAP);

    const tiles: Box[] = [];
    for (let i = 0; i < tileCount; i++) {
      tiles.push({ x: sideX, y: slotY(i), w: innerW, h: slotH });
    }
    const map: Box = { x: sideX, y: slotY(tileCount), w: innerW, h: slotH };
    return { screen, tiles, map };
  }

  // Gallery view: no screenshare.
  if (tileCount === 0) {
    // Nothing but the office — show the map full-frame so the recording isn't
    // blank (e.g. cameras off, recording the room only).
    return {
      screen: null,
      tiles: [],
      map: { x: GAP, y: GAP, w: W - 2 * GAP, h: H - 2 * GAP },
    };
  }

  const cols = Math.ceil(Math.sqrt(tileCount));
  const rows = Math.ceil(tileCount / cols);
  const cellW = W / cols;
  const cellH = H / rows;
  const tiles: Box[] = [];
  for (let i = 0; i < tileCount; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    tiles.push({
      x: col * cellW + GAP / 2,
      y: row * cellH + GAP / 2,
      w: cellW - GAP,
      h: cellH - GAP,
    });
  }
  // Small map inset, bottom-right corner (overlaid on the grid).
  const mapW = Math.round(W * 0.22);
  const mapH = Math.round((mapW * 9) / 16);
  const map: Box = { x: W - mapW - GAP, y: H - mapH - GAP, w: mapW, h: mapH };
  return { screen: null, tiles, map };
}

// A video has a paintable frame.
function hasFrame(v: HTMLVideoElement | null): v is HTMLVideoElement {
  return !!v && v.readyState >= 2 && v.videoWidth > 0;
}

const FPS = 30;
const FRAME_INTERVAL_MS = 1000 / FPS;
const FLOOR_BG = '#1a1d24';

// Fixed 16:9 recording frame (logical px). The backing store is scaled by the
// device pixel ratio (capped) so the capture stays crisp, while all drawing
// keeps using these logical coordinates.
const REC_WIDTH = 1280;
const REC_HEIGHT = 720;

export class SceneCompositor {
  private canvas = document.createElement('canvas');
  private ctx: CanvasRenderingContext2D;
  private stream: MediaStream | null = null;
  private raf = 0;
  private running = false;
  private lastDrawMs = 0;
  private width = REC_WIDTH;
  private height = REC_HEIGHT;

  constructor(private floorCanvas: HTMLCanvasElement) {
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('2d context not available');
    this.ctx = ctx;
  }

  get active() {
    return this.running;
  }

  // Begin compositing and return a 30fps capture stream of the scene. The
  // output is a fixed 16:9 frame for the whole recording, independent of the
  // window size, so resizing never distorts the recording's aspect ratio.
  start(): MediaStream {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.width = REC_WIDTH;
    this.height = REC_HEIGHT;
    this.canvas.width = Math.floor(this.width * dpr);
    this.canvas.height = Math.floor(this.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.running = true;
    this.lastDrawMs = 0;
    this.drawFrame(); // paint an initial frame before capture starts
    this.stream = this.canvas.captureStream(FPS);
    this.raf = requestAnimationFrame(this.loop);
    return this.stream;
  }

  stop() {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (this.stream) {
      for (const t of this.stream.getTracks()) t.stop();
      this.stream = null;
    }
  }

  private loop = (now: number) => {
    if (!this.running) return;
    this.raf = requestAnimationFrame(this.loop);
    // Throttle to 30fps so the composite never doubles the main loop's cost.
    if (now - this.lastDrawMs < FRAME_INTERVAL_MS) return;
    this.lastDrawMs = now;
    this.drawFrame();
  };

  private drawFrame() {
    const { ctx, width: W, height: H } = this;
    ctx.fillStyle = FLOOR_BG;
    ctx.fillRect(0, 0, W, H);

    const stage = document.getElementById('screenshare-stage');
    const screenVideo = document.getElementById(
      'screenshare-video',
    ) as HTMLVideoElement | null;
    const screenVisible =
      !!stage && stage.classList.contains('visible') && hasFrame(screenVideo);

    const tiles = this.collectTiles();
    const layout = computeRecordingLayout(screenVisible, tiles.length, W, H);

    // Office-map inset: reuse the already-rendered floor canvas, fit (contain)
    // into the inset so it keeps its own aspect ratio.
    this.drawMap(layout.map);

    if (screenVisible && layout.screen && stage && screenVideo) {
      this.drawBox(layout.screen, '#000');
      this.drawVideo(screenVideo, layout.screen, 'contain', false);
      this.drawLabel(stage, layout.screen);
    }

    layout.tiles.forEach((box, i) => this.drawTile(tiles[i], box));
  }

  // Visible camera/mic `.panel` tiles (remote tiles + self preview). The
  // screenshare stage is handled separately. Self preview is sorted last so
  // remote participants lead the gallery.
  private collectTiles(): HTMLElement[] {
    return Array.from(document.querySelectorAll<HTMLElement>('.panel'))
      .filter((el) => el.id !== 'screenshare-stage' && el.offsetParent !== null)
      .sort(
        (a, b) =>
          (a.id === 'self-preview' ? 1 : 0) - (b.id === 'self-preview' ? 1 : 0),
      );
  }

  private drawBox(box: Box, color: string) {
    this.ctx.fillStyle = color;
    this.ctx.fillRect(box.x, box.y, box.w, box.h);
  }

  private drawMap(box: Box) {
    const fc = this.floorCanvas;
    this.drawBox(box, FLOOR_BG);
    if (fc.width <= 0 || fc.height <= 0) return;
    const d = fitRect(fc.width, fc.height, box.x, box.y, box.w, box.h, 'contain');
    const { ctx } = this;
    ctx.save();
    ctx.beginPath();
    ctx.rect(box.x, box.y, box.w, box.h);
    ctx.clip();
    ctx.drawImage(fc, d.x, d.y, d.w, d.h);
    ctx.restore();
  }

  private drawTile(panel: HTMLElement, box: Box) {
    this.drawBox(box, '#000');
    const video = panel.querySelector('video') as HTMLVideoElement | null;
    if (hasFrame(video)) {
      const fit: ObjectFit =
        getComputedStyle(video).objectFit === 'contain' ? 'contain' : 'cover';
      this.drawVideo(video, box, fit, panel.id === 'self-preview');
    } else {
      this.drawPlaceholder(panel, box);
    }
    this.drawLabel(panel, box);
  }

  private drawVideo(
    video: HTMLVideoElement,
    box: Box,
    fit: ObjectFit,
    mirror: boolean,
  ) {
    const { ctx } = this;
    const d = fitRect(
      video.videoWidth,
      video.videoHeight,
      box.x,
      box.y,
      box.w,
      box.h,
      fit,
    );
    ctx.save();
    ctx.beginPath();
    ctx.rect(box.x, box.y, box.w, box.h);
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
    ctx.fillStyle = '#1a1d24';
    ctx.fillRect(box.x, box.y, box.w, box.h);

    const cx = box.x + box.w / 2;
    const cy = box.y + box.h / 2;
    const initials = panel.querySelector('.no-video-initials')?.textContent ?? '';
    const name = panel.querySelector('.no-video-name')?.textContent ?? '';

    const radius = Math.min(28, box.w / 4, box.h / 4);
    ctx.beginPath();
    ctx.arc(cx, cy - radius / 2, radius, 0, Math.PI * 2);
    ctx.fillStyle = '#3a4050';
    ctx.fill();

    ctx.fillStyle = '#e6e8ee';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `bold ${Math.round(radius * 0.75)}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
    ctx.fillText(initials, cx, cy - radius / 2);

    if (name) {
      ctx.fillStyle = '#9da3b0';
      ctx.font = '12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
      ctx.fillText(name, cx, cy + radius);
    }
  }

  // Name badge in the box's top-left corner — the only chrome we reproduce.
  private drawLabel(panel: HTMLElement, box: Box) {
    const text = panel.querySelector('.panel-header .label')?.textContent?.trim();
    if (!text) return;
    const { ctx } = this;
    ctx.font = '12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const padX = 6;
    const w = ctx.measureText(text).width + padX * 2;
    const h = 18;
    const x = box.x + 6;
    const y = box.y + 6;
    ctx.fillStyle = 'rgba(0,0,0,0.65)';
    roundRect(ctx, x, y, w, h, 4);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.fillText(text, x + padX, y + h / 2 + 1);
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
