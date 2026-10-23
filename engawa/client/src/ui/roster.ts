// Participant roster (#242): a toggleable panel listing everyone in the space —
// name, presence status, and mic/cam state — so people who aren't on a camera
// tile (audio-only, or hidden by the big-group compact view #239) are still
// visible and countable. Reads the shared players map; owns only its DOM.

import { t } from '@/core/i18n';
import { groupRoster } from '@/ui/roster-logic';
import { STATUS_EMOJI } from '@/ui/status-menu';
import type { PlayerState } from '@/world/player';
import { ZONES, zoneAt } from '@/world/tilemap';

export class RosterPanel {
  private btn: HTMLButtonElement;
  private panel: HTMLDivElement;
  private titleEl: HTMLElement;
  private list: HTMLDivElement;
  private scopeBtn: HTMLButtonElement;
  // "Only this room" filter: on by default whenever you step into a zone, so a
  // meeting room shows just the people in it; the header button widens it to
  // everyone (and back). Off outside a zone, where it has no meaning.
  private onlyHere = false;
  // The zone seen on the previous render, to notice walking into / between rooms.
  private lastZoneId: string | null = null;
  private getPlayers: () => Map<string, PlayerState>;
  // Row actions, run by the App: show where someone is on the map, walk over to
  // them, or knock.
  private onLocate: (userId: string) => void;
  private onGoTo: (userId: string) => void;
  private onCall: (userId: string) => void;
  // The row the viewer clicked: it shows the go / call buttons. Cleared by the
  // App when the locate ends (select(null)), or by clicking the row again.
  private selectedId: string | null = null;
  // While a pointer is held inside the panel the list is not rebuilt: render()
  // runs every second, and replacing a button between its mousedown and mouseup
  // would swallow the click.
  private pointerDown = false;

  constructor(opts: {
    getPlayers: () => Map<string, PlayerState>;
    onLocate: (userId: string) => void;
    onGoTo: (userId: string) => void;
    onCall: (userId: string) => void;
  }) {
    this.getPlayers = opts.getPlayers;
    this.onLocate = opts.onLocate;
    this.onGoTo = opts.onGoTo;
    this.onCall = opts.onCall;
    this.btn = document.getElementById('btn-roster') as HTMLButtonElement;
    this.panel = document.getElementById('roster') as HTMLDivElement;
    this.titleEl = document.getElementById('roster-title') as HTMLElement;
    this.list = document.getElementById('roster-list') as HTMLDivElement;
    this.scopeBtn = document.getElementById('roster-scope') as HTMLButtonElement;
    this.scopeBtn.addEventListener('click', () => {
      this.onlyHere = !this.onlyHere;
      this.render();
    });

    // One delegated handler: rows are rebuilt every second.
    this.list.addEventListener('click', (e) => this.onListClick(e));
    this.panel.addEventListener('pointerdown', () => {
      this.pointerDown = true;
    });
    const release = () => {
      this.pointerDown = false;
    };
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', release);

    this.btn.addEventListener('click', () => this.toggle());
    document.getElementById('roster-close')?.addEventListener('click', () => this.close());
  }

  private get isOpen() {
    return !this.panel.classList.contains('hidden');
  }

  // Public so the 'p' shortcut (issue #297) opens/closes the same way the button
  // does.
  toggle() {
    if (this.isOpen) this.close();
    else this.open();
  }

  private open() {
    this.panel.classList.remove('hidden');
    this.btn.classList.add('active');
    this.render();
  }

  private close() {
    this.panel.classList.add('hidden');
    this.btn.classList.remove('active');
  }

  // Programmatic selection (the App clears it when the locate times out).
  select(userId: string | null) {
    this.selectedId = userId;
    this.render();
  }

  private onListClick(e: MouseEvent) {
    const target = e.target as HTMLElement | null;
    const action = target?.closest<HTMLElement>('[data-action]');
    const rowEl = target?.closest<HTMLElement>('[data-user-id]');
    const userId = (action ?? rowEl)?.dataset.userId;
    if (!userId) return;
    if (action) {
      if (action.dataset.action === 'goto') this.onGoTo(userId);
      else if (action.dataset.action === 'call') this.onCall(userId);
      return;
    }
    // Clicking the selected row again just closes its actions.
    if (this.selectedId === userId) {
      this.selectedId = null;
      this.render();
      return;
    }
    this.selectedId = userId;
    this.onLocate(userId);
    this.render();
  }

