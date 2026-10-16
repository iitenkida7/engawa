import { t } from '@/core/i18n';
import { exportNetLog, netLogEntries } from '@/core/netlog';
import type { GroupMethod } from '@/core/types';
import {
  attributeBlame,
  type ConnDiag,
  describeVerdict,
  diagnoseConns,
  formatDiagReport,
  summarizeTierHistory,
} from '@/rtc/diag';
import type { NetTier } from '@/rtc/netquality';
import { describeStream, type RtcConn, type RtcStreamRate } from '@/rtc/rtcstats';
import { SFU_UPSTREAM_ID } from '@/rtc/sfu';
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
// On top of the raw rows it grades each connection (rtc/diag.ts: verdict,
// reasons, "whose side is it?"), keeps a 60s per-connection tier strip so a
// flapping link is visible, and copies a Markdown report meant to be pasted into
// Claude for analysis.
//
// Peer names come from external input, so every label is set via textContent
// (never innerHTML) to avoid injection.
type Diag = { conn: RtcConn; diag: ConnDiag };

// Seconds of per-connection tier history shown as the colored strip.
const HISTORY_LEN = 60;

export class DebugConsole {
  private root: HTMLElement;
  private body: HTMLElement;
  private timer: ReturnType<typeof setInterval> | null = null;
  private collect: () => Promise<{ method: GroupMethod; conns: RtcConn[] }>;
  private resolveName: (id: string) => string;
  private history = new Map<string, NetTier[]>();
  private last: { method: GroupMethod; diags: Diag[] } | null = null;

