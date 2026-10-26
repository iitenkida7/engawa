// Pointer and pen over a screenshare (request: point at things while sharing, and
// mark them up). Anyone watching a share — and the sharer, on their own stage —
// can show a pointer or draw; everyone in the call sees it, drawn on a transparent
// canvas laid over the shared picture.
//
// Marks are small `annotate` messages relayed to the call (nothing is stored, the
// media path is untouched), in 0–1 fractions of the shared frame
// (ui/annotate-logic.ts). Strokes hold for a few seconds and fade, laser-pen
// style, so there is nothing to clear and nothing a late joiner has to be shown.

import { t } from '@/core/i18n';
import type { AnnotateBody } from '@/core/types';
import {
  ANNOTATE_SEND_MS,
  capPoints,
  chunkPoints,
  contentRect,
  farEnough,
  flatToPoints,
  fromFrac,
  nextRedrawIn,
  POINTER_TTL_MS,
  type Pt,
  pointsToFlat,
  strokeAlpha,
  toFrac,
} from '@/ui/annotate-logic';

type Tool = 'off' | 'pointer' | 'pen';
type Peer = { name: string; color: string };
type Stroke = { pts: Pt[]; color: string; lastAt: number };

const PEN_WIDTH = 4;

export class ShareAnnotator {
  private readonly container: HTMLElement;
  private readonly body: HTMLElement;
  private readonly video: HTMLVideoElement;
  private readonly shareId: string;
  private readonly selfId: () => string;
  private readonly peer: (userId: string) => Peer;
  private readonly send: (m: AnnotateBody) => void;
  private readonly now: () => number;

  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly bar: HTMLElement;
  private readonly buttons = new Map<Tool, HTMLButtonElement>();
  private readonly observer: ResizeObserver | null;

  private tool: Tool = 'off';
  private readonly strokes = new Map<string, Stroke>();
  private readonly pointers = new Map<string, { pt: Pt; at: number }>();
  private raf = 0;
  // Wakes the loop when a still overlay next changes (a fade starts, a pointer
  // expires); see nextRedrawIn.
  private wake: ReturnType<typeof setTimeout> | null = null;

