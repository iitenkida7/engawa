import { describe, expect, it } from 'bun:test';
import { stepTarget, tileCenterAt } from '@/world/grid';
import { TILE_SIZE } from '@/world/tilemap';

// A simple all-walkable-except-a-wall grid for deterministic tests, independent
// of the real office map.
const open = () => true;
const wallAt = (wc: number, wr: number) => (c: number, r: number) => !(c === wc && r === wr);

describe('tileCenterAt', () => {
  it('snaps any point in a tile to that tile center', () => {
    expect(tileCenterAt(0, 0)).toEqual({ x: TILE_SIZE / 2, y: TILE_SIZE / 2 });
    // Anywhere inside tile (2, 3) maps to the same center.
    const cx = 2 * TILE_SIZE + TILE_SIZE / 2;
    const cy = 3 * TILE_SIZE + TILE_SIZE / 2;
    expect(tileCenterAt(2 * TILE_SIZE + 1, 3 * TILE_SIZE + 49)).toEqual({ x: cx, y: cy });
  });
});

describe('stepTarget', () => {
  const center = (col: number, row: number) => ({
    x: col * TILE_SIZE + TILE_SIZE / 2,
    y: row * TILE_SIZE + TILE_SIZE / 2,
  });

  it('returns the adjacent tile center for each cardinal direction', () => {
    const start = center(5, 5);
    expect(stepTarget(start.x, start.y, 1, 0, open)).toEqual(center(6, 5));
    expect(stepTarget(start.x, start.y, -1, 0, open)).toEqual(center(4, 5));
    expect(stepTarget(start.x, start.y, 0, 1, open)).toEqual(center(5, 6));
    expect(stepTarget(start.x, start.y, 0, -1, open)).toEqual(center(5, 4));
  });

  it('snaps an off-center origin to its tile before stepping', () => {
    // Just inside tile (5,5): still steps to (6,5).
    expect(stepTarget(5 * TILE_SIZE + 1, 5 * TILE_SIZE + 1, 1, 0, open)).toEqual(center(6, 5));
  });

  it('returns null when the destination tile is not walkable', () => {
    const start = center(5, 5);
    expect(stepTarget(start.x, start.y, 1, 0, wallAt(6, 5))).toBeNull();
  });

  it('returns null for a zero direction', () => {
    const start = center(5, 5);
    expect(stepTarget(start.x, start.y, 0, 0, open)).toBeNull();
  });
});
