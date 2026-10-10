// Background-tab alerts for knocks (issue #140). While the tab is hidden a knock
// toast is easy to miss (it auto-dismisses after KNOCK_COOLDOWN_MS), so we also
// raise an OS notification and badge the tab title. Plain Notification API only:
// no Service Worker / Web Push, which would need server-side subscription state
// (invariant #2). Notifications only fire while the page is alive, which matches
// engawa's "keep the tab open to be present" model.

import type { PlayerStatus } from '@/core/types';

export type AlertLevel = 'none' | 'badge' | 'desktop';
export type NotifyPermission = 'default' | 'granted' | 'denied' | 'unsupported';

const STORAGE_KEY = 'engawa-desktop-notify';
const ICON = '/icons/engawa-logo-192.png';

/**
 * How loudly to surface a knock (pure, unit-tested). Visible tab: the existing
 * toast + chime are enough. Away: we've soft-left, stay quiet. Busy, opted out,
 * or no permission: title badge only. Otherwise an OS notification + badge.
 */
export function knockAlertLevel(opts: {
  hidden: boolean;
  status: PlayerStatus;
  enabled: boolean;
  permission: NotifyPermission;
}): AlertLevel {
  if (!opts.hidden || opts.status === 'away') return 'none';
  if (opts.status === 'busy' || !opts.enabled || opts.permission !== 'granted') return 'badge';
  return 'desktop';
}

/** Tab title with an unseen-knock count, e.g. "(2) 🔔 engawa" (pure). */
export function badgedTitle(base: string, count: number): string {
  return count > 0 ? `(${count}) 🔔 ${base}` : base;
}

export class DesktopNotifier {
  private enabled: boolean;
  private badgeCount = 0;
  private baseTitle = document.title;

  constructor() {
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(STORAGE_KEY);
    } catch {
      /* ignore private-mode storage errors */
    }
    this.enabled = stored === '1';
  }

  permission(): NotifyPermission {
    return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
  }

  // The toggle reads as ON only when it will actually notify.
  isEnabled(): boolean {
    return this.enabled && this.permission() === 'granted';
  }

  // Flip the toggle. Turning it on asks for permission the first time (only
  // ever from this user gesture, never unprompted). Resolves to the resulting
  // permission so the caller can explain a denial.
  async toggle(): Promise<NotifyPermission> {
    let perm = this.permission();
    if (this.isEnabled()) {
      this.save(false);
      return perm;
    }
    if (perm === 'default') perm = await Notification.requestPermission();
    this.save(perm === 'granted');
    return perm;
  }

  // A knock arrived. `level` comes from knockAlertLevel().
  knock(level: AlertLevel, fromUserId: string, title: string, body: string) {
    if (level === 'none') return;
    this.badgeCount++;
    document.title = badgedTitle(this.baseTitle, this.badgeCount);
    if (level !== 'desktop') return;
    try {
      // Tag per sender so repeat knocks from one person replace each other.
      const n = new Notification(title, { body, icon: ICON, tag: `knock-${fromUserId}` });
      n.onclick = () => {
        window.focus();
        n.close();
      };
    } catch {
      /* some platforms (e.g. Android Chrome) only allow SW notifications */
    }
  }

  // The tab is visible again: drop the title badge.
  clearBadge() {
    if (this.badgeCount === 0) return;
    this.badgeCount = 0;
    document.title = this.baseTitle;
  }

  private save(on: boolean) {
    this.enabled = on;
    try {
      localStorage.setItem(STORAGE_KEY, on ? '1' : '0');
    } catch {
      /* ignore private-mode storage errors */
    }
  }
}
