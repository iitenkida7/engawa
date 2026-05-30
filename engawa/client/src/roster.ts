// The participant roster: a collapsible sidebar listing everyone in the
// workspace, self pinned first. Each row shows a color dot, name, status emoji,
// and mic/cam/screen icons, with a "speaking" highlight that tracks the shared
// players map. Clicking a row focuses that avatar on the map; the per-row →
// button walks self over to them (App wires both callbacks). This view owns the
// DOM that mirrors the players map; the App owns the map itself, mirroring the
// RemoteMediaView split.

import type { PlayerState } from './player';
import type { PlayerStatus } from './types';

// Status emoji shown in the roster. Unlike the canvas avatar badge, `online`
// gets an explicit 🟢 so every row carries a status indicator.
export const ROSTER_STATUS_EMOJI: Record<PlayerStatus, string> = {
  online: '🟢',
  busy: '🔴',
  away: '🟡',
  meeting: '🤝',
  break: '☕',
};

// Viewport width (px) at or below which the roster auto-collapses so it never
// eats the map on a phone-sized screen. Crossing the breakpoint drives the
// collapsed state; a manual toggle in between persists until the next crossing.
const NARROW_BREAKPOINT = 640;

// Pure: order players for the roster — self first, then the rest by name
// (case-insensitive, ties broken by userId for a stable order). Generic over
// anything with userId/name so it can be unit-tested with plain objects.
export function orderRoster<T extends { userId: string; name: string }>(
  players: Iterable<T>,
  myId: string,
): T[] {
  return [...players].sort((a, b) => {
    if (a.userId === myId) return b.userId === myId ? 0 : -1;
    if (b.userId === myId) return 1;
    const an = a.name.toLowerCase();
    const bn = b.name.toLowerCase();
    if (an !== bn) return an < bn ? -1 : 1;
    return a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0;
  });
}

type RosterRow = {
  el: HTMLDivElement;
  dot: HTMLSpanElement;
  name: HTMLSpanElement;
  status: HTMLSpanElement;
  mic: HTMLSpanElement;
  cam: HTMLSpanElement;
  screen: HTMLSpanElement;
  // Last-rendered values, so per-frame syncs skip redundant DOM writes.
  cache: {
    name?: string;
    color?: string;
    status?: PlayerStatus;
    muted?: boolean;
    cam?: boolean;
    screen?: boolean;
    speaking?: boolean;
    self?: boolean;
    focused?: boolean;
  };
};

export class RosterPanel {
  private players: Map<string, PlayerState>;
  private getMyId: () => string;
  private onFocus: (userId: string) => void;
  private onGoTo: (userId: string) => void;

  private panelEl: HTMLDivElement;
  private countEl: HTMLElement;
  private toggleEl: HTMLButtonElement;
  private listEl: HTMLDivElement;

  private rows = new Map<string, RosterRow>();
  // The userId sequence currently in the DOM; rebuilding only on change keeps
  // the per-frame update cheap (names never change after join, so order is
  // stable except on join/leave).
  private orderKey = '';
  private collapsed = false;
  private wasNarrow: boolean;

  constructor(opts: {
    players: Map<string, PlayerState>;
    getMyId: () => string;
    onFocus: (userId: string) => void;
    onGoTo: (userId: string) => void;
  }) {
    this.players = opts.players;
    this.getMyId = opts.getMyId;
    this.onFocus = opts.onFocus;
    this.onGoTo = opts.onGoTo;

    this.panelEl = document.getElementById('roster') as HTMLDivElement;
    this.countEl = document.getElementById('roster-count')!;
    this.toggleEl = document.getElementById('roster-toggle') as HTMLButtonElement;
    this.listEl = document.getElementById('roster-list') as HTMLDivElement;

    this.toggleEl.addEventListener('click', () => this.setCollapsed(!this.collapsed));

    // Auto-collapse on narrow viewports; expand again when it widens.
    this.wasNarrow = window.innerWidth <= NARROW_BREAKPOINT;
    this.collapsed = this.wasNarrow;
    window.addEventListener('resize', () => this.onResize());
    this.applyCollapsed();
  }

  show() {
    this.panelEl.classList.remove('hidden');
  }

  private onResize() {
    const narrow = window.innerWidth <= NARROW_BREAKPOINT;
    if (narrow !== this.wasNarrow) {
      this.wasNarrow = narrow;
      this.setCollapsed(narrow);
    }
  }

  private setCollapsed(collapsed: boolean) {
    this.collapsed = collapsed;
    this.applyCollapsed();
  }

