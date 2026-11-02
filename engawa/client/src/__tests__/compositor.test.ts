import { describe, expect, it } from 'bun:test';
import { computeRecordingLayout, fitRect } from '@/media/compositor';

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

describe('computeRecordingLayout', () => {
  const W = 1280;
  const H = 720;

  const inFrame = (b: { x: number; y: number; w: number; h: number }) =>
    b.x >= 0 && b.y >= 0 && b.x + b.w <= W + 0.001 && b.y + b.h <= H + 0.001;

  describe('screenshare present', () => {
    it('puts the screen on the left and stacks the tiles down the sidebar', () => {
      const l = computeRecordingLayout(true, 2, W, H);
      // sideW = round(1280*0.26)=333, mainW=947.
      expect(l.screen).toEqual({ x: 12, y: 12, w: 935, h: 696 });
      // sidebar: x=959, innerW=309; slotH=(720-36)/2=342.
      expect(l.tiles).toEqual([
        { x: 959, y: 12, w: 309, h: 342 },
        { x: 959, y: 366, w: 309, h: 342 },
      ]);
    });

    it('gives the screen the whole frame when there are no tiles', () => {
      const l = computeRecordingLayout(true, 0, W, H);
      expect(l.screen).toEqual({ x: 12, y: 12, w: 1256, h: 696 });
      expect(l.tiles).toEqual([]);
    });

    it('keeps every box inside the frame', () => {
      for (const n of [0, 1, 2, 3, 5, 8]) {
        const l = computeRecordingLayout(true, n, W, H);
        expect(inFrame(l.screen!)).toBe(true);
        for (const t of l.tiles) expect(inFrame(t)).toBe(true);
      }
    });
  });

  describe('gallery view (no screenshare)', () => {
    it('has no screen and arranges tiles in a grid', () => {
      const l = computeRecordingLayout(false, 2, W, H);
      expect(l.screen).toBeNull();
      // cols=2, rows=1 → cellW=640, cellH=720.
      expect(l.tiles).toEqual([
        { x: 6, y: 6, w: 628, h: 708 },
        { x: 646, y: 6, w: 628, h: 708 },
      ]);
    });

    it('is empty when there are no tiles', () => {
      const l = computeRecordingLayout(false, 0, W, H);
      expect(l.screen).toBeNull();
      expect(l.tiles).toEqual([]);
    });

    it('uses a near-square grid for larger counts', () => {
      const l = computeRecordingLayout(false, 5, W, H);
      // cols=ceil(sqrt(5))=3, rows=ceil(5/3)=2.
      expect(l.tiles.length).toBe(5);
      for (const t of l.tiles) expect(inFrame(t)).toBe(true);
    });
  });
});
