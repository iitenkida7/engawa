import { describe, expect, it } from 'bun:test';
import { coverSquare } from '@/ui/profile-image';

describe('coverSquare (centre-crop to a square)', () => {
  it('takes the full image when already square', () => {
    expect(coverSquare(100, 100)).toEqual({ sx: 0, sy: 0, size: 100 });
  });

  it('crops the sides of a landscape image, keeping the middle', () => {
    expect(coverSquare(200, 100)).toEqual({ sx: 50, sy: 0, size: 100 });
  });

  it('crops top and bottom of a portrait image, keeping the middle', () => {
    expect(coverSquare(100, 300)).toEqual({ sx: 0, sy: 100, size: 100 });
  });

  it('degrades to an empty square for a zero dimension', () => {
    expect(coverSquare(0, 100)).toEqual({ sx: 0, sy: 50, size: 0 });
  });
});
