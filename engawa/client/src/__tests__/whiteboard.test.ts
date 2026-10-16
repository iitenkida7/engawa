import { describe, expect, it } from 'bun:test';
import {
  strokeStyleFor,
  toCanvasPoint,
  WB_COLORS,
  WB_HEIGHT,
  WB_WIDTH,
  whiteboardFileName,
} from '@/ui/whiteboard-logic';

describe('strokeStyleFor', () => {
  it('pen is thin and opaque', () => {
    expect(strokeStyleFor('pen')).toEqual({ width: 4, alpha: 1 });
  });

  it('marker is wide and translucent', () => {
    const m = strokeStyleFor('marker');
    expect(m.width).toBeGreaterThan(strokeStyleFor('pen').width);
    expect(m.alpha).toBeLessThan(1);
  });
});

describe('toCanvasPoint', () => {
  const rect = { left: 100, top: 50, width: 640, height: 360 };

  it('scales CSS pixels to logical canvas coordinates', () => {
    expect(toCanvasPoint(100, 50, rect)).toEqual({ x: 0, y: 0 });
    expect(toCanvasPoint(420, 230, rect)).toEqual({ x: WB_WIDTH / 2, y: WB_HEIGHT / 2 });
    expect(toCanvasPoint(740, 410, rect)).toEqual({ x: WB_WIDTH, y: WB_HEIGHT });
  });

  it('clamps points outside the canvas (pointer capture can leave it)', () => {
    expect(toCanvasPoint(0, 0, rect)).toEqual({ x: 0, y: 0 });
    expect(toCanvasPoint(9999, 9999, rect)).toEqual({ x: WB_WIDTH, y: WB_HEIGHT });
  });

  it('survives a zero-size rect', () => {
    expect(toCanvasPoint(10, 10, { left: 0, top: 0, width: 0, height: 0 })).toEqual({ x: 0, y: 0 });
  });
});

describe('whiteboardFileName', () => {
  it('formats local time as YYYYMMDD-HHmmss', () => {
    expect(whiteboardFileName(new Date(2026, 9, 16, 9, 5, 7))).toBe(
      'engawa-whiteboard-20261016-090507.png',
    );
  });
});

describe('WB_COLORS', () => {
  it('offers a handful of distinct colors', () => {
    expect(new Set(WB_COLORS).size).toBe(WB_COLORS.length);
    expect(WB_COLORS.length).toBeGreaterThanOrEqual(3);
  });
});
