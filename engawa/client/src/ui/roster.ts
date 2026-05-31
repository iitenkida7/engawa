// The participant roster: a collapsible sidebar listing everyone in the
// workspace, self pinned first. Each row shows a color dot, name, status emoji,
// and mic/cam/screen icons, with a "speaking" highlight that tracks the shared
// players map. Clicking a row focuses that avatar on the map; the per-row →
// button walks self over to them (App wires both callbacks). This view owns the
// DOM that mirrors the players map; the App owns the map itself, mirroring the
// RemoteMediaView split.

import type { PlayerState } from '@/world/player';
import type { PlayerStatus } from '@/core/types';
import { formatUntil, STATUS_NOTE_MAX_LEN, STATUS_UNTIL_PRESETS_MIN } from '@/core/types';

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

// Pure: the secondary line under a roster name (#85) — the one-liner plus the
// return time as "〜HH:MMまで". Either part may be absent; an already-passed
// `until` is dropped (the owner will broadcast online shortly). '' = no line.
export function composeStatusNote(
  note: string,
  until: number | null | undefined,
  now = Date.now(),
): string {
  const parts: string[] = [];
  if (note) parts.push(note);
  const hhmm = formatUntil(until, now);
  if (hhmm) parts.push(`〜${hhmm}まで`);
  return parts.join(' ');
}

type RosterRow = {
  el: HTMLDivElement;
  dot: HTMLSpanElement;
  name: HTMLSpanElement;
  note: HTMLSpanElement;
  status: HTMLSpanElement;
  // Last-rendered values, so per-frame syncs skip redundant DOM writes.
  cache: {
    name?: string;
    color?: string;
    status?: PlayerStatus;
    note?: string;
    speaking?: boolean;
    self?: boolean;
    focused?: boolean;
  };
};

// Selectable statuses with their labels, used by the roster status dropdown.
const STATUS_ORDER: PlayerStatus[] = ['online', 'busy', 'away', 'meeting', 'break'];
const STATUS_LABELS: Record<PlayerStatus, string> = {
  online: '🟢 オンライン',
  busy: '🔴 取り込み中',
  away: '🟡 離席中',
  meeting: '🤝 商談中',
  break: '☕ 休憩中',
};

export class RosterPanel {
  private players: Map<string, PlayerState>;
  private getMyId: () => string;
  private onFocus: (userId: string) => void;
  private onGoTo: (userId: string) => void;
  private onKnock: (userId: string) => void;
  private getStatus: () => PlayerStatus;
  private getNote: () => string;
  private getUntilMin: () => number | null;
  private onSetStatus: (status: PlayerStatus, note: string, untilMin: number | null) => void;

  // Status-menu draft (#85): the note input plus the picked return-time preset
  // (minutes, null = none). Both seed from the current status when the menu
  // opens; clicking a status commits them together.
  private noteInput: HTMLInputElement | null = null;
  private untilMinDraft: number | null = null;

