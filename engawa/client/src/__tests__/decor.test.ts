import { describe, expect, it } from 'bun:test';
import { propFor } from '@/world/decor';
import { canOccupy, MAP, TILE_SIZE, Tile } from '@/world/tilemap';

const [LOUNGE] = MAP.lounges;

describe('propFor', () => {
  it('maps desk and plant tiles to their props, everything else to null', () => {
    expect(propFor(Tile.DESK)).toBe('desk');
    expect(propFor(Tile.PLANT)).toBe('plant');
    expect(propFor(Tile.FLOOR)).toBeNull();
    expect(propFor(Tile.WALL)).toBeNull();
    expect(propFor(Tile.MEETING)).toBeNull();
    expect(propFor(Tile.LOUNGE)).toBeNull();
  });
});

describe('lounge', () => {
  it('is walkable (an open social spot, not a solid prop)', () => {
    const cx = (LOUNGE.c + 0.5) * TILE_SIZE;
    const cy = (LOUNGE.r + 0.5) * TILE_SIZE;
    expect(canOccupy(cx, cy, 5)).toBe(true);
  });
});
