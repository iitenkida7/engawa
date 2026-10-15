// Persistent "you are recording" indicator (issue #315).
//
// Recording happens inside this browser (media/recorder.ts): the file is only
// downloaded when the user presses stop, so closing the tab mid-recording
// loses it. The native beforeunload prompt can't say that (its text is
// browser-controlled), so this pill at the top of the screen keeps the
// recording state, its elapsed time and the "stop to save" hint in view, and
// the tab title carries a "● REC" prefix so the state is visible from the tab
// strip / window title as well.

import { t } from '@/core/i18n';

// Format an elapsed duration as m:ss, or h:mm:ss once it passes an hour.
export function formatRecDuration(elapsedMs: number): string {
  const total = Math.max(0, Math.floor(elapsedMs / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

// Tab title while recording: the REC prefix goes first so it survives the
// truncation of narrow tabs.
export function recordingTitle(baseTitle: string, elapsedMs: number): string {
  return `● REC ${formatRecDuration(elapsedMs)} · ${baseTitle}`;
}

export class RecIndicator {
  private el: HTMLDivElement | null = null;
  private timeEl: HTMLSpanElement | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private startedAt = 0;
  private baseTitle = '';
  private now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.now = now;
  }

  get visible() {
    return this.el !== null;
  }

  // Show the pill (idempotent) and start ticking the elapsed time once a second.
  show(startedAt: number) {
    if (this.el) return;
    this.startedAt = startedAt;
    this.baseTitle = document.title;

    const el = document.createElement('div');
    el.id = 'rec-indicator';
    el.setAttribute('role', 'status');

    const dot = document.createElement('span');
    dot.className = 'rec-indicator-dot';
    dot.setAttribute('aria-hidden', 'true');
    el.appendChild(dot);

    const label = document.createElement('span');
    label.className = 'rec-indicator-label';
    label.textContent = t('rec.indicator');
    el.appendChild(label);

    const time = document.createElement('span');
    time.className = 'rec-indicator-time';
    el.appendChild(time);

    const hint = document.createElement('span');
    hint.className = 'rec-indicator-hint';
    hint.textContent = t('rec.indicatorHint');
    el.appendChild(hint);

    document.body.appendChild(el);
    this.el = el;
    this.timeEl = time;

    this.tick();
    this.timer = setInterval(() => this.tick(), 1000);
  }

  // Remove the pill and restore the tab title.
  hide() {
    if (!this.el) return;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.el.remove();
    this.el = null;
    this.timeEl = null;
    document.title = this.baseTitle;
  }

  private tick() {
    if (!this.timeEl) return;
    const elapsed = this.now() - this.startedAt;
    this.timeEl.textContent = formatRecDuration(elapsed);
    document.title = recordingTitle(this.baseTitle, elapsed);
  }
}
