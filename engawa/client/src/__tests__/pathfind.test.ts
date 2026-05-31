import { describe, expect, it } from 'bun:test';
import { findPath, defaultTileWalkable, type TileWalkable } from '@/world/pathfind';
import { TILE_SIZE, MAP_COLS, MAP_ROWS } from '@/world/tilemap';

// Pixel coordinate of the center of tile (col, row).
function center(col: number, row: number): { x: number; y: number } {
  return { x: col * TILE_SIZE + TILE_SIZE / 2, y: row * TILE_SIZE + TILE_SIZE / 2 };
}

// All tiles walkable except those in `blocked` (set of "col,row" keys).
function gridWith(blocked: Array<[number, number]>): TileWalkable {
  const set = new Set(blocked.map(([c, r]) => `${c},${r}`));
  return (col, row) => {
    if (col < 0 || col >= MAP_COLS || row < 0 || row >= MAP_ROWS) return false;
    return !set.has(`${col},${row}`);
  };
}

describe('findPath', () => {
  it('returns an empty path when start and goal are the same tile', () => {
    expect(findPath(center(5, 5), center(5, 5), gridWith([]))).toEqual([]);
  });

  it('walks a straight horizontal line on an open grid', () => {
    const path = findPath(center(2, 5), center(5, 5), gridWith([]));
    // Excludes the start tile; ends at the goal tile center.
    expect(path).toEqual([center(3, 5), center(4, 5), center(5, 5)]);
  });

  it('ends exactly at the goal tile center', () => {
    const path = findPath(center(2, 2), center(6, 9), gridWith([]));
    expect(path[path.length - 1]).toEqual(center(6, 9));
  });

  it('detours around a wall instead of passing through it', () => {
    // A vertical wall at col 4 (rows 4..6) between start (col 2) and goal (col 6)
    // on row 5 — the straight route is blocked, so the path must go around.
    const wall = gridWith([
      [4, 4],
      [4, 5],
      [4, 6],
    ]);
    const path = findPath(center(2, 5), center(6, 5), wall);
    expect(path.length).toBeGreaterThan(0);
    expect(path[path.length - 1]).toEqual(center(6, 5));
    // No waypoint sits on the wall tiles.
    for (const p of path) {
      const col = Math.floor(p.x / TILE_SIZE);
      const row = Math.floor(p.y / TILE_SIZE);
      expect(wall(col, row)).toBe(true);
    }
  });

  it('returns an empty path when the goal is fully walled off', () => {
    // Enclose tile (5,5) on all four orthogonal + diagonal sides.
    const walls: Array<[number, number]> = [];
    for (let dc = -1; dc <= 1; dc++)
      for (let dr = -1; dr <= 1; dr++) if (dc !== 0 || dr !== 0) walls.push([5 + dc, 5 + dr]);
    const path = findPath(center(1, 1), center(5, 5), gridWith(walls));
    expect(path).toEqual([]);
  });

  it('returns an empty path when the goal tile itself is not walkable', () => {
    const path = findPath(center(1, 1), center(5, 5), gridWith([[5, 5]]));
    expect(path).toEqual([]);
  });

  it('does not cut corners: a diagonal step needs both orthogonal tiles free', () => {
    // Block (3,5) and (2,4) around a would-be diagonal from (2,5) to (3,4).
    // Going (2,5)→(3,4) diagonally would clip the corner, so it must be avoided.
    const blocked = gridWith([
      [3, 5],
      [2, 4],
    ]);
    const path = findPath(center(2, 5), center(3, 4), blocked);
    expect(path.length).toBeGreaterThan(0);
    // The first step must not be the corner-cutting diagonal straight to goal.
    expect(path[0]).not.toEqual(center(3, 4));
  });
});

describe('defaultTileWalkable', () => {
  it('treats out-of-bounds tiles as not walkable', () => {
    expect(defaultTileWalkable(-1, 5)).toBe(false);
    expect(defaultTileWalkable(MAP_COLS, 5)).toBe(false);
    expect(defaultTileWalkable(5, MAP_ROWS)).toBe(false);
  });
});
