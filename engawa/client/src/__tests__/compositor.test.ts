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
    it('puts the screen on the left and stacks tiles + map down the sidebar', () => {
      const l = computeRecordingLayout(true, 2, W, H);
      // sideW = round(1280*0.26)=333, mainW=947.
      expect(l.screen).toEqual({ x: 12, y: 12, w: 935, h: 696 });
      // sidebar: x=959, innerW=309; slots=3, slotH=(720-48)/3=224.
      expect(l.tiles).toEqual([
        { x: 959, y: 12, w: 309, h: 224 },
        { x: 959, y: 248, w: 309, h: 224 },
      ]);
      expect(l.map).toEqual({ x: 959, y: 484, w: 309, h: 224 });
    });

    it('keeps the map in the sidebar even with no camera tiles', () => {
      const l = computeRecordingLayout(true, 0, W, H);
      expect(l.screen).toEqual({ x: 12, y: 12, w: 935, h: 696 });
      expect(l.tiles).toEqual([]);
      // slots=1 → map fills the sidebar height.
      expect(l.map).toEqual({ x: 959, y: 12, w: 309, h: 696 });
    });

    it('keeps every box inside the frame', () => {
      for (const n of [1, 2, 3, 5, 8]) {
        const l = computeRecordingLayout(true, n, W, H);
        expect(inFrame(l.screen!)).toBe(true);
        expect(inFrame(l.map)).toBe(true);
        for (const t of l.tiles) expect(inFrame(t)).toBe(true);
      }
    });
  });

  describe('gallery view (no screenshare)', () => {
    it('has no screen and arranges tiles in a grid with a corner map inset', () => {
      const l = computeRecordingLayout(false, 2, W, H);
      expect(l.screen).toBeNull();
      // cols=2, rows=1 → cellW=640, cellH=720.
      expect(l.tiles).toEqual([
        { x: 6, y: 6, w: 628, h: 708 },
        { x: 646, y: 6, w: 628, h: 708 },
      ]);
      // mapW=round(1280*0.22)=282, mapH=round(282*9/16)=159; bottom-right.
      expect(l.map).toEqual({ x: 986, y: 549, w: 282, h: 159 });
    });

    it('shows the map full-frame when there are no tiles', () => {
      const l = computeRecordingLayout(false, 0, W, H);
      expect(l.screen).toBeNull();
      expect(l.tiles).toEqual([]);
      expect(l.map).toEqual({ x: 12, y: 12, w: 1256, h: 696 });
    });

    it('uses a near-square grid for larger counts', () => {
      const l = computeRecordingLayout(false, 5, W, H);
      // cols=ceil(sqrt(5))=3, rows=ceil(5/3)=2.
      expect(l.tiles.length).toBe(5);
      for (const t of l.tiles) expect(inFrame(t)).toBe(true);
    });
  });
});
