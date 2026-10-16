import { t } from '@/core/i18n';
import {
  type StrokeStyle,
  strokeStyleFor,
  toCanvasPoint,
  WB_COLORS,
  WB_HEIGHT,
  WB_TEXT_SIZE,
  WB_WIDTH,
  type WbTool,
  whiteboardFileName,
} from '@/ui/whiteboard-logic';

type Stroke = { points: { x: number; y: number }[]; color: string; style: StrokeStyle };

// A whiteboard shared like a screen share: the presenter draws on a canvas and
// the canvas is captured as a video track that rides the existing 'screen'
// path (mesh / SFU), so viewers just see another screen-share stage and the
// server is untouched. Only the presenter can draw.
export class Whiteboard {
  private root: HTMLDivElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  // Everything drawn so far (white background + finished strokes/text). The
  // visible canvas is this plus the stroke in progress.
  private committed: HTMLCanvasElement | null = null;
  private stream: MediaStream | null = null;
  private keepalive: ReturnType<typeof setInterval> | null = null;
  private textInput: HTMLInputElement | null = null;
  private stroke: Stroke | null = null;
  private tool: WbTool = 'pen';
  private color: string = WB_COLORS[0];
  private toolButtons = new Map<WbTool, HTMLButtonElement>();
  private swatches = new Map<string, HTMLButtonElement>();

  private onClose: () => void;

  // onClose runs when the user presses ✕; the owner stops the share.
  constructor(onClose: () => void) {
    this.onClose = onClose;
  }

  get isOpen() {
    return this.root !== null;
  }

  // Show the board and return the stream to publish.
  open(): MediaStream {
    if (this.stream) return this.stream;
    this.buildDom();
    const canvas = this.canvas as HTMLCanvasElement;
    // 0 fps = frames only when we ask (requestFrame), so an idle board costs nothing.
    const stream = canvas.captureStream(0);
    const track = stream.getVideoTracks()[0];
    if (track) track.contentHint = 'detail';
    this.stream = stream;
    this.render();
    // A captured canvas only emits a frame when it changes, so someone who joins
    // the call later would see nothing until the next stroke. Re-send the
    // current frame periodically.
    this.keepalive = setInterval(() => this.pushFrame(), 1000);
    return stream;
  }

  close() {
    if (this.keepalive) clearInterval(this.keepalive);
    this.keepalive = null;
    this.root?.remove();
    this.root = null;
    this.canvas = null;
    this.ctx = null;
    this.committed = null;
    this.textInput = null;
    this.stroke = null;
    this.stream = null;
  }

  private pushFrame() {
    const track = this.stream?.getVideoTracks()[0] as
      | (MediaStreamTrack & { requestFrame?: () => void })
      | undefined;
    track?.requestFrame?.();
  }

  private render() {
    const ctx = this.ctx;
    if (!ctx || !this.committed) return;
    ctx.clearRect(0, 0, WB_WIDTH, WB_HEIGHT);
    ctx.drawImage(this.committed, 0, 0);
    if (this.stroke) this.drawStroke(ctx, this.stroke);
    this.pushFrame();
  }

