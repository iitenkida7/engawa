import { describe, expect, test } from 'bun:test';
import { DEFAULT_OUTFIT, OUTFIT_MAX_INDEX, sanitizeOutfit } from '../logic';
import type { Outfit } from '../types';

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

describe('sanitizeOutfit', () => {
  test('keeps valid non-negative integer indices', () => {
    const o: Outfit = {
      sex: 1,
      skin: 1,
      hair: 4,
      hairColor: 2,
      top: 2,
      topColor: 3,
      bottom: 0,
      bottomColor: 1,
      shoes: 1,
      hat: 0,
      glasses: 2,
    };
    expect(sanitizeOutfit(o)).toEqual(o);
  });

  test('only the known category keys survive (extra keys dropped)', () => {
    expect(sanitizeOutfit({ sex: 1, skin: 1, hair: 2, evil: 99 })).toEqual({
      ...ZEROS,
      sex: 1,
      skin: 1,
      hair: 2,
    });
  });

  test('clamps to [0, OUTFIT_MAX_INDEX] and truncates fractions', () => {
    expect(sanitizeOutfit({ skin: -5, hair: 1000, top: 2.9, glasses: 1 })).toEqual({
      ...ZEROS,
      skin: 0,
      hair: OUTFIT_MAX_INDEX,
      top: 2,
      glasses: 1,
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
      ZEROS,
    );
  });

  test('returns a fresh object (not a shared default reference)', () => {
    const a = sanitizeOutfit(undefined);
    a.skin = 3;
    expect(DEFAULT_OUTFIT.skin).toBe(0);
  });
});
