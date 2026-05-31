import { describe, expect, test } from 'bun:test';
import { DEFAULT_OUTFIT, OUTFIT_MAX_INDEX, sanitizeOutfit } from '../logic';

describe('sanitizeOutfit', () => {
  test('keeps valid non-negative integer indices', () => {
    const o = { skin: 1, hair: 4, top: 2, bottom: 0, acc: 2 };
    expect(sanitizeOutfit(o)).toEqual(o);
  });

  test('only the known category keys survive (extra keys dropped)', () => {
    expect(sanitizeOutfit({ skin: 1, hair: 2, top: 3, bottom: 1, acc: 0, evil: 99 })).toEqual({
      skin: 1,
      hair: 2,
      top: 3,
      bottom: 1,
      acc: 0,
    });
  });

  test('clamps to [0, OUTFIT_MAX_INDEX] and truncates fractions', () => {
    expect(sanitizeOutfit({ skin: -5, hair: 1000, top: 2.9, bottom: 0, acc: 1 })).toEqual({
      skin: 0,
      hair: OUTFIT_MAX_INDEX,
      top: 2,
      bottom: 0,
      acc: 1,
    });
  });

  test('garbage / non-object input yields the default outfit', () => {
    expect(sanitizeOutfit(undefined)).toEqual(DEFAULT_OUTFIT);
    expect(sanitizeOutfit(null)).toEqual(DEFAULT_OUTFIT);
    expect(sanitizeOutfit('nope')).toEqual(DEFAULT_OUTFIT);
    expect(sanitizeOutfit(42)).toEqual(DEFAULT_OUTFIT);
  });

  test('non-numeric field values collapse to 0', () => {
    expect(sanitizeOutfit({ skin: 'x', hair: Number.NaN, top: Number.POSITIVE_INFINITY })).toEqual(
      DEFAULT_OUTFIT,
    );
  });

  test('returns a fresh object (not a shared default reference)', () => {
    const a = sanitizeOutfit(undefined);
    a.skin = 3;
    expect(DEFAULT_OUTFIT.skin).toBe(0);
  });
});