  private actions(userId: string): HTMLElement {
    const box = document.createElement('div');
    box.className = 'roster-actions';
    box.dataset.userId = userId;
    for (const [action, key] of [
      ['goto', 'avatar.goto'],
      ['call', 'avatar.knock'],
    ] as const) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'roster-action';
      b.dataset.action = action;
      b.dataset.userId = userId;
      b.textContent = t(key);
      box.appendChild(b);
    }
    return box;
  }

  private row(p: PlayerState): HTMLElement {
    const row = document.createElement('div');
    row.className = p.isSpeaking ? 'roster-row speaking' : 'roster-row';
    row.dataset.userId = p.userId;
    if (p.userId === this.selectedId) row.classList.add('selected');

    // Profile picture (circular), or an initials chip in the avatar's colour.
    const avatar = document.createElement('span');
    avatar.className = 'roster-avatar';
    if (p.avatarImage) {
      const img = document.createElement('img');
      img.src = p.avatarImage;
      img.alt = '';
      avatar.appendChild(img);
    } else {
      avatar.textContent = p.initials();
      avatar.style.background = p.color;
    }

    const status = document.createElement('span');
    status.textContent = STATUS_EMOJI[p.status];

    const name = document.createElement('span');
    name.className = 'roster-name';
    name.textContent = p.isSelf ? `${p.name}（${t('common.you')}）` : p.name;

    const icons = document.createElement('span');
    icons.className = 'roster-icons';
    // Mic: muted vs live; cam: on vs off; screen share when active.
    icons.textContent =
      `${p.isMuted ? '🔇' : '🎙'}${p.isVideoOn ? '📹' : '　'}` + `${p.isSharingScreen ? '🖥' : ''}`;

    row.append(avatar, status, name, icons);
    return row;
  }

  // Rebuild the list from the current players. Cheap and called on a slow cadence
  // from the loop while open (and once on open); no-op while closed.
  render() {
    if (!this.isOpen || this.pointerDown) return;
    const players = [...this.getPlayers().values()].sort(
      (a, b) =>
        (a.isSelf ? -1 : 0) - (b.isSelf ? -1 : 0) ||
        a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
    );
    const me = players.find((p) => p.isSelf);
    const myZoneId = me ? (zoneAt(me.x, me.y)?.id ?? null) : null;
    // Entering a room (or moving to another) resets to "this room only"; leaving
    // clears it. A manual "show everyone" sticks until the next room change.
    if (myZoneId !== this.lastZoneId) {
      this.onlyHere = myZoneId !== null;
      this.lastZoneId = myZoneId;
    }
    this.scopeBtn.classList.toggle('hidden', myZoneId === null);
    this.scopeBtn.textContent = t(this.onlyHere ? 'roster.all' : 'roster.onlyHere');

    const located = players.map((p) => ({ p, zoneId: zoneAt(p.x, p.y)?.id ?? null }));
    let groups = groupRoster(
      located,
      ZONES.map((z) => z.id),
      myZoneId,
    );
    if (this.onlyHere) groups = groups.filter((g) => g.zoneId === myZoneId);
    const shown = groups.reduce((n, g) => n + g.items.length, 0);
    this.titleEl.textContent = `${t('roster.title')} (${shown})`;
    // A lone open-floor group needs no heading (the flat list it always was).
    const showHeaders = groups.length > 1 || groups[0]?.zoneId !== null;

    const rows: HTMLElement[] = [];
    for (const g of groups) {
      if (showHeaders) {
        const head = document.createElement('div');
        const mine = g.zoneId !== null && g.zoneId === myZoneId;
        head.className = mine ? 'roster-group mine' : 'roster-group';
        const zoneName = ZONES.find((z) => z.id === g.zoneId)?.name ?? t('roster.floor');
        head.textContent = `${mine ? '📍 ' : ''}${zoneName} · ${g.items.length}`;
        rows.push(head);
      }
      for (const { p } of g.items) {
        rows.push(this.row(p));
        // Your own row only re-centers the map; go / call make no sense on yourself.
        if (p.userId === this.selectedId && !p.isSelf) rows.push(this.actions(p.userId));
      }
    }
    this.list.replaceChildren(...rows);
  }
}
