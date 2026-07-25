import { describe, expect, it } from 'bun:test';
import { ZOOM_MAX, ZOOM_MIN } from '@/core/types';
import { zoomFromWheel } from '@/world/canvas';

describe('zoomFromWheel', () => {
  // A plain pixel-mode wheel (deltaMode 0), no ctrl → mouse wheel / two-finger scroll.
  it('zooms in when scrolling up (deltaY < 0)', () => {
    expect(zoomFromWheel(1.0, -100, 0, false)).toBeGreaterThan(1.0);
  });

  it('zooms out when scrolling down (deltaY > 0)', () => {
    expect(zoomFromWheel(1.0, 100, 0, false)).toBeLessThan(1.0);
  });

  it('is a no-op for a zero delta', () => {
    expect(zoomFromWheel(1.0, 0, 0, false)).toBe(1.0);
  });

  it('clamps to ZOOM_MAX when zooming in past the limit', () => {
    expect(zoomFromWheel(ZOOM_MAX, -100000, 0, false)).toBe(ZOOM_MAX);
  });

  it('clamps to ZOOM_MIN when zooming out past the limit', () => {
    expect(zoomFromWheel(ZOOM_MIN, 100000, 0, false)).toBe(ZOOM_MIN);
  });

  it('is multiplicative — the same delta scales the level by a constant factor', () => {
    const a = zoomFromWheel(0.6, -100, 0, false) / 0.6;
    const b = zoomFromWheel(1.2, -100, 0, false) / 1.2;
    expect(a).toBeCloseTo(b, 10);
  });

  it('applies a stronger step for a trackpad pinch (ctrl+wheel) at the same delta', () => {
    const wheel = zoomFromWheel(1.0, -10, 0, false);
    const pinch = zoomFromWheel(1.0, -10, 0, true);
    expect(pinch).toBeGreaterThan(wheel);
  });

  it('treats line-mode deltas (deltaMode 1) as ~16px per line', () => {
    const lines = zoomFromWheel(1.0, -1, 1, false);
    const pixels = zoomFromWheel(1.0, -16, 0, false);
    expect(lines).toBeCloseTo(pixels, 10);
  });
});
