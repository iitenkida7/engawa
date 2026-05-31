import { makeDraggable } from '@/ui/draggable';
import { describeStream, type RtcConn, type RtcStreamRate } from '@/rtc/rtcstats';
import type { GroupMethod } from '@/core/types';

// The debug console modal: a panel toggled from the toolbar's "⋯" overflow menu
// that lists, once a second, the WebRTC connections of the active transport
// (mesh or SFU) with their per-stream send/recv bitrate, codec, resolution,
// fps, RTT, loss and jitter. It replaces the old `?debug=rtc` console logging —
// anyone can open it from the overflow menu. All stat math lives in rtcstats.ts
// (pure, tested); this is a thin renderer. It only polls while open, so a closed
// console costs nothing.
//
// It owns no toolbar button: the overflow menu drives it through the public
// toggle()/isOpen() (wired by App), keeping the toolbar transport-agnostic.
//
// Peer names come from external input, so every label is set via textContent
// (never innerHTML) to avoid injection.
export class DebugConsole {
  private root: HTMLElement;
  private body: HTMLElement;
  private timer: ReturnType<typeof setInterval> | null = null;
  private collect: () => Promise<{ method: GroupMethod; conns: RtcConn[] }>;
  private resolveName: (id: string) => string;

  constructor(opts: {
    collect: () => Promise<{ method: GroupMethod; conns: RtcConn[] }>;
    resolveName: (id: string) => string;
  }) {
    this.collect = opts.collect;
    this.resolveName = opts.resolveName;
    this.root = document.getElementById('debug-console') as HTMLElement;
    this.body = document.getElementById('debug-body') as HTMLElement;

    document.getElementById('debug-close')?.addEventListener('click', () => this.close());
    // Draggable by its header, like the screenshare/preview panels. The CSS keeps
    // the initial top-right placement; makeDraggable normalizes it to left/top on
    // the first drag. The console keeps its high z-index (no bringToFront), so it
    // stays above the call regardless of where it's moved.
    const header = document.getElementById('debug-header');
    if (header) makeDraggable(this.root, { handle: header });
  }

  isOpen(): boolean {
    return !this.root.classList.contains('hidden');
  }

  toggle() {
    if (this.root.classList.contains('hidden')) this.open();
    else this.close();
  }

  private open() {
    this.root.classList.remove('hidden');
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), 1000);
  }

  private close() {
    this.root.classList.add('hidden');
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async refresh() {
    const { method, conns } = await this.collect();
    this.render(method, conns);
  }

  private render(method: GroupMethod, conns: RtcConn[]) {
    this.body.replaceChildren();

    const summary = document.createElement('div');
    summary.className = 'debug-summary';
    const badge = document.createElement('span');
    badge.className = `debug-badge debug-badge-${method}`;
    badge.textContent = method === 'sfu' ? 'SFU' : 'メッシュ';
    summary.appendChild(badge);
    const count = document.createElement('span');
    count.textContent = `接続 ${conns.length}`;
    summary.appendChild(count);
    this.body.appendChild(summary);

    if (conns.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'debug-empty';
      empty.textContent = '接続はありません（近くに誰かがいると表示されます）';
      this.body.appendChild(empty);
      return;
    }

    for (const conn of conns) {
      this.body.appendChild(this.renderConn(conn));
    }
  }

  private renderConn(conn: RtcConn): HTMLElement {
    const card = document.createElement('div');
    card.className = 'debug-conn';

    const head = document.createElement('div');
    head.className = 'debug-conn-head';
    const name = document.createElement('span');
    name.className = 'debug-conn-name';
    // label wins (SFU synthetic entries), then the resolved peer name, then a
    // truncated id for a peer we don't have in the roster yet.
    name.textContent = conn.label ?? (this.resolveName(conn.id) || conn.id.slice(0, 8));
    head.appendChild(name);
    if (conn.rttMs !== undefined) {
      const rtt = document.createElement('span');
      rtt.className = 'debug-rtt';
      rtt.textContent = `RTT ${conn.rttMs}ms`;
      head.appendChild(rtt);
    }
    card.appendChild(head);

    if (conn.streams.length === 0) {
      const idle = document.createElement('div');
      idle.className = 'debug-stream-empty';
      idle.textContent = 'ストリームなし';
      card.appendChild(idle);
    }
    for (const s of conn.streams) {
      card.appendChild(this.renderStream(s));
    }
    return card;
  }

  private renderStream(s: RtcStreamRate): HTMLElement {
    const row = document.createElement('div');
    row.className = `debug-stream debug-stream-${s.dir}`;
    const tag = document.createElement('span');
    tag.className = 'debug-stream-tag';
    const arrow = s.dir === 'send' ? '⬆' : '⬇';
    const icon = s.kind === 'audio' ? '🎤' : '🎥';
    tag.textContent = `${arrow}${icon}`;
    row.appendChild(tag);
    const detail = document.createElement('span');
    detail.className = 'debug-stream-detail';
    detail.textContent = describeStream(s).join(' · ');
    row.appendChild(detail);
    return row;
  }
}