  // One path per stroke (not per segment) so a translucent marker doesn't get
  // darker where its own segments overlap.
  private drawStroke(ctx: CanvasRenderingContext2D, s: Stroke) {
    ctx.save();
    ctx.globalAlpha = s.style.alpha;
    ctx.strokeStyle = s.color;
    ctx.fillStyle = s.color;
    ctx.lineWidth = s.style.width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const pts = s.points;
    if (pts.length === 1) {
      ctx.beginPath();
      ctx.arc(pts[0].x, pts[0].y, s.style.width / 2, 0, Math.PI * 2);
      ctx.fill();
    } else if (pts.length > 1) {
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length - 1; i++) {
        const mx = (pts[i].x + pts[i + 1].x) / 2;
        const my = (pts[i].y + pts[i + 1].y) / 2;
        ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
      }
      const last = pts[pts.length - 1];
      ctx.lineTo(last.x, last.y);
      ctx.stroke();
    }
    ctx.restore();
  }

  private point(e: PointerEvent) {
    const rect = (this.canvas as HTMLCanvasElement).getBoundingClientRect();
    return toCanvasPoint(e.clientX, e.clientY, rect);
  }

  private onPointerDown(e: PointerEvent) {
    if (e.button !== 0 || !this.canvas) return;
    const p = this.point(e);
    if (this.tool === 'text') {
      // Finish any text being typed, then start a new one here.
      this.commitText();
      this.startText(p.x, p.y);
      e.preventDefault();
      return;
    }
    this.commitText();
    this.canvas.setPointerCapture(e.pointerId);
    this.stroke = { points: [p], color: this.color, style: strokeStyleFor(this.tool) };
    this.render();
  }

  private onPointerMove(e: PointerEvent) {
    if (!this.stroke) return;
    this.stroke.points.push(this.point(e));
    this.render();
  }

  private onPointerUp() {
    if (!this.stroke) return;
    const cctx = this.committed?.getContext('2d');
    if (cctx) this.drawStroke(cctx, this.stroke);
    this.stroke = null;
    this.render();
  }

  private startText(x: number, y: number) {
    const canvas = this.canvas;
    if (!canvas || !canvas.parentElement) return;
    const rect = canvas.getBoundingClientRect();
    const scale = rect.width / WB_WIDTH;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'wb-text-input';
    input.dataset.x = String(x);
    input.dataset.y = String(y);
    input.style.left = `${x * scale}px`;
    input.style.top = `${y * scale}px`;
    input.style.fontSize = `${WB_TEXT_SIZE * scale}px`;
    input.style.color = this.color;
    input.addEventListener('keydown', (e) => {
      // Enter while composing confirms the IME conversion, not the text.
      if (e.isComposing) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        this.commitText();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.removeTextInput();
      }
    });
    canvas.parentElement.appendChild(input);
    this.textInput = input;
    input.focus();
  }

  private removeTextInput() {
    this.textInput?.remove();
    this.textInput = null;
  }

  // Bake the pending text into the board.
  private commitText() {
    const input = this.textInput;
    if (!input) return;
    const text = input.value;
    const x = Number(input.dataset.x);
    const y = Number(input.dataset.y);
    const color = input.style.color;
    this.removeTextInput();
    const cctx = this.committed?.getContext('2d');
    if (!cctx || text.trim() === '') return;
    cctx.save();
    cctx.fillStyle = color;
    cctx.font = `${WB_TEXT_SIZE}px sans-serif`;
    cctx.textBaseline = 'top';
    cctx.fillText(text, x, y);
    cctx.restore();
    this.render();
  }

  private clearAll() {
    this.commitText();
    const cctx = this.committed?.getContext('2d');
    if (!cctx) return;
    cctx.fillStyle = '#ffffff';
    cctx.fillRect(0, 0, WB_WIDTH, WB_HEIGHT);
    this.render();
  }

  private exportPng() {
    this.commitText();
    this.canvas?.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = whiteboardFileName(new Date());
      a.click();
      URL.revokeObjectURL(url);
    }, 'image/png');
  }

  private setTool(tool: WbTool) {
    this.commitText();
    this.tool = tool;
    for (const [k, btn] of this.toolButtons) btn.classList.toggle('active', k === tool);
    if (this.canvas) this.canvas.style.cursor = tool === 'text' ? 'text' : 'crosshair';
  }

  private setColor(color: string) {
    this.color = color;
    for (const [c, btn] of this.swatches) btn.classList.toggle('active', c === color);
    if (this.textInput) this.textInput.style.color = color;
  }

  private button(label: string, onClick: () => void, className = 'wb-btn') {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = className;
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  }

  private buildDom() {
    const root = document.createElement('div');
    root.id = 'whiteboard';

    const bar = document.createElement('div');
    bar.className = 'wb-bar';
    const tools: [WbTool, string][] = [
      ['pen', t('wb.pen')],
      ['marker', t('wb.marker')],
      ['text', t('wb.text')],
    ];
    for (const [tool, label] of tools) {
      const b = this.button(label, () => this.setTool(tool));
      this.toolButtons.set(tool, b);
      bar.appendChild(b);
    }
    const colors = document.createElement('div');
    colors.className = 'wb-colors';
    for (const c of WB_COLORS) {
      const b = this.button('', () => this.setColor(c), 'wb-swatch');
      b.style.background = c;
      b.setAttribute('aria-label', c);
      this.swatches.set(c, b);
      colors.appendChild(b);
    }
    bar.appendChild(colors);
    const spacer = document.createElement('span');
    spacer.className = 'wb-spacer';
    bar.appendChild(spacer);
    bar.appendChild(this.button(t('wb.clear'), () => this.clearAll()));
    bar.appendChild(this.button(t('wb.export'), () => this.exportPng()));
    bar.appendChild(this.button('✕', () => this.onClose(), 'wb-btn wb-close'));

    const stage = document.createElement('div');
    stage.className = 'wb-stage';
    const canvas = document.createElement('canvas');
    canvas.width = WB_WIDTH;
    canvas.height = WB_HEIGHT;
    canvas.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    canvas.addEventListener('pointermove', (e) => this.onPointerMove(e));
    canvas.addEventListener('pointerup', () => this.onPointerUp());
    canvas.addEventListener('pointercancel', () => this.onPointerUp());
    stage.appendChild(canvas);

    root.appendChild(bar);
    root.appendChild(stage);
    document.body.appendChild(root);

    const committed = document.createElement('canvas');
    committed.width = WB_WIDTH;
    committed.height = WB_HEIGHT;
    const cctx = committed.getContext('2d');
    if (cctx) {
      cctx.fillStyle = '#ffffff';
      cctx.fillRect(0, 0, WB_WIDTH, WB_HEIGHT);
    }

    this.root = root;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.committed = committed;
    this.setTool('pen');
    this.setColor(this.color);
  }
}
