import { describe, expect, it } from 'bun:test';
import {
  chunkPoints,
  contentRect,
  flatToPoints,
  fromFrac,
  POINTER_TTL_MS,
  pointsToFlat,
  STROKE_FADE_MS,
  STROKE_HOLD_MS,
  strokeAlpha,
  toFrac,
} from '@/ui/annotate-logic';

describe('contentRect', () => {
  it('letterboxes a wide frame in a tall box', () => {
    // 1920x1080 in 800x800 → 800 wide, 450 tall, centred vertically.
    expect(contentRect(800, 800, 1600, 900)).toEqual({ x: 0, y: 175, w: 800, h: 450 });
  });

  it('pillarboxes a tall frame in a wide box', () => {
    expect(contentRect(1000, 500, 500, 500)).toEqual({ x: 250, y: 0, w: 500, h: 500 });
  });

  it('uses the whole box until the video size is known', () => {
    expect(contentRect(640, 360, 0, 0)).toEqual({ x: 0, y: 0, w: 640, h: 360 });
  });

  it('is empty for an empty box', () => {
    expect(contentRect(0, 100, 1920, 1080)).toEqual({ x: 0, y: 0, w: 0, h: 0 });
  });
});

describe('toFrac / fromFrac', () => {
  const rect = { x: 0, y: 175, w: 800, h: 450 };

  it('maps box pixels to fractions of the shared frame and back', () => {
    const p = toFrac(400, 400, rect);
    expect(p).toEqual({ x: 0.5, y: 0.5 });
    expect(fromFrac(p ?? { x: 0, y: 0 }, rect)).toEqual({ x: 400, y: 400 });
  });

  it('is null on the letterbox bars (off the shared picture)', () => {
    expect(toFrac(400, 100, rect)).toBeNull();
    expect(toFrac(400, 700, rect)).toBeNull();
  });

  it('is null for an empty rect', () => {
    expect(toFrac(1, 1, { x: 0, y: 0, w: 0, h: 0 })).toBeNull();
  });
});

describe('strokeAlpha', () => {
  it('is opaque while held, then fades linearly to nothing', () => {
    expect(strokeAlpha(1000, 1000)).toBe(1);
    expect(strokeAlpha(1000 + STROKE_HOLD_MS, 1000)).toBe(1);
    expect(strokeAlpha(1000 + STROKE_HOLD_MS + STROKE_FADE_MS / 2, 1000)).toBeCloseTo(0.5, 5);
    expect(strokeAlpha(1000 + STROKE_HOLD_MS + STROKE_FADE_MS, 1000)).toBe(0);
    expect(strokeAlpha(1000 + STROKE_HOLD_MS + STROKE_FADE_MS * 5, 1000)).toBe(0);
  });

  it('keeps the pointer lifetime shorter than a held stroke', () => {
    expect(POINTER_TTL_MS).toBeLessThan(STROKE_HOLD_MS);
  });
});

describe('flat point conversion', () => {
  it('round-trips', () => {
    const pts = [
      { x: 0.1, y: 0.2 },
      { x: 0.3, y: 0.4 },
    ];
    expect(flatToPoints(pointsToFlat(pts))).toEqual(pts);
  });

  it('ignores a dangling coordinate', () => {
    expect(flatToPoints([0.1, 0.2, 0.3])).toEqual([{ x: 0.1, y: 0.2 }]);
  });
});

describe('chunkPoints', () => {
  const run = (n: number) => Array.from({ length: n }, (_, i) => ({ x: i / 100, y: 0 }));

  it('sends a short run as one chunk, and nothing as nothing', () => {
    expect(chunkPoints(run(5), 10)).toHaveLength(1);
    expect(chunkPoints([], 10)).toEqual([]);
  });

  it('splits a long run into chunks within the limit, joined at the seams', () => {
    const chunks = chunkPoints(run(25), 10);
    expect(chunks.every((c) => c.length <= 10)).toBe(true);
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i][0]).toEqual(chunks[i - 1][chunks[i - 1].length - 1]);
    }
    // Every original point is still in there, in order, ending on the last one.
    expect(chunks[chunks.length - 1].at(-1)).toEqual({ x: 0.24, y: 0 });
  });
});
