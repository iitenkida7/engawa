import type { GroupMethod } from '@/core/types';
import { describeStream, type RtcConn, type RtcStreamRate } from '@/rtc/rtcstats';
import { el } from '@/ui/dom';
import { makeDraggable } from '@/ui/draggable';

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

    this.body.appendChild(
      el('div', { className: 'debug-summary' }, [
        el('span', {
          className: `debug-badge debug-badge-${method}`,
          textContent: method === 'sfu' ? 'SFU' : 'メッシュ',
        }),
        el('span', { textContent: `接続 ${conns.length}` }),
      ]),
    );

    if (conns.length === 0) {
      this.body.appendChild(
        el('div', {
          className: 'debug-empty',
          textContent: '接続はありません（近くに誰かがいると表示されます）',
        }),
      );
      return;
    }

    for (const conn of conns) {
      this.body.appendChild(this.renderConn(conn));
    }
  }

  private renderConn(conn: RtcConn): HTMLElement {
    const head = el('div', { className: 'debug-conn-head' }, [
      el('span', {
        className: 'debug-conn-name',
        // label wins (SFU synthetic entries), then the resolved peer name, then a
        // truncated id for a peer we don't have in the roster yet.
        textContent: conn.label ?? (this.resolveName(conn.id) || conn.id.slice(0, 8)),
      }),
    ]);
    if (conn.rttMs !== undefined) {
      head.appendChild(el('span', { className: 'debug-rtt', textContent: `RTT ${conn.rttMs}ms` }));
    }
    if (conn.transport) {
      head.appendChild(el('span', { className: 'debug-rtt', textContent: conn.transport }));
    }

    const card = el('div', { className: 'debug-conn' }, [head]);
    if (conn.streams.length === 0) {
      card.appendChild(
        el('div', { className: 'debug-stream-empty', textContent: 'ストリームなし' }),
      );
    }
    for (const s of conn.streams) {
      card.appendChild(this.renderStream(s));
    }
    return card;
  }

  private renderStream(s: RtcStreamRate): HTMLElement {
    const arrow = s.dir === 'send' ? '⬆' : '⬇';
    const icon = s.kind === 'audio' ? '🎤' : '🎥';
    return el('div', { className: `debug-stream debug-stream-${s.dir}` }, [
      el('span', { className: 'debug-stream-tag', textContent: `${arrow}${icon}` }),
      el('span', { className: 'debug-stream-detail', textContent: describeStream(s).join(' · ') }),
    ]);
  }
}
