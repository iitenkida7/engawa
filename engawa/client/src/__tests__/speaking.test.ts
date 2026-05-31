import { describe, expect, it } from 'bun:test';
import { isLoud } from '@/media/speaking';

describe('isLoud', () => {
  it('is true when the average magnitude exceeds the threshold', () => {
    // average 20 > 15
    expect(isLoud(new Uint8Array([20, 20, 20, 20]))).toBe(true);
  });

  it('is false when the average magnitude is at or below the threshold', () => {
    // average exactly 15 is not "loud" (strictly greater than required)
    expect(isLoud(new Uint8Array([15, 15, 15, 15]))).toBe(false);
    // average 10 < 15
    expect(isLoud(new Uint8Array([10, 10, 10, 10]))).toBe(false);
  });

  it('averages across all bins, not just the peak', () => {
    // one loud bin (255) but the rest silent → average 255/4 ≈ 63.75 > 15
    expect(isLoud(new Uint8Array([255, 0, 0, 0]))).toBe(true);
    // one loud bin spread across many silent bins → average drops below threshold
    expect(
      isLoud(
        new Uint8Array(
          Array(32)
            .fill(0)
            .map((_, i) => (i === 0 ? 255 : 0)),
        ),
      ),
    ).toBe(false);
  });

  it('is false for an empty buffer (no audio data yet)', () => {
    expect(isLoud(new Uint8Array(0))).toBe(false);
  });
});
