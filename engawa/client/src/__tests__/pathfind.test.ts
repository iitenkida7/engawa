import { describe, expect, it } from 'bun:test';
import {
  AVOID_COST,
  defaultTileCost,
  defaultTileWalkable,
  findPath,
  type TileCost,
  type TileWalkable,
} from '@/world/pathfind';
import { LOUNGE_RECTS, MAP_COLS, MAP_ROWS, OPEN_DESK_CHAIRS, TILE_SIZE } from '@/world/tilemap';

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

// Extra cost on the given tiles, free everywhere else.
function costOn(tiles: Array<[number, number]>, amount = AVOID_COST): TileCost {
  const set = new Set(tiles.map(([c, r]) => `${c},${r}`));
  return (col, row) => (set.has(`${col},${row}`) ? amount : 0);
}

const colsOf = (path: Array<{ x: number; y: number }>) =>
  path.map((p) => Math.floor(p.x / TILE_SIZE));
const rowsOf = (path: Array<{ x: number; y: number }>) =>
  path.map((p) => Math.floor(p.y / TILE_SIZE));

// Routing preferences (#360): rugs and cafés are walkable, but an auto-walk
// should take the aisle instead of crossing them.
describe('findPath tile costs', () => {
  it('steps around a costly strip when the detour is cheaper', () => {
    // A 3-tile-wide "rug" on row 5 between start and goal; going around it is
    // two rows of detour, far cheaper than 3 × AVOID_COST.
    const rug = costOn([
      [3, 5],
      [4, 5],
      [5, 5],
    ]);
    const path = findPath(center(2, 5), center(6, 5), gridWith([]), rug);
    expect(path[path.length - 1]).toEqual(center(6, 5));
    expect(rowsOf(path).some((row) => row !== 5)).toBe(true);
    for (const p of path)
      expect(rug(Math.floor(p.x / TILE_SIZE), Math.floor(p.y / TILE_SIZE))).toBe(0);
  });

  it('crosses it anyway when going around costs more', () => {
    // The same strip, but walled in above and below: the only way around is the
    // long way, so paying the surcharge wins.
    const walls: Array<[number, number]> = [];
    for (let c = 0; c < 12; c++) {
      if (c !== 4) {
        walls.push([c, 4]);
        walls.push([c, 6]);
      }
    }
    const path = findPath(center(2, 5), center(6, 5), gridWith(walls), costOn([[4, 5]]));
    expect(colsOf(path)).toEqual([3, 4, 5, 6]);
  });

  it('still reaches a goal that sits on a costly tile', () => {
    const path = findPath(center(2, 5), center(5, 5), gridWith([]), costOn([[5, 5]]));
    expect(path[path.length - 1]).toEqual(center(5, 5));
  });

  it('never charges for the tile we start on', () => {
    // Starting inside the strip: the straight line out is unchanged.
    const path = findPath(center(4, 5), center(7, 5), gridWith([]), costOn([[4, 5]]));
    expect(path).toEqual([center(5, 5), center(6, 5), center(7, 5)]);
  });
});

describe('defaultTileCost', () => {
  it('charges for a desk pod rug (the chair tile in front of the desk)', () => {
    const desk = OPEN_DESK_CHAIRS[0];
    const seatRow = desk.row + (desk.facesSouth ? -1 : 1);
    expect(defaultTileCost(desk.col, seatRow)).toBe(AVOID_COST);
  });

  it('charges for a café tile', () => {
    const cafe = LOUNGE_RECTS[0];
    const col = Math.floor(cafe.x / TILE_SIZE);
    const row = Math.floor(cafe.y / TILE_SIZE);
    expect(defaultTileCost(col, row)).toBe(AVOID_COST);
  });

  it('is free on the aisle beside an island, and out of bounds', () => {
    const desk = OPEN_DESK_CHAIRS[0];
    const seatRow = desk.row + (desk.facesSouth ? -1 : 1);
    // Pitch 5 with a 3-wide rug: two tiles over is the aisle.
    expect(defaultTileCost(desk.col + 2, seatRow)).toBe(0);
    expect(defaultTileCost(-1, 5)).toBe(0);
    expect(defaultTileCost(5, MAP_ROWS)).toBe(0);
  });
});

// The real map (#360). Two spots where the shortest route used to clip a floor
// it has no business crossing: the desk islands (2-tile aisles between 3-tile
// rugs) and the café beside the left gate (a zone — stepping in joins its call).
describe('findPath on the real office map', () => {
  // Every waypoint, with the surcharge its tile carries.
  const costs = (path: Array<{ x: number; y: number }>) =>
    path.map((p) => defaultTileCost(Math.floor(p.x / TILE_SIZE), Math.floor(p.y / TILE_SIZE)));
  const free: TileCost = () => 0;

  it('takes the aisle between the desk islands instead of clipping a rug', () => {
    // Straight down the leftmost island of the top band: three rows above its
    // desks is the aisle, five below is the corridor, and the only way between
    // them that is not rug is the aisle beside the island. Taken off the desk
    // data, so a map that shifts (the president's office did, #358) cannot
    // quietly move these points onto a rug.
    const island = OPEN_DESK_CHAIRS[0];
    const from = center(island.col, island.row - 3);
    const to = center(island.col, island.row + 5);
    expect(costs(findPath(from, to, defaultTileWalkable, free)).some((c) => c > 0)).toBe(true);
    const path = findPath(from, to);
    expect(path[path.length - 1]).toEqual(to);
    expect(costs(path).every((c) => c === 0)).toBe(true);
  });

  it('walks around the café rather than through it', () => {
    // Down the café's middle column, from two rows above it to two below.
    const cafe = LOUNGE_RECTS[0];
    const col = Math.floor((cafe.x + cafe.w / 2) / TILE_SIZE);
    const from = center(col, Math.floor(cafe.y / TILE_SIZE) - 2);
    const to = center(col, Math.floor((cafe.y + cafe.h) / TILE_SIZE) + 2);
    expect(costs(findPath(from, to, defaultTileWalkable, free)).some((c) => c > 0)).toBe(true);
    const path = findPath(from, to);
    expect(path[path.length - 1]).toEqual(to);
    expect(costs(path).every((c) => c === 0)).toBe(true);
  });
});

describe('defaultTileWalkable', () => {
  it('treats out-of-bounds tiles as not walkable', () => {
    expect(defaultTileWalkable(-1, 5)).toBe(false);
    expect(defaultTileWalkable(MAP_COLS, 5)).toBe(false);
    expect(defaultTileWalkable(5, MAP_ROWS)).toBe(false);
  });
});
