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
  // "Only this room" filter: meaningful (and offered) only while standing in a
  // zone; it quietly resets when you walk out.
  private onlyHere = false;
  private getPlayers: () => Map<string, PlayerState>;

  constructor(opts: { getPlayers: () => Map<string, PlayerState> }) {
    this.getPlayers = opts.getPlayers;
    this.btn = document.getElementById('btn-roster') as HTMLButtonElement;
    this.panel = document.getElementById('roster') as HTMLDivElement;
    this.titleEl = document.getElementById('roster-title') as HTMLElement;
    this.list = document.getElementById('roster-list') as HTMLDivElement;
    this.scopeBtn = document.getElementById('roster-scope') as HTMLButtonElement;
    this.scopeBtn.addEventListener('click', () => {
      this.onlyHere = !this.onlyHere;
      this.render();
    });

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

  private row(p: PlayerState): HTMLElement {
    const row = document.createElement('div');
    row.className = p.isSpeaking ? 'roster-row speaking' : 'roster-row';

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

    row.append(status, name, icons);
    return row;
  }

  // Rebuild the list from the current players. Cheap and called on a slow cadence
  // from the loop while open (and once on open); no-op while closed.
  render() {
    if (!this.isOpen) return;
    const players = [...this.getPlayers().values()].sort(
      (a, b) =>
        (a.isSelf ? -1 : 0) - (b.isSelf ? -1 : 0) ||
        a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
    );
    const me = players.find((p) => p.isSelf);
    const myZoneId = me ? (zoneAt(me.x, me.y)?.id ?? null) : null;
    if (myZoneId === null) this.onlyHere = false;
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
      for (const { p } of g.items) rows.push(this.row(p));
    }
    this.list.replaceChildren(...rows);
  }
}
