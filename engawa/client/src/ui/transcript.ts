// The meeting transcript panel: a running log of who said what, filled by our
// own transcriber (media/transcriber.ts) and by the lines peers share over the
// WebSocket.
//
// Text arrives from other people, so every label is written with textContent,
// never innerHTML — the same rule ui/debug-console.ts follows for peer names.
//
// The formatting helpers are pure and unit-tested; the class is a thin
// renderer over them.

import { getLang, t } from '@/core/i18n';
import { makeDraggable } from '@/ui/draggable';
import { canSummarize, summarize, toSummaryInput } from '@/ui/transcript-summary';

export type TranscriptEntry = {
  speakerId: string;
  // Resolved when the line arrives: userIds are per-connection, so a name
  // looked up later would be wrong (or gone) for anyone who has left.
  speakerName: string;
  text: string;
  at: number;
};

// Lines kept in the panel. A long meeting is still only a few hundred lines, and
// trimming keeps the DOM from growing without bound.
export const TRANSCRIPT_MAX_ENTRIES = 1_000;

// Pure: wall-clock HH:MM:SS for one line.
export function formatClock(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// Lines from the same speaker within this gap stack under one name header,
// like consecutive messages in a chat app.
export const TRANSCRIPT_GROUP_GAP_MS = 60_000;

// Pure: whether `entry` continues the previous line's speech bubble group
// (same speaker, close in time), so its name/time header can be omitted.
export function continuesGroup(prev: TranscriptEntry | undefined, entry: TranscriptEntry): boolean {
  return (
    prev !== undefined &&
    prev.speakerId === entry.speakerId &&
    entry.at - prev.at < TRANSCRIPT_GROUP_GAP_MS
  );
}

// One transcription run. Each start opens a new one; older runs stay in memory
// (listed from the toolbar's ▾) until deleted or the page reloads.
export type TranscriptSession = {
  id: number;
  startedAt: number;
  entries: TranscriptEntry[];
};

// Pure: how a session is listed in the toolbar menu — start time and size.
export function sessionLabel(session: TranscriptSession): string {
  return t('transcript.sessionLabel', {
    time: formatClock(session.startedAt).slice(0, 5),
    n: session.entries.length,
  });
}

// Pure: the whole transcript as plain text, for copying or saving.
export function toPlainText(entries: TranscriptEntry[]): string {
  return entries.map((e) => `[${formatClock(e.at)}] ${e.speakerName}: ${e.text}`).join('\n');
}

export class TranscriptPanel {
  private root: HTMLElement;
  private body: HTMLElement;
  private title: HTMLElement;
  private sessions: TranscriptSession[] = [];
  private nextId = 1;
  // The session new lines go to, and the one on screen. They differ when an
  // older transcript is reopened while a new one is still filling.
  private live: TranscriptSession | null = null;
  private shown: TranscriptSession | null = null;
  // On-device summary (ui/transcript-summary.ts), shown in its own area above
  // the lines — it never replaces or edits the transcript itself.
  private summary: HTMLElement;
  private summaryBody: HTMLElement;
  private summarizing = false;

  constructor() {
    this.root = document.getElementById('transcript') as HTMLElement;
    this.body = document.getElementById('transcript-body') as HTMLElement;
    this.summary = document.getElementById('transcript-summary') as HTMLElement;
    this.summaryBody = document.getElementById('transcript-summary-body') as HTMLElement;
    this.title = document.getElementById('transcript-title') as HTMLElement;

    // ✕ deletes the transcript on screen (it is only in memory, so it is gone
    // for good — hence the confirm). It does NOT stop the transcription; the
    // person who started it stops it from the toolbar.
    const closeBtn = document.getElementById('transcript-close');
    closeBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.shown && window.confirm(t('transcript.deleteConfirm'))) this.remove(this.shown.id);
    });
    const header = document.getElementById('transcript-header');
    if (header) makeDraggable(this.root, { handle: header });

    // – puts the panel away without losing anything; reopen it from the
    // toolbar's ▾ list.
    const minBtn = document.createElement('button');
    minBtn.id = 'transcript-minimize';
    minBtn.className = 'transcript-action';
    minBtn.title = t('transcript.minimize');
    minBtn.textContent = '–';
    minBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.close();
    });
    if (header && closeBtn) header.insertBefore(minBtn, closeBtn);

    // Copy / save, with the button flashing its own ✓/✗ feedback (no toast
    // dependency), mirroring the debug console's copy buttons.
    const copyBtn = this.makeHeaderButton('📋', t('transcript.copy'), () =>
      navigator.clipboard.writeText(toPlainText(this.entries)),
    );
    const saveBtn = this.makeHeaderButton('💾', t('transcript.save'), async () => this.download());
    if (header && closeBtn) {
      header.insertBefore(saveBtn, closeBtn);
      header.insertBefore(copyBtn, saveBtn);
    }

    // Summary button, only where Chrome's on-device model can run.
    const summarizeBtn = document.createElement('button');
    summarizeBtn.className = 'transcript-action';
    summarizeBtn.title = t('transcript.summarize');
    summarizeBtn.textContent = '✨';
    summarizeBtn.addEventListener('click', () => void this.runSummary());
    void canSummarize(getLang()).then((ok) => {
      if (ok && header) header.insertBefore(summarizeBtn, copyBtn);
    });

    document.getElementById('transcript-summary-close')?.addEventListener('click', () => {
      this.summary.classList.add('hidden');
      this.root.classList.remove('has-summary');
    });
    const summaryCopy = document.getElementById('transcript-summary-copy');
    summaryCopy?.addEventListener('click', () => {
      navigator.clipboard.writeText(this.summaryBody.textContent ?? '').then(
        () => this.flash(summaryCopy as HTMLButtonElement, '📋', '✓'),
        () => this.flash(summaryCopy as HTMLButtonElement, '📋', '✗'),
      );
    });
  }

  isOpen(): boolean {
    return !this.root.classList.contains('hidden');
  }

  open() {
    this.root.classList.remove('hidden');
    this.scrollToBottom();
  }

  close() {
    this.root.classList.add('hidden');
  }

  // Kept transcripts, newest first, for the toolbar's ▾ list.
  list(): TranscriptSession[] {
    return [...this.sessions].reverse();
  }

  shownId(): number | null {
    return this.shown?.id ?? null;
  }

  // A transcription run started (ours or a peer's): new lines go to a fresh,
  // empty transcript, which opens on screen. Earlier ones stay in the list.
  startNew(at = Date.now()) {
    this.live = { id: this.nextId++, startedAt: at, entries: [] };
    this.sessions.push(this.live);
    this.show(this.live.id);
  }

  // Open a kept transcript.
  show(id: number) {
    const session = this.sessions.find((s) => s.id === id);
    if (!session) return;
    this.shown = session;
    this.title.textContent = `${t('transcript.title')} ${formatClock(session.startedAt).slice(0, 5)}`;
    this.body.replaceChildren(
      ...session.entries.map((e, i) =>
        this.renderRow(e, continuesGroup(session.entries[i - 1], e)),
      ),
    );
    this.summaryBody.textContent = '';
    this.summary.classList.add('hidden');
    this.root.classList.remove('has-summary');
    this.open();
  }

  // Delete a transcript for good and put the panel away if it was on screen.
  remove(id: number) {
    this.sessions = this.sessions.filter((s) => s.id !== id);
    if (this.live?.id === id) this.live = null;
    if (this.shown?.id === id) {
      this.shown = null;
      this.body.replaceChildren();
      this.close();
    }
  }

  add(entry: TranscriptEntry) {
    // A line with no run in progress (we joined a call mid-transcription and
    // missed its start) still gets a transcript of its own.
    if (!this.live) {
      this.live = { id: this.nextId++, startedAt: entry.at, entries: [] };
      this.sessions.push(this.live);
      if (!this.shown) this.show(this.live.id);
    }
    const entries = this.live.entries;
    const prev = entries[entries.length - 1];
    entries.push(entry);
    const visible = this.live === this.shown;
    if (entries.length > TRANSCRIPT_MAX_ENTRIES) {
      entries.shift();
      if (visible) this.body.firstElementChild?.remove();
    }
    if (!visible) return;
    // Only follow the tail when the reader is already there, so scrolling back
    // to re-read something isn't yanked away by the next line.
    const atBottom = this.body.scrollHeight - this.body.scrollTop - this.body.clientHeight < 40;
    this.body.appendChild(this.renderRow(entry, continuesGroup(prev, entry)));
    if (atBottom) this.scrollToBottom();
  }

  // Lines of the transcript on screen (copy / save / summary act on it).
  private get entries(): TranscriptEntry[] {
    return this.shown?.entries ?? [];
  }

  // One line as a speech bubble under a "name  time" header; a continuation of
  // the same speaker's group drops the header so the bubbles stack.
  // Summarise everything so far into the summary area. Called from the click so
  // a first-time model download has the user activation it needs.
  private async runSummary() {
    if (this.summarizing) return;
    this.summary.classList.remove('hidden');
    this.root.classList.add('has-summary');
    if (this.entries.length === 0) {
      this.summaryBody.textContent = t('transcript.summaryEmpty');
      return;
    }
    this.summarizing = true;
    this.summaryBody.textContent = t('transcript.summarizing');
    try {
      const text = await summarize(toSummaryInput(this.entries), getLang(), (fraction) => {
        // Once the download completes the model starts summarising; say so
        // instead of leaving "100%" up for the whole run.
        this.summaryBody.textContent =
          fraction < 1
            ? t('transcript.summaryDownloading', { percent: Math.round(fraction * 100) })
            : t('transcript.summarizing');
      });
      this.summaryBody.textContent = text.trim();
    } catch (err) {
      this.summaryBody.textContent = t('transcript.summaryError', {
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.summarizing = false;
    }
  }

  private renderRow(entry: TranscriptEntry, continued: boolean): HTMLElement {
    const row = document.createElement('div');
    row.className = continued ? 'transcript-row continued' : 'transcript-row';
    if (!continued) {
      const meta = document.createElement('div');
      meta.className = 'transcript-meta';
      const who = document.createElement('span');
      who.className = 'transcript-who';
      who.textContent = entry.speakerName;
      const time = document.createElement('span');
      time.className = 'transcript-time';
      time.textContent = formatClock(entry.at);
      meta.append(who, time);
      row.append(meta);
    }
    const bubble = document.createElement('div');
    bubble.className = 'transcript-text';
    bubble.textContent = entry.text;
    // Hover shows the exact time even on header-less continuation bubbles.
    bubble.title = formatClock(entry.at);
    row.append(bubble);
    return row;
  }

  private makeHeaderButton(
    label: string,
    title: string,
    onClick: () => unknown,
  ): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.className = 'transcript-action';
    btn.title = title;
    btn.textContent = label;
    btn.addEventListener('click', () => {
      Promise.resolve(onClick()).then(
        () => this.flash(btn, label, '✓'),
        () => this.flash(btn, label, '✗'),
      );
    });
    return btn;
  }

  private flash(btn: HTMLButtonElement, label: string, mark: string) {
    btn.textContent = mark;
    setTimeout(() => {
      btn.textContent = label;
    }, 1200);
  }

  private download() {
    const blob = new Blob([toPlainText(this.entries)], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    a.href = url;
    a.download = `transcript-${ts}.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  private scrollToBottom() {
    this.body.scrollTop = this.body.scrollHeight;
  }
}
