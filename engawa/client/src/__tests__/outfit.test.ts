import { describe, expect, it } from 'bun:test';
import {
  defaultOutfit,
  normalizeOutfit,
  type Outfit,
  type OutfitCounts,
  randomOutfit,
  wrapIndex,
} from '@/world/outfit';

// Test-fixture counts (not the live manifest counts — just small ranges).
const COUNTS: OutfitCounts = {
  sex: 2,
  skin: 5,
  hair: 6,
  hairColor: 4,
  top: 5,
  topColor: 6,
  bottom: 3,
  bottomColor: 6,
  shoes: 3,
  hat: 3,
  glasses: 3,
};

const ZEROS: Outfit = {
  sex: 0,
  skin: 0,
  hair: 0,
  hairColor: 0,
  top: 0,
  topColor: 0,
  bottom: 0,
  bottomColor: 0,
  shoes: 0,
  hat: 0,
  glasses: 0,
};

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
  it('is a sensible clothed default (not all zeros)', () => {
    expect(defaultOutfit()).toEqual({
      sex: 0,
      skin: 0,
      hair: 1,
      hairColor: 0,
      top: 0,
      topColor: 4,
      bottom: 0,
      bottomColor: 2,
      shoes: 1,
      hat: 0,
      glasses: 0,
    });
  });
});

describe('normalizeOutfit', () => {
  it('keeps valid in-range indices', () => {
    const o: Outfit = {
      sex: 1,
      skin: 2,
      hair: 5,
      hairColor: 3,
      top: 4,
      topColor: 5,
      bottom: 1,
      bottomColor: 2,
      shoes: 2,
      hat: 1,
      glasses: 0,
    };
    expect(normalizeOutfit(o, COUNTS)).toEqual(o);
  });

  it('clamps out-of-range indices into [0, count)', () => {
    expect(
      normalizeOutfit(
        { sex: 9, skin: 99, hair: -3, hairColor: 50, top: 4, topColor: 99, bottom: 10 },
        COUNTS,
      ),
    ).toEqual({
      sex: 1,
      skin: 4,
      hair: 0,
      hairColor: 3,
      top: 4,
      topColor: 5,
      bottom: 2,
      bottomColor: 0,
      shoes: 0,
      hat: 0,
      glasses: 0,
    });
  });

  it('falls back to 0 per field for missing values', () => {
    expect(normalizeOutfit({ skin: 1, hair: 3 }, COUNTS)).toEqual({ ...ZEROS, skin: 1, hair: 3 });
  });

  it('yields all zeros for null / garbage input (not the styled default)', () => {
    expect(normalizeOutfit(null, COUNTS)).toEqual(ZEROS);
    expect(normalizeOutfit('nope', COUNTS)).toEqual(ZEROS);
    expect(normalizeOutfit({ skin: 'x', hair: Number.NaN }, COUNTS)).toEqual(ZEROS);
  });

  it('truncates fractional indices', () => {
    expect(normalizeOutfit({ skin: 2.9, hair: 1.1 }, COUNTS)).toMatchObject({ skin: 2, hair: 1 });
  });
});

describe('randomOutfit', () => {
  it('is deterministic given an injected random source', () => {
    // rand() = 0.5 → floor(0.5 * count) per category.
    const half = () => 0.5;
    expect(randomOutfit(COUNTS, half)).toEqual({
      sex: 1,
      skin: 2,
      hair: 3,
      hairColor: 2,
      top: 2,
      topColor: 3,
      bottom: 1,
      bottomColor: 3,
      shoes: 1,
      hat: 1,
      glasses: 1,
    });
  });

  it('always produces in-range indices across the random spectrum', () => {
    for (const r of [0, 0.01, 0.25, 0.5, 0.75, 0.999]) {
      const o = randomOutfit(COUNTS, () => r);
      for (const key of Object.keys(COUNTS) as (keyof OutfitCounts)[]) {
        expect(o[key]).toBeGreaterThanOrEqual(0);
        expect(o[key]).toBeLessThan(COUNTS[key]);
      }
    }
  });
});
