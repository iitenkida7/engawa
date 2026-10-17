import { afterEach, describe, expect, it } from 'bun:test';
import {
  badgedTitle,
  DesktopNotifier,
  detectOs,
  isBackgrounded,
  knockAlertLevel,
  type NotifyPermission,
} from '@/ui/desktop-notify';

const base = {
  backgrounded: true,
  status: 'online' as const,
  enabled: true,
  permission: 'granted' as const,
};

describe('knockAlertLevel', () => {
  it('raises a desktop notification for a backgrounded, online, opted-in tab', () => {
    expect(knockAlertLevel(base)).toBe('desktop');
  });

  it('stays quiet while the window is in front (toast + chime cover it)', () => {
    expect(knockAlertLevel({ ...base, backgrounded: false })).toBe('none');
  });

  it('stays quiet while away', () => {
    expect(knockAlertLevel({ ...base, status: 'away' })).toBe('none');
  });

  it('only badges the title while busy', () => {
    expect(knockAlertLevel({ ...base, status: 'busy' })).toBe('badge');
  });

  it('only badges the title when opted out or without permission', () => {
    expect(knockAlertLevel({ ...base, enabled: false })).toBe('badge');
    expect(knockAlertLevel({ ...base, permission: 'default' })).toBe('badge');
    expect(knockAlertLevel({ ...base, permission: 'denied' })).toBe('badge');
    expect(knockAlertLevel({ ...base, permission: 'unsupported' })).toBe('badge');
  });
});

describe('badgedTitle', () => {
  it('prefixes the unseen-knock count', () => {
    expect(badgedTitle('engawa', 2)).toBe('(2) 🔔 engawa');
  });

  it('returns the base title when nothing is unseen', () => {
    expect(badgedTitle('engawa', 0)).toBe('engawa');
  });
});

describe('isBackgrounded', () => {
  const realHasFocus = document.hasFocus.bind(document);
  afterEach(() => {
    document.hasFocus = realHasFocus;
  });

  it('is false for a visible, focused window', () => {
    document.hasFocus = () => true;
    expect(isBackgrounded()).toBe(false);
  });

  // The #321 case: engawa is on screen (document.hidden === false) but another
  // window has focus, which used to suppress every knock alert.
  it('is true for a visible window that lost focus', () => {
    document.hasFocus = () => false;
    expect(isBackgrounded()).toBe(true);
  });
});

// Minimal Notification stand-in: happy-dom provides none. Counts permission
// prompts and constructed notifications; `throws` mimics a browser that refuses
// page-level notifications (e.g. Android Chrome).
function stubNotification(
  permission: NotifyPermission,
  answer: NotifyPermission = 'granted',
  throws = false,
) {
  const calls = { requests: 0, shown: 0 };
  class FakeNotification {
    static permission = permission;
    static requestPermission = async () => {
      calls.requests++;
      return answer;
    };
    onclick: (() => void) | null = null;
    constructor() {
      if (throws) throw new TypeError('Illegal constructor');
      calls.shown++;
    }
    close() {}
  }
  (globalThis as unknown as { Notification: unknown }).Notification = FakeNotification;
  return calls;
}

const stored = () => localStorage.getItem('engawa-desktop-notify');

describe('DesktopNotifier', () => {
  afterEach(() => {
    localStorage.clear();
    (globalThis as unknown as { Notification?: unknown }).Notification = undefined;
  });

  it('is on by default, with no stored preference (#321)', () => {
    stubNotification('granted');
    expect(new DesktopNotifier().isEnabled()).toBe(true);
  });

  it('stays off once explicitly opted out', () => {
    stubNotification('granted');
    localStorage.setItem('engawa-desktop-notify', '0');
    expect(new DesktopNotifier().isEnabled()).toBe(false);
  });

  it('reads as off until the browser permission is granted', () => {
    stubNotification('default');
    expect(new DesktopNotifier().isEnabled()).toBe(false);
  });

  it('switches off on join unless already granted, without prompting', () => {
    for (const perm of ['default', 'denied', 'unsupported'] as const) {
      localStorage.clear();
      const calls = stubNotification(perm);
      if (perm === 'unsupported')
        (globalThis as unknown as { Notification?: unknown }).Notification = undefined;
      new DesktopNotifier().syncOnJoin();
      expect(stored()).toBe('0');
      expect(calls.requests).toBe(0);
    }
  });

  it('keeps the toggle as-is on join when granted', () => {
    stubNotification('granted');
    const n = new DesktopNotifier();
    n.syncOnJoin();
    expect(stored()).toBeNull();
    expect(n.isEnabled()).toBe(true);
  });

  it('turning on asks for permission, then sends a test notification', async () => {
    const calls = stubNotification('default', 'granted');
    localStorage.setItem('engawa-desktop-notify', '0');
    expect(await new DesktopNotifier().toggle()).toBe('sent');
    expect(calls.requests).toBe(1);
    expect(calls.shown).toBe(1);
    expect(stored()).toBe('1');
  });

  it('reports the browser gate when permission is denied', async () => {
    const calls = stubNotification('default', 'denied');
    expect(await new DesktopNotifier().toggle()).toBe('denied');
    expect(calls.shown).toBe(0);
    expect(stored()).toBe('0');
  });

  it('does not re-prompt an earlier denial', async () => {
    const calls = stubNotification('denied');
    expect(await new DesktopNotifier().toggle()).toBe('denied');
    expect(calls.requests).toBe(0);
  });

  it('reports unsupported when the browser refuses page notifications', async () => {
    stubNotification('granted', 'granted', true);
    localStorage.setItem('engawa-desktop-notify', '0');
    expect(await new DesktopNotifier().toggle()).toBe('unsupported');
    expect(stored()).toBe('0');
  });

  it('reports unsupported without the Notification API', async () => {
    const n = new DesktopNotifier();
    expect(n.permission()).toBe('unsupported');
    expect(await n.toggle()).toBe('unsupported');
  });

  it('turning off needs no test', async () => {
    const calls = stubNotification('granted');
    expect(await new DesktopNotifier().toggle()).toBe('off');
    expect(calls.shown).toBe(0);
    expect(stored()).toBe('0');
  });
});

describe('detectOs', () => {
  it('recognises macOS, Windows and the rest', () => {
    expect(
      detectOs('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/155'),
    ).toBe('mac');
    expect(
      detectOs('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/155'),
    ).toBe('windows');
    expect(detectOs('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/155')).toBe('other');
    expect(
      detectOs('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15'),
    ).toBe('other');
  });
});
