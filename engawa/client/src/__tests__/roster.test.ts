import { describe, expect, it } from 'bun:test';
import { orderRoster } from '../roster';

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