  // Our own stroke in progress: its id, and the points not yet sent.
  private myStrokeId: string | null = null;
  private pending: Pt[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private lastPointerSentAt = 0;
  private pointerShown = false;

  constructor(opts: {
    container: HTMLElement;
    body: HTMLElement;
    video: HTMLVideoElement;
    shareId: string;
    selfId: () => string;
    peer: (userId: string) => Peer;
    send: (m: AnnotateBody) => void;
    now?: () => number;
  }) {
    this.container = opts.container;
    this.body = opts.body;
    this.video = opts.video;
    this.shareId = opts.shareId;
    this.selfId = opts.selfId;
    this.peer = opts.peer;
    this.send = opts.send;
    this.now = opts.now ?? (() => performance.now());

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'annot-canvas';
    // No backing store until there is something to draw (see draw()).
    this.canvas.width = 0;
    this.canvas.height = 0;
    this.ctx = this.canvas.getContext('2d');
    this.body.appendChild(this.canvas);
    this.canvas.addEventListener('pointerdown', (e) => this.onDown(e));
    this.canvas.addEventListener('pointermove', (e) => this.onMove(e));
    this.canvas.addEventListener('pointerup', () => this.endStroke());
    this.canvas.addEventListener('pointercancel', () => this.endStroke());
    this.canvas.addEventListener('pointerleave', () => this.hideOwnPointer());
    // A mark must not also promote the stage to the featured share.
    this.canvas.addEventListener('click', (e) => e.stopPropagation());

    this.bar = document.createElement('div');
    this.bar.className = 'annot-bar';
    this.bar.addEventListener('click', (e) => e.stopPropagation());
    for (const [tool, label] of [
      ['pointer', t('annot.pointer')],
      ['pen', t('annot.pen')],
    ] as const) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'annot-btn';
      b.dataset.tool = tool;
      b.textContent = label;
      b.addEventListener('click', () => this.setTool(this.tool === tool ? 'off' : tool));
      this.buttons.set(tool, b);
      this.bar.appendChild(b);
    }
    this.container.appendChild(this.bar);

    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(() => {
        if (this.strokes.size > 0 || this.pointers.size > 0) this.kick();
      });
      observer.observe(this.body);
    }
    this.observer = observer;
  }

  dispose() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (this.wake) clearTimeout(this.wake);
    this.wake = null;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.observer?.disconnect();
    this.hideOwnPointer();
    this.canvas.remove();
    this.bar.remove();
  }

  private setTool(tool: Tool) {
    if (tool !== 'pen') this.endStroke();
    if (tool !== 'pointer') this.hideOwnPointer();
    this.tool = tool;
    this.canvas.classList.toggle('on', tool !== 'off');
    this.canvas.classList.toggle('pen', tool === 'pen');
    for (const [k, b] of this.buttons) b.classList.toggle('active', k === tool);
  }

  // ---- Our own marks ----

  private frameRect() {
    return contentRect(
      this.body.clientWidth,
      this.body.clientHeight,
      this.video.videoWidth,
      this.video.videoHeight,
    );
  }

  private frac(e: PointerEvent): Pt | null {
    const r = this.canvas.getBoundingClientRect();
    return toFrac(e.clientX - r.left, e.clientY - r.top, this.frameRect());
  }

  private onDown(e: PointerEvent) {
    if (e.button !== 0 || this.tool !== 'pen') return;
    const p = this.frac(e);
    if (!p) return;
    e.preventDefault();
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      /* the pointer may already be gone */
    }
    this.myStrokeId = Math.random().toString(36).slice(2, 10);
    this.pending = [p];
    this.strokes.set(this.key(this.selfId(), this.myStrokeId), {
      pts: [p],
      color: this.peer(this.selfId()).color,
      lastAt: this.now(),
    });
    this.scheduleFlush();
    this.kick();
  }

  private onMove(e: PointerEvent) {
    if (this.tool === 'pointer') {
      const p = this.frac(e);
      if (!p) {
        this.hideOwnPointer();
        return;
      }
      const t0 = this.now();
      if (t0 - this.lastPointerSentAt < ANNOTATE_SEND_MS) return;
      this.lastPointerSentAt = t0;
      this.pointerShown = true;
      this.send({ shareId: this.shareId, kind: 'pointer', x: p.x, y: p.y });
      return;
    }
    if (this.tool !== 'pen' || !this.myStrokeId) return;
    const p = this.frac(e);
    if (!p) return;
    const s = this.strokes.get(this.key(this.selfId(), this.myStrokeId));
    if (s) {
      const last = s.pts[s.pts.length - 1];
      if (last && !farEnough(last, p)) return;
      s.pts.push(p);
      capPoints(s.pts);
      s.lastAt = this.now();
    }
    this.pending.push(p);
    this.scheduleFlush();
    this.kick();
  }

  private hideOwnPointer() {
    if (!this.pointerShown) return;
    this.pointerShown = false;
    this.send({ shareId: this.shareId, kind: 'pointer', off: true });
  }

  private scheduleFlush() {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush(false);
    }, ANNOTATE_SEND_MS);
  }

  // Send the points gathered since the last flush. The last point stays as the
  // seed of the next chunk so the line stays joined at the seam.
  private flush(end: boolean) {
    const id = this.myStrokeId;
    if (!id || this.pending.length === 0) return;
    const chunks = chunkPoints(this.pending);
    chunks.forEach((chunk, i) => {
      this.send({
        shareId: this.shareId,
        kind: 'stroke',
        id,
        pts: pointsToFlat(chunk),
        end: end && i === chunks.length - 1,
      });
    });
    this.pending = [this.pending[this.pending.length - 1]];
  }

  private endStroke() {
    if (!this.myStrokeId) return;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.flush(true);
    this.myStrokeId = null;
    this.pending = [];
  }

  // ---- Everyone else's marks ----

  receive(from: string, m: AnnotateBody) {
    if (m.kind === 'pointer') {
      if (m.off || typeof m.x !== 'number' || typeof m.y !== 'number') {
        this.pointers.delete(from);
      } else {
        this.pointers.set(from, { pt: { x: m.x, y: m.y }, at: this.now() });
      }
    } else if (m.id && m.pts) {
      const k = this.key(from, m.id);
      let s = this.strokes.get(k);
      if (!s) {
        s = { pts: [], color: this.peer(from).color, lastAt: 0 };
        this.strokes.set(k, s);
      }
      s.pts.push(...flatToPoints(m.pts));
      capPoints(s.pts);
      s.lastAt = this.now();
    }
    this.kick();
  }

  private key(from: string, id: string) {
    return `${from}:${id}`;
  }

  // ---- Drawing ----

  // Redraw on the next frame. Called when something changed (a point arrived, the
  // box resized); in between, tick() only keeps animating while a stroke fades.
  private kick() {
    if (!this.raf) this.raf = requestAnimationFrame(() => this.tick());
  }

  private tick() {
    this.raf = 0;
    if (this.wake) clearTimeout(this.wake);
    this.wake = null;
    const now = this.now();
    const mine = this.myStrokeKey();
    for (const [k, s] of this.strokes) {
      if (k !== mine && strokeAlpha(now, s.lastAt) <= 0) this.strokes.delete(k);
    }
    for (const [from, p] of this.pointers) {
      if (now - p.at > POINTER_TTL_MS) this.pointers.delete(from);
    }
    this.draw(now);
    const ms = nextRedrawIn(
      now,
      // Still being drawn by us: never fades under the pen.
      [...this.strokes].map(([k, s]) => (k === mine ? now : s.lastAt)),
      [...this.pointers.values()].map((p) => p.at),
    );
    if (ms === null) return;
    if (ms === 0) this.kick();
    else
      this.wake = setTimeout(() => {
        this.wake = null;
        this.kick();
      }, ms);
  }

  private myStrokeKey() {
    return this.myStrokeId ? this.key(this.selfId(), this.myStrokeId) : null;
  }

  private draw(now: number) {
    const ctx = this.ctx;
    if (!ctx) return;
    // Nothing left: drop the backing store, so an idle overlay laid over the
    // video holds no stage-sized bitmap.
    if (this.strokes.size === 0 && this.pointers.size === 0) {
      if (this.canvas.width !== 0) {
        this.canvas.width = 0;
        this.canvas.height = 0;
      }
      return;
    }
    const w = this.body.clientWidth;
    const h = this.body.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    const pw = Math.max(1, Math.floor(w * dpr));
    const ph = Math.max(1, Math.floor(h * dpr));
    if (this.canvas.width !== pw || this.canvas.height !== ph) {
      this.canvas.width = pw;
      this.canvas.height = ph;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const rect = this.frameRect();
    const mine = this.myStrokeKey();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const [k, s] of this.strokes) {
      ctx.globalAlpha = k === mine ? 1 : strokeAlpha(now, s.lastAt);
      ctx.strokeStyle = s.color;
      ctx.fillStyle = s.color;
      ctx.lineWidth = PEN_WIDTH;
      const pts = s.pts.map((p) => fromFrac(p, rect));
      if (pts.length === 1) {
        ctx.beginPath();
        ctx.arc(pts[0].x, pts[0].y, PEN_WIDTH / 2, 0, Math.PI * 2);
        ctx.fill();
      } else if (pts.length > 1) {
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
    for (const [from, p] of this.pointers) this.drawPointer(ctx, from, fromFrac(p.pt, rect));
  }

  private drawPointer(ctx: CanvasRenderingContext2D, from: string, at: Pt) {
    const peer = this.peer(from);
    ctx.fillStyle = peer.color;
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(at.x, at.y, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    // Name tag, so several pointers on one slide can be told apart.
    ctx.font = '12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.textBaseline = 'middle';
    const label = peer.name;
    const tw = ctx.measureText(label).width + 10;
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.fillRect(at.x + 12, at.y - 9, tw, 18);
    ctx.fillStyle = '#fff';
    ctx.fillText(label, at.x + 17, at.y);
  }
}