  private panelEl: HTMLDivElement;
  private countEl: HTMLElement;
  private toggleEl: HTMLButtonElement;
  private listEl: HTMLDivElement;
  private btnStatus: HTMLButtonElement;
  private statusMenu: HTMLDivElement;

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
    onKnock: (userId: string) => void;
    getStatus: () => PlayerStatus;
    getNote: () => string;
    getUntilMin: () => number | null;
    onSetStatus: (status: PlayerStatus, note: string, untilMin: number | null) => void;
  }) {
    this.players = opts.players;
    this.getMyId = opts.getMyId;
    this.onFocus = opts.onFocus;
    this.onGoTo = opts.onGoTo;
    this.onKnock = opts.onKnock;
    this.getStatus = opts.getStatus;
    this.getNote = opts.getNote;
    this.getUntilMin = opts.getUntilMin;
    this.onSetStatus = opts.onSetStatus;

    this.panelEl = document.getElementById('roster') as HTMLDivElement;
    this.countEl = document.getElementById('roster-count')!;
    this.toggleEl = document.getElementById('roster-toggle') as HTMLButtonElement;
    this.listEl = document.getElementById('roster-list') as HTMLDivElement;
    this.btnStatus = document.getElementById('btn-status') as HTMLButtonElement;
    this.statusMenu = document.getElementById('status-menu') as HTMLDivElement;

    this.toggleEl.addEventListener('click', () => this.setCollapsed(!this.collapsed));
    this.setupStatusMenu();

    // Auto-collapse on narrow viewports; expand again when it widens.
    this.wasNarrow = window.innerWidth <= NARROW_BREAKPOINT;
    this.collapsed = this.wasNarrow;
    window.addEventListener('resize', () => this.onResize());
    this.applyCollapsed();
  }

  show() {
    this.panelEl.classList.remove('hidden');
  }

  refreshStatus() {
    this.btnStatus.textContent = ROSTER_STATUS_EMOJI[this.getStatus()];
  }

  private setupStatusMenu() {
    // No stopPropagation: the click bubbles to document so the toolbar's own
    // outside-click handler closes its menus too (the two menu groups stay
    // mutually exclusive). The document handler below is guarded by
    // "t !== btnStatus", so this toggle never closes the menu it just opened.
    this.btnStatus.addEventListener('click', () => {
      const open = this.statusMenu.classList.contains('hidden');
      if (open) {
        this.populateStatusMenu();
        this.positionStatusMenu();
      }
      this.statusMenu.classList.toggle('hidden', !open);
    });
    document.addEventListener('click', (e) => {
      const t = e.target as Node;
      if (!this.statusMenu.contains(t) && t !== this.btnStatus) {
        this.statusMenu.classList.add('hidden');
      }
    });
  }

  // The status menu is portaled to #app top-level (not nested in the roster's
  // overflow:hidden box), so we anchor it under the button each time it opens:
  // dropping downward, right-aligned to the button. Measuring on open keeps it
  // correct regardless of header width (chat button present, count digits, …).
  private positionStatusMenu() {
    const r = this.btnStatus.getBoundingClientRect();
    this.statusMenu.style.top = `${r.bottom + 6}px`;
    this.statusMenu.style.right = `${window.innerWidth - r.right}px`;
    this.statusMenu.style.left = 'auto';
  }

  // Build the status menu fresh each open (#85): a one-liner input + return-time
  // presets seed from the current status as a draft, then the status buttons
  // commit status + draft together and close. Clicks inside the form fields are
  // stopped from bubbling so the document outside-click handler doesn't close it.
  private populateStatusMenu() {
    this.statusMenu.replaceChildren();
    this.untilMinDraft = this.getUntilMin();

    // One-liner input.
    const noteField = document.createElement('label');
    noteField.className = 'status-field';
    const noteLabel = document.createElement('span');
    noteLabel.className = 'status-field-label';
    noteLabel.textContent = '一言メッセージ';
    const note = document.createElement('input');
    note.type = 'text';
    note.className = 'status-note-input';
    note.maxLength = STATUS_NOTE_MAX_LEN;
    note.placeholder = '例: ランチ';
    note.value = this.getNote();
    note.addEventListener('click', (e) => e.stopPropagation());
    // Enter commits with the current status, for a quick note-only update.
    note.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.commitStatus(this.getStatus());
      }
    });
    this.noteInput = note;
    noteField.append(noteLabel, note);
    this.statusMenu.appendChild(noteField);

    // Return-time presets.
    const untilField = document.createElement('div');
    untilField.className = 'status-field';
    const untilLabel = document.createElement('span');
    untilLabel.className = 'status-field-label';
    untilLabel.textContent = '戻り時刻';
    const untilRow = document.createElement('div');
    untilRow.className = 'status-until-row';
    const presets: { min: number | null; text: string }[] = [
      { min: null, text: 'なし' },
      ...STATUS_UNTIL_PRESETS_MIN.map((min) => ({ min, text: `${min}分` })),
    ];
    for (const preset of presets) {
      const btn = document.createElement('button');
      btn.className = 'status-until-btn';
      btn.textContent = preset.text;
      if (preset.min === this.untilMinDraft) btn.classList.add('selected');
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.untilMinDraft = preset.min;
        for (const b of untilRow.children) b.classList.remove('selected');
        btn.classList.add('selected');
      });
      untilRow.appendChild(btn);
    }
    untilField.append(untilLabel, untilRow);
    this.statusMenu.appendChild(untilField);

    const divider = document.createElement('div');
    divider.className = 'status-divider';
    this.statusMenu.appendChild(divider);

    // Status buttons — selecting one commits the draft and closes.
    const current = this.getStatus();
    for (const status of STATUS_ORDER) {
      const item = document.createElement('button');
      item.className = 'device-item';
      const isSelected = status === current;
      if (isSelected) item.classList.add('selected');
      item.textContent = (isSelected ? '✓ ' : '') + STATUS_LABELS[status];
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        this.commitStatus(status);
      });
      this.statusMenu.appendChild(item);
    }
  }

  // Apply the picked status with the menu's current note/return-time draft, then
  // close. `online` clears the note/time so "戻りました" is a clean reset.
  private commitStatus(status: PlayerStatus) {
    this.statusMenu.classList.add('hidden');
    if (status === 'online') {
      this.onSetStatus(status, '', null);
      return;
    }
    const note = this.noteInput?.value.trim() ?? '';
    this.onSetStatus(status, note, this.untilMinDraft);
  }

  private onResize() {
    const narrow = window.innerWidth <= NARROW_BREAKPOINT;
    if (narrow !== this.wasNarrow) {
      this.wasNarrow = narrow;
      this.setCollapsed(narrow);
    }
    // The portaled status menu is positioned by JS from the button's rect, so a
    // resize while it's open would leave it misaligned — re-anchor it. (If the
    // resize just collapsed the roster, setCollapsed already hid it, so this
    // no-ops.)
    if (!this.statusMenu.classList.contains('hidden')) this.positionStatusMenu();
  }

  private setCollapsed(collapsed: boolean) {
    this.collapsed = collapsed;
    this.applyCollapsed();
  }

  private applyCollapsed() {
    this.panelEl.classList.toggle('collapsed', this.collapsed);
    this.toggleEl.textContent = this.collapsed ? '⟩' : '⟨';
    this.toggleEl.title = this.collapsed ? '参加者リストを開く' : '折りたたむ';
    // Collapsing hides the action buttons; close the (portaled) status menu so
    // it can't linger detached from its now-hidden button.
    if (this.collapsed) this.statusMenu.classList.add('hidden');
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

    // Name and the optional status one-liner stack in a column so the note (#85)
    // sits under the name without pushing the status emoji / buttons around.
    const main = document.createElement('div');
    main.className = 'roster-main';

    const name = document.createElement('span');
    name.className = 'roster-name';

    const note = document.createElement('span');
    note.className = 'roster-note hidden';

    main.append(name, note);

    const status = document.createElement('span');
    status.className = 'roster-status';

    el.append(dot, main, status);

    // Self can't knock or walk to itself, so its row has neither button.
    if (!p.isSelf) {
      const knock = document.createElement('button');
      knock.className = 'roster-knock';
      knock.textContent = '🔔';
      knock.title = `${p.name} さんにノック（話したいと伝える）`;
      knock.addEventListener('click', (e) => {
        // Don't let the button click bubble up to the row's focus handler.
        e.stopPropagation();
        this.onKnock(p.userId);
      });
      el.appendChild(knock);

      const go = document.createElement('button');
      go.className = 'roster-go';
      go.textContent = '→';
      go.title = `${p.name} のそばへ移動`;
      go.addEventListener('click', (e) => {
        e.stopPropagation();
        this.onGoTo(p.userId);
      });
      el.appendChild(go);
    }

    // Clicking the row (anywhere but the → button) focuses the avatar on the
    // map — a light, non-destructive action; moving requires the explicit →.
    el.addEventListener('click', () => this.onFocus(p.userId));

    return { el, dot, name, note, status, cache: {} };
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
    // The note line recomputes from note + return time; the latter ticks down to
    // a minute boundary, so compose every frame but only touch the DOM on change.
    const noteText = composeStatusNote(p.note, p.until);
    if (c.note !== noteText) {
      row.note.textContent = noteText;
      row.note.classList.toggle('hidden', noteText === '');
      c.note = noteText;
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
