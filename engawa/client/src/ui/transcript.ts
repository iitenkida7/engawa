// The meeting transcript panel: a running log of who said what, filled by our
// own transcriber (media/transcriber.ts) and by the lines peers share over the
// WebSocket.
//
// Text arrives from other people, so every label is written with textContent,
// never innerHTML — the same rule ui/debug-console.ts follows for peer names.
//
// The formatting helpers are pure and unit-tested; the class is a thin
// renderer over them.

import { t } from '@/core/i18n';
import { makeDraggable } from '@/ui/draggable';

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

// Pure: the whole transcript as plain text, for copying or saving.
export function toPlainText(entries: TranscriptEntry[]): string {
  return entries.map((e) => `[${formatClock(e.at)}] ${e.speakerName}: ${e.text}`).join('\n');
}

export class TranscriptPanel {
  private root: HTMLElement;
  private body: HTMLElement;
  private entries: TranscriptEntry[] = [];

  constructor() {
    this.root = document.getElementById('transcript') as HTMLElement;
    this.body = document.getElementById('transcript-body') as HTMLElement;

    const closeBtn = document.getElementById('transcript-close');
    // Closing discards the log, and nothing here can tell whether it was saved
    // first — so ask, unless there is nothing to lose. Stopping the
    // transcription deliberately does NOT close the panel, so the text stays
    // around to be copied or saved after the meeting.
    closeBtn?.addEventListener('click', () => {
      if (this.entries.length > 0 && !confirm(t('transcript.confirmClose'))) return;
      this.clear();
      this.close();
    });
    const header = document.getElementById('transcript-header');
    if (header) makeDraggable(this.root, { handle: header });

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
  }

  isOpen(): boolean {
    return !this.root.classList.contains('hidden');
  }

  toggle() {
    if (this.isOpen()) this.close();
    else this.open();
  }

  open() {
    this.root.classList.remove('hidden');
    this.scrollToBottom();
  }

  close() {
    this.root.classList.add('hidden');
  }

  get count(): number {
    return this.entries.length;
  }

  add(entry: TranscriptEntry) {
    const prev = this.entries[this.entries.length - 1];
    this.entries.push(entry);
    if (this.entries.length > TRANSCRIPT_MAX_ENTRIES) {
      this.entries.shift();
      this.body.firstElementChild?.remove();
    }
    // Only follow the tail when the reader is already there, so scrolling back
    // to re-read something isn't yanked away by the next line.
    const atBottom = this.body.scrollHeight - this.body.scrollTop - this.body.clientHeight < 40;
    this.body.appendChild(this.renderRow(entry, continuesGroup(prev, entry)));
    if (atBottom) this.scrollToBottom();
  }

  clear() {
    this.entries = [];
    this.body.replaceChildren();
  }

  // One line as a speech bubble under a "name  time" header; a continuation of
  // the same speaker's group drops the header so the bubbles stack.
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
