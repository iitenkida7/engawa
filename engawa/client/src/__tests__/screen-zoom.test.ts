import { describe, expect, it } from 'bun:test';
import { clampPan, clampZoom, SCREEN_ZOOM_MAX, SCREEN_ZOOM_MIN } from '@/ui/screen-zoom';

describe('clampZoom', () => {
  it('keeps a value inside [MIN, MAX]', () => {
    expect(clampZoom(2)).toBe(2);
    expect(clampZoom(SCREEN_ZOOM_MIN)).toBe(SCREEN_ZOOM_MIN);
    expect(clampZoom(SCREEN_ZOOM_MAX)).toBe(SCREEN_ZOOM_MAX);
  });

  it('clamps below MIN and above MAX', () => {
    expect(clampZoom(0.2)).toBe(SCREEN_ZOOM_MIN);
    expect(clampZoom(-5)).toBe(SCREEN_ZOOM_MIN);
    expect(clampZoom(99)).toBe(SCREEN_ZOOM_MAX);
  });

  it('rounds to whole percents and survives non-finite input', () => {
    expect(clampZoom(1.234)).toBe(1.23);
    expect(clampZoom(Number.NaN)).toBe(SCREEN_ZOOM_MIN);
    expect(clampZoom(Number.POSITIVE_INFINITY)).toBe(SCREEN_ZOOM_MAX);
  });
});

describe('clampPan', () => {
  it('allows no pan at 1× (the content exactly fills the frame)', () => {
    expect(clampPan(100, 100, 1, 800, 600)).toEqual({ tx: 0, ty: 0 });
  });

  it('limits the offset to half the extra size each way', () => {
    // At 2× over an 800×600 frame the content is 1600×1200, so it can slide
    // 400px / 300px each direction.
    expect(clampPan(1000, -1000, 2, 800, 600)).toEqual({ tx: 400, ty: -300 });
    expect(clampPan(-1000, 1000, 2, 800, 600)).toEqual({ tx: -400, ty: 300 });
  });

  it('passes through offsets already within range', () => {
    expect(clampPan(120, -50, 2, 800, 600)).toEqual({ tx: 120, ty: -50 });
  });
});
