import { describe, expect, it } from 'bun:test';
import { formatUntil } from '@/core/types';
import { composeStatusNote, orderRoster } from '@/ui/roster';

const P = (userId: string, name: string) => ({ userId, name });

describe('orderRoster', () => {
  it('pins self to the front regardless of name', () => {
    const players = [P('c', 'Zoe'), P('me', 'Zzz'), P('a', 'Anna')];
    expect(orderRoster(players, 'me').map((p) => p.userId)).toEqual(['me', 'a', 'c']);
  });

  it('orders the rest by name, case-insensitively', () => {
    const players = [P('1', 'bob'), P('2', 'Alice'), P('3', 'charlie')];
    expect(orderRoster(players, 'me').map((p) => p.name)).toEqual(['Alice', 'bob', 'charlie']);
  });

  it('breaks name ties by userId for a stable order', () => {
    const players = [P('z', 'Sam'), P('a', 'Sam')];
    expect(orderRoster(players, 'me').map((p) => p.userId)).toEqual(['a', 'z']);
  });

  it('handles an empty roster and a missing self', () => {
    expect(orderRoster([], 'me')).toEqual([]);
    // No self present → pure name order, nothing pinned.
    const players = [P('b', 'Bea'), P('a', 'Ash')];
    expect(orderRoster(players, 'nobody').map((p) => p.userId)).toEqual(['a', 'b']);
  });
});

describe('formatUntil', () => {
  // 2026-01-02T08:00:00 local time as the reference "now".
  const now = new Date(2026, 0, 2, 8, 0, 0).getTime();

  it('formats a future time as zero-padded HH:MM', () => {
    const at0905 = new Date(2026, 0, 2, 9, 5, 0).getTime();
    expect(formatUntil(at0905, now)).toBe('09:05');
  });

  it('returns empty for no time, or a time already passed', () => {
    expect(formatUntil(null, now)).toBe('');
    expect(formatUntil(undefined, now)).toBe('');
    expect(formatUntil(now - 1, now)).toBe('');
    expect(formatUntil(now, now)).toBe('');
  });
});

describe('composeStatusNote', () => {
  const now = new Date(2026, 0, 2, 14, 0, 0).getTime();
  const until = new Date(2026, 0, 2, 14, 30, 0).getTime();

  it('combines note and return time', () => {
    expect(composeStatusNote('ランチ', until, now)).toBe('ランチ 〜14:30まで');
  });

  it('shows note alone when there is no return time', () => {
    expect(composeStatusNote('離席中', null, now)).toBe('離席中');
  });

  it('shows the return time alone when there is no note', () => {
    expect(composeStatusNote('', until, now)).toBe('〜14:30まで');
  });

  it('drops an already-passed return time', () => {
    expect(composeStatusNote('ランチ', until, until + 1)).toBe('ランチ');
  });

  it('returns empty when neither is present', () => {
    expect(composeStatusNote('', null, now)).toBe('');
  });
});
