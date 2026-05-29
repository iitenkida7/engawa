import { describe, expect, it } from 'bun:test';
import { worldFromScreen } from '../canvas';
import { MAP_WIDTH, MAP_HEIGHT } from '../types';

describe('worldFromScreen', () => {
  const view = { w: 800, h: 600 };
  const rect = { left: 0, top: 0 };

  it('maps the viewport center to the player position (camera centers on self)', () => {
    const self = { x: 1000, y: 750 };
    expect(worldFromScreen(view.w / 2, view.h / 2, rect, view, self)).toEqual(self);
  });

  it('applies the camera offset away from center', () => {
    const self = { x: 1000, y: 750 };
    // 100px right and 50px down from the viewport center.
    const screen = { x: view.w / 2 + 100, y: view.h / 2 + 50 };
    expect(worldFromScreen(screen.x, screen.y, rect, view, self)).toEqual({
      x: self.x + 100,
      y: self.y + 50,
    });
  });

  it('subtracts the canvas bounding-rect offset', () => {
    const self = { x: 1000, y: 750 };
    const offsetRect = { left: 30, top: 20 };
    // A click at the rect origin maps to the top-left world corner of the view.
    expect(worldFromScreen(30, 20, offsetRect, view, self)).toEqual({
      x: self.x - view.w / 2,
      y: self.y - view.h / 2,
    });
  });

  it('falls back to the map center when there is no self', () => {
    expect(worldFromScreen(view.w / 2, view.h / 2, rect, view, null)).toEqual({
      x: MAP_WIDTH / 2,
      y: MAP_HEIGHT / 2,
    });
  });
});