  private applyCollapsed() {
    this.panelEl.classList.toggle('collapsed', this.collapsed);
    this.toggleEl.textContent = this.collapsed ? '⟩' : '⟨';
    this.toggleEl.title = this.collapsed ? '参加者リストを開く' : '折りたたむ';
  }

  // Pumped once per frame from the game loop: reconciles the rows with the
  // players map, then syncs each row's dynamic fields. `focusedId` is the
  // App-owned focused player (the row the user last clicked).
  update(focusedId: string | null) {
    const ordered = orderRoster(this.players.values(), this.getMyId());
    const key = ordered.map((p) => p.userId).join(',');
    if (key !== this.orderKey) {
      this.reconcile(ordered);
      this.orderKey = key;
    }
    for (const p of ordered) {
      const row = this.rows.get(p.userId);
      if (row) this.syncRow(row, p, p.userId === focusedId);
    }
    const text = String(ordered.length);
    if (this.countEl.textContent !== text) this.countEl.textContent = text;
  }

  // Adds rows for new players, drops rows for departed ones, then re-appends
  // every row in `ordered` sequence (appendChild moves existing nodes, so this
  // also fixes ordering). Called only when membership/order changes.
  private reconcile(ordered: PlayerState[]) {
    const present = new Set(ordered.map((p) => p.userId));
    for (const [userId, row] of this.rows) {
      if (!present.has(userId)) {
        row.el.remove();
        this.rows.delete(userId);
      }
    }
    for (const p of ordered) {
      let row = this.rows.get(p.userId);
      if (!row) {
        row = this.createRow(p);
        this.rows.set(p.userId, row);
      }
      this.listEl.appendChild(row.el);
    }
  }

  private createRow(p: PlayerState): RosterRow {
    const el = document.createElement('div');
    el.className = 'roster-row';
    el.dataset.userId = p.userId;

    const dot = document.createElement('span');
    dot.className = 'roster-dot';

    const name = document.createElement('span');
    name.className = 'roster-name';

    const status = document.createElement('span');
    status.className = 'roster-status';

    const icons = document.createElement('span');
    icons.className = 'roster-icons';
    const mic = document.createElement('span');
    mic.className = 'roster-icon roster-mic';
    const cam = document.createElement('span');
    cam.className = 'roster-icon roster-cam';
    const screen = document.createElement('span');
    screen.className = 'roster-icon roster-screen';
    icons.append(mic, cam, screen);

    el.append(dot, name, status, icons);

    // Self can't walk to itself, so no → button on its own row.
    if (!p.isSelf) {
      const go = document.createElement('button');
      go.className = 'roster-go';
      go.textContent = '→';
      go.title = `${p.name} のそばへ移動`;
      go.addEventListener('click', (e) => {
        // Don't let the button click bubble up to the row's focus handler.
        e.stopPropagation();
        this.onGoTo(p.userId);
      });
      el.appendChild(go);
    }

    // Clicking the row (anywhere but the → button) focuses the avatar on the
    // map — a light, non-destructive action; moving requires the explicit →.
    el.addEventListener('click', () => this.onFocus(p.userId));

    return { el, dot, name, status, mic, cam, screen, cache: {} };
  }

  private syncRow(row: RosterRow, p: PlayerState, focused: boolean) {
    const c = row.cache;
    if (c.name !== p.name) {
      row.name.textContent = p.name || p.userId.slice(0, 6);
      c.name = p.name;
    }
    if (c.color !== p.color) {
      row.dot.style.background = p.color;
      c.color = p.color;
    }
    if (c.status !== p.status) {
      row.status.textContent = ROSTER_STATUS_EMOJI[p.status] ?? '';
      c.status = p.status;
    }
    if (c.muted !== p.isMuted) {
      row.mic.textContent = p.isMuted ? '🔇' : '🎤';
      row.mic.classList.toggle('off', p.isMuted);
      c.muted = p.isMuted;
    }
    if (c.cam !== p.isVideoOn) {
      row.cam.textContent = p.isVideoOn ? '📷' : '';
      c.cam = p.isVideoOn;
    }
    if (c.screen !== p.isSharingScreen) {
      row.screen.textContent = p.isSharingScreen ? '🖥' : '';
      c.screen = p.isSharingScreen;
    }
    if (c.speaking !== p.isSpeaking) {
      row.el.classList.toggle('speaking', p.isSpeaking);
      c.speaking = p.isSpeaking;
    }
    if (c.self !== p.isSelf) {
      row.el.classList.toggle('self', p.isSelf);
      c.self = p.isSelf;
    }
    if (c.focused !== focused) {
      row.el.classList.toggle('focused', focused);
      c.focused = focused;
    }
  }
}
