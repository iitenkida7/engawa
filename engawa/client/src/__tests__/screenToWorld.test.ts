import { describe, expect, it } from 'bun:test';
import { MAP_HEIGHT, MAP_WIDTH } from '@/core/types';
import { worldFromScreen } from '@/world/canvas';

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

  it('keeps self centered regardless of zoom', () => {
    const self = { x: 1000, y: 750 };
    expect(worldFromScreen(view.w / 2, view.h / 2, rect, view, self, 0.5)).toEqual(self);
  });

  it('scales the offset from center by 1/zoom when zoomed out', () => {
    const self = { x: 1000, y: 750 };
    // At 0.5× the viewport covers 2× the world, so a 100px screen offset from
    // center maps to 200 world px from self.
    const screen = { x: view.w / 2 + 100, y: view.h / 2 + 50 };
    expect(worldFromScreen(screen.x, screen.y, rect, view, self, 0.5)).toEqual({
      x: self.x + 200,
      y: self.y + 100,
    });
  });

  it('round-trips a click back to a known world point under zoom', () => {
    // screen = (world - self) * zoom + center → world recovered by worldFromScreen.
    const self = { x: 1000, y: 750 };
    const zoom = 0.5;
    const world = { x: 1400, y: 900 };
    const screen = {
      x: (world.x - self.x) * zoom + view.w / 2,
      y: (world.y - self.y) * zoom + view.h / 2,
    };
    expect(worldFromScreen(screen.x, screen.y, rect, view, self, zoom)).toEqual(world);
  });
});
