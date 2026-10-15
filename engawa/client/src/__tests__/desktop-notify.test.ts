import { afterEach, describe, expect, it } from 'bun:test';
import {
  badgedTitle,
  DesktopNotifier,
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

// Minimal Notification stand-in: happy-dom provides none. Returns the number of
// permission prompts raised so tests can assert we only ask while undecided.
function stubNotification(permission: NotifyPermission, answer: NotifyPermission = 'granted') {
  const calls = { requests: 0 };
  (globalThis as unknown as { Notification: unknown }).Notification = {
    permission,
    requestPermission: async () => {
      calls.requests++;
      return answer;
    },
  };
  return calls;
}

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

  it('asks for permission on join while undecided', async () => {
    const calls = stubNotification('default', 'granted');
    expect(await new DesktopNotifier().ensurePermission()).toBe('granted');
    expect(calls.requests).toBe(1);
  });

  it('never re-asks once the user has decided', async () => {
    const denied = stubNotification('denied');
    expect(await new DesktopNotifier().ensurePermission()).toBe('denied');
    expect(denied.requests).toBe(0);
    const granted = stubNotification('granted');
    expect(await new DesktopNotifier().ensurePermission()).toBe('granted');
    expect(granted.requests).toBe(0);
  });

  it('does not record a denial as an opt-out, so re-allowing is enough', async () => {
    stubNotification('default', 'denied');
    await new DesktopNotifier().ensurePermission();
    expect(localStorage.getItem('engawa-desktop-notify')).toBeNull();
    stubNotification('granted');
    expect(new DesktopNotifier().isEnabled()).toBe(true);
  });

  it('reports unsupported (and asks nothing) without the Notification API', async () => {
    (globalThis as unknown as { Notification?: unknown }).Notification = undefined;
    const n = new DesktopNotifier();
    expect(n.permission()).toBe('unsupported');
    expect(await n.ensurePermission()).toBe('unsupported');
  });
});
