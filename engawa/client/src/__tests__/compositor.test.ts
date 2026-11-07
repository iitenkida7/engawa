import { describe, expect, it } from 'bun:test';
import { cameraFit, computeRecordingLayout, fitRect, layoutTileGrid } from '@/media/compositor';

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

describe('cameraFit', () => {
  it('fills when the source matches the tile', () => {
    expect(cameraFit(960, 540, 320, 180)).toBe('cover');
  });

  it('fills a 4:3 camera into a 16:9 tile (only the edges are cropped)', () => {
    expect(cameraFit(640, 480, 320, 180)).toBe('cover');
  });

  it('letterboxes a portrait camera instead of cropping the face', () => {
    expect(cameraFit(540, 960, 320, 180)).toBe('contain');
    expect(cameraFit(500, 500, 320, 180)).toBe('contain');
  });

  it('falls back to cover without a known size', () => {
    expect(cameraFit(0, 0, 320, 180)).toBe('cover');
  });
});

describe('layoutTileGrid', () => {
  const area = { x: 0, y: 0, w: 1000, h: 1000 };

  it('centers a short last row', () => {
    const t = layoutTileGrid(3, { x: 0, y: 0, w: 1000, h: 600 });
    // Two rows: the lone tile on the second row sits in the middle.
    expect(t[2].y).toBeGreaterThan(t[0].y);
    expect(t[2].x + t[2].w / 2).toBeCloseTo(500);
  });

  it('centers the block vertically', () => {
    const t = layoutTileGrid(1, area);
    expect(t[0].w).toBe(1000);
    expect(t[0].y + t[0].h / 2).toBeCloseTo(500);
  });
});

describe('computeRecordingLayout', () => {
  const W = 1280;
  const H = 720;

  const inFrame = (b: { x: number; y: number; w: number; h: number }) =>
    b.x >= 0 && b.y >= 0 && b.x + b.w <= W + 0.001 && b.y + b.h <= H + 0.001;
  const is16x9 = (b: { w: number; h: number }) => Math.abs(b.w / b.h - 16 / 9) < 1e-9;
  const overlaps = (
    a: { x: number; y: number; w: number; h: number },
    b: { x: number; y: number; w: number; h: number },
  ) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

  const checkTiles = (tiles: { x: number; y: number; w: number; h: number }[]) => {
    for (const t of tiles) {
      expect(inFrame(t)).toBe(true);
      expect(is16x9(t)).toBe(true);
    }
    for (let i = 0; i < tiles.length; i++)
      for (let j = i + 1; j < tiles.length; j++) expect(overlaps(tiles[i], tiles[j])).toBe(false);
  };

  describe('screenshare present', () => {
    it('puts the screen on the left and the tiles in the sidebar', () => {
      const l = computeRecordingLayout(true, 2, W, H);
      // sideW = round(1280*0.26)=333, mainW=947.
      expect(l.screen).toEqual({ x: 12, y: 12, w: 935, h: 696 });
      // Sidebar x=959, w=309 → 16:9 tiles of 309 wide, stacked and centered.
      for (const t of l.tiles) {
        expect(t.x).toBe(959);
        expect(t.w).toBe(309);
      }
      const top = l.tiles[0].y;
      const bottom = l.tiles[1].y + l.tiles[1].h;
      expect((top + bottom) / 2).toBeCloseTo(H / 2);
    });

    it('does not stretch a lone tile into a tall sliver', () => {
      const l = computeRecordingLayout(true, 1, W, H);
      expect(l.tiles[0].w).toBe(309);
      expect(l.tiles[0].h).toBeCloseTo(309 / (16 / 9));
    });

    it('gives the screen the whole frame when there are no tiles', () => {
      const l = computeRecordingLayout(true, 0, W, H);
      expect(l.screen).toEqual({ x: 12, y: 12, w: 1256, h: 696 });
      expect(l.tiles).toEqual([]);
    });

    it('keeps every tile 16:9, inside the sidebar and non-overlapping', () => {
      for (const n of [1, 2, 3, 4, 5, 8, 12]) {
        const l = computeRecordingLayout(true, n, W, H);
        expect(l.tiles.length).toBe(n);
        expect(inFrame(l.screen!)).toBe(true);
        checkTiles(l.tiles);
        for (const t of l.tiles) expect(t.x).toBeGreaterThanOrEqual(959);
      }
    });
  });

  describe('gallery view (no screenshare)', () => {
    it('places two people side by side as 16:9 tiles', () => {
      const l = computeRecordingLayout(false, 2, W, H);
      expect(l.screen).toBeNull();
      expect(l.tiles.length).toBe(2);
      expect(l.tiles[0].y).toBe(l.tiles[1].y);
      expect(l.tiles[0].w).toBeCloseTo((1256 - 12) / 2);
      checkTiles(l.tiles);
    });

    it('is empty when there are no tiles', () => {
      const l = computeRecordingLayout(false, 0, W, H);
      expect(l.screen).toBeNull();
      expect(l.tiles).toEqual([]);
    });

    it('keeps every tile 16:9, inside the frame and non-overlapping', () => {
      for (let n = 1; n <= 16; n++) {
        const l = computeRecordingLayout(false, n, W, H);
        expect(l.tiles.length).toBe(n);
        checkTiles(l.tiles);
      }
    });
  });
});
