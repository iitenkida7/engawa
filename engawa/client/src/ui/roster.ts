// Participant roster (#242): a toggleable panel listing everyone in the space —
// name, presence status, and mic/cam state — so people who aren't on a camera
// tile (audio-only, or hidden by the big-group compact view #239) are still
// visible and countable. Reads the shared players map; owns only its DOM.

import { t } from '@/core/i18n';
import { STATUS_EMOJI } from '@/ui/status-menu';
import type { PlayerState } from '@/world/player';

export class RosterPanel {
  private btn: HTMLButtonElement;
  private panel: HTMLDivElement;
  private titleEl: HTMLElement;
  private list: HTMLDivElement;
  private getPlayers: () => Map<string, PlayerState>;

  constructor(opts: { getPlayers: () => Map<string, PlayerState> }) {
    this.getPlayers = opts.getPlayers;
    this.btn = document.getElementById('btn-roster') as HTMLButtonElement;
    this.panel = document.getElementById('roster') as HTMLDivElement;
    this.titleEl = document.getElementById('roster-title') as HTMLElement;
    this.list = document.getElementById('roster-list') as HTMLDivElement;

    this.btn.addEventListener('click', () => this.toggle());
    document.getElementById('roster-close')?.addEventListener('click', () => this.close());
  }

  private get isOpen() {
    return !this.panel.classList.contains('hidden');
  }

  private toggle() {
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

  // Rebuild the list from the current players. Cheap and called on a slow cadence
  // from the loop while open (and once on open); no-op while closed.
  render() {
    if (!this.isOpen) return;
    const players = [...this.getPlayers().values()].sort(
      (a, b) =>
        (a.isSelf ? -1 : 0) - (b.isSelf ? -1 : 0) ||
        a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
    );
    this.titleEl.textContent = `${t('roster.title')} (${players.length})`;

    const rows = players.map((p) => {
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
    });
    this.list.replaceChildren(...rows);
  }
}
