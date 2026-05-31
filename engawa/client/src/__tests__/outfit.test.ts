import { describe, expect, it } from 'bun:test';
import {
  defaultOutfit,
  normalizeOutfit,
  type OutfitCounts,
  randomOutfit,
  wrapIndex,
} from '@/world/outfit';

const COUNTS: OutfitCounts = { skin: 5, hair: 6, top: 5, bottom: 3, acc: 3 };

describe('wrapIndex', () => {
  it('returns the index unchanged when in range', () => {
    expect(wrapIndex(0, 5)).toBe(0);
    expect(wrapIndex(4, 5)).toBe(4);
  });

  it('wraps forward past the end back to the start', () => {
    expect(wrapIndex(5, 5)).toBe(0);
    expect(wrapIndex(6, 5)).toBe(1);
  });

  it('wraps backward below zero to the end', () => {
    expect(wrapIndex(-1, 5)).toBe(4);
    expect(wrapIndex(-6, 5)).toBe(4);
  });

  it('yields 0 for a non-positive or non-finite length', () => {
    expect(wrapIndex(3, 0)).toBe(0);
    expect(wrapIndex(3, -2)).toBe(0);
    expect(wrapIndex(3, Number.NaN)).toBe(0);
  });
});

describe('defaultOutfit', () => {
  it('is all zeros', () => {
    expect(defaultOutfit()).toEqual({ skin: 0, hair: 0, top: 0, bottom: 0, acc: 0 });
  });
});

describe('normalizeOutfit', () => {
  it('keeps valid in-range indices', () => {
    const o = { skin: 2, hair: 5, top: 4, bottom: 1, acc: 2 };
    expect(normalizeOutfit(o, COUNTS)).toEqual(o);
  });

  it('clamps out-of-range indices into [0, count)', () => {
    expect(normalizeOutfit({ skin: 99, hair: -3, top: 4, bottom: 10, acc: 1 }, COUNTS)).toEqual({
      skin: 4,
      hair: 0,
      top: 4,
      bottom: 2,
      acc: 1,
    });
  });

  it('falls back to defaults for missing / garbage fields', () => {
    expect(normalizeOutfit({ skin: 1 }, COUNTS)).toEqual({
      skin: 1,
      hair: 0,
      top: 0,
      bottom: 0,
      acc: 0,
    });
    expect(normalizeOutfit(null, COUNTS)).toEqual(defaultOutfit());
    expect(normalizeOutfit('nope', COUNTS)).toEqual(defaultOutfit());
    expect(normalizeOutfit({ skin: 'x', hair: Number.NaN }, COUNTS)).toEqual(defaultOutfit());
  });

  it('truncates fractional indices', () => {
    expect(normalizeOutfit({ skin: 2.9, hair: 1.1 }, COUNTS)).toMatchObject({ skin: 2, hair: 1 });
  });
});

describe('randomOutfit', () => {
  it('is deterministic given an injected random source', () => {
    // rand() = 0.5 → floor(0.5 * count) per category.
    const half = () => 0.5;
    expect(randomOutfit(COUNTS, half)).toEqual({ skin: 2, hair: 3, top: 2, bottom: 1, acc: 1 });
  });

  it('always produces in-range indices across the random spectrum', () => {
    for (const r of [0, 0.01, 0.25, 0.5, 0.75, 0.999]) {
      const o = randomOutfit(COUNTS, () => r);
      expect(o.skin).toBeGreaterThanOrEqual(0);
      expect(o.skin).toBeLessThan(COUNTS.skin);
      expect(o.hair).toBeLessThan(COUNTS.hair);
      expect(o.bottom).toBeLessThan(COUNTS.bottom);
      expect(o.acc).toBeLessThan(COUNTS.acc);
    }
  });
});
