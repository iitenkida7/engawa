// Composites the live scene — the floor canvas plus every floating video panel
// (screenshare, remote cameras, self preview) — onto an offscreen canvas so it
// can be captured into the recording. It reuses the already-rendered floor
// canvas (no second world render) and throttles its own draw loop to 30fps so
// it never starves the main game loop. It runs only while recording.

export type ObjectFit = 'cover' | 'contain';

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

// Effective stacking order of a panel. Mirrors the CSS defaults
// (#screenshare-stage z6, everything else z5) and respects the inline z-index
// that bringToFront() assigns on focus, so the composite stacks like the DOM.
export function panelZIndex(el: HTMLElement): number {
  const raw = el.style.zIndex || '';
  const n = parseInt(raw, 10);
  if (!Number.isNaN(n)) return n;
  return el.id === 'screenshare-stage' ? 6 : 5;
}

const FPS = 30;
const FRAME_INTERVAL_MS = 1000 / FPS;
const FLOOR_BG = '#1a1d24';

export class SceneCompositor {
  private canvas = document.createElement('canvas');
  private ctx: CanvasRenderingContext2D;
  private stream: MediaStream | null = null;
  private raf = 0;
  private running = false;
  private lastDrawMs = 0;
  private width = 0;
  private height = 0;

  constructor(private floorCanvas: HTMLCanvasElement) {
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('2d context not available');
    this.ctx = ctx;
  }

  get active() {
    return this.running;
  }

  // Begin compositing and return a 30fps capture stream of the scene. The
  // resolution is fixed to the current viewport size for the whole recording.
  start(): MediaStream {
    this.width = Math.max(2, Math.floor(window.innerWidth));
    this.height = Math.max(2, Math.floor(window.innerHeight));
    this.canvas.width = this.width;
    this.canvas.height = this.height;
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
    const { ctx, width: w, height: h } = this;
    ctx.fillStyle = FLOOR_BG;
    ctx.fillRect(0, 0, w, h);

    // Floor: reuse the already-rendered main canvas (no second world render).
    if (this.floorCanvas.width > 0 && this.floorCanvas.height > 0) {
      ctx.drawImage(this.floorCanvas, 0, 0, w, h);
    }

    for (const panel of this.collectPanels()) this.drawPanel(panel);
  }

  // Visible `.panel` windows (self preview, screenshare, remote cameras),
  // sorted back-to-front by stacking order so the composite matches the DOM.
  // Toolbar / HUD / preset buttons are not `.panel`s, so they are excluded.
  private collectPanels(): HTMLElement[] {
    const panels = Array.from(
      document.querySelectorAll<HTMLElement>('.panel'),
    ).filter((el) => el.offsetParent !== null);
    const domOrder = new Map<HTMLElement, number>();
    panels.forEach((el, i) => domOrder.set(el, i));
    return panels.sort((a, b) => {
      const za = panelZIndex(a);
      const zb = panelZIndex(b);
      if (za !== zb) return za - zb;
      return domOrder.get(a)! - domOrder.get(b)!;
    });
  }

  private drawPanel(panel: HTMLElement) {
    const body = panel.querySelector<HTMLElement>('.panel-body');
    if (!body) return;
    const r = body.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return;
    const ctx = this.ctx;

    ctx.fillStyle = '#000';
    ctx.fillRect(r.left, r.top, r.width, r.height);

    const video = panel.querySelector('video') as HTMLVideoElement | null;
    const hasFrame = !!video && video.readyState >= 2 && video.videoWidth > 0;
    if (hasFrame && video) {
      const fit: ObjectFit =
        getComputedStyle(video).objectFit === 'contain' ? 'contain' : 'cover';
      this.drawVideo(video, r, fit, panel.id === 'self-preview');
    } else {
      this.drawPlaceholder(panel, r);
    }

    this.drawLabel(panel, r);
  }

  private drawVideo(
    video: HTMLVideoElement,
    box: DOMRect,
    fit: ObjectFit,
    mirror: boolean,
  ) {
    const { ctx } = this;
    const d = fitRect(
      video.videoWidth,
      video.videoHeight,
      box.left,
      box.top,
      box.width,
      box.height,
      fit,
    );
    ctx.save();
    ctx.beginPath();
    ctx.rect(box.left, box.top, box.width, box.height);
    ctx.clip();
    if (mirror) {
      // Flip horizontally within the box so the self preview reads as a mirror.
      ctx.translate(2 * box.left + box.width, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(video, d.x, d.y, d.w, d.h);
    ctx.restore();
  }

  private drawPlaceholder(panel: HTMLElement, box: DOMRect) {
    const { ctx } = this;
    ctx.fillStyle = '#1a1d24';
    ctx.fillRect(box.left, box.top, box.width, box.height);

    const cx = box.left + box.width / 2;
    const cy = box.top + box.height / 2;
    const initials = panel.querySelector('.no-video-initials')?.textContent ?? '';
    const name = panel.querySelector('.no-video-name')?.textContent ?? '';

    const radius = Math.min(28, box.width / 4, box.height / 4);
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

  // Name badge in the panel's top-left corner — the only chrome we reproduce.
  private drawLabel(panel: HTMLElement, box: DOMRect) {
    const text = panel.querySelector('.panel-header .label')?.textContent?.trim();
    if (!text) return;
    const { ctx } = this;
    ctx.font = '12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const padX = 6;
    const w = ctx.measureText(text).width + padX * 2;
    const h = 18;
    const x = box.left + 6;
    const y = box.top + 6;
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