  constructor(opts: {
    collect: () => Promise<{ method: GroupMethod; conns: RtcConn[] }>;
    resolveName: (id: string) => string;
  }) {
    this.collect = opts.collect;
    this.resolveName = opts.resolveName;
    this.root = document.getElementById('debug-console') as HTMLElement;
    this.body = document.getElementById('debug-body') as HTMLElement;

    const closeBtn = document.getElementById('debug-close');
    closeBtn?.addEventListener('click', () => this.close());
    // Draggable by its header (the only remaining draggable panel — the media
    // windows became fixed auto-layout in #175). The CSS keeps the initial
    // top-right placement; makeDraggable switches it to inline left/top on the
    // first drag. Its high CSS z-index keeps it above the call wherever it moves.
    const header = document.getElementById('debug-header');
    if (header) makeDraggable(this.root, { handle: header });

    // Copy the connection log (issue #182) so it can be pasted into a bug
    // report. Button flashes ✓/✗ as its own feedback — no toast dependency.
    const copyBtn = document.createElement('button');
    copyBtn.id = 'debug-copy-log';
    copyBtn.title = t('debug.copyLog');
    copyBtn.textContent = '📋';
    const flash = (mark: string) => {
      copyBtn.textContent = mark;
      setTimeout(() => {
        copyBtn.textContent = '📋';
      }, 1200);
    };
    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(exportNetLog()).then(
        () => flash('✓'),
        () => flash('✗'),
      );
    });
    if (header && closeBtn) header.insertBefore(copyBtn, closeBtn);

    // Copy the diagnosis report (Markdown, Claude-ready). Same flash feedback.
    const reportBtn = document.createElement('button');
    reportBtn.id = 'debug-copy-report';
    reportBtn.title = t('debug.copyReport');
    reportBtn.textContent = '🩺';
    reportBtn.addEventListener('click', () => {
      this.buildReport()
        .then((text) => navigator.clipboard.writeText(text))
        .then(
          () => {
            reportBtn.textContent = '✓';
          },
          () => {
            reportBtn.textContent = '✗';
          },
        )
        .finally(() => {
          setTimeout(() => {
            reportBtn.textContent = '🩺';
          }, 1200);
        });
    });
    if (header && closeBtn) header.insertBefore(reportBtn, copyBtn);
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
    this.history.clear();
    this.last = null;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async refresh() {
    const { method, conns } = await this.collect();
    const diags = diagnoseConns(conns, this.resolveName, SFU_UPSTREAM_ID);
    this.recordHistory(diags);
    this.last = { method, diags };
    this.render(method, diags);
  }

  // Per-connection tier history (1 sample per refresh), so a link that flaps
  // reads as "unstable" even when this second happens to look fine. Only kept
  // while the console is open; ids that went away are dropped.
  private recordHistory(diags: Diag[]) {
    const seen = new Set<string>();
    for (const { conn, diag } of diags) {
      seen.add(conn.id);
      const h = this.history.get(conn.id) ?? [];
      h.push(diag.verdict.tier);
      if (h.length > HISTORY_LEN) h.splice(0, h.length - HISTORY_LEN);
      this.history.set(conn.id, h);
    }
    for (const id of this.history.keys()) if (!seen.has(id)) this.history.delete(id);
  }

  // The Claude-ready Markdown report (rtc/diag.ts): verdicts + raw numbers +
  // the last 10 minutes of quality samples and connection events.
  private async buildReport(): Promise<string> {
    if (!this.last) await this.refresh();
    const last = this.last ?? { method: 'mesh' as GroupMethod, diags: [] };
    const nav = navigator as Navigator & {
      deviceMemory?: number;
      connection?: { effectiveType?: string; downlink?: number; rtt?: number };
    };
    return formatDiagReport({
      now: Date.now(),
      userAgent: nav.userAgent,
      env: {
        'CPU コア数': nav.hardwareConcurrency,
        'メモリ(GB)': nav.deviceMemory,
        ブラウザ推定回線: nav.connection?.effectiveType,
        'ブラウザ推定下り(Mbps)': nav.connection?.downlink,
        'ブラウザ推定RTT(ms)': nav.connection?.rtt,
        タブ表示: document.visibilityState,
      },
      method: last.method,
      conns: last.diags.map((d) => ({
        ...d,
        history: summarizeTierHistory(this.history.get(d.conn.id) ?? []),
      })),
      blame: attributeBlame(last.diags.map((d) => d.diag)),
      log: netLogEntries(),
    });
  }

  private render(method: GroupMethod, diags: Diag[]) {
    this.body.replaceChildren();

    const summary = document.createElement('div');
    summary.className = 'debug-summary';
    const badge = document.createElement('span');
    badge.className = `debug-badge debug-badge-${method}`;
    badge.textContent = method === 'sfu' ? 'SFU' : t('debug.mesh');
    summary.appendChild(badge);
    const count = document.createElement('span');
    count.textContent = t('debug.connections', { n: diags.length });
    summary.appendChild(count);
    this.body.appendChild(summary);

    if (diags.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'debug-empty';
      empty.textContent = t('debug.noConnections');
      this.body.appendChild(empty);
      return;
    }

    // "Whose side is it?" — the conclusion first, raw numbers below.
    const worst = diags[0].diag.verdict.tier;
    const blame = document.createElement('div');
    blame.className = `debug-blame q${worst}`;
    for (const line of attributeBlame(diags.map((d) => d.diag))) {
      const li = document.createElement('div');
      li.textContent = line;
      blame.appendChild(li);
    }
    this.body.appendChild(blame);

    for (const d of diags) this.body.appendChild(this.renderConn(d));
  }

  private renderConn({ conn, diag }: Diag): HTMLElement {
    const v = diag.verdict;
    const tiers = this.history.get(conn.id) ?? [];
    const card = document.createElement('div');
    card.className = `debug-conn q${v.tier}`;

    const head = document.createElement('div');
    head.className = 'debug-conn-head';
    const name = document.createElement('span');
    name.className = 'debug-conn-name';
    name.textContent = diag.name;
    head.appendChild(name);
    const verdict = document.createElement('span');
    verdict.className = `debug-verdict q${v.tier}`;
    verdict.textContent = describeVerdict(v.tier, summarizeTierHistory(tiers));
    head.appendChild(verdict);
    card.appendChild(head);

    const meta = [
      conn.rttMs !== undefined ? `RTT ${conn.rttMs}ms` : '',
      conn.transport ?? '',
      conn.availableOutgoingKbps !== undefined
        ? `${t('debug.avail')} ${conn.availableOutgoingKbps}kbps`
        : '',
    ].filter(Boolean);
    if (meta.length) this.appendLine(card, 'debug-rtt', meta.join(' · '));
    if (v.reasons.length) this.appendLine(card, 'debug-reasons', `⚠ ${v.reasons.join(' / ')}`);
    if (v.notes.length) this.appendLine(card, 'debug-notes', v.notes.join(' / '));

    // One colored cell per second over the last minute: green = good … red = bad.
    const strip = document.createElement('div');
    strip.className = 'debug-history';
    strip.title = t('debug.history');
    for (let i = tiers.length; i < HISTORY_LEN; i++) strip.appendChild(document.createElement('i'));
    for (const tier of tiers) {
      const c = document.createElement('i');
      c.className = `q${tier}`;
      strip.appendChild(c);
    }
    card.appendChild(strip);

    if (conn.streams.length === 0)
      this.appendLine(card, 'debug-stream-empty', t('debug.noStreams'));
    for (const s of conn.streams) card.appendChild(this.renderStream(s));
    return card;
  }

  private appendLine(parent: HTMLElement, cls: string, text: string) {
    const el = document.createElement('div');
    el.className = cls;
    el.textContent = text;
    parent.appendChild(el);
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
