// Background alerts for knocks (issues #140, #321). Whenever engawa is not the
// window you are looking at, a knock toast is easy to miss (it auto-dismisses
// after KNOCK_COOLDOWN_MS), so we also raise an OS notification and badge the tab
// title. Plain Notification API only: no Service Worker / Web Push, which would
// need server-side subscription state (invariant #2). Notifications only fire
// while the page is alive, which matches engawa's "keep the tab open to be
// present" model.

import { t } from '@/core/i18n';
import type { PlayerStatus } from '@/core/types';

export type AlertLevel = 'none' | 'badge' | 'desktop';
export type NotifyPermission = 'default' | 'granted' | 'denied' | 'unsupported';
// 'dismissed': the permission prompt was closed without answering.
export type ToggleResult = 'on' | 'off' | 'dismissed' | 'unsupported' | 'denied';
export type TestResult = 'sent' | 'dismissed' | 'unsupported' | 'denied';
export type HostOs = 'mac' | 'windows' | 'other';

const STORAGE_KEY = 'engawa-desktop-notify';
const ICON = '/icons/engawa-logo-192.png';

/**
 * Whether engawa is out of sight right now. `document.hidden` alone only covers
 * a background tab / minimized window: with engawa visible on a second monitor
 * (or beside the window you're actually working in) it stays false, which used
 * to suppress every knock alert (#321). Being unfocused is the condition that
 * actually matters, so it drives the alert too.
 */
export function isBackgrounded(): boolean {
  return document.hidden || !document.hasFocus();
}

/**
 * How loudly to surface a knock (pure, unit-tested). Focused window: the existing
 * toast + chime are enough. Away: we've soft-left, stay quiet. Busy, opted out,
 * or no permission: title badge only. Otherwise an OS notification + badge.
 * `backgrounded` comes from isBackgrounded().
 */
export function knockAlertLevel(opts: {
  backgrounded: boolean;
  status: PlayerStatus;
  enabled: boolean;
  permission: NotifyPermission;
}): AlertLevel {
  if (!opts.backgrounded || opts.status === 'away') return 'none';
  if (opts.status === 'busy' || !opts.enabled || opts.permission !== 'granted') return 'badge';
  return 'desktop';
}

/** Tab title with an unseen-knock count, e.g. "(2) 🔔 engawa" (pure). */
export function badgedTitle(base: string, count: number): string {
  return count > 0 ? `(${count}) 🔔 ${base}` : base;
}

/** Which OS's notification settings to point at, from the user agent (pure). */
export function detectOs(ua: string): HostOs {
  if (/Windows/i.test(ua)) return 'windows';
  // iPhone/iPad also say "like Mac OS X"; they have no desktop notifications here.
  if (/Macintosh|Mac OS X/i.test(ua) && !/iPhone|iPad/i.test(ua)) return 'mac';
  return 'other';
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
    // Default ON (#321): only an explicit opt-out ('0') disables it. Nothing is
    // shown until the browser permission is granted, and syncOnJoin() turns it
    // off at join when it isn't.
    this.enabled = stored !== '0';
  }

  permission(): NotifyPermission {
    return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
  }

  // The toggle reads as ON only when it will actually notify.
  isEnabled(): boolean {
    return this.enabled && this.permission() === 'granted';
  }

  // Called once per join (#321 follow-up). We no longer prompt here: unless the
  // browser permission is already granted, the toggle is switched OFF, so the
  // only way back ON is the status-menu toggle.
  syncOnJoin() {
    if (this.permission() !== 'granted') this.save(false);
  }

  // Flip the toggle. Turning it on asks for permission the first time (only
  // ever from this user gesture, never unprompted).
  async toggle(): Promise<ToggleResult> {
    if (this.isEnabled()) {
      this.save(false);
      return 'off';
    }
    const perm = await this.requestIfUndecided();
    this.save(perm === 'granted');
    if (perm === 'default') return 'dismissed';
    return perm === 'granted' ? 'on' : perm;
  }

  // "Test notification" in the ⋯ menu: checks the browser gate (asking while
  // undecided) and fires a test notification. 'sent' only means the browser
  // accepted it: whether the OS displayed it can't be observed from the page,
  // so the caller asks the user.
  async test(): Promise<TestResult> {
    const perm = await this.requestIfUndecided();
    if (perm === 'default') return 'dismissed';
    if (perm !== 'granted') return perm;
    try {
      const n = new Notification(t('notify.testTitle'), {
        body: t('notify.testBody'),
        icon: ICON,
        tag: 'engawa-test',
      });
      n.onclick = () => {
        window.focus();
        n.close();
      };
      return 'sent';
    } catch {
      // Some platforms (e.g. Android Chrome) only allow SW notifications.
      return 'unsupported';
    }
  }

  private async requestIfUndecided(): Promise<NotifyPermission> {
    const perm = this.permission();
    return perm === 'default' ? await Notification.requestPermission() : perm;
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
