// Self-status menu, opened from the bottom toolbar's status button. Lets you pick
// a presence status (online / busy / away). Extracted from the old roster panel
// when that was removed — the participant list is gone, but setting your own
// status stays, now living with the other self controls in the toolbar.

import { t } from '@/core/i18n';
import type { PlayerStatus } from '@/core/types';

// Status → emoji, shown on the toolbar button and next to avatar names on the
// map. `online` gets an explicit 🟢 so every avatar carries a status mark.
export const STATUS_EMOJI: Record<PlayerStatus, string> = {
  online: '🟢',
  busy: '🔴',
  away: '🟡',
};

const STATUS_ORDER: PlayerStatus[] = ['online', 'busy', 'away'];
const STATUS_LABELS: Record<PlayerStatus, string> = {
  online: t('status.online'),
  busy: t('status.busy'),
  away: t('status.away'),
};

export class StatusMenu {
  private getStatus: () => PlayerStatus;
  private onSetStatus: (status: PlayerStatus) => void;

  private btn: HTMLButtonElement;
  private menu: HTMLDivElement;

  constructor(opts: {
    getStatus: () => PlayerStatus;
    onSetStatus: (status: PlayerStatus) => void;
  }) {
    this.getStatus = opts.getStatus;
    this.onSetStatus = opts.onSetStatus;

    this.btn = document.getElementById('btn-status') as HTMLButtonElement;
    this.menu = document.getElementById('status-menu') as HTMLDivElement;

    this.btn.addEventListener('click', () => {
      const open = this.menu.classList.contains('hidden');
      if (open) {
        this.populate();
        this.position();
      }
      this.menu.classList.toggle('hidden', !open);
    });
    document.addEventListener('click', (e) => {
      const target = e.target as Node;
      if (!this.menu.contains(target) && target !== this.btn) {
        this.menu.classList.add('hidden');
      }
    });
    window.addEventListener('resize', () => {
      if (!this.menu.classList.contains('hidden')) this.position();
    });
  }

  // Sync the toolbar button's emoji to the current status.
  refresh() {
    this.btn.textContent = STATUS_EMOJI[this.getStatus()];
  }

  // The menu is portaled to #app top-level; its trigger is in the bottom toolbar,
  // so anchor it ABOVE the button (right-aligned), measured on open.
  private position() {
    const r = this.btn.getBoundingClientRect();
    this.menu.style.top = 'auto';
    this.menu.style.bottom = `${window.innerHeight - r.top + 6}px`;
    this.menu.style.right = `${window.innerWidth - r.right}px`;
    this.menu.style.left = 'auto';
  }

  // Build the menu fresh each open: one button per status; picking one commits
  // it and closes.
  private populate() {
    this.menu.replaceChildren();

    const current = this.getStatus();
    for (const status of STATUS_ORDER) {
      const item = document.createElement('button');
      item.className = 'device-item';
      const isSelected = status === current;
      if (isSelected) item.classList.add('selected');
      item.textContent = (isSelected ? '✓ ' : '') + STATUS_LABELS[status];
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        this.menu.classList.add('hidden');
        this.onSetStatus(status);
      });
      this.menu.appendChild(item);
    }
  }
}
