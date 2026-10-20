import { describe, expect, it } from 'bun:test';
import { MAP_HEIGHT, MAP_WIDTH } from '@/core/types';
import { visibleMapRect } from '@/world/canvas';

describe('visibleMapRect', () => {
  it('is the viewport around the camera at 1:1', () => {
    expect(visibleMapRect({ w: 800, h: 600 }, { x: 1000, y: 1000 }, 1)).toEqual({
      x: 600,
      y: 700,
      w: 800,
      h: 600,
    });
  });

  it('shrinks with zoom in and grows with zoom out', () => {
    expect(visibleMapRect({ w: 800, h: 600 }, { x: 1000, y: 1000 }, 2)).toEqual({
      x: 800,
      y: 850,
      w: 400,
      h: 300,
    });
    const out = visibleMapRect({ w: 800, h: 600 }, { x: 1000, y: 1000 }, 0.5);
    expect(out?.w).toBe(1600);
    expect(out?.h).toBe(1200);
  });

  it('clamps to the map edges', () => {
    expect(visibleMapRect({ w: 800, h: 600 }, { x: 100, y: 50 }, 1)).toEqual({
      x: 0,
      y: 0,
      w: 500,
      h: 350,
    });
    expect(visibleMapRect({ w: 10000, h: 10000 }, { x: 1300, y: 1000 }, 1)).toEqual({
      x: 0,
      y: 0,
      w: MAP_WIDTH,
      h: MAP_HEIGHT,
    });
  });

  it('widens fractional edges to whole pixels so no seam shows', () => {
    const r = visibleMapRect({ w: 801, h: 601 }, { x: 1000.3, y: 1000.7 }, 1);
    expect(r).toEqual({ x: 599, y: 700, w: 802, h: 602 });
  });

  it('is null when the map is entirely off screen', () => {
    expect(visibleMapRect({ w: 100, h: 100 }, { x: -500, y: -500 }, 1)).toBeNull();
  });
});
