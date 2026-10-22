// Viewer-side zoom for a maximized screenshare stage (requested: a 4K share
// scaled down to 1920px and letterboxed into a window is too small to read).
// The pixels we receive are capped at 1920px long edge (rtc/cam-bitrate.ts), so
// zooming past 1× upsamples — it can't add detail — but it does make small text
// legible. Zoom is a local CSS transform on the <video>; it changes nothing
// about the stream, the layout or what is recorded.
//
// +/- buttons step the scale (chosen over wheel/pinch for discoverability); once
// zoomed in, dragging the video pans it. Only offered while the stage is
// maximized (.focused) — the small inline stage is too cramped to pan.

import { t } from '@/core/i18n';

export const SCREEN_ZOOM_MIN = 1;
export const SCREEN_ZOOM_MAX = 4;
export const SCREEN_ZOOM_STEP = 0.25;

// Clamp a scale into [MIN, MAX], rounded to whole percents so the label is tidy.
export function clampZoom(scale: number): number {
  if (Number.isNaN(scale)) return SCREEN_ZOOM_MIN;
  const rounded = Math.round(scale * 100) / 100;
  return Math.min(SCREEN_ZOOM_MAX, Math.max(SCREEN_ZOOM_MIN, rounded));
}

// Clamp a pan offset so the scaled video keeps covering its frame. With the
// transform origin at the centre, the content can slide at most half its extra
// size each way before an edge crosses the centre and a gap would show.
export function clampPan(
  tx: number,
  ty: number,
  scale: number,
  w: number,
  h: number,
): { tx: number; ty: number } {
  const maxX = Math.max(0, ((scale - 1) * w) / 2);
  const maxY = Math.max(0, ((scale - 1) * h) / 2);
  const clamp1 = (v: number, max: number) => Math.min(max, Math.max(-max, v));
  return { tx: clamp1(tx, maxX), ty: clamp1(ty, maxY) };
}

// Wires +/- zoom buttons and drag-to-pan onto one screenshare stage. The control
// bar only shows while the stage is `.focused` (CSS); leaving the maximized view
// resets the zoom so the small inline stage is never left scaled with no way to
// zoom back out (its buttons are hidden). Call dispose() when the stage dies.
export class ScreenZoom {
  private scale = SCREEN_ZOOM_MIN;
  private tx = 0;
  private ty = 0;
  private panned = false;
  private readonly bar: HTMLElement;
  private readonly pctEl: HTMLElement;
  private readonly outBtn: HTMLButtonElement;
  private readonly inBtn: HTMLButtonElement;
  private readonly observer: MutationObserver;
  private readonly disposers: Array<() => void> = [];

  constructor(
    private readonly container: HTMLElement,
    private readonly video: HTMLVideoElement,
  ) {
    this.bar = document.createElement('div');
    this.bar.className = 'screen-zoom';

    this.outBtn = this.makeButton('−', t('media.zoomOut'), () => this.zoomBy(-SCREEN_ZOOM_STEP));
    this.pctEl = document.createElement('span');
    this.pctEl.className = 'screen-zoom-pct';
    this.inBtn = this.makeButton('+', t('media.zoomIn'), () => this.zoomBy(SCREEN_ZOOM_STEP));
    this.bar.append(this.outBtn, this.pctEl, this.inBtn);
    // A click on the bar must not bubble to the stage (which would promote it to
    // the featured share).
    this.bar.addEventListener('click', (e) => e.stopPropagation());
    container.appendChild(this.bar);

    this.attachPan();

    // Reset when the stage stops being shown big: the bar is hidden then, so a
    // lingering zoom would be stuck. "Big" is either maximized (.focused, outside
    // meeting mode) or the featured meeting share (.meeting-main).
    this.observer = new MutationObserver(() => {
      if (!this.isBig() && this.scale !== SCREEN_ZOOM_MIN) this.reset();
    });
    this.observer.observe(container, { attributes: true, attributeFilter: ['class'] });

    this.apply();
  }

  dispose() {
    this.observer.disconnect();
    for (const d of this.disposers) d();
    this.bar.remove();
    this.video.style.transform = '';
    this.container.classList.remove('zoomed');
  }

  private isBig(): boolean {
    return (
      this.container.classList.contains('focused') ||
      this.container.classList.contains('meeting-main')
    );
  }

  private makeButton(label: string, title: string, onClick: () => void): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'screen-zoom-btn';
    btn.textContent = label;
    btn.title = title;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      onClick();
    });
    return btn;
  }

  private zoomBy(delta: number) {
    const next = clampZoom(this.scale + delta);
    if (next === this.scale) return;
    this.scale = next;
    if (this.scale === SCREEN_ZOOM_MIN) {
      this.tx = 0;
      this.ty = 0;
    } else {
      const r = this.video.getBoundingClientRect();
      ({ tx: this.tx, ty: this.ty } = clampPan(this.tx, this.ty, this.scale, r.width, r.height));
    }
    this.apply();
  }

  private reset() {
    this.scale = SCREEN_ZOOM_MIN;
    this.tx = 0;
    this.ty = 0;
    this.apply();
  }

  private apply() {
    this.video.style.transform = `translate(${this.tx}px, ${this.ty}px) scale(${this.scale})`;
    this.pctEl.textContent = `${Math.round(this.scale * 100)}%`;
    this.outBtn.disabled = this.scale <= SCREEN_ZOOM_MIN;
    this.inBtn.disabled = this.scale >= SCREEN_ZOOM_MAX;
    this.container.classList.toggle('zoomed', this.scale > SCREEN_ZOOM_MIN);
  }

  // Drag-to-pan while zoomed in. Pointer events cover mouse and touch; capture
  // keeps the drag alive if the pointer leaves the video.
  private attachPan() {
    let startX = 0;
    let startY = 0;
    let dragging = false;

    const onDown = (e: PointerEvent) => {
      if (this.scale <= SCREEN_ZOOM_MIN) return;
      dragging = true;
      this.panned = false;
      startX = e.clientX;
      startY = e.clientY;
      this.video.setPointerCapture(e.pointerId);
      e.stopPropagation();
      e.preventDefault();
    };
    const onMove = (e: PointerEvent) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      startX = e.clientX;
      startY = e.clientY;
      if (dx !== 0 || dy !== 0) this.panned = true;
      const r = this.video.getBoundingClientRect();
      ({ tx: this.tx, ty: this.ty } = clampPan(
        this.tx + dx,
        this.ty + dy,
        this.scale,
        r.width,
        r.height,
      ));
      this.apply();
    };
    const onUp = (e: PointerEvent) => {
      if (!dragging) return;
      dragging = false;
      try {
        this.video.releasePointerCapture(e.pointerId);
      } catch {
        /* capture may already be gone */
      }
    };
    // Swallow the click that follows a drag, so panning never also promotes the
    // stage to the featured share.
    const onClick = (e: MouseEvent) => {
      if (this.panned) {
        e.stopPropagation();
        this.panned = false;
      }
    };

    this.video.addEventListener('pointerdown', onDown);
    this.video.addEventListener('pointermove', onMove);
    this.video.addEventListener('pointerup', onUp);
    this.video.addEventListener('pointercancel', onUp);
    this.video.addEventListener('click', onClick);
    this.disposers.push(() => {
      this.video.removeEventListener('pointerdown', onDown);
      this.video.removeEventListener('pointermove', onMove);
      this.video.removeEventListener('pointerup', onUp);
      this.video.removeEventListener('pointercancel', onUp);
      this.video.removeEventListener('click', onClick);
    });
  }
}
