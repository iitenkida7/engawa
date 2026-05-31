import { describe, expect, it } from 'bun:test';
import { followViewportGrowth } from '@/ui/draggable';

describe('followViewportGrowth', () => {
  it('shifts left/top by the grown amount to keep distance from the edge', () => {
    expect(followViewportGrowth(100, 50, 30, 20)).toEqual({ left: 130, top: 70 });
  });

  it('ignores shrinking per-axis (negative growth does not move the element)', () => {
    expect(followViewportGrowth(100, 50, -30, -20)).toEqual({ left: 100, top: 50 });
  });

  it('handles each axis independently', () => {
    expect(followViewportGrowth(100, 50, 40, -10)).toEqual({ left: 140, top: 50 });
  });

  it('is a no-op when the viewport did not grow', () => {
    expect(followViewportGrowth(100, 50, 0, 0)).toEqual({ left: 100, top: 50 });
  });
});
