import { describe, expect, it } from 'bun:test';
import {
  canOccupy,
  findWalkableSpawn,
  isSolid,
  MAP_COLS,
  MAP_ROWS,
  officeMap,
  SOLID,
  TILE_SIZE,
  Tile,
  ZONES,
  zoneAt,
} from '../tilemap';

// Pixel coordinate of the center of tile (col, row).
function center(col: number, row: number): { x: number; y: number } {
  return { x: col * TILE_SIZE + TILE_SIZE / 2, y: row * TILE_SIZE + TILE_SIZE / 2 };
}

// Find one solid and one floor tile from the generated map to test against.
function findTile(predicate: (t: number) => boolean): { col: number; row: number } {
  for (let r = 0; r < MAP_ROWS; r++) {
    for (let c = 0; c < MAP_COLS; c++) {
      if (predicate(officeMap[r][c])) return { col: c, row: r };
    }
  }
  throw new Error('no matching tile');
}

describe('isSolid', () => {
  it('returns true for a SOLID tile coordinate', () => {
    const { col, row } = findTile((t) => SOLID.has(t));
    const { x, y } = center(col, row);
    expect(isSolid(x, y)).toBe(true);
  });

  it('returns false for a FLOOR tile coordinate', () => {
    const { col, row } = findTile((t) => t === Tile.FLOOR);
    const { x, y } = center(col, row);
    expect(isSolid(x, y)).toBe(false);
  });

  it('treats out-of-bounds coordinates as solid', () => {
    expect(isSolid(-1, 10)).toBe(true);
    expect(isSolid(10, -1)).toBe(true);
    expect(isSolid(MAP_COLS * TILE_SIZE + 1, 10)).toBe(true);
    expect(isSolid(10, MAP_ROWS * TILE_SIZE + 1)).toBe(true);
  });
});

describe('canOccupy', () => {
  it('returns true when all four corners are on floor', () => {
    const { col, row } = findTile((t) => t === Tile.FLOOR);
    const { x, y } = center(col, row);
    expect(canOccupy(x, y, 5)).toBe(true);
  });

  it('returns false when a corner overlaps a wall', () => {
    // The outer border (row 0) is wall; a point just inside row 1 with a large
    // radius will have its top corner cross into the wall.
    const { x, y } = center(5, 1);
    expect(canOccupy(x, y, TILE_SIZE)).toBe(false);
  });

  it('returns false when centered on a solid tile', () => {
    const { col, row } = findTile((t) => SOLID.has(t));
    const { x, y } = center(col, row);
    expect(canOccupy(x, y, 5)).toBe(false);
  });
});

describe('findWalkableSpawn', () => {
  it('returns the same point when already walkable', () => {
    const { col, row } = findTile((t) => t === Tile.FLOOR);
    const { x, y } = center(col, row);
    expect(findWalkableSpawn(x, y, 5)).toEqual({ x, y });
  });

  it('spirals out to a walkable tile center when the start is solid', () => {
    const { col, row } = findTile((t) => SOLID.has(t));
    const { x, y } = center(col, row);
    const spawn = findWalkableSpawn(x, y, 5);
    expect(canOccupy(spawn.x, spawn.y, 5)).toBe(true);
    // Snapped to a tile center.
    expect((spawn.x - TILE_SIZE / 2) % TILE_SIZE).toBe(0);
    expect((spawn.y - TILE_SIZE / 2) % TILE_SIZE).toBe(0);
  });
});

describe('ZONES / zoneAt (meeting-room zones)', () => {
  it('derives exactly the two MEETING rooms from the map', () => {
    expect(ZONES).toHaveLength(2);
  });

  it('assigns a zone to every MEETING tile and none to other tiles', () => {
    for (let r = 0; r < MAP_ROWS; r++) {
      for (let c = 0; c < MAP_COLS; c++) {
        const z = zoneAt(c * TILE_SIZE + TILE_SIZE / 2, r * TILE_SIZE + TILE_SIZE / 2);
        if (officeMap[r][c] === Tile.MEETING) {
          expect(z).not.toBeNull();
        } else {
          expect(z).toBeNull();
        }
      }
    }
  });

  it('groups each room into a single distinct zone (the two rooms differ)', () => {
    // First MEETING tile in each room, scanning left-to-right / top-to-bottom.
    const meetingTiles: { col: number; row: number }[] = [];
    for (let r = 0; r < MAP_ROWS; r++) {
      for (let c = 0; c < MAP_COLS; c++) {
        if (officeMap[r][c] === Tile.MEETING) meetingTiles.push({ col: c, row: r });
      }
    }
    const leftmost = meetingTiles[0];
    const rightmost = meetingTiles[meetingTiles.length - 1];
    const left = zoneAt(leftmost.col * TILE_SIZE + 1, leftmost.row * TILE_SIZE + 1);
    const right = zoneAt(rightmost.col * TILE_SIZE + 1, rightmost.row * TILE_SIZE + 1);
    expect(left).not.toBeNull();
    expect(right).not.toBeNull();
    expect(left!.id).not.toBe(right!.id);
  });

  it('returns null outside the map bounds', () => {
    expect(zoneAt(-10, -10)).toBeNull();
    expect(zoneAt(MAP_COLS * TILE_SIZE + 10, 0)).toBeNull();
  });
});
