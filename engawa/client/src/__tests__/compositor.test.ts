import { describe, expect, it } from 'bun:test';
import { fitRect, panelZIndex } from '../compositor';

describe('fitRect', () => {
  it('contain: letterboxes a wide source into a square box (centered)', () => {
    // 200x100 into 100x100 → scale 0.5 → 100x50, centered vertically.
    const r = fitRect(200, 100, 0, 0, 100, 100, 'contain');
    expect(r).toEqual({ x: 0, y: 25, w: 100, h: 50 });
  });

  it('cover: fills and crops a wide source into a square box (centered)', () => {
    // 200x100 into 100x100 → scale 1.0 → 200x100, overflow cropped left/right.
    const r = fitRect(200, 100, 0, 0, 100, 100, 'cover');
    expect(r).toEqual({ x: -50, y: 0, w: 200, h: 100 });
  });

  it('honors the box offset', () => {
    const r = fitRect(100, 100, 30, 40, 100, 100, 'contain');
    expect(r).toEqual({ x: 30, y: 40, w: 100, h: 100 });
  });

  it('returns the full box when the source has no intrinsic size', () => {
    const r = fitRect(0, 0, 10, 20, 100, 50, 'cover');
    expect(r).toEqual({ x: 10, y: 20, w: 100, h: 50 });
  });
});

describe('panelZIndex', () => {
  const fake = (zIndex: string, id = '') =>
    ({ style: { zIndex }, id }) as unknown as HTMLElement;

  it('uses the inline z-index when set (e.g. bringToFront focus)', () => {
    expect(panelZIndex(fake('11'))).toBe(11);
  });

  it('defaults the screenshare stage above other panels', () => {
    expect(panelZIndex(fake('', 'screenshare-stage'))).toBe(6);
  });

  it('defaults other panels to the base layer', () => {
    expect(panelZIndex(fake('', 'self-preview'))).toBe(5);
    expect(panelZIndex(fake(''))).toBe(5);
  });
});
