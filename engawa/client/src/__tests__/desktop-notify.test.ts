import { describe, expect, it } from 'bun:test';
import { badgedTitle, knockAlertLevel } from '@/ui/desktop-notify';

const base = {
  hidden: true,
  status: 'online' as const,
  enabled: true,
  permission: 'granted' as const,
};

describe('knockAlertLevel', () => {
  it('raises a desktop notification for a hidden, online, opted-in tab', () => {
    expect(knockAlertLevel(base)).toBe('desktop');
  });

  it('stays quiet while the tab is visible (toast + chime cover it)', () => {
    expect(knockAlertLevel({ ...base, hidden: false })).toBe('none');
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
